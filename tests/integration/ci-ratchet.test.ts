import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { OWNER_URL } from './setup/urls'

/**
 * `ref.ci_ratchet` — the half of Gate 11 that lives outside the working tree.
 *
 * `perf-budgets.json` already turns the build red, which is a real mechanism.
 * What it is not is unwalkable: loosening a number there is a file edit, and
 * `CLAUDE.md`'s founding rule names the actor to design against as "Claude
 * writes it and nobody reads the diff". This suite is the proof that the engine
 * now refuses, because a ratchet that has never been seen to refuse is a table.
 *
 * Every arm is tested from BOTH sides. An arm that always raises would pass a
 * naive test and get deleted the first time it blocked something legitimate; an
 * arm that never raises passes the same naive test forever.
 *
 * Runs as the OWNER — the credential that can weaken things — on purpose. The
 * guarantee being asserted is that the trigger binds even the migrator, so
 * testing it as a restricted role would prove nothing about the case that
 * matters.
 */

let sql: postgres.Sql

const NAMES = {
  down: 'test.ratchet_down',
  up: 'test.ratchet_up',
  pinned: 'test.ratchet_pinned',
  shrink: 'test.ratchet_shrink',
  sealed: 'test.ratchet_sealed',
} as const

const RATIONALE =
  'Fixture for the ratchet suite, long enough to satisfy the registered rationale check.'

beforeAll(async () => {
  sql = postgres(OWNER_URL, { max: 1, onnotice: () => {} })

  await sql`
    INSERT INTO ref.ci_ratchet_name (name, direction, registered_in_migration, rationale)
    VALUES
      (${NAMES.down},   'monotonic_down', 'test', ${RATIONALE}),
      (${NAMES.up},     'monotonic_up',   'test', ${RATIONALE}),
      (${NAMES.pinned}, 'pinned',         'test', ${RATIONALE}),
      (${NAMES.shrink}, 'shrink_only',    'test', ${RATIONALE}),
      (${NAMES.sealed}, 'sealed_set',     'test', ${RATIONALE})`
})

afterAll(async () => {
  if (!sql) return
  // Deleting the fixture rows needs the immutability trigger out of the way for
  // exactly these names, which is itself the proof that it binds the owner: an
  // ordinary DELETE here raises AP001. The trigger is dropped and re-created
  // rather than weakened, and only for the duration of the cleanup.
  await sql`ALTER TABLE ref.ci_ratchet DISABLE TRIGGER t_immutable_ci_ratchet`
  await sql`ALTER TABLE ref.ci_ratchet_name DISABLE TRIGGER t_immutable_ci_ratchet_name`
  await sql`DELETE FROM ref.ci_ratchet WHERE name LIKE 'test.%'`
  await sql`DELETE FROM ref.ci_ratchet_name WHERE name LIKE 'test.%'`
  await sql`ALTER TABLE ref.ci_ratchet ENABLE TRIGGER t_immutable_ci_ratchet`
  await sql`ALTER TABLE ref.ci_ratchet_name ENABLE TRIGGER t_immutable_ci_ratchet_name`
  await sql.end()
})

const num = (name: string, value: number): Promise<unknown> =>
  sql`INSERT INTO ref.ci_ratchet (name, value_num, set_by_run) VALUES (${name}, ${value}, 'suite')`

const set = (name: string, value: string[]): Promise<unknown> =>
  sql`INSERT INTO ref.ci_ratchet (name, value_set, set_by_run) VALUES (${name}, ${value}, 'suite')`

describe('a numeric budget only moves in its declared direction', () => {
  it('accepts a tightening and refuses the loosening, naming both numbers', async () => {
    await num(NAMES.down, 1000)
    await expect(num(NAMES.down, 900)).resolves.toBeDefined()

    // The message is the product here: a red build has to say what was refused,
    // not merely that something was.
    await expect(num(NAMES.down, 1200)).rejects.toThrow(/AP002.*loosened from 900 to 1200/s)
  })

  it('refuses a loosening that follows a restatement', async () => {
    await num(NAMES.down, 900)
    await expect(num(NAMES.down, 950)).rejects.toThrow(/AP002/)
  })

  // NOT ASSERTED, and stated rather than left implied: this suite cannot tell
  // `min(value_num)` apart from "the latest row". Mutating the trigger to the
  // latter left all fifteen tests green, and the reason is that under
  // monotonic_down the two are the same number by induction — every accepted
  // insert is <= the running minimum, so the latest row IS the minimum. The
  // aggregate is defensive, not load-bearing, and it only differs if a row ever
  // lands without the trigger. A test named for that distinction would be
  // asserting a property the rule makes unreachable.

  it('refuses the inverse direction for monotonic_up', async () => {
    await num(NAMES.up, 100)
    await expect(num(NAMES.up, 150)).resolves.toBeDefined()
    await expect(num(NAMES.up, 120)).rejects.toThrow(/AP003/)
  })

  it('lets a pinned value be restated and nothing else', async () => {
    await num(NAMES.pinned, 120)
    await expect(num(NAMES.pinned, 120)).resolves.toBeDefined()
    await expect(num(NAMES.pinned, 108)).rejects.toThrow(/AP004.*pinned at 120/s)
  })
})

describe('a set budget only moves in its declared direction', () => {
  it('lets a shrink_only list lose entries and refuses a new one', async () => {
    await set(NAMES.shrink, ['a', 'b', 'c'])
    await expect(set(NAMES.shrink, ['a', 'b'])).resolves.toBeDefined()

    // Adding to an exception list IS the loosening. This is the arm the errata
    // corrected: `frozen_set` permitted exactly this.
    await expect(set(NAMES.shrink, ['a', 'b', 'z'])).rejects.toThrow(/AP005/)
  })

  it('refuses both arms of a sealed set', async () => {
    await set(NAMES.sealed, ['x', 'y'])
    // Restating it is fine; order is not part of the value.
    await expect(set(NAMES.sealed, ['y', 'x'])).resolves.toBeDefined()
    await expect(set(NAMES.sealed, ['x', 'y', 'z'])).rejects.toThrow(/AP006/)
    await expect(set(NAMES.sealed, ['x'])).rejects.toThrow(/AP006/)
  })
})

describe('there is no default direction, and no ambiguous row', () => {
  it('refuses a value for a name that was never registered', async () => {
    // The foreign key catches this first, which is the point: a new list cannot
    // inherit an arm because there is no arm to inherit.
    await expect(num('test.never_registered', 5)).rejects.toThrow()
  })

  it('refuses a numeric value on a set ratchet and the reverse', async () => {
    await expect(set(NAMES.down, ['nope'])).rejects.toThrow(/AP008/)
    await expect(num(NAMES.shrink, 1)).rejects.toThrow(/AP008/)
  })

  it('refuses a row carrying both shapes', async () => {
    // The CHECK, because the trigger is happy: value_num is present and the arm
    // is numeric, so nothing about the ratchet is violated — only the row's
    // shape is, and a row whose arm is ambiguous is a row the trigger would have
    // to guess about.
    await expect(
      sql`INSERT INTO ref.ci_ratchet (name, value_num, value_set, set_by_run)
          VALUES (${NAMES.down}, 1, ARRAY['a'], 'suite')`,
    ).rejects.toThrow(/ci_ratchet_one_shape/)
  })

  it('refuses a row carrying neither shape', async () => {
    // AP008 rather than the CHECK, and that ordering is worth knowing: a BEFORE
    // INSERT trigger runs before table CHECK constraints, so the trigger's
    // message is the one a person sees. Both refuse; only one gets to explain.
    await expect(
      sql`INSERT INTO ref.ci_ratchet (name, set_by_run) VALUES (${NAMES.down}, 'suite')`,
    ).rejects.toThrow(/AP008/)
  })
})

describe('the record and the arms are immutable, to the owner as well', () => {
  it('refuses UPDATE and DELETE on the value ledger', async () => {
    await expect(
      sql`UPDATE ref.ci_ratchet SET value_num = 1 WHERE name = ${NAMES.down}`,
    ).rejects.toThrow(/AP001/)

    // `WHERE false` matters: a row-level trigger never fires when nothing
    // matches, so the statement would succeed silently. This is the statement
    // level one.
    await expect(sql`DELETE FROM ref.ci_ratchet WHERE false`).rejects.toThrow(/AP001/)
  })

  it('refuses to reclassify an arm by editing its row', async () => {
    // The whole reason the direction was lifted out of the value table: an arm
    // chosen by whoever writes the newest row is chosen by whoever is attacking
    // it. Flipping one now requires dropping a protected trigger.
    await expect(
      sql`UPDATE ref.ci_ratchet_name SET direction = 'monotonic_up'
          WHERE name = ${NAMES.down}`,
    ).rejects.toThrow(/AP001/)
  })

  it('refuses TRUNCATE, which bypasses row triggers and the DELETE privilege', async () => {
    await expect(sql`TRUNCATE ref.ci_ratchet`).rejects.toThrow(/AP001/)
  })
})

describe('the budgets this project actually ships are registered', () => {
  it('has an arm for every performance budget, and P20 has no value yet', async () => {
    const arms = await sql<{ name: string; direction: string }[]>`
      SELECT name, direction::text AS direction FROM ref.ci_ratchet_name
      WHERE name LIKE 'perf.%' ORDER BY name`

    // The exact list, so registering a budget is a decision somebody made
    // rather than a name that appeared. This assertion going red on a new arm
    // is the mechanism working — it went red for N13, which is how the search
    // budget got read by a person before it counted as shipped.
    expect(arms.map((a) => a.name)).toEqual([
      'perf.N13_search_server_p95',
      'perf.P12_initial_js_gzip',
      'perf.P13_initial_css_gzip',
      'perf.P20_mobile_tti_pipeline',
      'perf.P6_drag_frames',
    ])
    for (const arm of arms) expect(arm.direction).toBe('monotonic_down')

    // 🔴 THIS ASSERTION USED TO READ `expect(p20?.n).toBe('0')`, and changing it
    // is the point rather than a chore. E6 made P20 a DECLARED hole — the name
    // registered, the value absent — and this line was what kept the hole
    // visible: it would have gone red the moment somebody wrote a number
    // without meaning to. Migration 0028 measured it at 2251 ms and registered
    // 2300, so the hole closed in a diff. A hole that closes because nobody
    // noticed it was open is the failure this arrangement exists to prevent,
    // in either direction.
    const [p20] = await sql<{ n: string; latest: string | null }[]>`
      SELECT count(*)::text AS n,
             (SELECT value_num::text FROM ref.ci_ratchet
               WHERE name = 'perf.P20_mobile_tti_pipeline'
               ORDER BY set_at DESC LIMIT 1) AS latest
        FROM ref.ci_ratchet WHERE name = 'perf.P20_mobile_tti_pipeline'`
    expect(Number(p20?.n ?? '0')).toBeGreaterThan(0)
    expect(p20?.latest).toBe('2300')
  })

  it('refuses to loosen the measured TTI budget', async () => {
    // The walk this arm exists to stop, on the budget most likely to invite it:
    // P20 is MACHINE-DEPENDENT, so a slower runner measures a larger number and
    // the tempting fix is to write the larger number down. It is not available.
    await expect(
      sql`INSERT INTO ref.ci_ratchet (name, value_num, set_by_run)
          VALUES ('perf.P20_mobile_tti_pipeline', 4000, 'suite')`,
    ).rejects.toThrow(/AP002.*2300 to 4000/s)
  })

  it('refuses to loosen the shipped bundle budget', async () => {
    // The exact walk this table exists to stop: the measured budget is 128000,
    // and something wants it to be 400000 so a build goes green.
    await expect(
      sql`INSERT INTO ref.ci_ratchet (name, value_num, set_by_run)
          VALUES ('perf.P12_initial_js_gzip', 400000, 'suite')`,
    ).rejects.toThrow(/AP002.*128000 to 400000/s)
  })
})
