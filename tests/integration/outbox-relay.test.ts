import { sql as raw } from 'drizzle-orm'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { withTenant } from '~/db'
import { CONSUMERS, relayOnce } from '~/modules/events/relay'

import { TEST_URL } from './setup/urls'

/**
 * The outbox relay: the half of the transport 0043 did not build.
 *
 * Before this existed, `app.event_emit` wrote fan-out rows nothing ever read —
 * a delivery owed forever. The store looked complete and was a queue with no
 * consumer, which is the failure shape this project keeps finding: two halves
 * that each look right alone.
 */

const TENANT = '00000000-0000-7000-8000-0000000e7100'
const ANA = '00000000-0000-7000-8000-0000000e71a1'

let sql: postgres.Sql

/** How many consumers actually receive a fan-out row for an event. */
async function fanoutWidth(eventName: string): Promise<number> {
  const [row] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM app.event_consumer
     WHERE event_name = ${eventName}::app.event_name
       AND delivery IN ('outbox', 'pgboss')
       AND handler_built`
  return row?.n ?? 0
}

const EVENT_OK = '01999999-0000-7000-8000-0000000071a1'
const EVENT_TWO = '01999999-0000-7000-8000-0000000071a2'

async function emit(eventId: string, name: string, subjectId: string): Promise<void> {
  await withTenant({ tenantId: TENANT, userId: ANA }, async (tx) => {
    await tx.execute(raw`
      SELECT app.event_emit(${eventId}::uuid, ${ANA}::uuid, ${name}::app.event_name,
                            'opportunity', ${subjectId}::uuid, ${'nat-' + eventId},
                            '{"deal_value_annual_premium":"120000"}'::jsonb)`)
  })
}

beforeAll(async () => {
  sql = postgres(TEST_URL, { max: 1, onnotice: () => {} })

  await sql`
    INSERT INTO app.tenant (id, name, business_tz)
    VALUES (${TENANT}, 'Relay Agency', 'America/New_York')`
  await sql`
    INSERT INTO app.app_user (tenant_id, id, email, full_name, display_name, role)
    VALUES (${TENANT}, ${ANA}, 'ana@relay.test', 'Ana Relay', 'Ana R.', 'seller')`
})

afterAll(async () => {
  await sql?.end()
})

describe('the registry and the engine agree on who has a handler', () => {
  it('registers a handler for exactly the consumers marked handler_built', async () => {
    // 🎯 THE GATE, and it runs in BOTH directions because each failure is
    // silent on its own.
    //
    // A consumer marked built with no handler here: `event_emit` fans out to
    // it, the relay claims the row, finds nothing to run, and the delivery can
    // never succeed — it climbs the ladder into a dead letter for a reason
    // nobody intended.
    //
    // A handler here whose consumer is not marked built: it receives nothing,
    // forever, and looks exactly like a quiet system.
    const rows = await sql<{ consumer_name: string }[]>`
      SELECT DISTINCT consumer_name FROM app.event_consumer WHERE handler_built`

    expect(rows.map((r) => r.consumer_name).sort()).toEqual([...CONSUMERS.keys()].sort())
  })

  it('is looking at a real set, not an empty one', () => {
    // The mutation guard. Two empty sets are equal, and this file would pass
    // forever over a relay that handles nothing.
    expect(CONSUMERS.size).toBeGreaterThan(0)
  })
})

describe('a delivery lands once and is acknowledged', () => {
  it('writes the audit row and marks the delivery delivered', async () => {
    await emit(EVENT_OK, 'opportunity.won', EVENT_OK)

    // ⚠️ THE FAN-OUT GREW WHEN THE TIMELINE ARRIVED, and this used to assert a
    // literal `['pending']`. `contacts` became a built handler in 0059, so an
    // event now fans out to two consumers rather than one. Derived from the
    // engine instead of counted here, so the next consumer moves this number
    // rather than turning the file red for being right.
    const width = await fanoutWidth('opportunity.won')

    const before = await sql<{ status: string }[]>`
      SELECT status::text AS status FROM app.event_outbox
       WHERE tenant_id = ${TENANT} AND event_id = ${EVENT_OK}`
    expect(before).toHaveLength(width)
    expect(before.every((r) => r.status === 'pending')).toBe(true)

    const outcome = await relayOnce()
    expect(outcome.delivered).toBeGreaterThanOrEqual(1)
    expect(outcome.unhandled).toBe(0)

    const after = await sql<{ status: string; delivered_at: Date | null }[]>`
      SELECT status::text AS status, delivered_at FROM app.event_outbox
       WHERE tenant_id = ${TENANT} AND event_id = ${EVENT_OK}`
    expect(after).toHaveLength(width)
    expect(after.every((r) => r.status === 'delivered')).toBe(true)
    expect(after.every((r) => r.delivered_at !== null)).toBe(true)

    // THE POINT OF THE WHOLE EXERCISE: `audit_log` stops being a table with no
    // writer. An event that names a write US-9.13 requires auditing now leaves
    // a row, and the relay is what put it there.
    const audit = await sql<{ action: string; actor_type: string; correlation_id: string }[]>`
      SELECT action, actor_type::text AS actor_type, correlation_id
        FROM app.audit_log WHERE tenant_id = ${TENANT} AND subject_id = ${EVENT_OK}`
    expect(audit).toHaveLength(1)

    // `ledger.adjusted` and NOT `earnings.adjusted`: the second is a ruled-out
    // EVENT name, and `audit-vocabulary.test.ts` now refuses any action that
    // collides with one. Two closed vocabularies, no shared words.
    expect(audit[0]?.action).toBe('ledger.adjusted')

    // 'system' and not the seller: the relay is what wrote this row, and the
    // human who caused the event is named inside the event itself. Claiming
    // otherwise would put a seller's id on a write they did not make.
    expect(audit[0]?.actor_type).toBe('system')
  })

  it('does not deliver the same row twice', async () => {
    // A second pass must find nothing to do. Delivery is exactly-once for a
    // database-only consumer because the handler's write and the ack commit
    // together — if that were two transactions, the lease would expire and this
    // would write a second audit row.
    const outcome = await relayOnce()

    const audit = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM app.audit_log
       WHERE tenant_id = ${TENANT} AND subject_id = ${EVENT_OK}`
    expect(audit[0]?.n).toBe(1)
    expect(outcome.delivered).toBe(0)
  })

  it('leaves no audit row for an event the audit map does not name', async () => {
    // 49 events, sixteen audit actions. An event with no mapping is delivered
    // and acked — the consumer HAS run and has correctly decided there is
    // nothing to record — rather than failing or being retried forever.
    await emit(EVENT_TWO, 'opportunity.created', EVENT_TWO)
    await relayOnce()

    const [row] = await sql<{ status: string }[]>`
      SELECT status::text AS status FROM app.event_outbox
       WHERE tenant_id = ${TENANT} AND event_id = ${EVENT_TWO}`
    expect(row?.status).toBe('delivered')

    const audit = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM app.audit_log
       WHERE tenant_id = ${TENANT} AND subject_id = ${EVENT_TWO}`
    expect(audit[0]?.n).toBe(0)
  })
})

describe('the audit log refuses to be edited', () => {
  it('is append-only by privilege, not only by policy', async () => {
    // The constitution ranks a revoked privilege above a policy, because a
    // policy is one dropped statement away from being absent. `harden()` gives
    // `append_only_tenant_admin` SELECT and nothing else.
    const grants = await sql<{ privilege_type: string }[]>`
      SELECT DISTINCT privilege_type FROM information_schema.role_table_grants
       WHERE table_schema = 'app' AND table_name = 'audit_log' AND grantee = 'crm_app'`
    expect(grants.map((g) => g.privilege_type).sort()).toEqual(['SELECT'])
  })

  it('refuses an UPDATE even as the migrator, who has the privilege', async () => {
    // The trigger is the half that survives a grant being restored. Run as the
    // owning role on purpose: policy and privilege both permit this, and the
    // statement still has to fail.
    await expect(
      sql`UPDATE app.audit_log SET reason = 'rewritten' WHERE tenant_id = ${TENANT}`,
    ).rejects.toThrow()
  })
})
