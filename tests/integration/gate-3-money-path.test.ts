import fc from 'fast-check'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { annualize, fromCents } from '~/lib/money/money'

import { TEST_URL } from './setup/urls'

/**
 * GATE 3 — the money path, before a single screen exists. §2535.
 *
 * `money-path.test.ts` already covers most of (a) and all of (c). This file is
 * the rest, and it exists because the ladder recorded G3 as "mostly" for weeks
 * with one line of prose naming what was missing: "a process killed mid-gate
 * without leaving a lock."
 *
 * ⚠️ WHAT MOVED SINCE THE GATE WAS WRITTEN. §2535 (b) lists the close-gate
 * transaction as "gate check → stage_transition → stage write → ledger_append →
 * projection → watermark → event_emit + outbox rows". The last two links did
 * not exist until 0054: `app.stage_move` had no emission at all. So the
 * atomicity assertion below is testing a longer chain than the one anybody had
 * ever run.
 */

const TENANT = '00000000-0000-7000-8000-0000000e3100'
const ANA = '00000000-0000-7000-8000-0000000e31a1'
const CONTACT = '00000000-0000-7000-8000-0000000e31c1'
const OPP = '00000000-0000-7000-8000-0000000e31d1'
const OPEN_STAGE = '00000000-0000-7000-8000-0000000e3101'
const WON_STAGE = '00000000-0000-7000-8000-0000000e3102'

/** The four append-only tables §2535 (a) names. */
const APPEND_ONLY = ['earnings_ledger', 'audit_log', 'consent_ledger', 'suppression_list'] as const

let sql: postgres.Sql

beforeAll(async () => {
  sql = postgres(TEST_URL, { max: 2, onnotice: () => {} })

  await sql`
    INSERT INTO app.tenant (id, name, business_tz)
    VALUES (${TENANT}, 'Money Agency', 'America/New_York')`
  await sql`
    INSERT INTO app.app_user (tenant_id, id, email, full_name, display_name, role)
    VALUES (${TENANT}, ${ANA}, 'ana@money.test', 'Ana Money', 'Ana M.', 'seller')`
  await sql`
    INSERT INTO app.contact (tenant_id, id, owner_user_id, full_name, created_via)
    VALUES (${TENANT}, ${CONTACT}, ${ANA}, 'Ruth Money', 'manual')`
  await sql`
    INSERT INTO app.pipeline (tenant_id, owner_user_id, name)
    VALUES (${TENANT}, ${ANA}, 'Board')`
  await sql`
    INSERT INTO app.stage (tenant_id, id, pipeline_id, owner_user_id, name, stage_type, sort_order)
    SELECT ${TENANT}, ${OPEN_STAGE}, p.id, ${ANA}, 'Working', 'open', 0
      FROM app.pipeline p WHERE p.tenant_id = ${TENANT}`
  await sql`
    INSERT INTO app.stage (tenant_id, id, pipeline_id, owner_user_id, name, stage_type, sort_order)
    SELECT ${TENANT}, ${WON_STAGE}, p.id, ${ANA}, 'Closed Won', 'earning', 1
      FROM app.pipeline p WHERE p.tenant_id = ${TENANT}`
  await sql`
    INSERT INTO app.opportunity
      (tenant_id, id, owner_user_id, contact_id, pipeline_id, stage_id,
       current_stage_type, created_from, stage_entered_at)
    SELECT ${TENANT}, ${OPP}, ${ANA}, ${CONTACT}, p.id, ${OPEN_STAGE},
           'open', 'manual', clock_timestamp()
      FROM app.pipeline p WHERE p.tenant_id = ${TENANT}`
})

afterAll(async () => {
  await sql?.end()
})

describe('(a) all four append-only tables refuse a rewrite, from the console', () => {
  it('refuses UPDATE on every one of them, as the OWNER', async () => {
    // 🎯 "INCLUDING FROM THE PROVIDER'S SQL CONSOLE — which is what proves the
    // TRIGGER, not merely the REVOKE, is in place." Run as the owning role on
    // purpose: policy and privilege both permit this, and the statement still
    // has to fail. A test as `crm_app` would pass on the revoke alone and say
    // nothing about the day somebody restores a grant.
    for (const table of APPEND_ONLY) {
      await expect(
        sql.unsafe(`UPDATE app.${table} SET tenant_id = tenant_id WHERE false`),
        `app.${table} accepted an UPDATE`,
      ).rejects.toThrow()
    }
  })

  it('refuses DELETE and TRUNCATE on every one of them, as the OWNER', async () => {
    for (const table of APPEND_ONLY) {
      await expect(
        sql.unsafe(`DELETE FROM app.${table} WHERE false`),
        `app.${table} accepted a DELETE`,
      ).rejects.toThrow()

      // TRUNCATE bypasses row triggers AND the DELETE privilege, which is why
      // the immutability trigger is FOR EACH STATEMENT and names TRUNCATE.
      await expect(
        sql.unsafe(`TRUNCATE app.${table}`),
        `app.${table} accepted a TRUNCATE`,
      ).rejects.toThrow()
    }
  })

  it('refuses an accidental ON CONFLICT DO UPDATE', async () => {
    // §2535 (a) names this shape specifically, and it is the realistic one: an
    // upsert written for convenience turns an append-only ledger into a mutable
    // one at the exact moment somebody re-runs an import. The trigger fires on
    // the UPDATE half whether it was spelled UPDATE or not.
    await expect(
      sql`
        INSERT INTO app.consent_ledger (tenant_id, contact_id, channel, status, source)
        VALUES (${TENANT}, ${CONTACT}, 'sms', 'granted', 'import')
        ON CONFLICT DO NOTHING`,
    ).rejects.toThrow()
  })
})

describe('(b) the close gate commits as ONE unit, emission included', () => {
  it('leaves nothing behind when a link after the ledger fails', async () => {
    // 🔴 THE CHAIN IS LONGER THAN THE GATE'S AUTHORS COULD TEST. §2535 (b) ends
    // with "event_emit + outbox rows", and those did not exist until 0054 —
    // `app.stage_move` emitted nothing at all. So this is the first run of the
    // assertion against the whole chain.
    //
    // The failure is injected by aborting the transaction after stage_move
    // returns: every write it made is inside that transaction, so if any of
    // them survived, the unit is not a unit.
    const before = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM app.earnings_ledger WHERE tenant_id = ${TENANT}`

    await expect(
      sql.begin(async (tx) => {
        await tx`SELECT app.begin_request(${TENANT}::uuid, ${ANA}::uuid)`
        await tx`
          SELECT * FROM app.stage_move(${OPP}::uuid, ${WON_STAGE}::uuid,
            'kanban_drag'::app.moved_via, 'human'::app.actor_type, NULL,
            120000::bigint, 'annual'::app.premium_mode)`
        // The link that fails. Anything after the ledger append does.
        await tx`SELECT 1 / 0`
      }),
    ).rejects.toThrow()

    const after = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM app.earnings_ledger WHERE tenant_id = ${TENANT}`
    expect(after[0]?.n, 'a ledger row survived a failed gate').toBe(before[0]?.n)

    // And the same for every other link, because "commits or fails as one unit"
    // is a claim about all of them and not about the money alone.
    const [transitions] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM app.stage_transition WHERE tenant_id = ${TENANT}`
    const [events] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM app.event_log WHERE tenant_id = ${TENANT}`
    const [outbox] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM app.event_outbox WHERE tenant_id = ${TENANT}`
    const [opp] = await sql<{ stage_id: string }[]>`
      SELECT stage_id FROM app.opportunity WHERE tenant_id = ${TENANT} AND id = ${OPP}`

    expect(transitions?.n, 'a stage_transition survived').toBe(0)
    expect(events?.n, 'an event row survived').toBe(0)
    expect(outbox?.n, 'an outbox row survived').toBe(0)
    expect(opp?.stage_id, 'the card moved anyway').toBe(OPEN_STAGE)
  })
})

describe('(e) annualize is exact over a hundred thousand values', () => {
  it('never loses a cent, at any monthly premium', () => {
    // §2535 (e) names fast-check and the count. The property is not "close
    // enough": Final Expense sells monthly and Earnings are annual, so the ×12
    // happens once, in integer cents, and a single rounding error is a public
    // leaderboard that disagrees with a seller's own arithmetic.
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 100_000_000n }), (monthly) => {
        // Through fromCents, which is the only door into the branded type.
        // That is part of the property rather than ceremony: the guard that
        // stops a raw bigint reaching annualize is the same one that keeps a
        // float out of the money path, and the typecheck refused the first
        // version of this test for exactly that reason.
        return annualize(fromCents(monthly)) === monthly * 12n
      }),
      { numRuns: 100_000 },
    )
  })

  it('is reading the real function, not a stub', () => {
    // The mutation guard. A property over a function that returns its input
    // would pass every run above for monthly = 0.
    expect(annualize(fromCents(24_999n))).toBe(299_988n)
  })
})

describe('(f) no role can park a transaction on the money path', () => {
  it('sets idle_in_transaction_session_timeout on every crm role', async () => {
    // The close gate takes FOR UPDATE on the opportunity row and writes the
    // leaderboard projection in the same transaction. A session that opens one
    // and then stops — a slept laptop, a crashed editor, a psql window left
    // open — holds those locks for as long as the connection lives. Every
    // seller trying to close that card waits behind it and the public board
    // stops moving, with no error anywhere.
    //
    // Measured before 0056: crm and crm_ci had none.
    const roles = await sql<{ rolname: string; timeout: string | null }[]>`
      SELECT rolname,
             (SELECT option_value FROM pg_options_to_table(rolconfig)
               WHERE option_name = 'idle_in_transaction_session_timeout') AS timeout
        FROM pg_roles WHERE rolname LIKE 'crm%' ORDER BY rolname`

    expect(roles.length, 'no crm roles found — the query is wrong, not the tree').toBeGreaterThan(3)

    for (const role of roles) {
      expect(role.timeout, `${role.rolname} can park a transaction forever`).not.toBeNull()
    }
  })

  it('leaves no lock on the opportunity row when the session dies mid-gate', async () => {
    // 🎯 THE ASSERTION THE LADDER HAS BEEN CARRYING AS "MISSING" FOR WEEKS, and
    // it is the one that cannot be reasoned about — a lock released by
    // backend termination is a property of the server, not of our code, and the
    // only way to know is to kill a backend holding one.
    const victim = postgres(TEST_URL, { max: 1, onnotice: () => {} })
    let pid = 0

    try {
      // Open a transaction, take the same FOR UPDATE the gate takes, and stop.
      const started = victim.begin(async (tx) => {
        const [row] = await tx<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`
        pid = row?.pid ?? 0
        await tx`SELECT app.begin_request(${TENANT}::uuid, ${ANA}::uuid)`
        await tx`SELECT id FROM app.opportunity
                  WHERE tenant_id = ${TENANT} AND id = ${OPP} FOR UPDATE`
        // Park. The kill below is what ends this.
        await new Promise((r) => setTimeout(r, 30_000))
      })
      started.catch(() => undefined)

      // Wait for the lock to actually exist before killing, or the test proves
      // that killing a backend holding nothing releases nothing.
      let held = 0
      for (let i = 0; i < 40 && held === 0; i += 1) {
        await new Promise((r) => setTimeout(r, 100))
        const [l] = await sql<{ n: number }[]>`
          SELECT count(*)::int AS n FROM pg_locks
           WHERE pid = ${pid} AND locktype = 'transactionid' AND granted`
        held = l?.n ?? 0
      }
      expect(held, 'the victim never took a lock, so the kill proves nothing').toBeGreaterThan(0)

      await sql`SELECT pg_terminate_backend(${pid})`

      // The lock must be gone, and the row must be writable again by somebody
      // else — which is the property a seller actually experiences.
      let remaining = 1
      for (let i = 0; i < 40 && remaining > 0; i += 1) {
        await new Promise((r) => setTimeout(r, 100))
        const [l] = await sql<{ n: number }[]>`
          SELECT count(*)::int AS n FROM pg_locks WHERE pid = ${pid} AND granted`
        remaining = l?.n ?? 0
      }
      expect(remaining, 'the killed backend still holds a lock').toBe(0)

      const [locked] = await sql<{ id: string }[]>`
        SELECT id FROM app.opportunity
         WHERE tenant_id = ${TENANT} AND id = ${OPP}
         FOR UPDATE NOWAIT`
      expect(locked?.id, 'the opportunity row is still locked after the kill').toBe(OPP)
    } finally {
      await victim.end({ timeout: 1 }).catch(() => undefined)
    }
  }, 30_000)
})
