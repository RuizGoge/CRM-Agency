import { createHash } from 'node:crypto'

import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { CALL_MERGE_QUEUE, MESSAGE_MERGE_QUEUE } from '~/jobs/queues'
import { mergeMessageFromEvent } from '~/modules/communications/message-merge'

import { OWNER_URL } from './setup/urls'

/**
 * `app.message_merge()` and the SMS routing §4.3 asks for.
 *
 * Migration 0035 stored an SMS delivery and enqueued nothing, because handing
 * the CALL merger a row keyed on `provider_message_id` would have been worse
 * than waiting. 0038 is when the waiting ends.
 */

const TENANT = '00000000-0000-7000-8000-000000380038'
const SELLER = '00000000-0000-7000-8000-000000380001'
const CONTACT = '00000000-0000-7000-8000-0000003800c1'
const TOKEN = 'sms-test-token-0038'
const SEAT = 120777
const OUR_NUMBER = '+12025550143'
const LEAD_NUMBER = '+12025550178'

let owner: postgres.Sql

const digestOf = (s: string): Buffer => createHash('sha256').update(s).digest()

/**
 * The one SMS shape the capture contains: `current_status2: 19`,
 * `disposition_status2: 7` — the message was never delivered.
 *
 * Returns the body AND the keys the edge would have extracted, rather than
 * re-parsing the string to recover them. Re-parsing was the first version and
 * lint refused it: `JSON.parse` returns `any`, and reaching into an `any` is
 * exactly how a test stops checking the thing it names.
 */
function invalidSms(id: number, text: string): { body: string; event: string; id: string } {
  const event = 'OutboundSMS-DispositionInvalid'
  return {
    event,
    id: String(id),
    body: JSON.stringify({
      event,
      body: {
        id,
        direction: 2,
        current_status2: 19,
        disposition_status2: 7,
        user_id: SEAT,
        incoming_number: OUR_NUMBER,
        lead_number: LEAD_NUMBER,
        body: text,
        call_disposition: 'Invalid number',
        created_at: '2026-08-05 22:15:00',
        updated_at: '2026-08-05 22:15:03',
      },
    }),
  }
}

async function deliver(sms: { body: string; event: string; id: string }): Promise<string> {
  await owner`
    SELECT app.webhook_ingest(${TOKEN}, ${Buffer.from(sms.body, 'utf8')},
      ${sms.event}, 'message.delivery_failed', ${sms.id}, 'parsed', NULL)`
  const [row] = await owner<{ id: string }[]>`
    SELECT id FROM app.inbound_webhook_event
     WHERE provider_event_id = ${digestOf(sms.body).toString('hex')}`
  if (row === undefined) throw new Error('the delivery was not stored')
  return row.id
}

beforeAll(async () => {
  owner = postgres(OWNER_URL, { max: 1, onnotice: () => {} })
  await owner`
    INSERT INTO app.tenant (id, name, business_tz)
    VALUES (${TENANT}, 'SMS Agency', 'America/Phoenix')`
  await owner`
    INSERT INTO app.app_user (tenant_id, id, email, full_name, display_name, role)
    VALUES (${TENANT}, ${SELLER}, 'sms-0038@example.com', 'Tess Roy', 'Tess R.', 'seller')`
  await owner`
    INSERT INTO app.webhook_endpoint (tenant_id, provider, token_sha256, label)
    VALUES (${TENANT}, 'aloware', ${digestOf(TOKEN)}, 'sms test')`
  await owner`
    INSERT INTO app.aloware_number_mapping
      (tenant_id, owner_user_id, aloware_user_id, aloware_line_id, from_number_e164, verified_at)
    VALUES (${TENANT}, ${SELLER}, ${SEAT}, 63950, ${OUR_NUMBER}, clock_timestamp())`
  await owner`
    INSERT INTO app.contact (tenant_id, id, owner_user_id, full_name, created_via)
    VALUES (${TENANT}, ${CONTACT}, ${SELLER}, 'Texted Lead', 'manual')`
  await owner`
    INSERT INTO app.contact_phone (tenant_id, contact_id, owner_user_id, phone_e164, is_primary)
    VALUES (${TENANT}, ${CONTACT}, ${SELLER}, ${LEAD_NUMBER}, true)`
})

afterAll(async () => {
  await owner.end()
})

describe('an SMS reaches its own merger, not the call one', () => {
  it('enqueues onto message-merge and never onto call-merge', async () => {
    // 🔴 THE ROUTING IS EXHAUSTIVE, NOT A PREFIX MATCH. `LIKE 'call.%'` would be
    // shorter and would send a canonical event nobody has defined yet to the
    // call merger with confidence.
    await deliver(invalidSms(950001, 'Hi, following up on your quote.'))

    const onMessage = await owner<{ n: string }[]>`
      SELECT count(*) AS n FROM pgboss.job
       WHERE name = ${MESSAGE_MERGE_QUEUE} AND singleton_key = '950001'`
    const onCall = await owner<{ n: string }[]>`
      SELECT count(*) AS n FROM pgboss.job
       WHERE name = ${CALL_MERGE_QUEUE} AND singleton_key = '950001'`

    expect(Number(onMessage[0]?.n ?? '0')).toBe(1)
    expect(Number(onCall[0]?.n ?? '-1')).toBe(0)
  })

  it('merges into app.message with the seller and the contact resolved', async () => {
    const outcome = await mergeMessageFromEvent({
      tenantId: TENANT,
      inboundWebhookEventId: await deliver(invalidSms(950002, 'Second text, also undeliverable.')),
      alowareCallId: '950002',
      canonical: 'message.delivery_failed',
    })
    expect(outcome.status).toBe('resolved')

    const [row] = await owner<
      {
        state: string
        direction: string | null
        owner_user_id: string | null
        contact_id: string | null
        body_text: string | null
        failure_reason: string | null
      }[]
    >`
      SELECT state, direction, owner_user_id, contact_id, body_text, failure_reason
        FROM app.message
       WHERE tenant_id = ${TENANT} AND provider_message_id = '950002'`

    expect(row?.state).toBe('failed')
    expect(row?.direction).toBe('outbound')
    expect(row?.owner_user_id).toBe(SELLER)
    expect(row?.contact_id).toBe(CONTACT)
    expect(row?.body_text).toContain('undeliverable')
    expect(row?.failure_reason).toBe('Invalid number')
  })

  it('lands nothing in app.call — the two id spaces are shared, the tables are not', async () => {
    // G2 established that Aloware numbers calls and texts from ONE communication
    // id sequence. §4.4's ladder assumed two spaces. Two tables and two unique
    // indexes still work; what breaks is a reader who assumes an id can only be
    // one of the two.
    const [row] = await owner<{ n: string }[]>`
      SELECT count(*) AS n FROM app.call
       WHERE tenant_id = ${TENANT} AND aloware_call_id IN ('950001', '950002')`
    expect(Number(row?.n ?? '-1')).toBe(0)
  })
})

describe('the message merge is order-free and failure is terminal', () => {
  it('merges twice into one row and never un-fails a failed message', async () => {
    // §4.4 rung 3: merge, never insert. And a delivery failure reported after
    // the fact is the fact that matters for compliance — a later `received`
    // must not erase it.
    const eventId = await deliver(invalidSms(950003, 'Third.'))
    const job = {
      tenantId: TENANT,
      inboundWebhookEventId: eventId,
      alowareCallId: '950003',
      canonical: 'message.delivery_failed',
    }
    await mergeMessageFromEvent(job)
    await mergeMessageFromEvent(job)

    const rows = await owner<{ state: string }[]>`
      SELECT state FROM app.message
       WHERE tenant_id = ${TENANT} AND provider_message_id = '950003'`
    expect([...rows]).toHaveLength(1)
    expect(rows[0]?.state).toBe('failed')

    await owner.begin(async (tx) => {
      await tx`SELECT app.begin_system_work(${TENANT}::uuid)`
      await tx`
        SELECT app.message_merge('950003', 'received', 'inbound', ${SEAT},
          ${OUR_NUMBER}, ${LEAD_NUMBER}, 'a later inbound', NULL, NULL, NULL)`
    })

    const [after] = await owner<{ state: string }[]>`
      SELECT state FROM app.message
       WHERE tenant_id = ${TENANT} AND provider_message_id = '950003'`
    expect(after?.state).toBe('failed')
  })

  it('refuses a state nothing can ever write', async () => {
    // `sent` and `delivered` are absent because no webhook in the capture
    // reports a successful send. A state machine with an unreachable terminal is
    // how a screen ends up saying "Sending…" for ever.
    await expect(
      owner.begin(async (tx) => {
        await tx`SELECT app.begin_system_work(${TENANT}::uuid)`
        await tx`SELECT app.message_merge('950099', 'delivered')`
      }),
    ).rejects.toThrow(/MM003/)
  })
})

describe('what the seller may do to a message', () => {
  it('grants crm_app SELECT on app.message and nothing else', async () => {
    const grants = await owner<{ privilege_type: string }[]>`
      SELECT privilege_type FROM information_schema.role_table_grants
       WHERE grantee = 'crm_app' AND table_schema = 'app' AND table_name = 'message'
       ORDER BY privilege_type`
    expect([...grants].map((g) => g.privilege_type)).toEqual(['SELECT'])
  })
})
