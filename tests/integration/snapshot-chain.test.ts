import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * The Drizzle snapshot chain, kept level with the migrations.
 *
 * 🔴 WHY THIS IS A TEST AND NOT A HABIT. `drizzle-kit generate` diffs the
 * schema files against the NEWEST SNAPSHOT — never against the database. From
 * 0019 to 0025 the snapshots stopped being written while several migrations
 * changed things Drizzle models, so the generator's picture of the database
 * was five objects out of date and every diff it produced would have been the
 * catch-up: `CREATE TYPE` for a type that exists, `ADD COLUMN` for a column
 * that exists. A migration that fails on its first statement, on a database
 * with no down migrations.
 *
 * The quieter exposure is the one the last assertion here covers. A relation
 * Postgres has and the schema files do not is a relation outside the
 * generator's management entirely — invisible to the diff rather than
 * endangered by it, and coordinated with nothing. `ref.timing_constant`, which
 * holds the undo window in SQL, had been in exactly that state since migration
 * 0009 and was found by writing this test.
 *
 * `DBGEN003` blocks the GENERATOR while the chain is behind, which is what
 * kept this a debt rather than a broken deploy. This asserts the debt stays
 * paid — a guard that only refuses is a guard somebody eventually silences,
 * and the useful state is the chain being level, not the command blocked.
 */

const MIGRATIONS = 'app/db/migrations'
const META = join(MIGRATIONS, 'meta')

function newest(pattern: RegExp, dir: string): string {
  const found = readdirSync(dir)
    .filter((f) => pattern.test(f))
    .sort()
  const last = found[found.length - 1]
  if (last === undefined) throw new Error(`nothing matching ${String(pattern)} in ${dir}`)
  return last
}

describe('the snapshot chain is level with the migrations', () => {
  it('has a snapshot at least as new as the newest migration', () => {
    // THE ASSERTION THIS FILE EXISTS FOR. Both are zero-padded and sorted as
    // text, so "0026" beats "0018" and the comparison is the ordering the
    // journal itself uses.
    const migration = newest(/^\d{4}_.*\.sql$/, MIGRATIONS).slice(0, 4)
    const snapshot = newest(/^\d{4}_snapshot\.json$/, META).slice(0, 4)

    expect(
      Number(snapshot),
      `snapshot ${snapshot} is behind migration ${migration}; run the generator and ` +
        `reconcile before the next schema change`,
    ).toBeGreaterThanOrEqual(Number(migration))
  })

  it('journals every migration file, and only files that exist', () => {
    // A journal entry without a file is a migration the deploy cannot apply;
    // a file without an entry is one it will silently skip.
    const journal = JSON.parse(readFileSync(join(META, '_journal.json'), 'utf8')) as {
      entries: readonly { tag: string }[]
    }
    const onDisk = readdirSync(MIGRATIONS)
      .filter((f) => /^\d{4}_.*\.sql$/.test(f))
      .map((f) => f.replace(/\.sql$/, ''))
      .sort()

    expect(journal.entries.map((e) => e.tag).sort()).toEqual(onDisk)
  })

  it('declares every table the migrations create', () => {
    // READ FROM THE MIGRATION FILES, not from a live database, and that is a
    // correction rather than a shortcut. The first version queried
    // `information_schema` and passed alone while failing in the suite:
    // `silo.test.ts` CREATES tables on purpose, to prove `harden()` refuses an
    // unclassified one, and `crm_test` is shared across files. So the answer
    // depended on which file vitest happened to run first — the same
    // shared-state signature this project has now paid for three times.
    //
    // The question is static anyway. "Does every table a migration creates have
    // a declaration" is answerable from the tree: no database, no ordering, no
    // cleanup, and it cannot go green because something else dropped a table.
    //
    // `security` never appears here: migration 0000 owns it and Drizzle
    // deliberately does not — it holds `harden()` and the RLS registry, and
    // `crm_app` has no grants on it at all.
    const declared = readdirSync('app/db/schema')
      .filter((f) => f.endsWith('.ts') && !f.startsWith('_'))
      .map((f) => readFileSync(join('app/db/schema', f), 'utf8'))
      .join('\n')

    const created = new Set<string>()
    for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql'))) {
      const statements = readFileSync(join(MIGRATIONS, file), 'utf8')
      for (const match of statements.matchAll(
        /CREATE TABLE (?:IF NOT EXISTS )?"?(?:app|ref)"?\."?([a-z_]+)"?/gi,
      )) {
        const table = match[1]
        if (table !== undefined) created.add(table)
      }
    }

    // An empty list is the cheapest way to make a grep gate green.
    expect(created.size, 'no CREATE TABLE parsed — the regex broke, not the tree').toBeGreaterThan(
      10,
    )

    const undeclared = [...created].filter((name) => !declared.includes(`'${name}'`)).sort()

    expect(
      undeclared,
      `${undeclared.join(', ')} are created by a migration and declared in no schema ` +
        `file, so the generator has no picture of them`,
    ).toEqual([])
  })

  it('declares every index the migrations create', () => {
    // 🔴 ADDED BECAUSE THE TABLE CHECK WAS NOT ENOUGH, proven by the very next
    // migration. `contact_name_trgm_idx` has existed since 0011 — hand-written,
    // `IF NOT EXISTS`, never in a snapshot — so the generator had no picture of
    // it and cheerfully proposed creating it a second time. The migration
    // applied against a fresh database, hit "already exists", and rolled the
    // WHOLE CHAIN back, because drizzle's migrator is one transaction.
    //
    // That is the same class of gap as the missing tables, one level down, and
    // it cost more: a table nobody declared is merely unmanaged, while an index
    // nobody declared is a migration that cannot be applied to a new database
    // at all.
    const declared = readdirSync('app/db/schema')
      .filter((f) => f.endsWith('.ts') && !f.startsWith('_'))
      .map((f) => readFileSync(join('app/db/schema', f), 'utf8'))
      .join('\n')

    const created = new Set<string>()
    for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql'))) {
      const statements = readFileSync(join(MIGRATIONS, file), 'utf8')
      // ⚠️ `\s+ON\s` IS LOad-BEARING, and without it this gate reports an index
      // called "IF". A dynamically created index reads
      // `CREATE UNIQUE INDEX IF NOT EXISTS %I ON app.%I (...)` inside a
      // format() string; `%` is not in the name class, so the engine backtracks
      // past the optional `IF NOT EXISTS ` and captures `IF` as the name.
      //
      // Requiring the name to be followed by ON rejects that and — the point —
      // skips the dynamic form entirely, which is the SAME treatment the table
      // check above already gives a `format()` partition and for the same
      // reason: an index created alongside a partition is storage for a
      // declared parent, not something anybody models in Drizzle. Every
      // literal CREATE INDEX still parses, which is what this gate is for.
      for (const match of statements.matchAll(
        /CREATE (?:UNIQUE )?INDEX (?:CONCURRENTLY )?(?:IF NOT EXISTS )?"?([a-z0-9_]+)"?\s+ON\s/gi,
      )) {
        const index = match[1]
        if (index !== undefined) created.add(index)
      }
    }

    expect(created.size, 'no CREATE INDEX parsed — the regex broke, not the tree').toBeGreaterThan(
      5,
    )

    const undeclared = [...created].filter((name) => !declared.includes(`'${name}'`)).sort()

    expect(
      undeclared,
      `${undeclared.join(', ')} are created by a migration and declared in no schema file. ` +
        `The generator will propose creating them again, and the second CREATE fails on a ` +
        `fresh database — rolling back every migration with it.`,
    ).toEqual([])
  })
})
