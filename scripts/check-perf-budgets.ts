import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'

import postgres from 'postgres'

/**
 * Sprint-0 Gate 11: the performance budget stops being a sentence.
 *
 * `CLAUDE.md` states that the bundle and TTI budgets are unset and that "a null
 * budget fails the build". Errata E6 (rank 1) says the same thing more sharply:
 * the null-budget build failure is the ONLY gate until the gate measures. That
 * failure did not exist anywhere in the repository — not in vite.config.ts, not
 * in package.json, not in the workflow, not in a test. The build was green
 * because nothing measured, which is precisely the class of defect this project
 * calls documentation presented as a guarantee.
 *
 * This is the mechanism. It fails the build on three distinct things, and they
 * are different failures on purpose:
 *
 *   BREACH     a measured value is over its budget
 *   NULL       a budget in a tier this checker runs has no value
 *   UNMEASURABLE  a budget names a route or metric that cannot be computed
 *
 * The third matters as much as the first. A checker that silently skips what it
 * cannot measure reports success for a budget it never looked at, and that is
 * indistinguishable from passing.
 */

const CLIENT_DIR = 'build/client'
const MANIFEST = join(CLIENT_DIR, '.vite/manifest.json')

/** The tier this process enforces. Nightly budgets are declared here, not run here. */
const TIER = 'pre-merge'

/**
 * React Router names its client route modules with this suffix in the Vite
 * manifest, and the browser entry comes from the framework's own defaults
 * because this project does not keep a revealed `entry.client.tsx` — the default
 * was identical, and a copy of a framework default in the tree can only drift.
 */
const ROUTE_SUFFIX = '?__react-router-build-client-route'
const CLIENT_ENTRY = 'node_modules/@react-router/dev/dist/config/defaults/entry.client.tsx'

/**
 * What the browser fetches for a route is the entry plus root plus every matched
 * layout plus the leaf. Hardcoded per route rather than derived from routes.ts:
 * the nesting is the thing being asserted, and deriving it from the same source
 * the product uses would make the check agree with a mistake.
 */
const ROUTE_CHAIN: Readonly<Record<string, readonly string[]>> = {
  '/board': ['app/root.tsx', 'app/routes/ui/shell.tsx', 'app/routes/ui/board.tsx'],
  '/earnings': ['app/root.tsx', 'app/routes/ui/shell.tsx', 'app/routes/ui/leaderboard.tsx'],
  '/my-day': ['app/root.tsx', 'app/routes/ui/shell.tsx', 'app/routes/ui/my-day.tsx'],
  '/sign-in': ['app/root.tsx', 'app/routes/ui/sign-in.tsx'],
}

interface ManifestChunk {
  readonly file?: string
  readonly css?: readonly string[]
  readonly imports?: readonly string[]
}

interface Budget {
  readonly id: string
  readonly name: string
  readonly title: string
  readonly tier: string
  readonly metric: string
  readonly route?: string
  readonly unit: string
  readonly value: number | null
}

/**
 * THE ANCHOR OUTSIDE THE WORKING TREE, half built.
 *
 * `perf-budgets.json` already turns the build red, which is a real mechanism.
 * What it is not is un-walkable: loosening a number there is editing a file,
 * and the founding rule names the actor to design against — "Claude writes it
 * and nobody reads the diff". Migration 0022 moved the refusal into Postgres,
 * where `ref.ci_ratchet` rejects a loosening with its own SQLSTATE. Until now
 * nothing compared the two, so the engine could refuse a value the file was
 * already shipping.
 *
 * This closes that for every run that can reach the engine — which today means
 * the pre-commit hook, where this project's commits actually go through. It
 * does NOT yet cover CI: that needs `crm_ci` to have LOGIN and a password, set
 * out of band, and the connection string as a repository secret. When the
 * engine is unreachable this says so in a box rather than passing quietly,
 * because a cross-check that skips itself in silence is the same defect as a
 * budget nobody measured.
 */
const RATCHET_URL =
  process.env['CI_RATCHET_DATABASE_URL'] ??
  process.env['MIGRATION_DATABASE_URL'] ??
  process.env['DEV_DATABASE_URL'] ??
  'postgresql://crm:crm@localhost:5432/crm_dev'

interface RatchetRow {
  readonly name: string
  readonly latest: string | null
}

async function readRatchet(): Promise<readonly RatchetRow[] | null> {
  const client = postgres(RATCHET_URL, { max: 1, onnotice: () => {}, connect_timeout: 5 })
  try {
    return await client<RatchetRow[]>`
      SELECT n.name,
             (SELECT r.value_num::text FROM ref.ci_ratchet r
               WHERE r.name = n.name ORDER BY r.set_at DESC LIMIT 1) AS latest
        FROM ref.ci_ratchet_name n`
  } catch {
    // Unreachable, or the migration that creates the table has not run here.
    // Reported, never swallowed — see the box printed by the caller.
    return null
  } finally {
    await client.end({ timeout: 5 })
  }
}

/**
 * Three disagreements, and the third is the one worth the code.
 *
 * A budget the engine never heard of is a name added to the file alone. A
 * value that differs is the file and the engine shipping two numbers. And a
 * budget the FILE calls null while the engine holds a measurement is the
 * cheapest way to make a breach disappear: delete the number, and a checker
 * that only reads the file reports a budget "not yet measured".
 */
function compareToEngine(budgets: readonly Budget[], rows: readonly RatchetRow[]): string[] {
  const engine = new Map(rows.map((r) => [r.name, r.latest]))
  const problems: string[] = []

  for (const b of budgets) {
    if (!engine.has(b.name)) {
      problems.push(
        `  ${b.id} ${b.name} — the file declares it; ref.ci_ratchet_name has no such name. ` +
          'Register it in a migration with its arm and its rationale.',
      )
      continue
    }

    const held = engine.get(b.name) ?? null
    if (b.value === null && held !== null) {
      problems.push(
        `  ${b.id} ${b.name} — the file says NO VALUE and the engine holds ${held}. ` +
          'Emptying a measured budget is how a breach disappears.',
      )
      continue
    }
    if (b.value !== null && held === null) {
      problems.push(
        `  ${b.id} ${b.name} — the file ships ${b.value} and the engine holds no value. ` +
          'A budget the engine never accepted is a number nobody ratcheted.',
      )
      continue
    }
    if (b.value !== null && held !== null && String(b.value) !== held) {
      problems.push(
        `  ${b.id} ${b.name} — the file ships ${b.value}, the engine holds ${held}. ` +
          'Tightening is free but it is an INSERT: the engine has to accept the new number.',
      )
    }
  }

  return problems
}

function fail(lines: readonly string[]): never {
  console.error(`\n${lines.join('\n')}\n`)
  process.exit(1)
}

/** Every chunk the browser loads before the route is interactive. */
function initialAssets(
  manifest: Readonly<Record<string, ManifestChunk>>,
  route: string,
): { js: Set<string>; css: Set<string> } {
  const chain = ROUTE_CHAIN[route]
  if (chain === undefined) {
    fail([
      `PERF002: budget names route "${route}", which this checker cannot measure.`,
      '',
      'Add it to ROUTE_CHAIN with its full layout nesting. A budget whose route is',
      'silently skipped reports success for something nobody looked at.',
    ])
  }

  const keys = [CLIENT_ENTRY, ...chain.map((m) => `${m}${ROUTE_SUFFIX}`)]
  const seen = new Set<string>()
  const js = new Set<string>()
  const css = new Set<string>()

  const walk = (key: string): void => {
    if (seen.has(key)) return
    seen.add(key)
    const chunk = manifest[key]
    if (chunk === undefined) {
      fail([
        `PERF003: the client manifest has no chunk "${key}".`,
        '',
        'The route graph moved and this checker did not. It refuses rather than',
        'measuring a smaller graph than the browser actually loads.',
      ])
    }
    if (chunk.file !== undefined) js.add(chunk.file)
    for (const c of chunk.css ?? []) css.add(c)
    for (const i of chunk.imports ?? []) walk(i)
  }

  keys.forEach(walk)
  return { js, css }
}

function gzipBytes(files: ReadonlySet<string>): number {
  let total = 0
  for (const f of files) {
    total += gzipSync(readFileSync(join(CLIENT_DIR, f)), { level: 9 }).length
  }
  return total
}

async function main(): Promise<void> {
  if (!existsSync(MANIFEST)) {
    fail([
      'PERF001: no client build to measure.',
      '',
      `Expected ${MANIFEST}. Run \`npm run build\` first — this gate measures the`,
      'artifact a seller downloads, never the source it came from.',
    ])
  }

  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as Record<string, ManifestChunk>
  const config = JSON.parse(readFileSync('perf-budgets.json', 'utf8')) as {
    budgets: readonly Budget[]
  }

  const enforced = config.budgets.filter((b) => b.tier === TIER)
  if (enforced.length === 0) {
    fail([
      `PERF005: perf-budgets.json declares no budget in the "${TIER}" tier.`,
      '',
      'Emptying the list is the cheapest way to make this gate pass, so an empty',
      'list is a failure rather than a green run.',
    ])
  }

  const breaches: string[] = []
  const report: string[] = []

  for (const b of enforced) {
    // E6's null-budget failure, which is the whole reason this file exists.
    if (b.value === null) {
      breaches.push(
        `  ${b.id} ${b.name} — NO VALUE. A budget in the ${TIER} tier must carry a ` +
          `measured number; an unmeasured budget fails the build (errata E6).`,
      )
      continue
    }

    if (b.route === undefined) {
      fail([`PERF004: budget ${b.id} is in the ${TIER} tier with no route to measure.`])
    }

    const { js, css } = initialAssets(manifest, b.route)
    let measured: number
    if (b.metric === 'initial_js_gzip') measured = gzipBytes(js)
    else if (b.metric === 'initial_css_gzip') measured = gzipBytes(css)
    else {
      fail([
        `PERF002: budget ${b.id} uses metric "${b.metric}", which this checker cannot compute.`,
        '',
        'It refuses rather than skipping. A metric that is quietly not measured is',
        'a budget that passes forever.',
      ])
    }

    const pct = Math.round((measured / b.value) * 100)
    report.push(
      `  ${b.id.padEnd(4)} ${b.title.padEnd(30)} ${String(measured).padStart(7)} / ` +
        `${String(b.value).padStart(7)} ${b.unit}  (${pct}%)`,
    )

    if (measured > b.value) {
      breaches.push(
        `  ${b.id} ${b.name} — ${measured} ${b.unit} exceeds the budget of ${b.value}. ` +
          `Over by ${measured - b.value} (${pct}% of budget).`,
      )
    }
  }

  console.log(`\nPerformance budgets — ${TIER} tier\n${report.join('\n')}`)

  const declared = config.budgets.filter((b) => b.tier !== TIER)
  if (declared.length > 0) {
    console.log(
      `\nDeclared but NOT enforced here (their tier does not exist yet):\n` +
        declared
          .map((b) => `  ${b.id.padEnd(4)} ${b.title} — ${b.value === null ? 'NO VALUE' : b.value}`)
          .join('\n'),
    )
  }

  if (breaches.length > 0) {
    fail([
      'PERF100: performance budget failed.',
      '',
      ...breaches,
      '',
      'Do not raise the number to make this pass. Every row is monotonic_down: the',
      'budget may be tightened freely and loosened only deliberately, and 05c 10.0.1',
      'moves that refusal into Postgres so it stops being a file edit at all.',
    ])
  }

  // The engine half. Ordered AFTER the breach report on purpose: a run that
  // fails both should print the measurement first, because that is the one a
  // seller would feel.
  const rows = await readRatchet()
  if (rows === null) {
    console.log(
      [
        '',
        '  ┌─────────────────────────────────────────────────────────────────────┐',
        '  │ THE ENGINE CROSS-CHECK DID NOT RUN.                                 │',
        '  │                                                                     │',
        '  │ ref.ci_ratchet was unreachable, so the only authority in this run   │',
        '  │ was perf-budgets.json — a file. Loosening a number in it is an edit │',
        '  │ nobody reviews, which is the failure mode migration 0022 exists to  │',
        '  │ close. CI needs crm_ci with LOGIN and a password, set out of band,  │',
        '  │ and its connection string as CI_RATCHET_DATABASE_URL.               │',
        '  └─────────────────────────────────────────────────────────────────────┘',
      ].join('\n'),
    )
  } else {
    const problems = compareToEngine(config.budgets, rows)
    if (problems.length > 0) {
      fail([
        'PERF006: perf-budgets.json disagrees with ref.ci_ratchet.',
        '',
        ...problems,
        '',
        'The engine is the authority. A number that only exists in the file is a',
        'number nobody ratcheted, and the whole point of 05c 10.0.1 is that loosening',
        'one stops being something a file edit can do.',
      ])
    }
    console.log(
      `\n  Engine cross-check: ${config.budgets.length} budgets agree with ref.ci_ratchet.`,
    )
  }

  console.log('\nAll enforced budgets pass.\n')
}

await main()
