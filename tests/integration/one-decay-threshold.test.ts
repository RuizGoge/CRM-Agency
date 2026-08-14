import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { TEST_URL } from './setup/urls'

/**
 * CI check **R2-6**, which `04b` §9 declares and nothing ran: *"any string,
 * setting or code path that references a `rot_threshold`"* fails the build.
 *
 * It was not hypothetical. `app.tenant` shipped in migration 0001 with
 * `rotting_threshold_days` (default 7), `cold_threshold_days` (default 14) and
 * a CHECK forcing the first below the second — the pre-R6 two-tier decay,
 * encoded exactly, in the database, for seventeen migrations. Ruling **R1.7**
 * is rank 1 and one sentence long: *"One threshold: `cold_threshold_days`,
 * default 7, configurable. There is no separate 'rot' threshold."*
 *
 * Nothing read the column, so nothing could notice. It surfaced only when the
 * health rail needed the number — and the two defects it would have shipped
 * are both silent: the going-cold signal firing a week late, and red keeping a
 * second meaning on a card face where red means "you may not contact this
 * person".
 *
 * Asserted in the ENGINE and in the TREE, because the defect lived in one and
 * the ban is written about the other.
 */

let sql: postgres.Sql

/** Every source file that could carry a threshold, excluding this test. */
function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.git' || entry.startsWith('.')) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) sourceFiles(full, acc)
    else if (/\.(ts|tsx|sql|json|css)$/.test(entry)) acc.push(full)
  }
  return acc
}

beforeAll(() => {
  sql = postgres(TEST_URL, { max: 1, onnotice: () => {} })
})

afterAll(async () => {
  await sql?.end()
})

describe('there is one decay threshold and it is cold_threshold_days', () => {
  it('carries no rot threshold column on any table', async () => {
    const columns = await sql<{ table_name: string; column_name: string }[]>`
      SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema IN ('app', 'ref')
         AND (column_name ILIKE '%rot%threshold%' OR column_name ILIKE '%rotting%')`

    expect(columns).toEqual([])
  })

  it('carries no constraint that orders two decay thresholds', async () => {
    // `tenant_rotting_before_cold` did not merely name the deleted design — it
    // ENFORCED it, so a tenant could not have been configured out of the two
    // tiers even by hand.
    //
    // ⚠️ THE PATTERN WAS `'%rot%'` AND CAUGHT THE WRONG WORD. Migration 0076's
    // `protected_object` constraints contain "p-ROT-ected", so this went red on
    // a change that has nothing to do with decay tiers. Narrowed to the two
    // shapes the sibling assertion above already uses, which still match
    // `tenant_rotting_before_cold` exactly — the guard is unchanged, its aim is.
    const constraints = await sql<{ conname: string }[]>`
      SELECT conname FROM pg_constraint
       WHERE conname ILIKE '%rotting%' OR conname ILIKE '%rot%threshold%'`

    expect(constraints).toEqual([])
  })

  it('defaults the one threshold to the ruled number', async () => {
    // R1.7 says 7. The column shipped at 14, which is the struck red tier
    // wearing the surviving column's name — the worst of the two possible
    // wrong values, because it looks like a threshold rather than a leftover.
    const [row] = await sql<{ default_value: string | null }[]>`
      SELECT column_default AS default_value FROM information_schema.columns
       WHERE table_schema = 'app' AND table_name = 'tenant'
         AND column_name = 'cold_threshold_days'`

    expect(row?.default_value).toBe('7')
  })

  it('leaves no tenant sitting on the struck 14-day tier', async () => {
    const rows = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM app.tenant WHERE cold_threshold_days = 14`

    expect(rows[0]?.n).toBe('0')
  })

  it('names no rot threshold anywhere a builder would read', () => {
    // THE ASSERTION R2-6 ASKS FOR, and the reason it is a grep rather than a
    // type: the banned thing is a CONCEPT, and a concept comes back as a
    // variable name long before it comes back as a column.
    //
    // Migration 0001 and its snapshots are exempt: migrations are never edited
    // after merge and there are no down migrations, so the history keeps the
    // word and 0025 is what removes the object.
    const offenders = sourceFiles('app')
      .concat(sourceFiles('scripts'))
      .filter((f) => !f.includes('migrations'))
      .filter((f) =>
        /rot_threshold|rottingThreshold|rotting_threshold/i.test(readFileSync(f, 'utf8')),
      )

    expect(offenders, `${offenders.join(', ')} still names a rot threshold`).toEqual([])
  })

  it('never renders the banned word on a card face', () => {
    // Ruling R11, and it is not squeamishness: `Rotting` is the one string in
    // the product an owner asks to soften, and it editorialises about the
    // seller rather than describing the lead. `Going cold` says the same thing.
    const offenders = sourceFiles('app')
      .filter((f) => !f.includes('migrations'))
      .filter((f) => /\bRotting\b/.test(readFileSync(f, 'utf8')))

    expect(offenders, `${offenders.join(', ')} renders the banned word`).toEqual([])
  })
})
