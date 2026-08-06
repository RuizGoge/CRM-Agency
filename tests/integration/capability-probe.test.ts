import { createHash } from 'node:crypto'

import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { APP_URL, OWNER_URL } from './setup/urls'

/**
 * `ref.capability_probe` and `ref.provider_capability` — errata **E9** and
 * §7.7.6, asserted against the engine.
 *
 * The point of this table is that "verified" stops being a word in a column.
 * §7.7.6 names the failure precisely: the original CHECK
 * (`status <> 'verified' OR evidence_ref IS NOT NULL`) is satisfied by a
 * migration seeding `evidence_ref = 'spike'`. Every assertion below exists
 * because some specific way of talking the registry into `verified` has to
 * stop working.
 *
 * ⚠️ THE PRECEDENCE TEST IS THE FIRST ONE, and it is the reason this file leads
 * with structure rather than behaviour. `05c-closure-register.md` §7.7.6 still
 * carries the DDL E9 struck — `raw_payload_id uuid NOT NULL` into
 * `raw_payload_vault`, whose partitions drop on a 30–90 day window. Anybody
 * implementing from that text one to three months from now reintroduces a
 * production process that exits non-zero on every start while development and
 * CI stay green the entire interval. A test is the only thing that can notice
 * a document being followed.
 */

let owner: postgres.Sql
let appRole: postgres.Sql

const RUN = 'capability-probe.test'

/** Inserts a probe as the owner and returns its id. */
async function insertProbe(opts: {
  capability: string
  httpStatus: number
  body: string
  observedAt?: Date
  digest?: Buffer
}): Promise<{ probeId: string; observedAt: Date }> {
  const body = Buffer.from(opts.body, 'utf8')
  const digest = opts.digest ?? createHash('sha256').update(body).digest()
  const observedAt = opts.observedAt ?? new Date()
  const [row] = await owner<{ probe_id: string }[]>`
    INSERT INTO ref.capability_probe
      (provider, capability, http_status, response_body, response_digest,
       observed_at, probe_run, request_method, request_url)
    VALUES
      ('aloware', ${opts.capability}, ${opts.httpStatus}, ${body}, ${digest},
       ${observedAt}, ${RUN}, 'GET', 'https://example.test/probe')
    RETURNING probe_id
  `
  if (row === undefined) throw new Error('no probe id returned')
  return { probeId: row.probe_id, observedAt }
}

beforeAll(() => {
  owner = postgres(OWNER_URL, { max: 1, onnotice: () => {} })
  appRole = postgres(APP_URL, { max: 1, onnotice: () => {} })
})

afterAll(async () => {
  await owner.end()
  await appRole.end()
})

describe('E9 · the probe carries its own evidence on its own clock', () => {
  it('has response_body and does NOT have raw_payload_id', async () => {
    const cols = await owner<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'ref' AND table_name = 'capability_probe'
    `
    const names = cols.map((c) => c.column_name)

    expect(names).toContain('response_body')
    expect(names).toContain('response_digest')

    // The struck design. If this ever comes back, the boot assertion becomes
    // unsatisfiable one partition-drop later and nothing before production
    // notices.
    expect(names).not.toContain('raw_payload_id')
  })

  it('refuses a digest that does not match the body it sits next to', async () => {
    await expect(
      insertProbe({
        capability: 'zz_test_digest',
        httpStatus: 200,
        body: '{"ok":true}',
        digest: createHash('sha256').update('something else').digest(),
      }),
    ).rejects.toThrow(/capability_probe_digest_matches/)
  })

  it('refuses an empty body under 200 but accepts one under 204', async () => {
    await expect(
      insertProbe({ capability: 'zz_test_empty_200', httpStatus: 200, body: '' }),
    ).rejects.toThrow(/capability_probe_body_present/)

    // 204 is the carve-out, by status and by nothing else: HTTP itself defines
    // no body here, and a prober that cannot store what it received is a prober
    // under pressure to invent something it can.
    const { probeId } = await insertProbe({
      capability: 'zz_test_empty_204',
      httpStatus: 204,
      body: '',
    })
    expect(probeId).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('is append-only to the OWNER, not merely to the app role', async () => {
    const { probeId } = await insertProbe({
      capability: 'zz_test_immutable',
      httpStatus: 200,
      body: '{"a":1}',
    })

    await expect(
      owner`UPDATE ref.capability_probe SET http_status = 500 WHERE probe_id = ${probeId}`,
    ).rejects.toThrow()

    await expect(
      owner`DELETE FROM ref.capability_probe WHERE probe_id = ${probeId}`,
    ).rejects.toThrow()
  })
})

describe('§7.7.6 · the registry cannot be talked into `verified`', () => {
  it('CAP001 · refuses `verified` with no probe attached', async () => {
    await expect(
      owner`
        INSERT INTO ref.provider_capability (provider, capability, status, tier, verified_at)
        VALUES ('aloware', 'zz_test_cap001', 'verified', 'probe_only', now())
      `,
      // The CHECK and the trigger both stand in the way here; either refusal is
      // the correct outcome, and asserting the pair is what keeps this honest
      // if the order ever changes.
    ).rejects.toThrow(/CAP001|capability_verified_needs_probe/)
  })

  it('CAP002 · refuses a probe captured for a DIFFERENT capability', async () => {
    const { probeId, observedAt } = await insertProbe({
      capability: 'contact_lookup',
      httpStatus: 200,
      body: '{"contacts":[]}',
    })

    // This is the one the CHECK cannot see: a probe IS attached, it IS 2xx, and
    // the timestamps DO match. It is simply evidence about something else.
    await expect(
      owner`
        INSERT INTO ref.provider_capability
          (provider, capability, status, tier, verified_at, evidence_probe_id)
        VALUES ('aloware', 'zz_test_cap002', 'verified', 'probe_only',
                ${observedAt}, ${probeId})
      `,
    ).rejects.toThrow(/CAP002/)
  })

  it('CAP003 · refuses a probe that did not return 2xx', async () => {
    const { probeId, observedAt } = await insertProbe({
      capability: 'zz_test_cap003',
      httpStatus: 404,
      body: '{"error":"not found"}',
    })

    await expect(
      owner`
        INSERT INTO ref.provider_capability
          (provider, capability, status, tier, verified_at, evidence_probe_id)
        VALUES ('aloware', 'zz_test_cap003', 'verified', 'probe_only',
                ${observedAt}, ${probeId})
      `,
    ).rejects.toThrow(/CAP003/)
  })

  it('CAP004 · refuses a verified_at that is not the moment the provider answered', async () => {
    const { probeId } = await insertProbe({
      capability: 'zz_test_cap004',
      httpStatus: 200,
      body: '{"ok":true}',
    })

    await expect(
      owner`
        INSERT INTO ref.provider_capability
          (provider, capability, status, tier, verified_at, evidence_probe_id)
        VALUES ('aloware', 'zz_test_cap004', 'verified', 'probe_only',
                now(), ${probeId})
      `,
    ).rejects.toThrow(/CAP004/)
  })

  it('ACCEPTS a well-formed verification — the gate is not simply closed', async () => {
    const { probeId, observedAt } = await insertProbe({
      capability: 'zz_test_happy',
      httpStatus: 200,
      body: '{"call_id":"synthetic"}',
    })

    await owner`
      INSERT INTO ref.provider_capability
        (provider, capability, status, tier, verified_at, evidence_probe_id)
      VALUES ('aloware', 'zz_test_happy', 'verified', 'probe_only',
              ${observedAt}, ${probeId})
    `

    const [row] = await owner<{ status: string }[]>`
      SELECT status FROM ref.provider_capability
       WHERE provider = 'aloware' AND capability = 'zz_test_happy'
    `
    expect(row?.status).toBe('verified')
  })

  it('refuses a verified_at left behind on a capability that is not verified', async () => {
    await expect(
      owner`
        INSERT INTO ref.provider_capability (provider, capability, status, tier, verified_at)
        VALUES ('aloware', 'zz_test_stale', 'absent', 'probe_only', now())
      `,
    ).rejects.toThrow(/capability_unverified_has_no_timestamp/)
  })
})

describe('the app role can read the evidence and can never mint it', () => {
  it('crm_app holds SELECT and nothing else on both tables', async () => {
    const grants = await appRole<{ table_name: string; privilege_type: string }[]>`
      SELECT table_name, privilege_type
        FROM information_schema.role_table_grants
       WHERE grantee = 'crm_app'
         AND table_schema = 'ref'
         AND table_name IN ('capability_probe', 'provider_capability')
    `
    const privileges = [...new Set(grants.map((g) => g.privilege_type))]
    expect(privileges).toEqual(['SELECT'])
  })

  it('crm_app cannot INSERT a probe — the refusal is a revoked privilege', async () => {
    const body = Buffer.from('{"forged":true}', 'utf8')
    await expect(
      appRole`
        INSERT INTO ref.capability_probe
          (provider, capability, http_status, response_body, response_digest,
           observed_at, probe_run, request_method, request_url)
        VALUES ('aloware', 'zz_test_forged', 200, ${body},
                ${createHash('sha256').update(body).digest()},
                now(), ${RUN}, 'GET', 'https://example.test/forged')
      `,
    ).rejects.toThrow(/permission denied/i)
  })

  it('crm_app can read what /admin/integration-health renders', async () => {
    const rows = await appRole<{ capability: string }[]>`
      SELECT capability FROM ref.provider_capability WHERE provider = 'aloware'
    `
    expect(rows.length).toBeGreaterThan(0)
  })
})

describe('§7.3 · the eight capabilities exist as rows in a verification state', () => {
  it('registers exactly the three mvp_required capabilities the corpus names', async () => {
    const rows = await owner<{ capability: string }[]>`
      SELECT capability FROM ref.provider_capability
       WHERE provider = 'aloware' AND tier = 'mvp_required'
       ORDER BY capability
    `
    // The tier is what the boot assertion reads. A fifth name added here is a
    // new thing that can stop production from starting; a missing one is a
    // dependent surface built on an unverified capability.
    expect(rows.map((r) => r.capability)).toEqual([
      'call_list',
      'two_legged_call',
      'webhook_subscription',
    ])
  })

  /**
   * 🔴 THIS ASSERTION CHANGED, and that is what it was written for.
   *
   * It used to read "every seeded capability starts `unknown`", which was true
   * until migration 0030 promoted `two_legged_call` on the strength of the
   * Gate-2 dial. The guard went red the moment the fact moved — exactly like
   * the two ratchet guards that had to change when P20 was measured.
   *
   * A guard that silently keeps passing while the world underneath it changes
   * is the failure this whole arrangement exists to prevent, in both
   * directions: it must go red when something becomes verified, and it must go
   * red if something is verified that should not be.
   */
  it('exactly one capability is verified, and only with real evidence behind it', async () => {
    const rows = await owner<{ capability: string; status: string }[]>`
      SELECT capability, status FROM ref.provider_capability
       WHERE provider = 'aloware' AND capability NOT LIKE 'zz_test_%'
       ORDER BY capability
    `
    expect(rows).toHaveLength(8)

    const verified = rows.filter((r) => r.status === 'verified').map((r) => r.capability)
    expect(verified).toEqual(['two_legged_call'])

    // Everything else stays `unknown`. Nothing is assumed present, and in
    // particular `webhook_subscription` is NOT verified despite 20 captured
    // deliveries — `ref.capability_probe` models an outbound exchange and a
    // webhook is inbound, so there is no shape for that evidence yet.
    expect(rows.filter((r) => r.status !== 'verified').every((r) => r.status === 'unknown')).toBe(
      true,
    )
  })

  it('the verified capability is backed by a 2xx probe of ITSELF, timestamped to the answer', async () => {
    const [row] = await owner<
      {
        capability: string
        http_status: number
        probe_capability: string
        stamps_match: boolean
        body: string
      }[]
    >`
      SELECT pc.capability,
             p.http_status,
             p.capability                      AS probe_capability,
             pc.verified_at = p.observed_at    AS stamps_match,
             convert_from(p.response_body, 'UTF8') AS body
        FROM ref.provider_capability pc
        JOIN ref.capability_probe p ON p.probe_id = pc.evidence_probe_id
       WHERE pc.provider = 'aloware' AND pc.status = 'verified'
    `

    expect(row?.capability).toBe('two_legged_call')
    // CAP002: the probe must be of the capability it certifies.
    expect(row?.probe_capability).toBe('two_legged_call')
    // CAP003: a non-2xx is evidence of absent, never of verified.
    expect(row?.http_status).toBe(202)
    // CAP004: verified_at is when the provider answered, not when someone typed it.
    expect(row?.stamps_match).toBe(true)
    // And the body is the provider's own words, carried in the migration and
    // re-hashed by the CHECK on every apply.
    expect(row?.body).toBe('{"message":"Two legged call established."}')
  })
})
