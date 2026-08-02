import { sql as raw } from 'drizzle-orm'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { claimDueJobs, withSystemWork } from '~/db'
import { DROP_AFTER_MINUTES, dispatchDueJobs } from '~/modules/calendar/dispatch'

import { TEST_URL } from './setup/urls'

/**
 * The dispatcher: the process that consumes the scheduling layer.
 *
 * Two of these assertions are about a legal artifact rather than an operational
 * one. A reminder must fire ONCE, at the right instant, inside the lead's legal
 * calling window — so "twice" and "late" are not degraded versions of the
 * promise, they are different promises.
 */

const TENANT_A = '00000000-0000-7000-8000-0000000000d1'
const TENANT_B = '00000000-0000-7000-8000-0000000000d2'
const OWNER_A = '00000000-0000-7000-8000-0000000000e1'
const OWNER_B = '00000000-0000-7000-8000-0000000000e2'
/** Its own tenant, and the reason is the fairness rule itself: the claim hands
 *  back ONE job per tenant, so a lease assertion sharing a tenant with the
 *  storm fixture asserts on whichever job happens to be oldest. */
const TENANT_C = '00000000-0000-7000-8000-0000000000d3'
const OWNER_C = '00000000-0000-7000-8000-0000000000e3'

let sql: postgres.Sql

/** Schedules through the real definer, with tenant context, exactly as the product does. */
async function schedule(
  tenantId: string,
  ownerId: string,
  key: string,
  minutesFromNow: number,
): Promise<string> {
  return withSystemWork(tenantId, async (tx) => {
    const rows = await tx.execute<{ id: string }>(
      raw`SELECT app.schedule_job(
            'meeting_reminder'::app.scheduled_kind, ${key}, 'meeting',
            gen_random_uuid(),
            clock_timestamp() + make_interval(mins => ${minutesFromNow}),
            ${ownerId}::uuid) AS id`,
    )
    const id = rows[0]?.id
    if (id === undefined) throw new Error('schedule_job returned nothing')
    return id
  })
}

async function statusOf(jobId: string): Promise<{ status: string; reason: string | null }> {
  const [row] = await sql<{ status: string; reason: string | null }[]>`
    SELECT status::text AS status, terminal_reason AS reason
    FROM app.scheduled_job WHERE id = ${jobId}`
  return { status: row?.status ?? 'missing', reason: row?.reason ?? null }
}

beforeAll(async () => {
  sql = postgres(TEST_URL, { max: 1, onnotice: () => {} })

  await sql`
    INSERT INTO app.tenant (id, name, business_tz, sms_enabled) VALUES
      (${TENANT_A}, 'Dispatch A', 'America/New_York', false),
      (${TENANT_B}, 'Dispatch B', 'America/New_York', false),
      (${TENANT_C}, 'Dispatch C', 'America/New_York', false)`

  await sql`
    INSERT INTO app.app_user (tenant_id, id, email, full_name, display_name, role) VALUES
      (${TENANT_A}, ${OWNER_A}, 'a@dispatch.test', 'Ana Alpha', 'Ana', 'seller'),
      (${TENANT_B}, ${OWNER_B}, 'b@dispatch.test', 'Ben Beta',  'Ben', 'seller'),
      (${TENANT_C}, ${OWNER_C}, 'c@dispatch.test', 'Cleo Gamma', 'Cleo', 'seller')`
})

afterAll(async () => {
  await sql?.end()
})

describe('the claim actually claims', () => {
  it('hands the same due job to ONE caller, not to both', async () => {
    const jobId = await schedule(TENANT_A, OWNER_A, 'once:reminder_t60', -1)

    // Two dispatchers ticking the same second. Before migration 0020 this was a
    // plain SELECT with no lock and no mark, so BOTH received the row and both
    // fired it — and the side effect of a reminder is a message to a consumer's
    // phone. `scheduled_job_resolve` would then no-op on the second call, which
    // is why the double send left no trace at all.
    const [first, second] = await Promise.all([claimDueJobs(50), claimDueJobs(50)])

    const hits = [...first, ...second].filter((j) => j.jobId === jobId)
    expect(hits).toHaveLength(1)

    // And a third pass finds nothing: the lease outlives the transaction that
    // took it. A row lock alone would be released the moment the claim returned.
    const third = await claimDueJobs(50)
    expect(third.filter((j) => j.jobId === jobId)).toHaveLength(0)
  })

  it('gives every tenant a job before any tenant gets a second', async () => {
    // §9.6 residual #2, and it has a plaintiff attached: ordering purely by
    // fire_at lets ONE tenant's recovery storm starve another tenant's T-1h
    // reminders, and a reminder that fires late can fire outside the legal
    // calling window.
    const noisy: string[] = []
    for (let i = 0; i < 6; i += 1) {
      noisy.push(await schedule(TENANT_A, OWNER_A, `storm-${i}:reminder_t60`, -30 - i))
    }
    // Scheduled LAST and therefore the newest, so a queue ordered by age alone
    // would put it behind all six.
    const quiet = await schedule(TENANT_B, OWNER_B, 'quiet:reminder_t60', -1)

    const claimed = await claimDueJobs(50)
    expect(claimed.map((j) => j.jobId)).toContain(quiet)

    // One per tenant per pass is the shape of the guarantee.
    expect(claimed.filter((j) => j.tenantId === TENANT_A)).toHaveLength(1)
    expect(noisy.length).toBe(6)
  })

  it('lets a later pass reclaim a job whose claimer died', async () => {
    // On its OWN tenant. The claim is fair per call and returns one job per
    // tenant, so sharing a tenant with the storm fixture above would assert on
    // whichever job happened to be oldest rather than on this one.
    const jobId = await schedule(TENANT_C, OWNER_C, 'crashed:reminder_t60', -1)
    expect((await claimDueJobs(50)).map((j) => j.jobId)).toContain(jobId)
    expect((await claimDueJobs(50)).map((j) => j.jobId)).not.toContain(jobId)

    // A dispatcher that dies mid-job leaves the row claimed and still pending.
    // The lease is what makes that a retry rather than a reminder lost in
    // silence — asserted by asking for a zero-length lease rather than by
    // waiting five minutes, which also proves the predicate reads the parameter
    // instead of hard-coding a duration.
    const reclaimed = await withSystemWork(TENANT_C, async (tx) => {
      const rows = await tx.execute<{ job_id: string }>(
        raw`SELECT job_id FROM app.scheduled_job_claim(50, interval '0')`,
      )
      return [...rows].map((r) => r.job_id)
    })
    expect(reclaimed).toContain(jobId)
  })
})

describe('a reminder is dropped rather than sent late', () => {
  it('writes dropped_late past the fifteen-minute rule, with the count in the reason', async () => {
    const late = await schedule(TENANT_A, OWNER_A, 'late:reminder_t60', -(DROP_AFTER_MINUTES + 25))
    await dispatchDueJobs()

    const { status, reason } = await statusOf(late)
    // A terminal ROW, not a log line: "why did this reminder not go out" has to
    // be answerable months later, and an admin page counts these.
    expect(status).toBe('dropped_late')
    expect(reason).toMatch(/^dropped: \d+m late$/)
  })

  it('does not drop one that is merely due', async () => {
    const due = await schedule(TENANT_A, OWNER_A, 'ontime:reminder_t60', -1)
    await dispatchDueJobs()

    const { status, reason } = await statusOf(due)
    expect(status).not.toBe('dropped_late')
    // SMS-dark: skipped is a first-class terminal state, not an error. It is
    // what lets the launch configuration run with no path failing, and it is
    // the evidence that a reminder was skipped rather than lost.
    expect(status).toBe('skipped')
    expect(reason).toBe('skipped: sms_disabled')
  })

  it('reads sms_enabled from the TENANT ROW, not from the environment', async () => {
    // §10.16 makes this a column and bans process.env.SMS* across the tree.
    // Flipping the row must change the outcome, or the column is decoration.
    await sql`UPDATE app.tenant SET sms_enabled = true WHERE id = ${TENANT_A}`
    try {
      const job = await schedule(TENANT_A, OWNER_A, 'smson:reminder_t60', -1)
      await dispatchDueJobs()

      const { reason } = await statusOf(job)
      expect(reason).not.toBe('skipped: sms_disabled')
      expect(reason).toBe('skipped: no sms transport configured')
    } finally {
      await sql`UPDATE app.tenant SET sms_enabled = false WHERE id = ${TENANT_A}`
    }
  })
})

describe('the application role cannot forge a dispatch', () => {
  it('has no write on claimed_at, so it cannot make one reminder fire twice', async () => {
    // The lease is the dispatcher's. An UPDATE that clears it puts the job back
    // in the pool while the first send is still in flight — the exact failure
    // 0020 exists to close, reintroduced through a plain UPDATE.
    const [grant] = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM information_schema.column_privileges
      WHERE grantee = 'crm_app' AND table_schema = 'app'
        AND table_name = 'scheduled_job' AND column_name = 'claimed_at'
        AND privilege_type = 'UPDATE'`
    expect(grant?.n).toBe('0')
  })

  it('keeps pg-boss out of the hardened set, on the record', async () => {
    // Without this row the next deploy dies with HR001 the moment pg-boss
    // exists, because managed_relations() scans every schema. Verified by
    // flipping it: harden() raises. The exemption carries its reason, and the
    // constraint refuses one without.
    const [row] = await sql<{ posture: string; reason: string | null }[]>`
      SELECT posture, exception_reason AS reason
      FROM security.schema_policy WHERE schema_name = 'pgboss'`

    expect(row?.posture).toBe('exempt')
    expect(row?.reason).toMatch(/migrator/i)
  })
})
