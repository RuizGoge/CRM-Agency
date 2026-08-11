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

/** The contact and opportunity each tenant's reminders hang off. */
const SUBJECTS = new Map<string, { contactId: string; opportunityId: string }>()

/** Schedules through the real definer, with tenant context, exactly as the product does. */
async function schedule(
  tenantId: string,
  ownerId: string,
  key: string,
  minutesFromNow: number,
): Promise<string> {
  // ⚠️ A REAL MEETING, AND IT USED TO BE `gen_random_uuid()`.
  //
  // The subject was synthetic while nothing ever looked at it — the dispatcher
  // read `tenant.sms_enabled` and resolved the job without ever asking what the
  // reminder was ABOUT. Since the compliance gate was wired into this path it
  // does: `app.reminder_gate` resolves the job's meeting to a contact and asks
  // the one gate about that contact.
  //
  // With a subject that points at nothing the gate correctly fails CLOSED with
  // `blocked_timezone_unknown` — there is nobody to check — and every assertion
  // below would be reading that instead of the terminal row it means to read.
  // The fixture was what went stale, not the gate.
  // Seeded on the OWNER connection, not through `withSystemWork`. System work
  // carries no user, and `contact` is `owner_scoped` — its WITH CHECK requires
  // `owner_user_id = app.current_user_id()`, so the insert is refused. That is
  // the policy working, and it is why fixtures in this tree are written as the
  // owner rather than through the application's own door.
  const subject = SUBJECTS.get(tenantId)
  if (subject === undefined) throw new Error(`no subject chain seeded for ${tenantId}`)

  const [meeting] = await sql<{ id: string }[]>`
    INSERT INTO app.meeting (tenant_id, owner_user_id, contact_id, opportunity_id,
                             starts_at_utc, contact_timezone, created_via)
    VALUES (${tenantId}, ${ownerId}, ${subject.contactId}, ${subject.opportunityId},
            clock_timestamp() + interval '1 hour', 'America/Chicago', 'manual')
    RETURNING id`

  return withSystemWork(tenantId, async (tx) => {
    const rows = await tx.execute<{ id: string }>(
      raw`SELECT app.schedule_job(
            'meeting_reminder'::app.scheduled_kind, ${key}, 'meeting',
            ${meeting?.id ?? ''}::uuid,
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

  // A REMINDER IS ABOUT SOMETHING, and since the compliance gate was wired into
  // this path the dispatcher follows the chain: job → meeting → contact → the
  // one gate. `app.meeting` requires an opportunity, which requires a stage,
  // which requires a pipeline — so the whole chain is seeded once per tenant
  // and every scheduled job hangs a fresh meeting off it.
  //
  // Texas on purpose: two zones AND one-party recording, so a lead here is
  // refused by the calling window at night and never by the recording guard,
  // which keeps the verdicts these tests read unambiguous.
  for (const [tenant, owner] of [
    [TENANT_A, OWNER_A],
    [TENANT_B, OWNER_B],
    [TENANT_C, OWNER_C],
  ] as const) {
    const [contact] = await sql<{ id: string }[]>`
      INSERT INTO app.contact (tenant_id, owner_user_id, full_name, created_via, state_code, zip5)
      VALUES (${tenant}, ${owner}, 'Reminder Lead', 'manual', 'TX', '75201')
      RETURNING id`

    const [pipeline] = await sql<{ id: string }[]>`
      INSERT INTO app.pipeline (tenant_id, owner_user_id, name)
      VALUES (${tenant}, ${owner}, 'Board') RETURNING id`

    const [stage] = await sql<{ id: string }[]>`
      INSERT INTO app.stage (tenant_id, pipeline_id, owner_user_id, name, stage_type, sort_order)
      VALUES (${tenant}, ${pipeline?.id ?? ''}, ${owner}, 'Working', 'open', 0) RETURNING id`

    const [opportunity] = await sql<{ id: string }[]>`
      INSERT INTO app.opportunity
        (tenant_id, owner_user_id, contact_id, pipeline_id, stage_id,
         current_stage_type, created_from)
      VALUES (${tenant}, ${owner}, ${contact?.id ?? ''}, ${pipeline?.id ?? ''},
              ${stage?.id ?? ''}, 'open', 'manual')
      RETURNING id`

    SUBJECTS.set(tenant, {
      contactId: contact?.id ?? '',
      opportunityId: opportunity?.id ?? '',
    })
  }
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

    // 🔴 A BREAK-GLASS OVERRIDE, AND WITHOUT IT THIS ASSERTION DEPENDS ON THE
    // TIME OF DAY. With SMS on, the gate stops at `sms_disabled` and carries on
    // down the chain — and the next thing it checks is the lead's own calling
    // window. A Texas lead at 2am Central is refused, correctly, and this test
    // would pass in the afternoon and fail overnight. There is no state that
    // avoids it: between roughly 06:00 and 12:00 UTC nobody in the United
    // States is legally callable.
    //
    // The override releases EXACTLY the two clock verdicts and nothing else, so
    // what this test is actually about — that flipping the tenant row changes
    // the outcome — is what decides the result.
    await sql`
      INSERT INTO app.break_glass_override (tenant_id, started_by_user_id, reason)
      VALUES (${TENANT_A}, ${OWNER_A}, 'dispatch suite: the clock must not decide this')`

    try {
      const job = await schedule(TENANT_A, OWNER_A, 'smson:reminder_t60', -1)
      await dispatchDueJobs()

      const { reason } = await statusOf(job)
      expect(reason).not.toBe('skipped: sms_disabled')
      expect(reason).toBe('skipped: no sms transport configured')
    } finally {
      await sql`UPDATE app.tenant SET sms_enabled = false WHERE id = ${TENANT_A}`
      await sql`
        UPDATE app.break_glass_override SET ended_at = clock_timestamp(), end_reason = 'manual'
         WHERE tenant_id = ${TENANT_A} AND ended_at IS NULL`
    }
  })

  it('refuses a reminder to a suppressed number, which it could not do before', async () => {
    // 🎯 THE VERDICT THAT WAS UNREACHABLE ON THIS PATH. The dispatcher used to
    // read `tenant.sms_enabled` and nothing else, so a STOP on the lead's number
    // did not stop the reminder — the send simply did not exist yet to expose
    // it. One gate with two implementations is how that happens.
    //
    // A STOP is tenant-wide and has no owner column: the point is that a STOP
    // one seller receives silences the whole agency's dialler, including a
    // reminder scheduled before it arrived.
    await sql`UPDATE app.tenant SET sms_enabled = true WHERE id = ${TENANT_B}`
    try {
      const subject = SUBJECTS.get(TENANT_B)
      const [phone] = await sql<{ phone_e164: string }[]>`
        INSERT INTO app.contact_phone
          (tenant_id, contact_id, owner_user_id, phone_e164, kind, is_primary)
        VALUES (${TENANT_B}, ${subject?.contactId ?? ''}, ${OWNER_B},
                '+12145559911', 'mobile', true)
        RETURNING phone_e164`

      await sql`
        INSERT INTO app.suppression_list (tenant_id, phone_e164, kind, channel, effective_at, reason)
        VALUES (${TENANT_B}, ${phone?.phone_e164 ?? ''}, 'stop', NULL,
                clock_timestamp(), 'replied STOP')`

      const job = await schedule(TENANT_B, OWNER_B, 'stopped:reminder_t60', -1)
      await dispatchDueJobs()

      const { status, reason } = await statusOf(job)
      expect(status).toBe('skipped')
      expect(reason).toBe('skipped: blocked_suppressed')
    } finally {
      await sql`UPDATE app.tenant SET sms_enabled = false WHERE id = ${TENANT_B}`
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
