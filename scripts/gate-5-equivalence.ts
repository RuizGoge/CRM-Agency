import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'

/**
 * GATE 5 (c) — the identical E2E suite against both topologies.
 *
 * §2543 (c): "the identical E2E acceptance suite passes against the folded
 * deployment and against the split deployment, with no test aware of which is
 * running."
 *
 * 🔴 THE ASSERTION IS THE COMPARISON, NOT THE TWO GREEN RUNS. Two suites that
 * both pass prove that each topology works; §2543's failure clause is about
 * something else — "if any BEHAVIOUR DIFFERS between topologies, the split is
 * not configuration and the cheap tier is a trap." So this compares the two
 * result sets test by test: same titles, same outcomes. A spec that is skipped
 * under one topology and runs under the other is a difference, and a run with
 * fewer tests than the other is the loudest difference there is.
 *
 * WHY IT MATTERS MORE THAN IT LOOKS. The entire cost model rests on the fold
 * being a deployment variable — one image, one env var, no second build. If it
 * is not, that is discovered on the day the fleet outgrows the cheap rung,
 * which is the worst possible day to find out. §2543 says this gate runs on the
 * nightly tier forever after "so the split path is never executed for the first
 * time in production".
 *
 * ⚠️ THE SPLIT LEG IS TWO PROCESSES ON ONE MACHINE. It exercises the ROLE
 * boundary — the web process genuinely carries no worker, and the dispatcher,
 * relay and monitor genuinely live elsewhere — and it does NOT exercise two
 * containers, two event loops under contention, or a network between them. That
 * is the honest limit of a local run and it is stated rather than implied.
 */

const REPORT = 'gate-5-report.json'

interface PlaywrightReport {
  readonly suites?: readonly Suite[]
  readonly stats?: { readonly expected?: number; readonly unexpected?: number }
}
interface Suite {
  readonly title?: string
  readonly suites?: readonly Suite[]
  readonly specs?: readonly Spec[]
}
interface Spec {
  readonly title: string
  readonly tests?: readonly { readonly status?: string; readonly projectName?: string }[]
}

/**
 * Flattens the report into `project › title → status`, which is what gets
 * compared.
 *
 * 🔴 THE PROJECT IS PART OF THE KEY, and the first version left it out. Both
 * functional projects run the SAME spec titles, so a map keyed on the title
 * alone collapsed 110 results into 83 and the second write silently won. A
 * mobile-only difference would have been hidden by the desktop result for the
 * same test — which is the exact class of miss this whole gate exists to
 * prevent, reproduced inside the harness that checks for it.
 */
function outcomes(report: PlaywrightReport): Map<string, string> {
  const found = new Map<string, string>()

  const walk = (suite: Suite, path: readonly string[]): void => {
    const here = suite.title === undefined ? path : [...path, suite.title]
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        const project = test.projectName ?? 'unknown'
        found.set([project, ...here, spec.title].join(' › '), test.status ?? 'missing')
      }
    }
    for (const child of suite.suites ?? []) walk(child, here)
  }

  for (const suite of report.suites ?? []) walk(suite, [])
  return found
}

function run(topology: 'folded' | 'split'): Promise<Map<string, string>> {
  return new Promise((resolve, reject) => {
    if (existsSync(REPORT)) rmSync(REPORT)

    console.log(`\n=== ${topology.toUpperCase()} ===`)

    const child = spawn(
      'npx',
      ['playwright', 'test', '--project=desktop-ci', '--project=mobile-ci', '--reporter=json'],
      {
        // The JSON goes to a FILE rather than stdout: playwright writes progress
        // to stdout too, and parsing a stream that also carries a dev server's
        // logs is how a harness starts reporting on its own noise.
        env: {
          ...process.env,
          E2E_TOPOLOGY: topology,
          PLAYWRIGHT_JSON_OUTPUT_NAME: REPORT,
        },
        shell: true,
        stdio: ['ignore', 'inherit', 'inherit'],
      },
    )

    child.on('exit', () => {
      if (!existsSync(REPORT)) {
        reject(new Error(`${topology}: playwright produced no report`))
        return
      }
      const report = JSON.parse(readFileSync(REPORT, 'utf8')) as PlaywrightReport
      resolve(outcomes(report))
    })
  })
}

/** Starts a worker in its own process, the way a split deployment does. */
function startWorker(): ChildProcess {
  const child = spawn('npm', ['run', 'worker'], {
    env: { ...process.env, PROCESS_ROLES: 'worker' },
    shell: true,
    stdio: ['ignore', 'inherit', 'inherit'],
  })
  return child
}

/**
 * Kills the worker AND ITS CHILDREN.
 *
 * 🔴 `child.kill()` DOES NOT DO THIS, and the first version of this script
 * leaked two worker trees that ran for EIGHT AND A HALF HOURS before anybody
 * looked. `shell: true` puts a shell between us and the process, and
 * `npm run worker` puts npm and tsx between the shell and node — so the signal
 * reached the wrapper and the actual worker never heard it.
 *
 * That was not a tidy-up problem. Each orphan ran the relay every second and
 * the dispatch tick every minute, and until 0057 that tick called
 * `security.harden()` — so two stray processes were taking ACCESS EXCLUSIVE on
 * every table in the schema, once a minute each, for most of a day. A harness
 * that leaves that behind is measuring a machine it is also degrading.
 *
 * `taskkill /T` walks the tree on Windows; a negative pid signals the process
 * group everywhere else.
 */
function killTree(child: ChildProcess): void {
  const pid = child.pid
  if (pid === undefined) return

  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', shell: true })
  } else {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      child.kill('SIGKILL')
    }
  }
}

async function main(): Promise<void> {
  console.log('Gate 5 (c) — the same suite, both topologies, compared test by test.')

  const folded = await run('folded')

  // The worker starts BEFORE the split run and outlives it. In a split
  // deployment the worker is a long-lived process that the web tier knows
  // nothing about, and starting it per-test would be a different topology
  // wearing this one's name.
  const worker = startWorker()
  await new Promise((r) => setTimeout(r, 5_000))

  let split: Map<string, string>
  try {
    split = await run('split')
  } finally {
    killTree(worker)
    if (existsSync(REPORT)) rmSync(REPORT)
  }

  console.log('\n=== EQUIVALENCE ===')
  console.log(`  folded  ${folded.size} tests`)
  console.log(`  split   ${split.size} tests`)

  const differences: string[] = []

  for (const [title, status] of folded) {
    const other = split.get(title)
    if (other === undefined) differences.push(`only under FOLDED: ${title}`)
    else if (other !== status) differences.push(`${title}: folded=${status} split=${other}`)
  }
  for (const title of split.keys()) {
    if (!folded.has(title)) differences.push(`only under SPLIT: ${title}`)
  }

  const failed = [...folded.values(), ...split.values()].filter(
    (s) => s !== 'expected' && s !== 'skipped',
  ).length

  if (folded.size === 0) {
    console.error('\n🔴 the folded run reported no tests. The harness is wrong, not the tree.')
    process.exit(1)
  }

  if (differences.length > 0) {
    console.error(`\n🔴 ${differences.length} BEHAVIOURAL DIFFERENCES:`)
    for (const line of differences) console.error(`  ${line}`)
    console.error(
      '\n§2543: if any behaviour differs between topologies, the split is not ' +
        'configuration and the cheap tier is a trap.',
    )
    process.exit(1)
  }

  if (failed > 0) {
    console.error(`\n🔴 the suites agree with each other and ${failed} tests FAILED in both.`)
    process.exit(1)
  }

  console.log('  identical: same tests, same outcomes, in both topologies.')
  console.log(
    '\n⚠️ Two processes on one machine. This exercises the ROLE boundary and ' +
      'not two containers, two contended event loops, or a network between them.',
  )
  process.exit(0)
}

void main()
