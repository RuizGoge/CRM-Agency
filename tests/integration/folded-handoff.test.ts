import { sql as raw } from 'drizzle-orm'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { claimDueJobs, withSystemWork, withTenant } from '~/db'

import { TEST_URL } from './setup/urls'

/**
 * Sprint-0 Gate 4, the last piece: the job → request handoff on a shared pooled
 * connection, in the FOLDED topology.
 *
 * This became reachable rather than theoretical when the fold shipped. The
 * worker now runs inside the web process (`app/jobs/boot.ts`), so a job and a
 * request take turns on the SAME connection pool — and `withSystemWork` sets a
 * tenant that is not the seller's, on a connection the seller's next page load
 * will be served from.
 *
 * WHAT WAS ALREADY CLOSED, so this file is not repeating it. Every GUC in
 * migration 0003 is `set_config(..., is_local => true)`, which reverts at
 * COMMIT, and `session-context.test.ts` proves `begin_request` raises `CTX001`
 * on a connection deliberately poisoned with a SESSION-scoped setting. What had
 * no test was the realistic path: a real job, a real request, a real pool, in
 * the order the folded process actually produces them.
 *
 * 🎯 PROVED BY MUTATION, and the result is more precise than the intention.
 * Adding one session-scoped `set_config('app.tenant_id', …, false)` inside
 * `withSystemWork` — a leak of exactly the shape this file is named for — turns
 * ALL FIVE red. But it is `CTX001` that fires, from inside `begin_request` and
 * `begin_system_work`, with a hint naming the cause: *"A bare SET leaked across
 * a transaction, or the pooler is in session mode."* The row comparisons never
 * get the chance.
 *
 * So the honest division of labour, written down instead of overclaimed:
 *
 *   a leaked CONTEXT  → the engine refuses the next unit of work outright
 *   a leaky POLICY    → the context is clean, the refusal never fires, and only
 *                       the rows say so
 *
 * Two different failures. The refusal is the one that exists today and the one
 * the mutation exercises; the rows are what would still be looking if somebody
 * weakened a policy while the envelope stayed correct. Asserting on a GUC alone
 * would cover neither of those second cases, which is why these read rows.
 *
 * ⚠️ Every test here refuses to conclude anything unless both halves ran on the
 * SAME backend. A pool that handed out two connections would make each pass for
 * a reason that has nothing to do with the handoff — the most expensive kind of
 * green, because it reports the very property it was written to protect.
 */

// The `cf` block, unused elsewhere in this suite. `crm_test` is shared and the
// ids are assigned by hand, which has collided once already — so `beforeAll`
// below says so in words rather than leaving a bare `duplicate key`.
const TENANT_JOB = '00000000-0000-7000-8000-00000000cf01'
const TENANT_WEB = '00000000-0000-7000-8000-00000000cf02'
const SELLER_JOB = '00000000-0000-7000-8000-00000000cf11'
const SELLER_WEB = '00000000-0000-7000-8000-00000000cf12'

let sql: postgres.Sql

interface Seen {
  readonly pid: number
  readonly tenant: string | null
  /** `app.contact`, which is `owner_scoped`. */
  readonly contacts: readonly string[]
  /** `app.tenant`, which is `tenant_scoped` — what a job is allowed to read. */
  readonly tenants: readonly string[]
}

/**
 * Everything one unit of work can see, on the backend that served it.
 *
 * TWO CLASSES OF TABLE, not one, because they answer different questions.
 * `contact` is `owner_scoped` and is what a SELLER's screen is made of;
 * `tenant` is `tenant_scoped` and is what a JOB actually reads — `dispatch.ts`
 * reads `sms_enabled` off it inside exactly this envelope. Probing only one of
 * them would leave half of each direction untested.
 */
const PROBE = raw`
  SELECT pg_backend_pid() AS pid,
         nullif(current_setting('app.tenant_id', true), '') AS tenant,
         coalesce((SELECT array_agg(full_name ORDER BY full_name) FROM app.contact),
                  ARRAY[]::text[]) AS contacts,
         coalesce((SELECT array_agg(name ORDER BY name) FROM app.tenant),
                  ARRAY[]::text[]) AS tenants`

// A `type`, not an `interface`, and it is not a style choice: drizzle's
// `execute<T>` constrains T to `Record<string, unknown>`, and TypeScript grants
// an implicit index signature to a type alias but never to an interface. The
// interface version compiles everywhere except at the call site.
type ProbeRow = {
  pid: number
  tenant: string | null
  contacts: string[]
  tenants: string[]
}

function shape(row: ProbeRow | undefined): Seen {
  return {
    pid: Number(row?.pid),
    tenant: row?.tenant ?? null,
    contacts: row?.contacts ?? [],
    tenants: row?.tenants ?? [],
  }
}

/** One request-shaped unit of work: who am I, and what rows can I actually read. */
async function asSeller(tenantId: string, userId: string): Promise<Seen> {
  return withTenant({ tenantId, userId }, async (tx) =>
    shape((await tx.execute<ProbeRow>(PROBE))[0]),
  )
}

/** One job-shaped unit of work, through the same door the dispatcher uses. */
async function asJob(tenantId: string): Promise<Seen> {
  return withSystemWork(tenantId, async (tx) => shape((await tx.execute<ProbeRow>(PROBE))[0]))
}

function sameBackend(a: Seen, b: Seen): void {
  expect(
    b.pid,
    `the two units of work ran on backends ${a.pid} and ${b.pid}, so this test ` +
      `did not exercise a handoff and proves nothing`,
  ).toBe(a.pid)
}

beforeAll(async () => {
  sql = postgres(TEST_URL, { max: 1, onnotice: () => {} })

  // Named collision check. `crm_test` is shared, the ids are hand-assigned, and
  // the one time this happened the symptom was a `duplicate key` in a
  // `beforeAll` — which reads like a broken fixture rather than like two files
  // claiming the same tenant.
  const [clash] = await sql<{ n: string }[]>`
    SELECT count(*)::text AS n FROM app.tenant WHERE id IN (${TENANT_JOB}, ${TENANT_WEB})`
  if (Number(clash?.n ?? '0') > 0) {
    throw new Error(
      `folded-handoff.test.ts: tenant ids ${TENANT_JOB} / ${TENANT_WEB} are already taken by ` +
        `another file in the shared crm_test database. Pick another block, do not reuse these.`,
    )
  }

  await sql`
    INSERT INTO app.tenant (id, name, business_tz, sms_enabled) VALUES
      (${TENANT_JOB}, 'Folded Job Tenant', 'America/New_York', false),
      (${TENANT_WEB}, 'Folded Web Tenant', 'America/New_York', false)`

  await sql`
    INSERT INTO app.app_user (tenant_id, id, email, full_name, display_name, role) VALUES
      (${TENANT_JOB}, ${SELLER_JOB}, 'job@folded.test', 'Job Seller', 'Job', 'seller'),
      (${TENANT_WEB}, ${SELLER_WEB}, 'web@folded.test', 'Web Seller', 'Web', 'seller')`

  // One row per tenant, each named after its tenant, so an assertion about
  // isolation reads as a sentence: the web seller must never see JOB-ONLY.
  await sql`
    INSERT INTO app.contact (tenant_id, owner_user_id, full_name, created_via) VALUES
      (${TENANT_JOB}, ${SELLER_JOB}, 'JOB-ONLY Contact', 'manual'),
      (${TENANT_WEB}, ${SELLER_WEB}, 'WEB-ONLY Contact', 'manual')`
})

afterAll(async () => {
  await sql?.end()
})

describe('a job does not leave its tenant on the connection a request then takes', () => {
  it('serves the next request its own book, not the job’s', async () => {
    // The order the folded process produces every fifteen seconds: the
    // dispatcher wakes, does cross-tenant work, and hands the connection back
    // to a pool a seller's page load is about to draw from.
    const job = await asJob(TENANT_JOB)
    const request = await asSeller(TENANT_WEB, SELLER_WEB)
    sameBackend(job, request)

    expect(job.tenants).toEqual(['Folded Job Tenant'])

    // THE ASSERTION, and it is about rows rather than about a setting: a GUC
    // check would pass a world where the context is clean and the policy is
    // not. This is the seller's screen.
    expect(request.contacts, 'the request read the job’s tenant').toEqual(['WEB-ONLY Contact'])
    expect(request.tenants).toEqual(['Folded Web Tenant'])
    expect(request.tenant).toBe(TENANT_WEB)
  })

  it('cannot read an owner-scoped table at all, tenant or no tenant', async () => {
    // 🔬 MEASURED WHILE WRITING THIS FILE, and it is a stronger guarantee than
    // the one I set out to assert. `withSystemWork` sets a tenant and
    // deliberately sets NO user (`app.user_id` is ''), so every `owner_scoped`
    // policy compares against NULL and returns nothing. A job cannot read a
    // seller's book through a plain SELECT even in its OWN tenant.
    //
    // That is why `scheduled_job` — itself `owner_scoped` — is reached by the
    // dispatcher only through `scheduled_job_claim` and `scheduled_job_resolve`,
    // which are definers. The consequence for the handoff is the useful part: a
    // context leak from a request into a job could not hand that job a book,
    // because the job has no user to be scoped to. This assertion is what keeps
    // that true if somebody ever gives system work a user id "so the dispatcher
    // can just read the row".
    const job = await asJob(TENANT_JOB)
    expect(job.tenant).toBe(TENANT_JOB)
    expect(job.contacts, 'system work can read an owner-scoped table').toEqual([])
  })

  it('leaves nothing behind when the job THROWS', async () => {
    // The crash path, which is the one a happy-path test never reaches. GUCs set
    // with `is_local => true` revert at ROLLBACK exactly as at COMMIT — but a
    // dispatcher that dies mid-job is an ordinary Tuesday (an SMS provider
    // timing out, a lease expiring), not an exotic case, so the guarantee is
    // worth holding rather than assuming.
    const before = await asJob(TENANT_JOB)

    await expect(
      withSystemWork(TENANT_JOB, () => {
        throw new Error('the provider timed out mid-job')
      }),
    ).rejects.toThrow('the provider timed out mid-job')

    const request = await asSeller(TENANT_WEB, SELLER_WEB)
    sameBackend(before, request)
    expect(request.contacts, 'a failed job left its tenant on the connection').toEqual([
      'WEB-ONLY Contact',
    ])
  })
})

describe('a request does not leave its tenant on the connection a job then takes', () => {
  it('runs the job in its own tenant, not the last seller’s', async () => {
    // The other direction, and it fails differently. A job inheriting a
    // request's tenant does not merely READ the wrong rows — `withSystemWork`
    // is the door the dispatcher WRITES through, so it would fire one tenant's
    // reminder against another tenant's records.
    const request = await asSeller(TENANT_WEB, SELLER_WEB)
    const job = await asJob(TENANT_JOB)
    sameBackend(request, job)

    expect(job.tenant).toBe(TENANT_JOB)
    expect(job.tenants, 'the job inherited the request’s tenant').toEqual(['Folded Job Tenant'])
  })
})

describe('the cross-tenant claim is not narrowed by whoever loaded a page last', () => {
  it('still sees every tenant’s due work after a request has run', async () => {
    // 🔴 THE FAILURE THIS ONE NAMES IS THE WORST OF THE FOUR, because it is
    // silent in both directions. `claimDueJobs` runs with NO tenant context on
    // purpose — it is one of the four enumerated cross-tenant paths — and with
    // no context every policy compares `tenant_id` against NULL and returns
    // nothing. If a request's context were still on the connection, the claim
    // would not error and would not return zero: it would return exactly ONE
    // TENANT'S jobs and drop everybody else's reminders, for as long as that
    // connection kept being reused.
    //
    // Nobody would find that by looking. Reminders would fire for whichever
    // tenant happened to load a page most recently and silently not fire for
    // the rest, and a reminder that does not fire leaves no row saying so.
    const jobA = await schedule(TENANT_JOB, SELLER_JOB, 'folded:claim_a')
    const jobB = await schedule(TENANT_WEB, SELLER_WEB, 'folded:claim_b')

    // A seller loads a page. In the folded process this is the connection the
    // dispatcher's next tick will be handed.
    await asSeller(TENANT_WEB, SELLER_WEB)

    const claimed = await claimDueJobs(50)
    const ids = claimed.map((j) => j.jobId)

    expect(ids, 'the claim missed the tenant that did NOT load a page').toContain(jobA)
    expect(ids, 'the claim missed the tenant that DID load a page').toContain(jobB)

    // Both tenants, which is the property in one line: the claim's reach is not
    // a function of who browsed last.
    expect(new Set(claimed.map((j) => j.tenantId)).size).toBeGreaterThanOrEqual(2)
  })
})

/** Schedules a job that is already due, through the real definer. */
async function schedule(tenantId: string, ownerId: string, key: string): Promise<string> {
  return withSystemWork(tenantId, async (tx) => {
    const rows = await tx.execute<{ id: string }>(
      raw`SELECT app.schedule_job(
            'meeting_reminder'::app.scheduled_kind, ${key}, 'meeting',
            gen_random_uuid(),
            clock_timestamp() - make_interval(mins => 1),
            ${ownerId}::uuid) AS id`,
    )
    const id = rows[0]?.id
    if (id === undefined) throw new Error('schedule_job returned nothing')
    return id
  })
}
