import { sql as raw } from 'drizzle-orm'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { withTenant } from '~/db'
import { relayOnce } from '~/modules/events/relay'

import { TEST_URL } from './setup/urls'

/**
 * The first real emitter, end to end.
 *
 * Before 0054 `app.event_emit` had ZERO production callers: the store, the
 * outbox, the 49-name enum and the 268 consumer rows all existed and no fact of
 * the product ever entered them. `05c` had closed finding A7 on the claim that
 * §7.4.1 emits inside `app.stage_move()` — the claim was true of the document
 * and false of the tree.
 *
 * This file asserts the whole chain in one place, because every link was green
 * on its own while the chain did not exist: move → event row → fan-out →
 * relay → audit row, and the sale credited exactly once through all of it.
 */

const TENANT = '00000000-0000-7000-8000-0000000e5400'
const ANA = '00000000-0000-7000-8000-0000000e54a1'
const CONTACT = '00000000-0000-7000-8000-0000000e54c1'
const OPP = '00000000-0000-7000-8000-0000000e54d1'
const OPEN_STAGE = '00000000-0000-7000-8000-0000000e5401'
const WON_STAGE = '00000000-0000-7000-8000-0000000e5402'

let sql: postgres.Sql

const PREMIUM = 120_000n

async function move(toStage: string, premium: bigint | null): Promise<void> {
  await withTenant({ tenantId: TENANT, userId: ANA }, async (tx) => {
    await tx.execute(raw`
      SELECT * FROM app.stage_move(
        ${OPP}::uuid, ${toStage}::uuid, 'kanban_drag'::app.moved_via,
        'human'::app.actor_type, NULL,
        ${premium === null ? null : premium.toString()}::bigint,
        ${premium === null ? null : 'annual'}::app.premium_mode)`)
  })
}

beforeAll(async () => {
  sql = postgres(TEST_URL, { max: 1, onnotice: () => {} })

  await sql`
    INSERT INTO app.tenant (id, name, business_tz)
    VALUES (${TENANT}, 'Emit Agency', 'America/New_York')`
  await sql`
    INSERT INTO app.app_user (tenant_id, id, email, full_name, display_name, role)
    VALUES (${TENANT}, ${ANA}, 'ana@emit.test', 'Ana Emit', 'Ana E.', 'seller')`
  await sql`
    INSERT INTO app.contact (tenant_id, id, owner_user_id, full_name, created_via)
    VALUES (${TENANT}, ${CONTACT}, ${ANA}, 'Ruth Emit', 'manual')`
  await sql`
    INSERT INTO app.pipeline (tenant_id, owner_user_id, name)
    VALUES (${TENANT}, ${ANA}, 'My Board')`
  await sql`
    INSERT INTO app.stage (tenant_id, id, pipeline_id, owner_user_id, name, stage_type, sort_order)
    SELECT ${TENANT}, ${OPEN_STAGE}, p.id, ${ANA}, 'Working', 'open', 0
      FROM app.pipeline p WHERE p.tenant_id = ${TENANT} AND p.owner_user_id = ${ANA}`
  await sql`
    INSERT INTO app.stage (tenant_id, id, pipeline_id, owner_user_id, name, stage_type, sort_order)
    SELECT ${TENANT}, ${WON_STAGE}, p.id, ${ANA}, 'Closed Won', 'earning', 1
      FROM app.pipeline p WHERE p.tenant_id = ${TENANT} AND p.owner_user_id = ${ANA}`
  await sql`
    INSERT INTO app.opportunity
      (tenant_id, id, owner_user_id, contact_id, pipeline_id, stage_id,
       current_stage_type, created_from, stage_entered_at)
    SELECT ${TENANT}, ${OPP}, ${ANA}, ${CONTACT}, p.id, ${OPEN_STAGE},
           'open', 'manual', clock_timestamp()
      FROM app.pipeline p WHERE p.tenant_id = ${TENANT} AND p.owner_user_id = ${ANA}`
})

afterAll(async () => {
  await sql?.end()
})

describe('a stage move writes the events it caused', () => {
  it('emits stage_changed AND won, tied by one correlation id', async () => {
    await move(WON_STAGE, PREMIUM)

    const events = await sql<
      { event_name: string; correlation_id: string; payload: Record<string, unknown> }[]
    >`
      SELECT event_name::text AS event_name, correlation_id, payload
        FROM app.event_log
       WHERE tenant_id = ${TENANT} AND subject_id = ${OPP}
       ORDER BY event_name`

    expect(events.map((e) => e.event_name)).toEqual([
      'opportunity.stage_changed',
      'opportunity.won',
    ])

    // ONE STORY. A consumer must be able to tie "the card moved" to "the sale
    // happened" without inferring it from timestamps, which is what a
    // correlation id is for and what two independent uuids would destroy.
    const stories = new Set(events.map((e) => e.correlation_id))
    expect(stories.size).toBe(1)
  })

  it('carries money as a STRING of whole cents, never a JSON number', async () => {
    // The constitution: money crosses JSON as a string of whole cents. A bare
    // bigint renders as a JSON number, and the first thing that reads it in
    // JavaScript puts a seller's premium into a float.
    const [won] = await sql<{ payload: Record<string, unknown> }[]>`
      SELECT payload FROM app.event_log
       WHERE tenant_id = ${TENANT} AND event_name = 'opportunity.won'`

    expect(won?.payload['deal_value_annual_premium']).toBe('120000')
    expect(typeof won?.payload['deal_value_annual_premium']).toBe('string')
  })

  it('binds the closed type to stage_type and never to the stage name', async () => {
    // Renaming "Closed Won" must change nothing. The payload's closed type is
    // derived from stage_type, which is immutable by trigger.
    const [changed] = await sql<{ payload: Record<string, unknown> }[]>`
      SELECT payload FROM app.event_log
       WHERE tenant_id = ${TENANT} AND event_name = 'opportunity.stage_changed'`

    expect(changed?.payload['to_stage_closed_type']).toBe('won')
    expect(changed?.payload['to_stage_is_closed']).toBe(true)
    expect(changed?.payload['required_fields_satisfied']).toEqual(['deal_value_annual_premium'])
  })

  it('fans out to audit and NOT to earnings, so the sale is credited once', async () => {
    // 🎯 THE ASSERTION THE WHOLE DELIVERY-TIER DESIGN EXISTS FOR. `earnings`
    // subscribes to opportunity.won, and app.stage_move has ALREADY appended to
    // the ledger in this same transaction. A fan-out row would ask the relay to
    // credit it again — permanently, on an append-only ledger with no recompute
    // job, and the first symptom would be a public board reading double.
    const rows = await sql<{ consumer_name: string }[]>`
      SELECT DISTINCT consumer_name FROM app.event_outbox
       WHERE tenant_id = ${TENANT}`
    const consumers = rows.map((r) => r.consumer_name)

    expect(consumers).toContain('audit')
    expect(consumers).not.toContain('earnings')

    const [ledger] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM app.earnings_ledger
       WHERE tenant_id = ${TENANT} AND opportunity_id = ${OPP} AND entry_type = 'sale'`
    expect(ledger?.n).toBe(1)
  })

  it('reaches the audit log through the relay', async () => {
    // The last link. Everything above proves the event was written; this proves
    // it was DELIVERED, which is the half that did not exist at all before this
    // branch.
    await relayOnce()

    const audit = await sql<{ action: string }[]>`
      SELECT action FROM app.audit_log
       WHERE tenant_id = ${TENANT} AND subject_id = ${OPP} ORDER BY action`

    expect(audit.map((a) => a.action)).toEqual(['ledger.adjusted'])
  })
})

describe('the move back reverses without emitting a second sale', () => {
  it('emits reopened, and the ledger nets to zero', async () => {
    await move(OPEN_STAGE, null)

    const names = await sql<{ event_name: string }[]>`
      SELECT event_name::text AS event_name FROM app.event_log
       WHERE tenant_id = ${TENANT} AND subject_id = ${OPP}
       ORDER BY occurred_at`
    expect(names.map((n) => n.event_name)).toContain('opportunity.reopened')

    // `opportunity.reopened` is the ONLY one of the four opportunity payloads
    // this function can fill completely and truthfully today — every field is a
    // column or derived from one.
    const [reopened] = await sql<{ payload: Record<string, unknown> }[]>`
      SELECT payload FROM app.event_log
       WHERE tenant_id = ${TENANT} AND event_name = 'opportunity.reopened'`
    expect(reopened?.payload['previous_closed_type']).toBe('won')
    expect(reopened?.payload['deal_value_reversed']).toBe('120000')
    expect(Object.values(reopened?.payload ?? {}).every((v) => v !== undefined)).toBe(true)

    const [net] = await sql<{ total: string }[]>`
      SELECT coalesce(sum(delta_cents), 0)::text AS total FROM app.earnings_ledger
       WHERE tenant_id = ${TENANT} AND opportunity_id = ${OPP}`
    expect(net?.total).toBe('0')
  })
})
