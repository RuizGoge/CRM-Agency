import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

/**
 * `npm run db:generate` refuses while the Drizzle snapshot chain is behind.
 *
 * THE TRAP THIS DISARMS. drizzle-kit generates a migration by diffing the schema
 * files against the NEWEST SNAPSHOT it has. Migrations 0019 onward were written
 * by hand — they are functions, triggers, policies and grants, none of which
 * Drizzle can express — and two of them also altered tables: 0019 added
 * constraints to `earnings_ledger` and 0020 added `claimed_at` to
 * `scheduled_job`. No snapshot recorded either.
 *
 * So the newest snapshot describes a database four migrations in the past.
 * Running `db:generate` today would diff against that stale picture and emit a
 * migration that re-adds what already exists, or drops what it cannot see a
 * reason for — against a database whose rule is that there are no down
 * migrations and rollback is the previous image.
 *
 * Nothing was wrong today only because nobody had run it. That is the definition
 * of a loaded trap, so it becomes a refusal with instructions instead: the same
 * posture as BOOT002 and JOBS002. A deploy that will not come up is a symptom;
 * a generated migration nobody reads is not.
 */

const JOURNAL = 'app/db/migrations/meta/_journal.json'
const META_DIR = 'app/db/migrations/meta'

interface Journal {
  readonly entries: readonly { readonly idx: number; readonly tag: string }[]
}

function main(): void {
  if (!existsSync(JOURNAL)) {
    console.error('DBGEN001: no migration journal. This is not a Drizzle project layout.')
    process.exit(1)
  }

  const journal = JSON.parse(readFileSync(JOURNAL, 'utf8')) as Journal
  const latestEntry = journal.entries.at(-1)
  if (!latestEntry) {
    // An empty journal is the legitimate first-run case.
    process.exit(0)
  }

  const snapshots = readdirSync(META_DIR)
    .filter((f) => /^\d{4}_snapshot\.json$/.test(f))
    .map((f) => Number.parseInt(f.slice(0, 4), 10))
    .sort((a, b) => a - b)

  const latestSnapshot = snapshots.at(-1)
  if (latestSnapshot === undefined) {
    console.error('DBGEN002: the journal has entries and there are no snapshots at all.')
    process.exit(1)
  }

  refuseIfIndexTaken(latestEntry.idx + 1)

  if (latestSnapshot >= latestEntry.idx) {
    process.exit(0)
  }

  const behind = latestEntry.idx - latestSnapshot
  const handWritten = journal.entries
    .filter((e) => e.idx > latestSnapshot)
    .map((e) => `    ${String(e.idx).padStart(4, '0')}  ${e.tag}`)
    .join('\n')

  console.error(
    `DBGEN003: refusing to generate. The snapshot chain is ${behind} migration(s) behind.\n\n` +
      `  newest snapshot : ${String(latestSnapshot).padStart(4, '0')}_snapshot.json\n` +
      `  newest migration: ${String(latestEntry.idx).padStart(4, '0')}_${latestEntry.tag}\n\n` +
      `  Written by hand since the last snapshot:\n${handWritten}\n\n` +
      `drizzle-kit diffs the schema files against the NEWEST SNAPSHOT, so it would\n` +
      `compare against a database ${behind} migration(s) in the past — and emit a migration\n` +
      `that re-adds objects that already exist or drops ones it cannot account for.\n` +
      `A hand-written migration changed a table and left no snapshot behind. This\n` +
      `project has no down migrations: rollback is the previous image, so a bad\n` +
      `generated migration is not something to undo.\n\n` +
      `Two honest ways forward:\n\n` +
      `  1. Keep writing SQL by hand, which is what 0019 to 0025 did.\n` +
      `     Add the file and its journal entry yourself. Nothing here blocks that —\n` +
      `     this guard only stops the GENERATOR.\n\n` +
      `  2. Reconcile the chain first, deliberately: bring the schema files and the\n` +
      `     snapshots back into agreement in one reviewed step, then generate.\n\n` +
      `Nothing was broken today only because nobody had run this command. Migration\n` +
      `0026 is what a reconciliation looks like: no SQL, one snapshot.`,
  )
  process.exit(1)
}

/** Migration indices already used by a sibling worktree or another branch. */
function indicesElsewhere(): Map<number, string[]> {
  const taken = new Map<number, string[]>()
  const note = (idx: number, where: string): void => {
    taken.set(idx, [...(taken.get(idx) ?? []), where])
  }
  const indexOf = (name: string): number | null => {
    const m = /^(\d{4})_.*\.sql$/.exec(name)
    return m?.[1] === undefined ? null : Number.parseInt(m[1], 10)
  }

  // (a) SIBLING WORKTREES — uncommitted work, which no git command can see.
  const here = resolve(process.cwd())
  if (basename(dirname(here)) === 'worktrees') {
    for (const sibling of readdirSync(dirname(here))) {
      if (sibling === basename(here)) continue
      const dir = join(dirname(here), sibling, 'app', 'db', 'migrations')
      if (!existsSync(dir)) continue
      for (const f of readdirSync(dir)) {
        const idx = indexOf(f)
        if (idx !== null) note(idx, `worktree ${sibling}`)
      }
    }
  }

  // (b) EVERY BRANCH — committed but unmerged work.
  try {
    const branches = execFileSync('git', ['branch', '--format=%(refname:short)'], {
      encoding: 'utf8',
    })
      .split('\n')
      .map((b) => b.trim())
      .filter(Boolean)
    const current = execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim()

    for (const branch of branches) {
      if (branch === current) continue
      const listing = execFileSync(
        'git',
        ['ls-tree', '--name-only', branch, 'app/db/migrations/'],
        {
          encoding: 'utf8',
        },
      )
      for (const path of listing.split('\n')) {
        const idx = indexOf(basename(path.trim()))
        if (idx !== null) note(idx, `branch ${branch}`)
      }
    }
  } catch {
    // No git, or a repository shape this cannot read. The worktree half still
    // ran; a guard that cannot see everything is better than one that refuses
    // to run at all.
  }

  return taken
}

function refuseIfIndexTaken(next: number): void {
  const taken = indicesElsewhere()
  const clash = taken.get(next)
  if (clash === undefined) return

  let free = next
  while (taken.has(free)) free += 1

  const pad = (n: number): string => String(n).padStart(4, '0')
  const lines = [
    `DBGEN004: refusing to generate. Migration ${pad(next)} is already used.`,
    '',
    ...clash.map((w) => `    ${pad(next)}  ${w}`),
    '',
    'A worktree isolates FILES and not the repository, so this tree reads its own',
    'newest migration and cannot know another session already claimed the next',
    'number. Three sessions did exactly that and each wrote an 0035; the collision',
    'only surfaced when all three were applied to the one shared development',
    'database, where harden() raised HR002 for a policy class the other branch had',
    'never taught it — and drizzle-kit swallowed even that.',
    '',
    'Migrations are never renumbered after merge and there are no down migrations,',
    'so this is cheap to fix now and expensive to fix later.',
    '',
    `  The first free index is ${pad(free)}.`,
    '',
    "Bump this branch's next migration to it, or agree a range with the other",
    'session before generating.',
  ]
  console.error(lines.join('\n'))
  process.exit(1)
}

main()
