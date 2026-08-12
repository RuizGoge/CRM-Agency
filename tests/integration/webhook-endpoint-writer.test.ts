import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { APP_URL, OWNER_URL } from './setup/urls'

/**
 * `app.webhook_endpoint_issue / _revoke / _list` — the credential the ingest
 * edge had no way to be given.
 *
 * 🔴 WHAT THIS CLOSES, AND IT WAS A LIVE PERMANENT-LOSS PATH. `webhook_endpoint`
 * is `definer_only` and had no writer anywhere — not in `app/`, not in the seed,
 * not in a migration. Gate 6 found it by tripping over it: the storm harness
 * tried to seed a row as `crm_app`, got permission denied, and had to insert as
 * the OWNER to run at all. The consequence in production is that no endpoint row
 * exists, so `webhook_ingest` resolves no tenant for any token, so the edge
 * answers 401 to every real delivery — and G2 measured that Aloware never
 * retries. Every call and every SMS discarded at the door, with nothing going
 * red anywhere.
 *
 * 🎯 THE ASSERTION THAT MATTERS IS THE ROUND TRIP, and it is deliberately not a
 * string comparison. The issuer and `webhook_ingest` must hash identically —
 * `pg_catalog.sha256(pg_catalog.convert_to(token, 'UTF8'))` — and any other
 * spelling produces a row that is structurally valid, passes every CHECK, and
 * resolves for nothing. That failure is a token the operator pastes correctly
 * which answers 401 forever with no error to read. So the test issues a token
 * and feeds it to the REAL `webhook_ingest`, which is the only thing that proves
 * the two agree.
 */

const TENANT = '00000000-0000-7000-8000-000000680068'
const OTHER_TENANT = '00000000-0000-7000-8000-000000680069'
const VAL = '00000000-0000-7000-8000-0000006800a1'
const SAM = '00000000-0000-7000-8000-0000006800a2'
const OTHER_ADMIN = '00000000-0000-7000-8000-0000006800a3'

let owner: postgres.Sql
let app: postgres.Sql

/** Runs one unit of work as a real `crm_app` session, exactly as the app does. */
async function asUser<T>(
  userId: string,
  work: (tx: postgres.TransactionSql) => Promise<T>,
  tenantId: string = TENANT,
): Promise<T> {
  // `postgres.begin` unwraps an array return type, which fights a generic that
  // may legitimately BE an array — several callers below return row sets. The
  // cast is on the library's shape, not on the value.
  const result = await app.begin(async (tx) => {
    await tx`SELECT app.begin_request(${tenantId}::uuid, ${userId}::uuid)`
    return work(tx)
  })
  return result as T
}

async function issue(
  userId: string,
  provider = 'aloware',
  label = 'Aloware production',
  tenantId: string = TENANT,
): Promise<{ endpoint_id: string; token: string }> {
  return asUser(
    userId,
    async (tx) => {
      const rows = await tx<{ endpoint_id: string; token: string }[]>`
        SELECT * FROM app.webhook_endpoint_issue(${provider}, ${label})`
      const row = rows[0]
      if (row === undefined) throw new Error('webhook_endpoint_issue returned no row')
      return row
    },
    tenantId,
  )
}

/** The real edge function, called as `crm_app` with no session — as a delivery arrives. */
async function ingestWith(token: string): Promise<string> {
  const body = Buffer.from(`{"event":"Call-Disposed","body":{"id":${Date.now()}}}`, 'utf8')
  const [row] = await app<{ outcome: string }[]>`
    SELECT app.webhook_ingest(${token}, ${body}, 'Call-Disposed', 'call.completed',
                              ${String(Date.now())}, 'parsed', NULL) AS outcome`
  if (row === undefined) throw new Error('webhook_ingest returned no row')
  return row.outcome
}

beforeAll(async () => {
  owner = postgres(OWNER_URL, { max: 1, onnotice: () => {} })
  app = postgres(APP_URL, { max: 1, onnotice: () => {} })

  await owner`
    INSERT INTO app.tenant (id, name, business_tz) VALUES
      (${TENANT}, 'Endpoint Writer Agency', 'America/New_York'),
      (${OTHER_TENANT}, 'Neighbour Agency', 'America/Chicago')`

  await owner`
    INSERT INTO app.app_user (tenant_id, id, email, full_name, display_name, role) VALUES
      (${TENANT}, ${VAL}, 'val@endpoint.test', 'Val Admin', 'Val A.', 'admin'),
      (${TENANT}, ${SAM}, 'sam@endpoint.test', 'Sam Seller', 'Sam S.', 'seller'),
      (${OTHER_TENANT}, ${OTHER_ADMIN}, 'other@endpoint.test', 'Otto Admin', 'Otto A.', 'admin')`
})

afterAll(async () => {
  await owner?.end()
  await app?.end()
})

describe('the credential reaches the edge', () => {
  it('issues a token that the real webhook_ingest resolves', async () => {
    const { token } = await issue(VAL)

    // 🎯 THE WHOLE POINT. Before this migration every token resolved to nothing
    // and the only possible answer was `unknown_token`.
    expect(await ingestWith(token)).toBe('accepted')
  })

  it('answers unknown_token once the credential is revoked', async () => {
    const { endpoint_id, token } = await issue(VAL, 'aloware', 'To be rotated out')
    expect(await ingestWith(token)).toBe('accepted')

    const revoked = await asUser(
      VAL,
      async (tx) =>
        (
          await tx<{ ok: boolean }[]>`
            SELECT app.webhook_endpoint_revoke(${endpoint_id}::uuid) AS ok`
        )[0]?.ok,
    )
    expect(revoked).toBe(true)

    // The revoke is REAL rather than cosmetic: `revoked_at IS NULL` is in the
    // resolution predicate (0047:126), so the edge stops resolving immediately.
    expect(await ingestWith(token)).toBe('unknown_token')
  })

  it('lets two credentials be live at once, which is what rotation needs', async () => {
    const first = await issue(VAL, 'aloware', 'Rotation: old')
    const second = await issue(VAL, 'aloware', 'Rotation: new')

    // Insert the new one, reconfigure Aloware, THEN revoke the old — with both
    // live in between, or the gap is a window of permanent loss.
    expect(await ingestWith(first.token)).toBe('accepted')
    expect(await ingestWith(second.token)).toBe('accepted')
  })
})

describe('the secret is not recoverable', () => {
  it('stores only the digest, never the plaintext', async () => {
    const { endpoint_id, token } = await issue(VAL, 'aloware', 'Digest only')

    const [row] = await owner<{ hit: string }[]>`
      SELECT count(*) AS hit FROM app.webhook_endpoint
       WHERE tenant_id = ${TENANT} AND id = ${endpoint_id}
         AND token_sha256 = pg_catalog.sha256(pg_catalog.convert_to(${token}, 'UTF8'))`
    expect(row?.hit).toBe('1')

    // Nothing anywhere in the row equals the token. A digest column that
    // happened to hold text would satisfy the CHECK on length and be a stored
    // bearer secret.
    const [plain] = await owner<{ hit: string }[]>`
      SELECT count(*) AS hit FROM app.webhook_endpoint
       WHERE tenant_id = ${TENANT}
         AND (label = ${token} OR encode(token_sha256, 'hex') = ${token})`
    expect(plain?.hit).toBe('0')
  })

  it('never returns the digest from the listing surface', async () => {
    await issue(VAL, 'aloware', 'Listed')
    const rows = await asUser(
      VAL,
      async (tx) => await tx`SELECT * FROM app.webhook_endpoint_list()`,
    )

    expect(rows.length).toBeGreaterThan(0)
    // 🔴 32 bytes of a 128-character hex token on a screen is an offline
    // guessing target for the one credential with no second factor.
    for (const row of rows) {
      expect(Object.keys(row)).not.toContain('token_sha256')
    }
    expect(Object.keys(rows[0] ?? {}).sort()).toEqual([
      'created_at',
      'endpoint_id',
      'label',
      'provider',
      'revoked_at',
    ])
  })
})

describe('it is an admin act, checked in the database', () => {
  it('refuses a seller who asks to issue', async () => {
    await expect(issue(SAM)).rejects.toThrow(/WE002/)
  })

  it('refuses a seller who asks to list', async () => {
    await expect(
      asUser(SAM, async (tx) => await tx`SELECT * FROM app.webhook_endpoint_list()`),
    ).rejects.toThrow(/WE009/)
  })

  it('refuses a seller who asks to revoke', async () => {
    const { endpoint_id } = await issue(VAL, 'aloware', 'Seller may not revoke')
    await expect(
      asUser(SAM, async (tx) => await tx`SELECT app.webhook_endpoint_revoke(${endpoint_id}::uuid)`),
    ).rejects.toThrow(/WE007/)
  })

  it('refuses everything outside a tenant session', async () => {
    // No `begin_request`: the guard fires before the admin check, which is the
    // right ordering — there is no tenant to be admin OF.
    await expect(
      app`SELECT * FROM app.webhook_endpoint_issue('aloware', 'No session')`,
    ).rejects.toThrow(/WE001/)
  })
})

describe('the silo holds across tenants', () => {
  it('gives a neighbouring admin the same answer as an unknown id', async () => {
    const { endpoint_id } = await issue(VAL, 'aloware', 'Ours, not theirs')

    // ONE ANSWER FOR BOTH, which is the not-found rule: a `true` here — or an
    // error that differed from the unknown-id case — would confirm to another
    // agency that this endpoint exists.
    const foreign = await asUser(
      OTHER_ADMIN,
      async (tx) =>
        (
          await tx<{ ok: boolean }[]>`
            SELECT app.webhook_endpoint_revoke(${endpoint_id}::uuid) AS ok`
        )[0]?.ok,
      OTHER_TENANT,
    )
    const unknown = await asUser(
      OTHER_ADMIN,
      async (tx) =>
        (
          await tx<{ ok: boolean }[]>`
            SELECT app.webhook_endpoint_revoke(${'00000000-0000-7000-8000-00000068ffff'}::uuid) AS ok`
        )[0]?.ok,
      OTHER_TENANT,
    )
    expect(foreign).toBe(false)
    expect(unknown).toBe(false)

    // And it really is still live for its owner.
    const [row] = await owner<{ revoked: Date | null }[]>`
      SELECT revoked_at AS revoked FROM app.webhook_endpoint
       WHERE tenant_id = ${TENANT} AND id = ${endpoint_id}`
    expect(row?.revoked).toBeNull()
  })

  it('lists only the calling admin’s own tenant', async () => {
    await issue(VAL, 'aloware', 'Ours')
    await issue(OTHER_ADMIN, 'aloware', 'Theirs', OTHER_TENANT)

    const labels = await asUser(
      OTHER_ADMIN,
      async (tx) => await tx<{ label: string }[]>`SELECT label FROM app.webhook_endpoint_list()`,
      OTHER_TENANT,
    )
    expect(labels.map((r) => r.label)).toEqual(['Theirs'])
  })

  it('revoking twice changes nothing the second time', async () => {
    const { endpoint_id } = await issue(VAL, 'aloware', 'Double revoke')
    const first = await asUser(
      VAL,
      async (tx) =>
        (
          await tx<{ ok: boolean }[]>`
            SELECT app.webhook_endpoint_revoke(${endpoint_id}::uuid) AS ok`
        )[0]?.ok,
    )
    const second = await asUser(
      VAL,
      async (tx) =>
        (
          await tx<{ ok: boolean }[]>`
            SELECT app.webhook_endpoint_revoke(${endpoint_id}::uuid) AS ok`
        )[0]?.ok,
    )
    expect(first).toBe(true)
    expect(second).toBe(false)
  })
})

describe('what it refuses to create', () => {
  it('refuses a provider this product does not ingest', async () => {
    // Free text would be copied verbatim onto every vault row and every inbound
    // event the token ever produces, and nothing downstream would reject it.
    await expect(issue(VAL, 'twilio')).rejects.toThrow(/WE003/)
  })

  it('refuses a blank label', async () => {
    await expect(issue(VAL, 'aloware', '   ')).rejects.toThrow(/WE004/)
  })

  it('refuses a label too long to read in a list', async () => {
    await expect(issue(VAL, 'aloware', 'x'.repeat(81))).rejects.toThrow(/WE005/)
  })
})

describe('both acts are auditable', () => {
  it('writes an audit row for the issue and for the revoke, without the token', async () => {
    const { endpoint_id, token } = await issue(VAL, 'aloware', 'Audited')
    await asUser(
      VAL,
      async (tx) => await tx`SELECT app.webhook_endpoint_revoke(${endpoint_id}::uuid)`,
    )

    const rows = await owner<{ action: string; actor: string; after: unknown }[]>`
      SELECT action, actor_user_id AS actor, after
        FROM app.audit_log
       WHERE tenant_id = ${TENANT} AND subject_id = ${endpoint_id}
       ORDER BY action`
    expect(rows.map((r) => r.action)).toEqual([
      'integration.credential_issued',
      'integration.credential_revoked',
    ])

    // WHO ACTED IS READ FROM THE SESSION, never taken as a parameter.
    for (const row of rows) expect(row.actor).toBe(VAL)

    // 🔴 `audit_log` is append-only and every admin in the tenant reads it. A
    // secret written there is a secret with no expiry and no delete.
    expect(JSON.stringify(rows)).not.toContain(token)
  })
})
