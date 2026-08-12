import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { relayOnce } from '~/modules/events/relay'
import { startDealFor } from '~/routes/api/opportunities'
import { readTimelineFor } from '~/routes/api/timeline'

import { TEST_URL } from './setup/urls'

/**
 * A SELLER CAN START A DEAL — the first writer the product never had.
 *
 * 🔴 THE STATE THIS CLOSES. `app.opportunity` has had a schema, two gates, an
 * atomic `stage_move`, a board that drags it and a ledger that pays it, and
 * NOTHING IN `app/` CREATED ONE. Two screens told the seller "No open deal.
 * Start one from your board" while the board had no such affordance. That is
 * also why only five of the 49 events had an emitter: there was engine and no
 * wiring.
 */

const TENANT = '00000000-0000-7000-8000-0000000d0100'
const ANA = '00000000-0000-7000-8000-0000000d01a1'
const BEN = '00000000-0000-7000-8000-0000000d01b1'
const ANAS_CONTACT = '00000000-0000-7000-8000-0000000d01c1'
/** Ben has a contact and NO pipeline: the fail-loud direction. */
const BENS_CONTACT = '00000000-0000-7000-8000-0000000d01c2'
const OPEN_STAGE = '00000000-0000-7000-8000-0000000d0101'
const WON_STAGE = '00000000-0000-7000-8000-0000000d0102'

let sql: postgres.Sql
const identity = { tenantId: TENANT, userId: ANA }

beforeAll(async () => {
  sql = postgres(TEST_URL, { max: 1, onnotice: () => {} })

  await sql`
    INSERT INTO app.tenant (id, name, business_tz)
    VALUES (${TENANT}, 'Deal Agency', 'America/New_York')`
  await sql`
    INSERT INTO app.app_user (tenant_id, id, email, full_name, display_name, role) VALUES
      (${TENANT}, ${ANA}, 'ana@deal.test', 'Ana Deal', 'Ana D.', 'seller'),
      (${TENANT}, ${BEN}, 'ben@deal.test', 'Ben Deal', 'Ben D.', 'seller')`
  await sql`
    INSERT INTO app.contact (tenant_id, id, owner_user_id, full_name, created_via) VALUES
      (${TENANT}, ${ANAS_CONTACT}, ${ANA}, 'Ana Lead', 'manual'),
      (${TENANT}, ${BENS_CONTACT}, ${BEN}, 'Ben Lead', 'manual')`
  await sql`
    INSERT INTO app.pipeline (tenant_id, owner_user_id, name)
    VALUES (${TENANT}, ${ANA}, 'Board')`

  // 🎯 THE WON STAGE IS INSERTED FIRST AND SORTS LAST. The door picks the first
  // stage by `stage_type = 'open'` then `sort_order` — never by name, never by
  // insertion order. A fixture whose insertion order disagrees with both is
  // what makes the assertion below mean something.
  await sql`
    INSERT INTO app.stage (tenant_id, id, pipeline_id, owner_user_id, name, stage_type, sort_order)
    SELECT ${TENANT}, ${WON_STAGE}, p.id, ${ANA}, 'Closed Won', 'earning', 9
      FROM app.pipeline p WHERE p.tenant_id = ${TENANT}`
  await sql`
    INSERT INTO app.stage (tenant_id, id, pipeline_id, owner_user_id, name, stage_type, sort_order)
    SELECT ${TENANT}, ${OPEN_STAGE}, p.id, ${ANA}, 'New Lead', 'open', 0
      FROM app.pipeline p WHERE p.tenant_id = ${TENANT}`
})

afterAll(async () => {
  await sql?.end()
})

describe('starting a deal', () => {
  it('creates it in the first OPEN stage, by type and never by name', async () => {
    const result = await startDealFor(identity, { contactId: ANAS_CONTACT })
    expect(result.status).toBe('created')
    if (result.status !== 'created') return

    const [row] = await sql<
      { stage_id: string; current_stage_type: string; owner: string; created_from: string }[]
    >`
      SELECT stage_id, current_stage_type::text AS current_stage_type,
             owner_user_id AS owner, created_from::text AS created_from
        FROM app.opportunity WHERE tenant_id = ${TENANT} AND id = ${result.opportunityId}`

    // MUTATION: order the stage lookup by name, or drop the `stage_type` filter
    // and take `sort_order` alone. The fixture's Closed Won was written first
    // and sorts last, so either one lands the deal in the wrong stage.
    expect(row?.stage_id).toBe(OPEN_STAGE)
    expect(row?.current_stage_type).toBe('open')
    expect(row?.owner).toBe(ANA)
    expect(row?.created_from).toBe('manual')
  })

  it('emits opportunity.created in the same transaction as the row', async () => {
    // 🔴 THE REASON THE DOOR IS A DEFINER. `crm_app` holds INSERT on
    // `app.opportunity`, so a route could write the row — and 0061 revoked
    // `event_emit`, so it could not emit. Section 2535(b) puts both in ONE
    // transaction, so "a deal exists and its event does not" is not a state
    // this can reach.
    //
    // MUTATION: delete the `PERFORM app.event_emit` from the door. The deal
    // still appears, the board still draws it, and the seller's history
    // silently never grows a line. This is the only thing that notices.
    const events = await sql<{ payload: Record<string, unknown>; owner: string }[]>`
      SELECT payload, owner_user_id AS owner FROM app.event_log
       WHERE tenant_id = ${TENANT} AND event_name = 'opportunity.created'`

    expect(events).toHaveLength(1)
    expect(events[0]?.owner).toBe(ANA)
    expect(events[0]?.payload['contact_id']).toBe(ANAS_CONTACT)
    expect(events[0]?.payload['created_from']).toBe('manual')

    // Every declared key present, the nullable ones as JSON null rather than
    // absent — the shape the generated payload type requires.
    expect(Object.keys(events[0]?.payload ?? {}).sort()).toEqual([
      'contact_id',
      'created_from',
      'deal_value_annual_premium',
      'opportunity_id',
      'parent_opportunity_id',
      'pipeline_id',
      'product_type',
      'stage_id',
    ])
  })

  it('reaches the seller’s own history as a line she can read', async () => {
    // 🎯 END TO END, THROUGH THE REAL PROJECTOR, and this is what "there is
    // engine and no wiring" meant: the store, the outbox, the relay, the
    // projection map and the screen all existed, and nothing ever fed them.
    await relayOnce()

    const page = await readTimelineFor(identity, ANAS_CONTACT, null)
    const created = page.entries.filter((e) => e.kind === 'lead_created')

    expect(created).toHaveLength(1)
    expect(created[0]?.actorLabelKey).toBe('timeline.actor.you')

    const [dead] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM app.dead_letter WHERE tenant_id = ${TENANT}`
    expect(dead?.n).toBe(0)
  })

  it('lets one contact buy twice', async () => {
    // The contact screen's own empty state says so, so "this contact already
    // has a deal" is not a refusal this product gets to make. MUTATION: add a
    // guard against a second open deal — which is exactly the kind of thing
    // that looks like tidiness and quietly forecloses a cross-sell.
    const second = await startDealFor(identity, { contactId: ANAS_CONTACT })
    expect(second.status).toBe('created')

    const [row] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM app.opportunity
       WHERE tenant_id = ${TENANT} AND contact_id = ${ANAS_CONTACT}`
    expect(row?.n).toBe(2)
  })

  it('answers a foreign contact, a missing one and a malformed id identically', async () => {
    // 🔴 OWNER-SCOPED NOT-FOUND, NEVER 403. The door returns NULL for all
    // three, so this route has no branch that could tell them apart and no way
    // to grow one by accident. MUTATION: make the door RAISE for an invisible
    // contact — the message then differs between the cases, which is the 403
    // this rule exists to prevent, written in softer words.
    const foreign = await startDealFor(identity, { contactId: BENS_CONTACT })
    const missing = await startDealFor(identity, {
      contactId: '00000000-0000-7000-8000-00000000dead',
    })
    const malformed = await startDealFor(identity, { contactId: 'not-a-uuid' })

    expect(foreign).toEqual({ status: 'not_found' })
    expect(missing).toEqual(foreign)
    expect(malformed).toEqual(foreign)

    // And nothing was written into Ben's book.
    const [row] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM app.opportunity
       WHERE tenant_id = ${TENANT} AND contact_id = ${BENS_CONTACT}`
    expect(row?.n).toBe(0)
  })

  it('refuses loudly when the seller has no board to start a deal on', async () => {
    // FAIL LOUD RATHER THAN CLOSED, and the distinction is the seller's time. A
    // seller with no pipeline is a setup defect; answering "not found" would
    // send her looking at the contact, which is the one place the problem is
    // not.
    //
    // The message lives in `.cause`: Drizzle rewraps the driver error one level
    // down and the outer text is only "Failed query".
    const error = await startDealFor(
      { tenantId: TENANT, userId: BEN },
      { contactId: BENS_CONTACT },
    ).catch((e: unknown) => e)

    const parts: string[] = []
    let cursor: unknown = error
    while (cursor instanceof Error) {
      parts.push(cursor.message)
      cursor = cursor.cause
    }
    expect(parts.join(' | ')).toMatch(/OP002/)
  })
})
