import { createHash } from 'node:crypto'

import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { mergeCallFromEvent } from '~/modules/communications/call-merge'

import { OWNER_URL } from './setup/urls'

/**
 * `app.dead_letter` and `app.admin_alert` — §4.6's two operational surfaces.
 *
 * *"The counter is a product surface, not a log."* Everything here asserts that
 * a failure becomes a ROW an admin can act on, in the same transaction as the
 * thing that failed, rather than a line in a file nobody reads until after.
 */

const TENANT = '00000000-0000-7000-8000-000000370037'
const TOKEN = 'health-test-token-0037'
const UNMAPPED_LINE = '+12025550188'
const OTHER_UNMAPPED = '+12025550189'

let owner: postgres.Sql

const digestOf = (s: string): Buffer => createHash('sha256').update(s).digest()

async function deliver(body: string, signatureValid: boolean | null = null): Promise<string> {
  await owner`
    SELECT app.webhook_ingest(${TOKEN}, ${Buffer.from(body, 'utf8')},
      NULL, NULL, NULL, 'parsed', ${signatureValid})`
  const [row] = await owner<{ id: string }[]>`
    SELECT id FROM app.inbound_webhook_event
     WHERE provider_event_id = ${digestOf(body).toString('hex')}`
  if (row === undefined) throw new Error('the delivery was not stored')
  return row.id
}

/** An inbound call on a line nobody mapped — the Local Presence pool case. */
const missedOn = (line: string, id: number): string =>
  JSON.stringify({
    event: 'InboundPhoneCall-DispositionMissed',
    body: {
      id,
      direction: 1,
      current_status2: 9,
      disposition_status2: 3,
      talk_time: 0,
      wait_time: 15,
      user_id: null,
      incoming_number: line,
      lead_number: '+12025550101',
      created_at: '2026-08-05 21:10:00',
      updated_at: '2026-08-05 21:10:00',
    },
  })

const mergeDelivery = (eventId: string, callId: string) =>
  mergeCallFromEvent({
    tenantId: TENANT,
    inboundWebhookEventId: eventId,
    alowareCallId: callId,
    canonical: 'call.completed',
  })

beforeAll(async () => {
  owner = postgres(OWNER_URL, { max: 1, onnotice: () => {} })
  await owner`
    INSERT INTO app.tenant (id, name, business_tz)
    VALUES (${TENANT}, 'Health Agency', 'America/Los_Angeles')`
  await owner`
    INSERT INTO app.webhook_endpoint (tenant_id, provider, token_sha256, label)
    VALUES (${TENANT}, 'aloware', ${digestOf(TOKEN)}, 'health test')`
})

afterAll(async () => {
  await owner.end()
})

describe('a signature-invalid delivery dead-letters BY TRIGGER', () => {
  it('writes the row, keeps the bytes, and holds them by reference', async () => {
    // §4.2 ruling 3: stored and dead-lettered, never rejected. The bytes are
    // kept and no job runs.
    const body = '{"event":"OutboundPhoneCall","body":{"id":770001}}'
    const eventId = await deliver(body, false)

    const [dl] = await owner<
      {
        origin: string
        subject_id: string
        raw_payload_id: string | null
        reason: string
        attempt_count: number
      }[]
    >`
      SELECT origin, subject_id, raw_payload_id, reason, attempt_count
        FROM app.dead_letter WHERE tenant_id = ${TENANT} AND subject_id = ${eventId}`

    expect(dl?.origin).toBe('inbound_webhook')
    expect(dl?.attempt_count).toBe(1)
    expect(dl?.reason).toContain('did not verify')

    // 🔴 BY REFERENCE, NEVER COPIED (ARR-PRV-02). A second copy of the body
    // would be a second PII store with its own retention clock, and the point
    // of one clock is that a deletion request has one place to reach.
    const [joined] = await owner<{ n: string }[]>`
      SELECT count(*) AS n
        FROM app.dead_letter d
        JOIN app.raw_payload_vault v
          ON v.tenant_id = d.tenant_id AND v.id = d.raw_payload_id
       WHERE d.tenant_id = ${TENANT} AND d.subject_id = ${eventId}
         AND v.body_sha256 = ${digestOf(body)}`
    expect(Number(joined?.n ?? '0')).toBe(1)
  })

  it('leaves a delivery we simply cannot verify alone', async () => {
    // NULL is not `false`. Aloware sends no signature at all, so every real
    // delivery lands here — and "we cannot verify this" is a permanent visible
    // line on the admin page, not a dead letter.
    const eventId = await deliver('{"event":"OutboundPhoneCall","body":{"id":770002}}', null)
    const [row] = await owner<{ n: string }[]>`
      SELECT count(*) AS n FROM app.dead_letter
       WHERE tenant_id = ${TENANT} AND subject_id = ${eventId}`
    expect(Number(row?.n ?? '-1')).toBe(0)
  })

  it('counts a repeated failure instead of adding a row', async () => {
    // The webhook path cannot reach this — each delivery is its own subject —
    // but a job or an outbox delivery retries against ONE subject, and a retry
    // storm has to produce a count rather than a thousand rows an admin pages
    // through to find the one that matters.
    await owner.begin(async (tx) => {
      await tx`SELECT app.begin_system_work(${TENANT}::uuid)`
      await tx`SELECT app.dead_letter_record('job', 'scheduled_job', 'job-42', NULL, 'Timed out')`
      await tx`SELECT app.dead_letter_record('job', 'scheduled_job', 'job-42', NULL, 'Timed out again')`
    })

    const rows = await owner<{ attempt_count: number; reason: string }[]>`
      SELECT attempt_count, reason FROM app.dead_letter
       WHERE tenant_id = ${TENANT} AND subject_id = 'job-42'`
    expect([...rows]).toHaveLength(1)
    expect(rows[0]?.attempt_count).toBe(2)
    expect(rows[0]?.reason).toBe('Timed out again')
  })
})

describe('an unattributable call raises an alert an admin can act on', () => {
  it('names the number, and counts repeats on one row', async () => {
    // §5: "1 call from a number we do not recognize. Nothing was written to a
    // seller's book." A sentence with a number in it only works if something
    // maintains the number.
    const first = await mergeDelivery(await deliver(missedOn(UNMAPPED_LINE, 810001)), '810001')
    expect(first.status).toBe('unmapped')

    const second = await mergeDelivery(await deliver(missedOn(UNMAPPED_LINE, 810002)), '810002')
    expect(second.status).toBe('unmapped')

    const rows = await owner<{ occurrence_count: number; detail: string }[]>`
      SELECT occurrence_count, detail FROM app.admin_alert
       WHERE tenant_id = ${TENANT} AND kind = 'unmapped_number'
         AND subject_key = ${UNMAPPED_LINE}`

    expect([...rows]).toHaveLength(1)
    expect(rows[0]?.occurrence_count).toBe(2)
    expect(rows[0]?.detail).toContain(UNMAPPED_LINE)
    expect(rows[0]?.detail).toContain("Nothing was written to a seller's book")
  })

  it('keeps a different line on its own row', async () => {
    await mergeDelivery(await deliver(missedOn(OTHER_UNMAPPED, 810003)), '810003')
    const rows = await owner<{ subject_key: string }[]>`
      SELECT subject_key FROM app.admin_alert
       WHERE tenant_id = ${TENANT} AND kind = 'unmapped_number' ORDER BY subject_key`
    expect([...rows].map((r) => r.subject_key)).toEqual([UNMAPPED_LINE, OTHER_UNMAPPED].sort())
  })

  it('raises the alert in the SAME transaction as the call it describes', async () => {
    // Not "the worker remembers to". `app.call_merge()` is the only writer of
    // `app.call`, so there is no window in which a quarantined call exists with
    // nothing telling an admin about it.
    const [both] = await owner<{ n: string }[]>`
      SELECT count(*) AS n FROM app.call c
       WHERE c.tenant_id = ${TENANT} AND c.owner_user_id IS NULL
         AND EXISTS (SELECT 1 FROM app.admin_alert a
                      WHERE a.tenant_id = c.tenant_id AND a.kind = 'unmapped_number')`
    expect(Number(both?.n ?? '0')).toBeGreaterThan(0)
  })
})

describe('the reconciliation gap cannot be acknowledged away', () => {
  it('refuses to acknowledge reconciliation_unavailable', async () => {
    // 🎯 A CHECK, NOT A RULE IN A HANDLER. The `call_list` fallback only holds
    // if the compensating control is PERMANENT: an admin who could tick this off
    // would restore exactly the silent hole it exists to advertise.
    await owner.begin(async (tx) => {
      await tx`SELECT app.begin_system_work(${TENANT}::uuid)`
      await tx`
        SELECT app.admin_alert_raise('reconciliation_unavailable', '',
          'Aloware exposes no call-listing endpoint, so deliveries we never received cannot be detected.')`
    })

    await expect(
      owner`
        UPDATE app.admin_alert SET acknowledged_at = clock_timestamp()
         WHERE tenant_id = ${TENANT} AND kind = 'reconciliation_unavailable'`,
    ).rejects.toThrow(/admin_alert_reconciliation_not_acknowledgeable/)
  })

  it('lets an ordinary alert be acknowledged', async () => {
    // A gate that refuses everything is indistinguishable from a broken one.
    await owner`
      UPDATE app.admin_alert SET acknowledged_at = clock_timestamp()
       WHERE tenant_id = ${TENANT} AND kind = 'unmapped_number'
         AND subject_key = ${OTHER_UNMAPPED}`

    const [row] = await owner<{ acknowledged_at: string | null }[]>`
      SELECT acknowledged_at FROM app.admin_alert
       WHERE tenant_id = ${TENANT} AND subject_key = ${OTHER_UNMAPPED}`
    expect(row?.acknowledged_at).not.toBeNull()
  })

  it('refuses an invented alert kind', async () => {
    await expect(
      owner.begin(async (tx) => {
        await tx`SELECT app.begin_system_work(${TENANT}::uuid)`
        await tx`SELECT app.admin_alert_raise('everything_is_fine', '', 'nope')`
      }),
    ).rejects.toThrow(/admin_alert_kind/)
  })
})

describe('what the application role may do to either table', () => {
  it('grants SELECT plus exactly one writable column each', async () => {
    // 🔴 THE ONE-COLUMN GRANT IS BUILT BY LISTING THE PROTECTED COLUMNS.
    // PostgreSQL does not decompose a table-level grant, so GRANT UPDATE ON t
    // then REVOKE UPDATE (c) ON t leaves c writable. Enumerating the permitted
    // columns is the only form that holds — and this asserts the RESULT rather
    // than the technique.
    for (const [table, writable] of [
      ['dead_letter', 'resolved_at'],
      ['admin_alert', 'acknowledged_at'],
    ] as const) {
      const cols = await owner<{ column_name: string }[]>`
        SELECT column_name FROM information_schema.column_privileges
         WHERE grantee = 'crm_app' AND table_schema = 'app'
           AND table_name = ${table} AND privilege_type = 'UPDATE'
         ORDER BY column_name`
      expect(
        [...cols].map((c) => c.column_name),
        `${table} writable columns`,
      ).toEqual([writable])

      const grants = await owner<{ privilege_type: string }[]>`
        SELECT DISTINCT privilege_type FROM information_schema.role_table_grants
         WHERE grantee = 'crm_app' AND table_schema = 'app' AND table_name = ${table}
         ORDER BY privilege_type`
      // 🔬 SELECT ALONE AT TABLE LEVEL, and that is the assertion rather than a
      // gap in it: `role_table_grants` lists TABLE-level privileges only, so an
      // UPDATE appearing here would mean the whole table is writable and the
      // column list above had been bypassed. No INSERT and no DELETE either —
      // rows arrive through a definer and never leave.
      expect([...grants].map((g) => g.privilege_type)).toEqual(['SELECT'])
    }
  })

  it('does not grant the alert-raising definers to the application at all', async () => {
    // An alert that a request could manufacture is not an operational signal.
    // Same class of rule as "nothing writes to the timeline directly".
    for (const fn of ['admin_alert_raise', 'dead_letter_record']) {
      const [row] = await owner<{ granted: boolean }[]>`
        SELECT has_function_privilege('crm_app', p.oid, 'EXECUTE') AS granted
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'app' AND p.proname = ${fn}`
      expect(row?.granted, fn).toBe(false)
    }
  })
})
