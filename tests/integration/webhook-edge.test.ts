import { createHash } from 'node:crypto'

import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { CALL_MERGE_QUEUE } from '~/jobs/queues'
import { action } from '~/routes/api/webhooks-aloware'

import { OWNER_URL } from './setup/urls'

/**
 * `POST /webhooks/aloware/v1/{endpoint_token}` — the edge, exercised end to end.
 *
 * The route module is imported directly, the same way `dial.test.ts` reaches
 * `dialFor`, so what runs here is the real handler over the real pool against
 * the real privilege set: `DATABASE_URL` points at `crm_test` as `crm_app`.
 *
 * ⚠️ EVERY BODY BELOW IS SYNTHETIC, and that is a requirement rather than
 * laziness. The 22 captured deliveries carry a real lead's phone number from the
 * production book, `evidence/` is git-ignored for exactly that reason, and a
 * test reading it would pass on the owner's machine and fail in CI — which is
 * the same "green by absence" defect the pg-boss gap just produced in
 * `silo.test.ts`. The SHAPES are the captured ones; the values are not.
 */

const TENANT = '00000000-0000-7000-8000-000000350037'
const TOKEN = 'edge-test-token-0035'

let owner: postgres.Sql

const digestOf = (body: Buffer): Buffer => createHash('sha256').update(body).digest()
const keyOf = (body: Buffer): string => digestOf(body).toString('hex')

/** Drives the handler exactly as the framework would. */
async function deliver(
  body: Buffer | string,
  opts: { token?: string; method?: string; contentLength?: string } = {},
): Promise<Response> {
  const raw = typeof body === 'string' ? Buffer.from(body, 'utf8') : body
  const token = opts.token ?? TOKEN
  const method = opts.method ?? 'POST'

  const headers = new Headers({ 'content-type': 'application/json' })
  if (opts.contentLength !== undefined) headers.set('content-length', opts.contentLength)

  const request = new Request(`https://in.example.com/webhooks/aloware/v1/${token}`, {
    method,
    headers,
    ...(method === 'POST' ? { body: new Uint8Array(raw) } : {}),
  })

  return action({ request, params: { endpointToken: token } })
}

const storedRows = async (body: Buffer | string): Promise<number> => {
  const raw = typeof body === 'string' ? Buffer.from(body, 'utf8') : body
  const [row] = await owner<{ n: string }[]>`
    SELECT count(*) AS n FROM app.inbound_webhook_event
     WHERE provider_event_id = ${keyOf(raw)}`
  return Number(row?.n ?? '0')
}

beforeAll(async () => {
  owner = postgres(OWNER_URL, { max: 1, onnotice: () => {} })
  await owner`
    INSERT INTO app.tenant (id, name, business_tz)
    VALUES (${TENANT}, 'Edge Agency', 'America/Denver')`
  await owner`
    INSERT INTO app.webhook_endpoint (tenant_id, provider, token_sha256, label)
    VALUES (${TENANT}, 'aloware', ${digestOf(Buffer.from(TOKEN, 'utf8'))}, 'edge test')`
})

afterAll(async () => {
  await owner.end()
})

describe('the happy path is a 204 and a row', () => {
  const BODY =
    '{"event":"OutboundPhoneCall-DispositionCompleted","body":{"id":770770,"direction":2}}'

  it('stores the delivery and enqueues the merge', async () => {
    const response = await deliver(BODY)

    expect(response.status).toBe(204)
    // Nothing readable comes back. The provider can act on none of it.
    expect(await response.text()).toBe('')
    expect(response.headers.get('cache-control')).toBe('no-store')

    expect(await storedRows(BODY)).toBe(1)

    const jobs = await owner<{ singleton_key: string | null }[]>`
      SELECT singleton_key FROM pgboss.job
       WHERE name = ${CALL_MERGE_QUEUE} AND singleton_key = '770770'`
    expect([...jobs]).toHaveLength(1)
  })

  it('answers the replay 204 as well, and stores nothing new', async () => {
    // 🔴 A REPLAY MUST NOT BE DISTINGUISHABLE IN THE STATUS CODE. §4.2 ruling 4:
    // never 4xx for a payload we already hold. A 409 here would be truthful and
    // would also invite a well-behaved provider to change its behaviour over
    // something it cannot act on.
    expect((await deliver(BODY)).status).toBe(204)
    expect(await storedRows(BODY)).toBe(1)
  })
})

describe('the only refusals', () => {
  it('answers 401 for a token nobody issued, and stores nothing', async () => {
    const body = '{"event":"OutboundPhoneCall","body":{"id":881881}}'
    const response = await deliver(body, { token: 'not-a-real-token' })

    expect(response.status).toBe(401)
    expect(await storedRows(body)).toBe(0)
    // No scheme to name — the credential is a path segment — and no body,
    // because a description of what was wrong helps whoever is guessing.
    expect(response.headers.get('www-authenticate')).toBeNull()
  })

  it('answers 405 for a method that is not POST', async () => {
    const response = await deliver('', { method: 'GET' })
    expect(response.status).toBe(405)
    expect(response.headers.get('allow')).toBe('POST')
  })

  it('refuses a body over the cap by its actual size, and stores nothing', async () => {
    // Refused, never truncated: truncating changes the bytes, the bytes are the
    // digest, and the digest is the only replay defence there is. A truncated
    // payload would be stored under a key describing something never sent.
    const huge = Buffer.alloc(256 * 1024 + 1, 0x41)
    const response = await deliver(huge)

    expect(response.status).toBe(413)
    expect(await storedRows(huge)).toBe(0)
  })

  it('refuses on a declared content-length before reading the body', async () => {
    // The header is a claim and the byte count is a fact; both are checked. A
    // chunked body arrives with no content-length at all, which is why the
    // header check alone would not be enough.
    const response = await deliver('{"event":"x"}', { contentLength: String(256 * 1024 + 1) })
    expect(response.status).toBe(413)
  })
})

describe('what the edge refuses to lose', () => {
  it('accepts a body that is not JSON and stores it unparsed', async () => {
    // The whole point of the vault. Aloware never retries, so a body the
    // extractor cannot read is a row we can replay or a delivery that is gone,
    // and there is no third option.
    const body = 'this is definitely not json'
    expect((await deliver(body)).status).toBe(204)

    const [row] = await owner<{ parse_status: string; provider_event: string | null }[]>`
      SELECT parse_status, provider_event FROM app.inbound_webhook_event
       WHERE provider_event_id = ${keyOf(Buffer.from(body, 'utf8'))}`
    expect(row?.parse_status).toBe('unparsed')
    expect(row?.provider_event).toBeNull()
  })

  it('stores bytes that are not valid UTF-8 EXACTLY, digest and all', async () => {
    // 🎯 THE ASSERTION THAT PROTECTS THE DECODE. The handler calls
    // `raw.toString('utf8')` to feed the extractor, and that substitutes U+FFFD
    // for invalid bytes — so if the DECODED string were what got stored, or what
    // got hashed, these bytes would be silently corrupted and keyed under a
    // digest of something else.
    //
    // The vault receives the raw Buffer and `provider_event_id` is computed as
    // `sha256()` INSIDE the database, so the lossy decode can cost a
    // `parse_status` and nothing more.
    const body = Buffer.from([0x7b, 0xff, 0xfe, 0x80, 0x9f, 0x7d])
    expect((await deliver(body)).status).toBe(204)

    const [row] = await owner<{ body: Buffer; matches: boolean }[]>`
      SELECT v.body, v.body_sha256 = ${digestOf(body)} AS matches
        FROM app.raw_payload_vault v
        JOIN app.inbound_webhook_event w
          ON w.tenant_id = v.tenant_id AND w.raw_payload_id = v.id
       WHERE w.provider_event_id = ${keyOf(body)}`

    expect(row?.matches).toBe(true)
    // Byte for byte. `toEqual` on Buffers compares contents.
    expect(row?.body).toEqual(body)
  })

  it('accepts a zero-byte delivery without storing one', async () => {
    // There is nothing in it to replay, and the vault's own
    // `raw_payload_vault_body_present` CHECK would refuse the row. Still a 2xx:
    // no payload here can be lost.
    const response = await deliver(Buffer.alloc(0))
    expect(response.status).toBe(204)
  })

  it('accepts an event name we have never seen, and maps it to nothing', async () => {
    // An unlisted name yields `canonical: null` — a visible unmapped delivery
    // rather than a confident wrong answer. A regex over the name would be
    // shorter and would swallow whatever the provider adds next month.
    const body = '{"event":"SomethingAlowareShipsNextMonth","body":{"id":991991}}'
    expect((await deliver(body)).status).toBe(204)

    const [row] = await owner<{ provider_event: string | null; aloware_call_id: string | null }[]>`
      SELECT provider_event, aloware_call_id FROM app.inbound_webhook_event
       WHERE provider_event_id = ${keyOf(Buffer.from(body, 'utf8'))}`
    expect(row?.provider_event).toBe('SomethingAlowareShipsNextMonth')
    expect(row?.aloware_call_id).toBe('991991')

    const jobs = await owner<{ n: string }[]>`
      SELECT count(*) AS n FROM pgboss.job
       WHERE name = ${CALL_MERGE_QUEUE} AND singleton_key = '991991'`
    expect(Number(jobs[0]?.n ?? '-1')).toBe(0)
  })

  it('finds the transcription id two levels down, where the provider hides it', async () => {
    // `transcription.*` carries no `body.id`; its communication id sits at
    // `body.communication.id`. Literally shallow extraction returns null here
    // and the transcript can never be attached to its call.
    const body =
      '{"event":"transcription.call.summarized","body":{"communication":{"id":662662},"summary":"x"}}'
    expect((await deliver(body)).status).toBe(204)

    const [row] = await owner<{ aloware_call_id: string | null }[]>`
      SELECT aloware_call_id FROM app.inbound_webhook_event
       WHERE provider_event_id = ${keyOf(Buffer.from(body, 'utf8'))}`
    expect(row?.aloware_call_id).toBe('662662')
  })
})
