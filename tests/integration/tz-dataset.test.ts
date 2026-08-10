import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * The ZIP timezone dataset is empty on purpose, and this keeps that a DECLARED
 * fact rather than an accident nobody noticed.
 *
 * An empty `ref.zip_timezone` looks exactly like one whose seed failed. In both
 * cases the resolver degrades quietly to the area code and then to the state,
 * every lead gets a coarser answer, and nothing anywhere goes red — which is
 * this project's most-feared shape, and the same one the loader whitelist and
 * the perf-budget checker were both written to close.
 *
 * ASKED STATICALLY, of the migration files, and that is deliberate. The runtime
 * table is not the right witness: `calling-window.test.ts` inserts one ZIP row
 * as a fixture, and `crm_test` is shared across files, so a live-table version
 * of this question would answer differently depending on which test ran first.
 * The register records that lesson three times already.
 */

const MIGRATIONS = 'app/db/migrations'

/** Every migration's SQL, oldest first. */
const sql = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => ({ file: f, body: readFileSync(join(MIGRATIONS, f), 'utf8') }))

/** The declared value of `system_constant['tz_dataset_version']`, last write wins. */
function declaredVersion(): string | null {
  let value: string | null = null
  for (const { body } of sql) {
    const match = /\(\s*'tz_dataset_version'\s*,\s*'([^']*)'/.exec(body)
    if (match?.[1] !== undefined) value = match[1]
  }
  return value
}

/** Whether any migration actually seeds rows into the ZIP table. */
function seedsZipTable(): boolean {
  return sql.some(({ body }) => /INSERT\s+INTO\s+ref\.zip_timezone/i.test(body))
}

describe('the ZIP dataset and the constant that describes it cannot disagree', () => {
  it('declares a version at all', () => {
    expect(
      declaredVersion(),
      'no migration writes system_constant.tz_dataset_version',
    ).not.toBeNull()
  })

  it('says `absent` exactly while no migration seeds the table', () => {
    // BOTH DIRECTIONS, which is the whole point. Seeding the dataset without
    // updating the constant is a red build; claiming a version while the table
    // is still empty is the same build, red for the opposite reason.
    const seeded = seedsZipTable()
    const version = declaredVersion()

    if (seeded) {
      expect(version, 'the ZIP table is seeded but the constant still says absent').not.toBe(
        'absent',
      )
    } else {
      expect(version, 'the ZIP table is empty but the constant claims a version').toBe('absent')
    }
  })

  it('carries a reason somebody can act on', () => {
    const row = sql.find(({ body }) => body.includes("'tz_dataset_version'"))
    expect(row).toBeDefined()
    // The reason has to name what unblocks it, not merely that it is blocked.
    expect(row?.body).toMatch(/Census|ZCTA/)
    expect(row?.body).toMatch(/checksum/i)
  })

  it('is reading migrations at all', () => {
    // The mutation guard: a scan over an empty list passes forever.
    expect(sql.length).toBeGreaterThan(30)
  })
})
