import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { APP_URL, OWNER_URL } from './setup/urls'

/**
 * A STOP FROM A LEAD SUPPRESSES — the last assertion Gate 6 had no subject for.
 *
 * 🔴 WHAT WAS MISSING. `message.received` has been in the canonical 49 since
 * 0042 with no emitter, so no inbound text could produce an event, so nothing a
 * lead ever sent could reach `suppression_list`. §581 names the failure as *"a
 * STOP honored on SMS but not on the dialer"* — and it was worse than that,
 * because a STOP was honored on neither.
 *
 * The end-to-end assertion is the last one in the first block: a lead texts
 * STOP, and the very next dial to that number is refused by the gate. That is
 * the legal property; everything else here is the machinery that produces it.
 *
 * ⚠️ THIS DOES NOT CLOSE G6/P24. That assertion adds a clock — the suppression
 * row within 5 s of the STOP, behind a 20,000-message backlog — and the lanes
 * that would guarantee it (`ref.job_registry.priority`, `05c` §11.7) do not
 * exist in this tree. Correctness is here; latency is not.
 */

const TENANT = '00000000-0000-7000-8000-000000690069'
const SELLER = '00000000-0000-7000-8000-0000006900a1'
const OTHER_SELLER = '00000000-0000-7000-8000-0000006900a2'
const SEAT = 690069
const OUR_NUMBER = '+13125550690'
const UNVERIFIED_NUMBER = '+13125550691'

const STOPPER = '00000000-0000-7000-8000-0000006900c1'
const CHATTER = '00000000-0000-7000-8000-0000006900c2'
const STOPPER_PHONE = '+14155550690'
const CHATTER_PHONE = '+14155550692'

let owner: postgres.Sql
let app: postgres.Sql

/** One unit of system work, exactly as the merge job runs. */
async function asSystem<T>(work: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  const result = await app.begin(async (tx) => {
    await tx`SELECT app.begin_system_work(${TENANT}::uuid)`
    return work(tx)
  })
  return result as T
}

async function merge(opts: {
  providerMessageId: string
  body: string
  direction?: 'inbound' | 'outbound'
  state?: 'received' | 'failed'
  leadNumber?: string
  ourNumber?: string
}): Promise<string> {
  return asSystem(async (tx) => {
    const rows = await tx<{ outcome: string }[]>`
      SELECT app.message_merge(
        ${opts.providerMessageId},
        ${opts.state ?? 'received'},
        ${opts.direction ?? 'inbound'},
        NULL::bigint,
        ${opts.ourNumber ?? OUR_NUMBER},
        ${opts.leadNumber ?? STOPPER_PHONE},
        ${opts.body},
        NULL,
        clock_timestamp(),
        clock_timestamp()
      ) AS outcome`
    return rows[0]?.outcome ?? 'no row'
  })
}

/** The gate itself, in a real seller session. */
async function gateVerdict(userId: string, contactId: string): Promise<string> {
  const result = await app.begin(async (tx) => {
    await tx`SELECT app.begin_request(${TENANT}::uuid, ${userId}::uuid)`
    const rows = await tx<{ verdict: string }[]>`
      SELECT verdict::text AS verdict
        FROM app.compliance_attempt(${contactId}::uuid, 'call', 'dial_button')`
    return rows[0]?.verdict ?? 'no row'
  })
  return result
}

const countOf = async (table: string, phone: string): Promise<number> => {
  const [row] = await owner<{ n: string }[]>`
    SELECT count(*) AS n FROM ${owner(table)}
     WHERE tenant_id = ${TENANT} AND ${owner(table === 'app.suppression_list' ? 'phone_e164' : 'contact_value_norm')} = ${phone}`
  return Number.parseInt(row?.n ?? '0', 10)
}

beforeAll(async () => {
  owner = postgres(OWNER_URL, { max: 1, onnotice: () => {} })
  app = postgres(APP_URL, { max: 1, onnotice: () => {} })

  await owner`
    INSERT INTO app.tenant (id, name, business_tz)
    VALUES (${TENANT}, 'STOP Agency', 'America/Chicago')`
  await owner`
    INSERT INTO app.app_user (tenant_id, id, email, full_name, display_name, role) VALUES
      (${TENANT}, ${SELLER}, 'stop-seller@stop.test', 'Sara Stop', 'Sara S.', 'seller'),
      (${TENANT}, ${OTHER_SELLER}, 'other@stop.test', 'Omar Other', 'Omar O.', 'seller')`

  // VERIFIED, which is what lets the chain run at all. The unverified row below
  // is the forged-webhook case and is deliberately left unverified.
  await owner`
    INSERT INTO app.aloware_number_mapping
      (tenant_id, owner_user_id, aloware_user_id, aloware_line_id, from_number_e164, verified_at)
    VALUES (${TENANT}, ${SELLER}, ${SEAT}, 63951, ${OUR_NUMBER}, clock_timestamp())`
  await owner`
    INSERT INTO app.aloware_number_mapping
      (tenant_id, owner_user_id, aloware_user_id, aloware_line_id, from_number_e164, verified_at)
    VALUES (${TENANT}, ${OTHER_SELLER}, ${SEAT + 1}, 63952, ${UNVERIFIED_NUMBER}, NULL)`

  // Texas: two zones and one-party recording, so the calling-window and
  // recording gates do not decide the verdict this file is about. `dial.test.ts`
  // learned that the hard way with Florida.
  await owner`
    INSERT INTO app.contact (tenant_id, id, owner_user_id, full_name, created_via, state_code, zip5) VALUES
      (${TENANT}, ${STOPPER}, ${SELLER}, 'Sam Stopper', 'manual', 'TX', '75201'),
      (${TENANT}, ${CHATTER}, ${SELLER}, 'Cora Chatter', 'manual', 'TX', '75201')`
  await owner`
    INSERT INTO app.contact_phone (tenant_id, contact_id, owner_user_id, phone_e164, is_primary) VALUES
      (${TENANT}, ${STOPPER}, ${SELLER}, ${STOPPER_PHONE}, true),
      (${TENANT}, ${CHATTER}, ${SELLER}, ${CHATTER_PHONE}, true)`
})

afterAll(async () => {
  await owner?.end()
  await app?.end()
})

describe('a STOP reaches the dialer', () => {
  it('writes consent, suppression and the event in ONE transaction, then blocks the dial', async () => {
    expect(await merge({ providerMessageId: 'stop-1', body: 'STOP' })).toBe('resolved')

    // The consent row: the legal record of the revocation.
    const [consent] = await owner<{ status: string; source: string; actor: string | null }[]>`
      SELECT status::text AS status, source::text AS source, actor_user_id AS actor
        FROM app.consent_ledger
       WHERE tenant_id = ${TENANT} AND contact_value_norm = ${STOPPER_PHONE}`
    expect(consent?.status).toBe('revoked')
    expect(consent?.source).toBe('stop_keyword')
    // No human did this. `current_user_id()` is NULL under system work, and a
    // uuid here would be a person's name on a machine's decision.
    expect(consent?.actor).toBeNull()

    // The suppression row: what the gate actually reads on every attempt.
    const [suppression] = await owner<{ kind: string; channel: string | null }[]>`
      SELECT kind::text AS kind, channel::text AS channel
        FROM app.suppression_list
       WHERE tenant_id = ${TENANT} AND phone_e164 = ${STOPPER_PHONE}`
    expect(suppression?.kind).toBe('stop')
    // 🔴 CHANNEL-WIDE. §2721: a STOP suppresses call AND text. Scoped to 'sms'
    // it would leave the dialer free to call a number that just said stop.
    expect(suppression?.channel).toBeNull()

    const [event] = await owner<{ name: string; payload: { intent_hint: string } }[]>`
      SELECT event_name AS name, payload
        FROM app.event_log
       WHERE tenant_id = ${TENANT} AND subject_id = (
         SELECT id FROM app.message WHERE tenant_id = ${TENANT} AND provider_message_id = 'stop-1')`
    expect(event?.name).toBe('message.received')
    expect(event?.payload.intent_hint).toBe('stop')

    // 🎯 THE ASSERTION THE WHOLE FILE EXISTS FOR. Before this migration the
    // gate had nothing to read and this dial went through.
    expect(await gateVerdict(SELLER, STOPPER)).toBe('blocked_suppressed')
  })

  it('suppresses for EVERY seller in the tenant, not only the one who was texted', async () => {
    // 🔴 THE TABLE HAS NO OWNER COLUMN AT ALL, and that absence IS the
    // mechanism — `suppression_list` is the one table in this schema that is
    // deliberately not owner-scoped, because a STOP given to one seller binds
    // every seller in the tenant. Asserting against the catalog rather than
    // against a row says so in the form that would actually break if somebody
    // "fixed" the inconsistency by adding the column everything else has.
    const [row] = await owner<{ n: string }[]>`
      SELECT count(*) AS n FROM information_schema.columns
       WHERE table_schema = 'app' AND table_name = 'suppression_list'
         AND column_name = 'owner_user_id'`
    expect(row?.n).toBe('0')

    // And the registry agrees, which is what harden() builds the policy from.
    const [cls] = await owner<{ policy_class: string }[]>`
      SELECT policy_class FROM security.table_registry
       WHERE schema_name = 'app' AND table_name = 'suppression_list'`
    expect(cls?.policy_class).not.toContain('owner')
  })
})

describe('what must NOT suppress', () => {
  it('reads a sentence containing the word as an ordinary reply', async () => {
    // 🔴 THE FALSE POSITIVE IS THE DANGEROUS DIRECTION. Suppression is
    // tenant-wide and this slice ships no un-suppress path, so a substring match
    // would silently delete a lead from every seller's reach for good.
    expect(
      await merge({
        providerMessageId: 'reply-1',
        body: 'please don’t stop calling me, I want to talk',
        leadNumber: CHATTER_PHONE,
      }),
    ).toBe('resolved')

    expect(await countOf('app.suppression_list', CHATTER_PHONE)).toBe(0)
    expect(await countOf('app.consent_ledger', CHATTER_PHONE)).toBe(0)
    expect(await gateVerdict(SELLER, CHATTER)).not.toBe('blocked_suppressed')

    const [event] = await owner<{ payload: { intent_hint: string } }[]>`
      SELECT payload FROM app.event_log
       WHERE tenant_id = ${TENANT} AND subject_id = (
         SELECT id FROM app.message WHERE tenant_id = ${TENANT} AND provider_message_id = 'reply-1')`
    expect(event?.payload.intent_hint).toBe('reply')
  })

  it('ignores the word in a message WE sent', async () => {
    await merge({
      providerMessageId: 'outbound-1',
      body: 'STOP',
      direction: 'outbound',
      leadNumber: CHATTER_PHONE,
    })
    expect(await countOf('app.suppression_list', CHATTER_PHONE)).toBe(0)
  })

  it('never reaches the chain from an UNVERIFIED number — the forged-STOP case', async () => {
    // §1797(3): a webhook whose destination does not match a verified mapping is
    // quarantined and never reaches the domain, "which means, in particular, it
    // never reaches the STOP chain". A forged inbound STOP is a denial of
    // service against a seller's book, and this is what bounds it.
    expect(
      await merge({
        providerMessageId: 'forged-1',
        body: 'STOP',
        ourNumber: UNVERIFIED_NUMBER,
        leadNumber: CHATTER_PHONE,
      }),
    ).toBe('unmapped')

    expect(await countOf('app.suppression_list', CHATTER_PHONE)).toBe(0)
    expect(await countOf('app.consent_ledger', CHATTER_PHONE)).toBe(0)
  })
})

describe('a restated delivery is not a second STOP', () => {
  it('appends once no matter how many times the provider restates it', async () => {
    // G2 measured that Aloware restates the same message with DIFFERENT bytes
    // seconds later, so this function runs more than once per real message by
    // design. Without the `xmax = 0` guard each restatement would append another
    // consent row and another suppression row for one STOP.
    await merge({ providerMessageId: 'stop-1', body: 'STOP' })
    await merge({ providerMessageId: 'stop-1', body: 'STOP' })

    expect(await countOf('app.suppression_list', STOPPER_PHONE)).toBe(1)
    expect(await countOf('app.consent_ledger', STOPPER_PHONE)).toBe(1)

    const [row] = await owner<{ n: string }[]>`
      SELECT count(*) AS n FROM app.event_log
       WHERE tenant_id = ${TENANT} AND event_name = 'message.received'
         AND subject_id = (SELECT id FROM app.message
                            WHERE tenant_id = ${TENANT} AND provider_message_id = 'stop-1')`
    expect(row?.n).toBe('1')
  })
})

describe('the keyword set, matched whole and never as a substring', () => {
  const cases: readonly (readonly [string, string | null])[] = [
    ['STOP', 'stop'],
    ['stop', 'stop'],
    [' Stop. ', 'stop'],
    ['STOP!', 'stop'],
    ['STOP ALL', 'stop'],
    ['UNSUBSCRIBE', 'stop'],
    ['Cancel', 'stop'],
    ['END', 'stop'],
    ['QUIT', 'stop'],
    ['HELP', 'help'],
    ['info', 'help'],
    // The four that must not suppress.
    ['please don’t stop calling me', 'reply'],
    ['stop by the office Tuesday', 'reply'],
    ['I want to stop', 'reply'],
    ['STOP CALLING', 'reply'],
    // No opt-back-in intent exists in the canonical enum, so START is a reply.
    ['START', 'reply'],
    ['', null],
    ['   ', null],
  ]

  it.each(cases)('classifies %j as %s', async (body, expected) => {
    const [row] = await owner<{ intent: string | null }[]>`
      SELECT app.sms_intent_of(${body}) AS intent`
    expect(row?.intent ?? null).toBe(expected)
  })
})
