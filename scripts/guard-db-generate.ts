import { existsSync, readFileSync, readdirSync } from 'node:fs'

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

main()
