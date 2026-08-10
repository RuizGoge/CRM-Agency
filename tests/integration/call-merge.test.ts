import { createHash } from 'node:crypto'

import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { CALL_MERGE } from '~/modules/communications/aloware-call-fields'
import { mergeCallFromEvent } from '~/modules/communications/call-merge'

import { OWNER_URL } from './setup/urls'

/**
 * `app.call_merge()` and the `call-merge` job — §4.5, ARR-INT-06.
 *
 * ⚠️ SYNTHETIC BODIES, SHAPED FROM THE CAPTURE. The field names, their types
 * and the status codes are the measured ones; every phone number is from the
 * North American reserved fictional range (555-0100..0199) because the real
 * capture carries a production lead's number and lives only in the git-ignored
 * evidence file.
 */

const TENANT = '00000000-0000-7000-8000-000000360036'
const SELLER = '00000000-0000-7000-8000-000000360001'
const OTHER_SELLER = '00000000-0000-7000-8000-000000360002'
const CONTACT = '00000000-0000-7000-8000-0000003600c1'
const OTHER_CONTACT = '00000000-0000-7000-8000-0000003600c2'

const TOKEN = 'merge-test-token-0036'
const SEAT = 120776
const OUR_NUMBER = '+12025550142'
const LEAD_NUMBER = '+12025550177'
const CALL_ID = '940868616'

let owner: postgres.Sql

const digestOf = (s: string): Buffer => createHash('sha256').update(s).digest()

/** Runs a body through the real ingest and hands back its event id. */
async function deliver(body: string): Promise<string> {
  await owner`
    SELECT app.webhook_ingest(${TOKEN}, ${Buffer.from(body, 'utf8')},
      NULL, NULL, NULL, 'parsed', NULL)`
  const [row] = await owner<{ id: string }[]>`
    SELECT id FROM app.inbound_webhook_event
     WHERE provider_event_id = ${digestOf(body).toString('hex')}`
  if (row === undefined) throw new Error('the delivery was not stored')
  return row.id
}

const merge = (eventId: string) =>
  mergeCallFromEvent({
    tenantId: TENANT,
    inboundWebhookEventId: eventId,
    alowareCallId: CALL_ID,
    canonical: 'call.completed',
  })

const CREATED = '2026-08-05 20:58:49'

const INITIATED = JSON.stringify({
  event: 'OutboundPhoneCall',
  body: {
    id: 940868616,
    direction: 2,
    current_status2: 1,
    disposition_status2: 1,
    talk_time: 0,
    wait_time: 0,
    // Measured: null on the establishment event. Attribution has to come from
    // the number here, which is the whole reason the number route exists.
    user_id: null,
    incoming_number: OUR_NUMBER,
    lead_number: LEAD_NUMBER,
    created_at: CREATED,
    updated_at: CREATED,
  },
})

const DISPOSED = JSON.stringify({
  event: 'OutboundPhoneCall-DispositionCompleted',
  body: {
    id: 940868616,
    direction: 2,
    current_status2: 9,
    disposition_status2: 4,
    talk_time: 63,
    wait_time: 2,
    user_id: SEAT,
    call_disposition: 'No Answer',
    incoming_number: OUR_NUMBER,
    lead_number: LEAD_NUMBER,
    created_at: CREATED,
    updated_at: '2026-08-05 21:00:00',
  },
})

const RECORDED = JSON.stringify({
  event: 'Recording-Saved',
  body: {
    id: 940868616,
    direction: 2,
    current_status2: 9,
    disposition_status2: 4,
    talk_time: 63,
    wait_time: 2,
    user_id: SEAT,
    direct_recording_url: 'https://app.aloware.io/static/recording/32c1a2f8-fixture',
    incoming_number: OUR_NUMBER,
    lead_number: LEAD_NUMBER,
    created_at: CREATED,
    updated_at: '2026-08-05 21:00:04',
  },
})

/** Five keys, no `body.id`, no status, no clock. The awkward one. */
const SUMMARISED = JSON.stringify({
  event: 'transcription.call.summarized',
  body: {
    communication: { id: 940868616 },
    summary: 'Seller confirmed coverage and scheduled a callback.',
    transcription: { id: 1, transcription_id: 'abc', driver: 'deepgram' },
    contact: { id: 155091981 },
  },
})

interface Snapshot {
  state: string
  state_ordinal: number
  direction: string | null
  owner_user_id: string | null
  contact_id: string | null
  disposition_raw: string | null
  talk_time_seconds: number | null
  wait_time_seconds: number | null
  recording_url: string | null
  transcript_url: string | null
  ai_summary_text: string | null
  provider_created_at: string | null
  provider_last_event_at: string | null
}

const snapshot = async (): Promise<Snapshot | undefined> => {
  const [row] = await owner<Snapshot[]>`
    SELECT state, state_ordinal, direction, owner_user_id, contact_id, disposition_raw,
           talk_time_seconds, wait_time_seconds, recording_url, transcript_url,
           ai_summary_text,
           to_char(provider_created_at    AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') AS provider_created_at,
           to_char(provider_last_event_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') AS provider_last_event_at
      FROM app.call WHERE tenant_id = ${TENANT} AND aloware_call_id = ${CALL_ID}`
  return row
}

beforeAll(async () => {
  owner = postgres(OWNER_URL, { max: 1, onnotice: () => {} })

  await owner`
    INSERT INTO app.tenant (id, name, business_tz)
    VALUES (${TENANT}, 'Merge Agency', 'America/New_York')`
  await owner`
    INSERT INTO app.app_user (tenant_id, id, email, full_name, display_name, role) VALUES
      (${TENANT}, ${SELLER}, 'seller-0036@example.com', 'Sam Mendez', 'Sam M.', 'seller'),
      (${TENANT}, ${OTHER_SELLER}, 'other-0036@example.com', 'Ola Price', 'Ola P.', 'seller')`
  await owner`
    INSERT INTO app.webhook_endpoint (tenant_id, provider, token_sha256, label)
    VALUES (${TENANT}, 'aloware', ${digestOf(TOKEN)}, 'merge test')`
  await owner`
    INSERT INTO app.aloware_number_mapping
      (tenant_id, owner_user_id, aloware_user_id, aloware_line_id, from_number_e164, verified_at)
    VALUES (${TENANT}, ${SELLER}, ${SEAT}, 63949, ${OUR_NUMBER}, clock_timestamp())`

  await owner`
    INSERT INTO app.contact (tenant_id, id, owner_user_id, full_name, created_via) VALUES
      (${TENANT}, ${CONTACT}, ${SELLER}, 'Lead In My Book', 'manual'),
      (${TENANT}, ${OTHER_CONTACT}, ${OTHER_SELLER}, 'Same Lead Someone Else Has', 'manual')`
  // 🔴 BOTH SELLERS HOLD THE SAME NUMBER, on purpose. `contact_phone_owner_uidx`
  // is unique on (tenant, owner, phone) and NOT on (tenant, phone), so a
  // tenant-wide phone match would attach the call to whichever row the index
  // happened to return first.
  await owner`
    INSERT INTO app.contact_phone (tenant_id, contact_id, owner_user_id, phone_e164, is_primary) VALUES
      (${TENANT}, ${CONTACT}, ${SELLER}, ${LEAD_NUMBER}, true),
      (${TENANT}, ${OTHER_CONTACT}, ${OTHER_SELLER}, ${LEAD_NUMBER}, true)`
})

afterAll(async () => {
  await owner.end()
})

describe('the declared field table and the SQL agree', () => {
  it('implements every classified field the way its class requires', async () => {
    // 🎯 THIS IS WHAT MAKES `CALL_MERGE` A GATE RATHER THAN A COMMENT. The
    // classification lives in TypeScript and the behaviour lives in plpgsql;
    // without this they are two documents that can drift, and the symptom of
    // drift is a timeline entry that looks fine and is merely missing its
    // transcript — which nobody ever reports.
    const [fn] = await owner<{ src: string }[]>`
      SELECT prosrc AS src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'app' AND p.proname = 'call_merge'`
    // Whitespace is normalised so the assertion is about the RULE and not about
    // how the SQL happens to be aligned. A gate that fails on indentation gets
    // relaxed, and a relaxed gate stops catching what it was written for.
    const src = (fn?.src ?? '').replace(/\s+/g, ' ')
    expect(src.length).toBeGreaterThan(0)

    const snake = (s: string): string => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)

    for (const [field, kind] of Object.entries(CALL_MERGE)) {
      const column = snake(field)
      if (kind === 'additive') {
        // Order-free: COALESCE(new, old), and nothing else.
        expect(src, `${column} is additive`).toContain(
          `COALESCE(EXCLUDED.${column}, app.call.${column})`,
        )
      } else {
        // Corrective, and all THREE arms are asserted — the clock guard alone is
        // what loses a disposition when an event that does not carry one
        // arrives with a newer timestamp.
        const assignment = src.slice(src.indexOf(`${column} = CASE`))
        expect(assignment, `${column} keeps a value an omitting delivery cannot erase`).toContain(
          `WHEN EXCLUDED.${column} IS NULL THEN app.call.${column}`,
        )
        expect(assignment, `${column} fills an empty field regardless of clock`).toContain(
          `WHEN app.call.${column} IS NULL THEN EXCLUDED.${column}`,
        )
        expect(assignment, `${column} lets the provider clock arbitrate`).toContain(
          'EXCLUDED.provider_last_event_at >= app.call.provider_last_event_at',
        )
      }
    }
  })
})

describe('merge, never insert', () => {
  it('lands four deliveries about one call on one row', async () => {
    const ids = [
      await deliver(INITIATED),
      await deliver(DISPOSED),
      await deliver(RECORDED),
      await deliver(SUMMARISED),
    ]
    for (const id of ids) await merge(id)

    const [count] = await owner<{ n: string }[]>`
      SELECT count(*) AS n FROM app.call WHERE tenant_id = ${TENANT}`
    expect(Number(count?.n ?? '0')).toBe(1)

    const row = await snapshot()
    expect(row?.state).toBe('completed')
    expect(row?.state_ordinal).toBe(90)
    expect(row?.direction).toBe('outbound')
    expect(row?.owner_user_id).toBe(SELLER)
    expect(row?.contact_id).toBe(CONTACT)
    expect(row?.disposition_raw).toBe('No Answer')
    expect(row?.talk_time_seconds).toBe(63)
    expect(row?.wait_time_seconds).toBe(2)
    expect(row?.recording_url).toContain('static/recording/')
    expect(row?.ai_summary_text).toContain('confirmed coverage')
    // No source in the capture: `transcription` is an object of ids, not a URL.
    expect(row?.transcript_url).toBeNull()
  })

  it('attributes the call to the seller who holds the number, not the other one', async () => {
    // Both sellers have a contact with this phone. The owner is resolved FIRST,
    // from the identity map, and the contact lookup is then scoped to that
    // owner's book — never tenant-wide.
    const row = await snapshot()
    expect(row?.owner_user_id).toBe(SELLER)
    expect(row?.contact_id).toBe(CONTACT)
    expect(row?.contact_id).not.toBe(OTHER_CONTACT)
  })
})

describe('out-of-order tolerance is a property, not a happy path (ARR-INT-06)', () => {
  it('produces an IDENTICAL row for all 24 arrival orders', async () => {
    // ARR-INT-06's real requirement is "final state must equal in-order state".
    // Expressed as a test rather than as prose, that is: permute the arrival
    // order of a fixed webhook set and assert the final row is byte-identical
    // across every permutation.
    //
    // 🔬 IT ALREADY EARNED ITS PLACE. Writing it is what showed that
    // `provider_created_at` was being merged with COALESCE(old, new) — "first
    // arrival wins" — which made the stored value depend on delivery order.
    // `LEAST` is commutative; that was a real defect and no other test saw it.
    const ids = [
      await deliver(INITIATED + ' '),
      await deliver(DISPOSED + ' '),
      await deliver(RECORDED + ' '),
      await deliver(SUMMARISED + ' '),
    ]

    const permutations = <T>(xs: readonly T[]): T[][] =>
      xs.length <= 1
        ? [[...xs]]
        : xs.flatMap((x, i) =>
            permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((rest) => [x, ...rest]),
          )

    const orders = permutations(ids)
    expect(orders).toHaveLength(24)

    let reference: Snapshot | undefined
    for (const order of orders) {
      await owner`DELETE FROM app.call WHERE tenant_id = ${TENANT} AND aloware_call_id = ${CALL_ID}`
      for (const id of order) await merge(id)

      const row = await snapshot()
      expect(row).toBeDefined()
      if (reference === undefined) reference = row
      else expect(row).toEqual(reference)
    }

    // 🔴 AND THE CONVERGED ROW IS ASSERTED FIELD BY FIELD, because CONSISTENCY
    // IS NOT CORRECTNESS and this test proved that about itself.
    //
    // Measured: removing the null-awareness from `disposition_raw`'s corrective
    // rule makes every one of the 24 orderings lose the disposition — so all 24
    // still AGREE, the permutation invariant still holds, and this test passed
    // while the data was gone. A permutation property is necessary and not
    // sufficient; it needs an assertion about the value it converged ON.
    expect(reference?.state).toBe('completed')
    expect(reference?.disposition_raw).toBe('No Answer')
    expect(reference?.talk_time_seconds).toBe(63)
    expect(reference?.wait_time_seconds).toBe(2)
    expect(reference?.recording_url).toContain('static/recording/')
    expect(reference?.ai_summary_text).toContain('confirmed coverage')
    expect(reference?.owner_user_id).toBe(SELLER)
    expect(reference?.contact_id).toBe(CONTACT)
    expect(reference?.provider_created_at).toBe('2026-08-05 20:58:49')
    expect(reference?.provider_last_event_at).toBe('2026-08-05 21:00:04')
  })

  it('refuses to let a late initiated regress a completed call', async () => {
    // The monotonic trigger, on its own. It CLAMPS rather than raising: an
    // out-of-order delivery is normal here, and failing its job would turn a
    // late webhook into a call missing from a seller's history.
    const before = await snapshot()
    expect(before?.state).toBe('completed')

    const late = await deliver(INITIATED + '  ')
    await merge(late)

    const after = await snapshot()
    expect(after?.state).toBe('completed')
    expect(after?.state_ordinal).toBe(90)
  })
})

describe('what the seller can and cannot do to a call', () => {
  it('grants crm_app SELECT on app.call and nothing else', async () => {
    // 🔴 `owner_scoped` + app_can_insert = false would have granted UPDATE here,
    // which is the mistake migrations 0033 and 0034 both made. A seller with
    // UPDATE on their own call rows can manufacture activity: the day strip
    // counts calls, and `last_activity_at`, the 7-day cold rule and the decay
    // rail all read from them.
    const grants = await owner<{ privilege_type: string }[]>`
      SELECT privilege_type FROM information_schema.role_table_grants
       WHERE grantee = 'crm_app' AND table_schema = 'app' AND table_name = 'call'
       ORDER BY privilege_type`
    expect([...grants].map((g) => g.privilege_type)).toEqual(['SELECT'])
  })

  it('hides an unattributable call from every seller', async () => {
    // §5: quarantined means written to NO book. `NULL = app.current_user_id()`
    // is NULL and never true, so the row is invisible rather than misfiled.
    const body = JSON.stringify({
      event: 'InboundPhoneCall-DispositionMissed',
      body: {
        id: 555000111,
        direction: 1,
        current_status2: 9,
        disposition_status2: 3,
        talk_time: 0,
        wait_time: 15,
        user_id: null,
        // A Local Presence pool number: real inbound traffic, no mapping row.
        incoming_number: '+12025550199',
        lead_number: LEAD_NUMBER,
        created_at: CREATED,
        updated_at: CREATED,
      },
    })

    const outcome = await mergeCallFromEvent({
      tenantId: TENANT,
      inboundWebhookEventId: await deliver(body),
      alowareCallId: '555000111',
      canonical: 'call.completed',
    })
    expect(outcome.status).toBe('unmapped')

    const [row] = await owner<{ owner_user_id: string | null; contact_id: string | null }[]>`
      SELECT owner_user_id, contact_id FROM app.call
       WHERE tenant_id = ${TENANT} AND aloware_call_id = '555000111'`
    // Stored — never dropped — and owned by nobody.
    expect(row?.owner_user_id).toBeNull()
    expect(row?.contact_id).toBeNull()
  })
})

describe('the merge refuses what it cannot key', () => {
  it('skips a body that does not parse instead of failing the job', async () => {
    const outcome = await mergeCallFromEvent({
      tenantId: TENANT,
      inboundWebhookEventId: await deliver('not json at all, from the merge test'),
      alowareCallId: 'n/a',
      canonical: 'call.completed',
    })
    expect(outcome).toEqual({ status: 'skipped', reason: 'no_mappable_body' })
  })

  it('skips a job whose payload the vault no longer holds', async () => {
    // Expected rather than exceptional: the retention clock deletes bodies on
    // purpose, and treating that as a failure would dead-letter a row somebody
    // meant to delete.
    const outcome = await mergeCallFromEvent({
      tenantId: TENANT,
      inboundWebhookEventId: '00000000-0000-7000-8000-00000000dead',
      alowareCallId: CALL_ID,
      canonical: 'call.completed',
    })
    expect(outcome).toEqual({ status: 'skipped', reason: 'event_gone' })
  })
})
