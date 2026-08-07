import { createHash } from 'node:crypto'

import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { OWNER_URL, TEST_URL } from './setup/urls'

/**
 * The two tables the ingest edge writes — `raw_payload_vault` and
 * `inbound_webhook_event` — asserted against the engine.
 *
 * Gate G2 turned every one of these from a performance property into a
 * correctness one: **Aloware never retries**, so a delivery the edge fails to
 * keep is gone for good, and there is no call-list API to reconcile against.
 */

const TENANT = '00000000-0000-7000-8000-0000000e6e00'

let owner: postgres.Sql
let sql: postgres.Sql

const digestOf = (body: string): Buffer => createHash('sha256').update(body).digest()

/** Stores a body as the OWNER — the app role has no INSERT, by design. */
async function vault(body: string): Promise<string> {
  const [row] = await owner<{ id: string }[]>`
    INSERT INTO app.raw_payload_vault (tenant_id, provider, body, body_sha256, purge_after)
    VALUES (${TENANT}, 'aloware', ${Buffer.from(body, 'utf8')}, ${digestOf(body)},
            clock_timestamp() + interval '30 days')
    RETURNING id`
  if (row === undefined) throw new Error('no vault id')
  return row.id
}

beforeAll(async () => {
  owner = postgres(OWNER_URL, { max: 1, onnotice: () => {} })
  sql = postgres(TEST_URL, { max: 1, onnotice: () => {} })
  await owner`
    INSERT INTO app.tenant (id, name, business_tz)
    VALUES (${TENANT}, 'Ingest Agency', 'America/New_York')`
})

afterAll(async () => {
  await owner.end()
  await sql.end()
})

describe('the application cannot write either table', () => {
  it('grants crm_app SELECT and nothing else', async () => {
    // §4.2 ruling 1: the vault write, the dedupe insert and the job enqueue are
    // ONE call in ONE transaction — `app.webhook_ingest()`, a definer function,
    // not yet written. Granting INSERT before it exists is how the shortcut
    // becomes the design.
    for (const table of ['raw_payload_vault', 'inbound_webhook_event']) {
      const grants = await sql<{ privilege_type: string }[]>`
        SELECT privilege_type FROM information_schema.role_table_grants
         WHERE grantee = 'crm_app' AND table_schema = 'app' AND table_name = ${table}
         ORDER BY privilege_type`
      expect([...grants].map((g) => g.privilege_type)).toEqual(['SELECT'])
    }
  })
})

describe('the vault refuses a row that is not internally consistent', () => {
  it('refuses a digest that does not match the body beside it', async () => {
    await expect(
      owner`
        INSERT INTO app.raw_payload_vault (tenant_id, provider, body, body_sha256, purge_after)
        VALUES (${TENANT}, 'aloware', ${Buffer.from('{"a":1}', 'utf8')},
                ${digestOf('{"different":true}')}, clock_timestamp() + interval '30 days')`,
    ).rejects.toThrow(/raw_payload_vault_digest_matches/)
  })

  it('refuses an empty body — a delivery with no bytes is not a delivery', async () => {
    await expect(
      owner`
        INSERT INTO app.raw_payload_vault (tenant_id, provider, body, body_sha256, purge_after)
        VALUES (${TENANT}, 'aloware', ${Buffer.alloc(0)}, ${digestOf('')},
                clock_timestamp() + interval '30 days')`,
    ).rejects.toThrow(/raw_payload_vault_body_present/)
  })

  it('refuses a purge clock that has already passed', async () => {
    await expect(
      owner`
        INSERT INTO app.raw_payload_vault (tenant_id, provider, body, body_sha256, purge_after)
        VALUES (${TENANT}, 'aloware', ${Buffer.from('x', 'utf8')}, ${digestOf('x')},
                clock_timestamp() - interval '1 day')`,
    ).rejects.toThrow(/raw_payload_vault_purge_after_receipt/)
  })
})

describe('the transport rung of the idempotency ladder', () => {
  const BODY = '{"event":"OutboundPhoneCall","body":{"id":940868616}}'
  const KEY = digestOf(BODY).toString('hex')

  it('accepts the first delivery and REFUSES the second with the same digest', async () => {
    // 🔴 THIS INDEX IS A SECURITY CONTROL, not only an idempotency convenience.
    // Aloware's webhook form offers None · Basic · Bearer and no HMAC, so
    // nothing in a delivery proves freshness and a captured request replays
    // forever. This is the only thing standing between that and unlimited replay.
    const first = await vault(BODY)
    const second = await vault(BODY)

    await owner`
      INSERT INTO app.inbound_webhook_event
        (tenant_id, provider, provider_event_id, raw_payload_id, provider_event,
         aloware_call_id, parse_status)
      VALUES (${TENANT}, 'aloware', ${KEY}, ${first}, 'OutboundPhoneCall', '940868616', 'parsed')`

    await expect(
      owner`
        INSERT INTO app.inbound_webhook_event
          (tenant_id, provider, provider_event_id, raw_payload_id, provider_event,
           aloware_call_id, parse_status)
        VALUES (${TENANT}, 'aloware', ${KEY}, ${second}, 'OutboundPhoneCall', '940868616', 'parsed')`,
    ).rejects.toThrow(/inbound_webhook_event_transport_uidx/)
  })

  it('refuses a key that is not a full sha256', async () => {
    // A truncated key collides across unrelated deliveries, and on THIS index a
    // collision means silently dropping a real event as a duplicate.
    const payload = await vault('{"event":"Recording-Saved"}')
    await expect(
      owner`
        INSERT INTO app.inbound_webhook_event
          (tenant_id, provider, provider_event_id, raw_payload_id, parse_status)
        VALUES (${TENANT}, 'aloware', 'deadbeef', ${payload}, 'parsed')`,
    ).rejects.toThrow(/inbound_webhook_event_digest_shape/)
  })

  it('stores an UNPARSED delivery rather than refusing it', async () => {
    // The whole point of the vault. A body the extractor could not read is kept
    // with all-null keys, because a parser that refused would turn a mapping bug
    // into permanent data loss.
    const body = 'this is not json'
    const payload = await vault(body)
    const [row] = await owner<{ parse_status: string; aloware_call_id: string | null }[]>`
      INSERT INTO app.inbound_webhook_event
        (tenant_id, provider, provider_event_id, raw_payload_id, parse_status)
      VALUES (${TENANT}, 'aloware', ${digestOf(body).toString('hex')}, ${payload}, 'unparsed')
      RETURNING parse_status, aloware_call_id`

    expect(row?.parse_status).toBe('unparsed')
    expect(row?.aloware_call_id).toBeNull()
  })

  it('refuses an invented parse status', async () => {
    const payload = await vault('{"event":"x"}')
    await expect(
      owner`
        INSERT INTO app.inbound_webhook_event
          (tenant_id, provider, provider_event_id, raw_payload_id, parse_status)
        VALUES (${TENANT}, 'aloware', ${digestOf('{"event":"x"}').toString('hex')}, ${payload},
                'probably_fine')`,
    ).rejects.toThrow(/inbound_webhook_event_parse_status/)
  })
})
