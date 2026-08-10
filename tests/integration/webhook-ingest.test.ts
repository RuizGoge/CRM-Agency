import { createHash } from 'node:crypto'

import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { CALL_MERGE_POLICY, CALL_MERGE_QUEUE } from '~/jobs/queues'

import { APP_URL, OWNER_URL } from './setup/urls'

/**
 * `app.webhook_ingest()` — §4.2 ruling 1, asserted against the engine.
 *
 * The vault write, the transport-dedupe insert and the job enqueue are ONE call
 * inside ONE transaction. Everything here exists because Gate G2 turned this
 * from a performance property into a correctness one: **Aloware never retries,
 * never signs, and sends no event id.** A delivery the edge fails to keep is
 * gone, and there is no call-list API to reconcile against.
 */

const TENANT = '00000000-0000-7000-8000-000000350035'
const OTHER_TENANT = '00000000-0000-7000-8000-000000350036'
const TOKEN = 'ingest-test-token-0035'
const OTHER_TOKEN = 'ingest-test-token-other'

let owner: postgres.Sql
let app: postgres.Sql

const digestOf = (body: string): Buffer => createHash('sha256').update(body).digest()
const keyOf = (body: string): string => digestOf(body).toString('hex')

/** One captured shape per fact under test, all from the G2 corpus. */
const DISPOSITION =
  '{"event":"OutboundPhoneCall-DispositionCompleted","body":{"id":940868616,"direction":2,"talk_time":63}}'
/**
 * The SAME call, restated 6.6 s later with different bytes — the finding that
 * makes `sha256(body)` insufficient on its own and `key_strict_fifo` necessary.
 */
const RESTATED = '{"event":"Call-Disposed","body":{"id":940868616,"direction":2,"talk_time":63}}'
/** The provider's own probe. Valid JSON, no event, no id — a delivery, not a fact. */
const TEST_PAYLOAD = '{"test_payload":true}'

async function ingest(
  body: string,
  opts: {
    token?: string
    providerEvent?: string | null
    canonical?: string | null
    callId?: string | null
    parseStatus?: string
    signatureValid?: boolean | null
    on?: postgres.Sql
  } = {},
): Promise<string> {
  const conn = opts.on ?? owner
  const [row] = await conn<{ outcome: string }[]>`
    SELECT app.webhook_ingest(
      ${opts.token ?? TOKEN},
      ${Buffer.from(body, 'utf8')},
      ${opts.providerEvent ?? null},
      ${opts.canonical ?? null},
      ${opts.callId ?? null},
      ${opts.parseStatus ?? 'parsed'},
      ${opts.signatureValid ?? null}
    ) AS outcome`
  if (row === undefined) throw new Error('webhook_ingest returned no row')
  return row.outcome
}

const vaultCount = async (body: string): Promise<number> => {
  const [row] = await owner<{ n: string }[]>`
    SELECT count(*) AS n FROM app.raw_payload_vault WHERE body_sha256 = ${digestOf(body)}`
  return Number(row?.n ?? '0')
}

const jobsFor = async (
  callId: string,
): Promise<{ policy: string | null; singleton_key: string | null; data: unknown }[]> => {
  const rows = await owner<
    { policy: string | null; singleton_key: string | null; data: unknown }[]
  >`
    SELECT policy, singleton_key, data FROM pgboss.job
     WHERE name = ${CALL_MERGE_QUEUE} AND singleton_key = ${callId}`
  return [...rows]
}

/**
 * Blocks until some backend on this database is waiting on a lock.
 *
 * The concurrency test needs the second delivery to be genuinely parked on the
 * transport index before the first one commits. Anything time-based here is a
 * flaky test on a busy machine and a false pass on a fast one.
 */
async function waitUntilBlocked(timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const [row] = await owner<{ blocked: string }[]>`
      SELECT count(*) AS blocked FROM pg_stat_activity
       WHERE datname = current_database()
         AND wait_event_type = 'Lock'
         AND pid <> pg_backend_pid()`
    if (Number(row?.blocked ?? '0') > 0) return
    if (Date.now() > deadline) {
      throw new Error(
        'No backend ever blocked on a lock. The second delivery never reached the ' +
          'transport index, so this test would be asserting nothing.',
      )
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

beforeAll(async () => {
  owner = postgres(OWNER_URL, { max: 1, onnotice: () => {} })
  app = postgres(APP_URL, { max: 1, onnotice: () => {} })

  await owner`
    INSERT INTO app.tenant (id, name, business_tz) VALUES
      (${TENANT}, 'Ingest Function Agency', 'America/New_York'),
      (${OTHER_TENANT}, 'Another Agency', 'America/Chicago')`

  await owner`
    INSERT INTO app.webhook_endpoint (tenant_id, provider, token_sha256, label) VALUES
      (${TENANT}, 'aloware', ${digestOf(TOKEN)}, 'ingest test endpoint'),
      (${OTHER_TENANT}, 'aloware', ${digestOf(OTHER_TOKEN)}, 'other tenant endpoint')`
})

afterAll(async () => {
  await owner.end()
  await app.end()
})

describe('the four outcomes', () => {
  it('accepts a delivery, stores the bytes, and enqueues one merge job', async () => {
    expect(
      await ingest(DISPOSITION, {
        providerEvent: 'OutboundPhoneCall-DispositionCompleted',
        canonical: 'call.completed',
        callId: '940868616',
      }),
    ).toBe('accepted')

    const [event] = await owner<
      { tenant_id: string; provider_event_id: string; parse_status: string }[]
    >`
      SELECT tenant_id, provider_event_id, parse_status FROM app.inbound_webhook_event
       WHERE provider_event_id = ${keyOf(DISPOSITION)}`

    // The key is BUILT, not received: Aloware's envelope carries no event_id,
    // no delivery_id and no webhook_id anywhere. G2 went looking and found none.
    expect(event?.provider_event_id).toBe(keyOf(DISPOSITION))
    expect(event?.tenant_id).toBe(TENANT)
    expect(await vaultCount(DISPOSITION)).toBe(1)

    const jobs = await jobsFor('940868616')
    expect(jobs).toHaveLength(1)
    expect(jobs[0]?.singleton_key).toBe('940868616')
    expect(jobs[0]?.data).toMatchObject({
      tenantId: TENANT,
      alowareCallId: '940868616',
      canonical: 'call.completed',
    })
  })

  it('answers duplicate for the same bytes and writes NOTHING the second time', async () => {
    // 🔴 The transport index is a SECURITY control, not an idempotency
    // convenience. Nothing in a delivery proves freshness — no signature, no
    // timestamp, no nonce — so a captured request replays forever and this is
    // the only thing in its way.
    const before = await vaultCount(DISPOSITION)

    expect(
      await ingest(DISPOSITION, {
        providerEvent: 'OutboundPhoneCall-DispositionCompleted',
        canonical: 'call.completed',
        callId: '940868616',
      }),
    ).toBe('duplicate')

    // The one that would rot silently: an orphan vault row per replayed
    // delivery. That is PII and a bearer token to call audio, kept with no
    // event row pointing at it — the opposite of what the retention clock does.
    expect(await vaultCount(DISPOSITION)).toBe(before)
    expect(await jobsFor('940868616')).toHaveLength(1)
  })

  it('quarantines an invalid signature: stored, and NO job', async () => {
    // §4.2 ruling 3. Unreachable against Aloware today — G2 established there is
    // no signature, so this is NULL on every real delivery — and written now so
    // the decision exists before the day one appears.
    const body = '{"event":"Recording-Saved","body":{"id":940868999}}'
    expect(
      await ingest(body, {
        providerEvent: 'Recording-Saved',
        canonical: 'call.enriched',
        callId: '940868999',
        signatureValid: false,
      }),
    ).toBe('quarantined')

    expect(await vaultCount(body)).toBe(1)
    expect(await jobsFor('940868999')).toHaveLength(0)
  })

  it('returns unknown_token and stores NOTHING at all', async () => {
    // §4.2 ruling 4: the ONLY case where nothing is persisted. Everything else
    // keeps the bytes, because we already hold them and Aloware will not resend.
    const body = '{"event":"OutboundPhoneCall","body":{"id":111222333}}'
    expect(
      await ingest(body, {
        token: 'nobody-issued-this',
        providerEvent: 'OutboundPhoneCall',
        canonical: 'call.initiated',
        callId: '111222333',
      }),
    ).toBe('unknown_token')

    expect(await vaultCount(body)).toBe(0)
    const [event] = await owner<{ n: string }[]>`
      SELECT count(*) AS n FROM app.inbound_webhook_event
       WHERE provider_event_id = ${keyOf(body)}`
    expect(Number(event?.n ?? '1')).toBe(0)
  })

  it('refuses a revoked token the same way it refuses an unknown one', async () => {
    // Rotation is: add the new row, reconfigure Aloware, revoke the old. A hard
    // DELETE would take the provenance of every vault row it wrote with it.
    await owner`
      UPDATE app.webhook_endpoint SET revoked_at = clock_timestamp()
       WHERE tenant_id = ${OTHER_TENANT}`

    expect(
      await ingest('{"event":"OutboundPhoneCall","body":{"id":999}}', { token: OTHER_TOKEN }),
    ).toBe('unknown_token')
  })
})

describe('the token is the only thing that produces a tenant', () => {
  it('lets the APP role ingest with no tenant context whatsoever', async () => {
    // The production path, exactly. A webhook arrives with no session, no
    // cookie and no user, so `app.current_tenant()` is NULL for the whole
    // request and nothing has called `app.begin_request`. This is the property
    // that makes taking `p_tenant_id` unnecessary — and taking it would have
    // let the caller name the tenant it writes into.
    const body = '{"event":"InboundPhoneCall","body":{"id":770001,"direction":1}}'
    expect(
      await ingest(body, {
        on: app,
        providerEvent: 'InboundPhoneCall',
        canonical: 'call.initiated',
        callId: '770001',
      }),
    ).toBe('accepted')

    const [row] = await owner<{ tenant_id: string }[]>`
      SELECT tenant_id FROM app.inbound_webhook_event
       WHERE provider_event_id = ${keyOf(body)}`
    expect(row?.tenant_id).toBe(TENANT)
  })

  it('hides app.webhook_endpoint from the app role entirely', async () => {
    // `definer_only`: harden() builds USING (false) WITH CHECK (false). The
    // role may issue the SELECT and reads zero rows — the token digests are
    // reachable only by the definer.
    const rows = await app<{ n: string }[]>`SELECT count(*) AS n FROM app.webhook_endpoint`
    expect(Number(rows[0]?.n ?? '-1')).toBe(0)

    const grants = await owner<{ privilege_type: string }[]>`
      SELECT privilege_type FROM information_schema.role_table_grants
       WHERE grantee = 'crm_app' AND table_schema = 'app' AND table_name = 'webhook_endpoint'
       ORDER BY privilege_type`
    // 🔴 SELECT and nothing else. `app_can_insert = false` alone would NOT have
    // produced this — it governs INSERT and only INSERT, and harden() still
    // grants UPDATE to any class that is not immutable or read-only. That
    // mistake was made in 0033 and repeated in 0034 an hour later; here the
    // class excludes both grants, so the flag is belt and the class is braces.
    expect([...grants].map((g) => g.privilege_type)).toEqual(['SELECT'])
  })

  it('still refuses the app role a direct write to either ingest table', async () => {
    for (const table of ['raw_payload_vault', 'inbound_webhook_event']) {
      const grants = await owner<{ privilege_type: string }[]>`
        SELECT privilege_type FROM information_schema.role_table_grants
         WHERE grantee = 'crm_app' AND table_schema = 'app' AND table_name = ${table}
         ORDER BY privilege_type`
      expect([...grants].map((g) => g.privilege_type)).toEqual(['SELECT'])
    }
  })
})

describe('what does not get a job, and why each one would be wrong', () => {
  it("stores the provider's own test payload with no job", async () => {
    // `{"test_payload":true}` parses fine and yields nothing. It is a delivery
    // and it is not a domain fact — and it is also the evidence migration 0031
    // used to verify `webhook_subscription`.
    expect(await ingest(TEST_PAYLOAD)).toBe('accepted')
    expect(await vaultCount(TEST_PAYLOAD)).toBe(1)

    const [row] = await owner<{ aloware_call_id: string | null; parse_status: string }[]>`
      SELECT aloware_call_id, parse_status FROM app.inbound_webhook_event
       WHERE provider_event_id = ${keyOf(TEST_PAYLOAD)}`
    expect(row?.aloware_call_id).toBeNull()
    expect(row?.parse_status).toBe('parsed')
  })

  it('stores an unmapped event name with a usable id, and enqueues nothing', async () => {
    // `OutboundAppointment` is real production traffic on this account, and
    // `transcription.open_search.saved` is a thirteenth event on nobody's list.
    // Both carry ids. Mapping them by pattern would hand the call merger
    // something that is not a call.
    const body = '{"event":"OutboundAppointment","body":{"id":880042}}'
    expect(await ingest(body, { providerEvent: 'OutboundAppointment', callId: '880042' })).toBe(
      'accepted',
    )
    expect(await jobsFor('880042')).toHaveLength(0)
  })

  it('stores an SMS event with no job, because message-merge does not exist', async () => {
    // §4.3 routes `message.*` to a `message-merge` consumer keyed on
    // `provider_message_id`. Neither that queue nor the `message` table is
    // built. Enqueuing it onto call-merge would hand the call merger a row it
    // cannot key. The bytes are kept, so a replay lands it when that arrives.
    const body = '{"event":"OutboundSMS-DispositionInvalid","body":{"id":550123}}'
    expect(
      await ingest(body, {
        providerEvent: 'OutboundSMS-DispositionInvalid',
        canonical: 'message.delivery_failed',
        callId: '550123',
      }),
    ).toBe('accepted')

    expect(await vaultCount(body)).toBe(1)
    expect(await jobsFor('550123')).toHaveLength(0)
  })

  it('stores an unparsed body with all-null keys rather than refusing it', async () => {
    // A parser that refused would turn a mapping bug into permanent data loss —
    // and G2 made that worse than it sounds: without retries, what the edge
    // rejects never comes back.
    const body = 'this is not json at all'
    expect(await ingest(body, { parseStatus: 'unparsed' })).toBe('accepted')

    const [row] = await owner<{ parse_status: string; provider_event: string | null }[]>`
      SELECT parse_status, provider_event FROM app.inbound_webhook_event
       WHERE provider_event_id = ${keyOf(body)}`
    expect(row?.parse_status).toBe('unparsed')
    expect(row?.provider_event).toBeNull()
  })
})

describe('two deliveries about one call are serialized, not discarded', () => {
  it('accepts Call-Disposed restating a disposition and queues BOTH jobs', async () => {
    // 🎯 THIS TEST IS THE POLICY CHOICE, and it is what makes the wrong one go
    // red rather than go quiet.
    //
    // `Call-Disposed` restates the same call 6.6 s later with different bytes,
    // so sha256 does NOT dedupe it and both deliveries are real. §4.5 wants
    // them SERIALIZED on `aloware_call_id`, not deduplicated.
    //
    // Under `exclusive` — the obvious reading of "singleton" — the index is
    // UNIQUE (name, key) WHERE state <= 'active', both jobs are 'created', and
    // the second INSERT raises. Under `key_strict_fifo` the index only covers
    // active/retry/failed, so both queue and one runs at a time. Changing
    // CALL_MERGE_POLICY to `exclusive` fails this test with a unique violation.
    expect(
      await ingest(RESTATED, {
        providerEvent: 'Call-Disposed',
        canonical: 'call.completed',
        callId: '940868616',
      }),
    ).toBe('accepted')

    const jobs = await jobsFor('940868616')
    expect(jobs).toHaveLength(2)
    expect(jobs.every((j) => j.policy === CALL_MERGE_POLICY)).toBe(true)
  })

  it('writes the policy the singleton index actually keys on', async () => {
    // 🔴 THE SILENT FAILURE THIS CLOSES. `policy` is a column on every JOB ROW
    // and pg-boss's partial unique indexes read it from the row, not from the
    // queue. A job inserted with a NULL or mismatched policy satisfies no index
    // at all: everything still runs, and the de-duplication simply is not there.
    const [index] = await owner<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes
       WHERE schemaname = 'pgboss' AND tablename = 'job_common'
         AND indexdef LIKE ${'%' + CALL_MERGE_POLICY + '%'}`

    expect(index?.indexdef).toBeDefined()
    expect(index?.indexdef).toMatch(/UNIQUE/)
    expect(index?.indexdef).toMatch(/singleton_key/)

    const [job] = await owner<{ policy: string | null }[]>`
      SELECT policy FROM pgboss.job WHERE name = ${CALL_MERGE_QUEUE} LIMIT 1`
    expect(job?.policy).toBe(CALL_MERGE_POLICY)
  })
})

describe('the race the short-circuit cannot cover', () => {
  it('keeps exactly one vault row when two deliveries of the same bytes overlap', async () => {
    // §4.4: "None is an application check-then-insert, because two concurrent
    // deliveries both pass a check and only a unique index is a constraint
    // under concurrency." The cheap lookup inside the function is an
    // optimisation for replay storms; THIS is what proves the guarantee.
    const body = '{"event":"Recording-Saved","body":{"id":990909,"direction":2}}'
    const a = postgres(OWNER_URL, { max: 1, onnotice: () => {} })
    const b = postgres(OWNER_URL, { max: 1, onnotice: () => {} })

    try {
      await a.unsafe('BEGIN')
      await b.unsafe('BEGIN')

      const first = await ingest(body, {
        on: a,
        providerEvent: 'Recording-Saved',
        canonical: 'call.enriched',
        callId: '990909',
      })
      expect(first).toBe('accepted')

      // B's own short-circuit sees nothing — A has not committed — so it writes
      // its vault row and then blocks on the transport index. Not awaited yet.
      const racing = ingest(body, {
        on: b,
        providerEvent: 'Recording-Saved',
        canonical: 'call.enriched',
        callId: '990909',
      })

      // 🔴 WAITING FOR THE LOCK IS THE TEST. Without it this races the harness
      // rather than the database: issuing B's query and committing A
      // immediately usually lets the COMMIT land first, B's cheap lookup finds
      // the committed row, and the conflict path never runs. The assertions
      // below all pass anyway — measured, not feared. Deleting the orphan
      // cleanup from the function left this test GREEN until this poll existed.
      // Blocked on a lock means B is past its lookup, past its vault write, and
      // sitting on the transport index, which is the only state worth testing.
      await waitUntilBlocked()

      await a.unsafe('COMMIT')
      expect(await racing).toBe('duplicate')
      await b.unsafe('COMMIT')
    } finally {
      await a.end()
      await b.end()
    }

    // The orphan-delete path. B wrote a vault row before it knew it had lost,
    // and deleting it is safe BECAUSE the transport key IS the digest of the
    // body: the row that survives is byte-identical to the one that went.
    expect(await vaultCount(body)).toBe(1)
    expect(await jobsFor('990909')).toHaveLength(1)
  })
})

describe('the guards that turn a silent loss into a named error', () => {
  it('raises WI004 when the call-merge queue is missing', async () => {
    // 🔴 WITHOUT THIS CHECK THE FAILURE ARRIVES AT COMMIT. `pgboss.job.name`
    // references `pgboss.queue(name)` DEFERRABLE INITIALLY DEFERRED, so a
    // missing queue does not fail the INSERT — it fails the COMMIT, taking the
    // vault write and the dedupe row with it, after the edge has every reason
    // to believe the delivery is safe. Aloware never retries.
    await expect(
      owner.begin(async (tx) => {
        await tx`DELETE FROM pgboss.job WHERE name = ${CALL_MERGE_QUEUE}`
        await tx`DELETE FROM pgboss.queue WHERE name = ${CALL_MERGE_QUEUE}`
        await tx`
          SELECT app.webhook_ingest(${TOKEN}, ${Buffer.from('{"event":"x","body":{"id":1}}', 'utf8')},
                                    'x', 'call.completed', '1', 'parsed', NULL)`
      }),
    ).rejects.toThrow(/WI004/)
  })

  it('raises WI005 when the queue exists with a policy that dedupes nothing', async () => {
    await expect(
      owner.begin(async (tx) => {
        await tx`UPDATE pgboss.queue SET policy = 'standard' WHERE name = ${CALL_MERGE_QUEUE}`
        await tx`
          SELECT app.webhook_ingest(${TOKEN}, ${Buffer.from('{"event":"y","body":{"id":2}}', 'utf8')},
                                    'y', 'call.completed', '2', 'parsed', NULL)`
      }),
    ).rejects.toThrow(/WI005/)
  })

  it('raises on OUR bugs, never on the provider’s data', async () => {
    // The asymmetry is deliberate. A value only our own edge produces is a
    // deterministic bug: failing every delivery loudly gets it caught by a
    // test. Failing on provider data would lose a fraction of deliveries in
    // silence, for ever, which is what the vault exists to prevent.
    await expect(ingest('{"event":"z"}', { parseStatus: 'probably_fine' })).rejects.toThrow(/WI002/)

    await expect(
      ingest('{"event":"z2"}', { canonical: 'call.vibed', callId: '5' }),
    ).rejects.toThrow(/WI006/)

    await expect(
      owner`SELECT app.webhook_ingest(${TOKEN}, ${Buffer.alloc(0)}, NULL, NULL, NULL, 'unparsed', NULL)`,
    ).rejects.toThrow(/WI001/)
  })
})

describe('the retention clock is registered, not written into the function', () => {
  it('stamps purge_after from ref.system_constant', async () => {
    const [row] = await owner<{ days: string }[]>`
      SELECT round(extract(epoch FROM (v.purge_after - v.received_at)) / 86400)::text AS days
        FROM app.raw_payload_vault v
       WHERE v.body_sha256 = ${digestOf(TEST_PAYLOAD)}`

    const [constant] = await owner<{ value: string }[]>`
      SELECT value FROM ref.system_constant WHERE key = 'webhook_vault_retention_days'`

    expect(constant?.value).toBeDefined()
    expect(row?.days).toBe(constant?.value)
  })

  it('refuses a retention long enough to defeat what it is for', async () => {
    // 🔴 THE UPPER BOUND IS THE ONE NOTHING ELSE CATCHES. A too-short value is
    // already refused by `raw_payload_vault_purge_after_receipt`; a too-long one
    // is silent. This clock is doing two jobs — CCPA minimisation, and bounding
    // how long a database backup stays a set of bearer tokens to call audio,
    // because `Recording-Saved` carries a URL that 302s to a pre-signed link.
    // `3650` reads as a typo and behaves as a policy.
    await expect(
      owner.begin(async (tx) => {
        await tx`
          UPDATE ref.system_constant SET value = '3650'
           WHERE key = 'webhook_vault_retention_days'`
      }),
    ).rejects.toThrow(/system_constant_vault_retention_bounded/)

    // And the top of §4.6's window is accepted, so the constraint is a bound
    // rather than a pin on the one value that happens to be set.
    await owner
      .begin(async (tx) => {
        await tx`
        UPDATE ref.system_constant SET value = '90'
         WHERE key = 'webhook_vault_retention_days'`
        await tx`SELECT 1`
        throw new Error('rollback')
      })
      .catch((err: unknown) => {
        if (!(err instanceof Error) || err.message !== 'rollback') throw err
      })
  })
})
