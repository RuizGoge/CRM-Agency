import { sql as raw } from 'drizzle-orm'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { withTenant } from '~/db'

import { rejectionChain } from './setup/errors'
import { TEST_URL } from './setup/urls'

/**
 * Calendar and reminders.
 *
 * The theme is that a reminder is a legal artefact, not a convenience. It has
 * to fire once, at the right instant, in a timezone that cannot be rewritten
 * afterwards — and when it does not fire, the reason has to survive.
 */

const TENANT = '00000000-0000-7000-8000-0000000000f7'
const NOISY = '00000000-0000-7000-8000-0000000000f8'
const SELLER = '00000000-0000-7000-8000-00000000aa01'
const NOISY_SELLER = '00000000-0000-7000-8000-00000000aa02'

let sql: postgres.Sql
let contactId = ''
let opportunityId = ''
let meetingId = ''

async function seedTenant(tenantId: string, userId: string, tz: string): Promise<void> {
  await sql`
    INSERT INTO app.tenant (id, name, business_tz) VALUES (${tenantId}, 'Cal Agency', ${tz})`
  await sql`
    INSERT INTO app.app_user (tenant_id, id, email, full_name, display_name, role)
    VALUES (${tenantId}, ${userId}, ${userId + '@cal.test'}, 'Cal Seller', 'Cal', 'seller')`
}

beforeAll(async () => {
  sql = postgres(TEST_URL, { max: 1, onnotice: () => {} })

  await seedTenant(TENANT, SELLER, 'America/New_York')
  await seedTenant(NOISY, NOISY_SELLER, 'America/Chicago')

  const [c] = await sql<{ id: string }[]>`
    INSERT INTO app.contact (tenant_id, owner_user_id, full_name, created_via, lead_local_tz, tz_confidence, tz_source)
    VALUES (${TENANT}, ${SELLER}, 'Curtis Vance', 'manual', 'America/New_York', 'high', 'zip')
    RETURNING id`
  contactId = c?.id ?? ''

  await sql`INSERT INTO app.pipeline (tenant_id, owner_user_id, name) VALUES (${TENANT}, ${SELLER}, 'Board')`
  const [st] = await sql<{ id: string }[]>`
    INSERT INTO app.stage (tenant_id, pipeline_id, owner_user_id, name, stage_type, sort_order)
    SELECT ${TENANT}, p.id, ${SELLER}, 'New', 'open', 0 FROM app.pipeline p
    WHERE p.tenant_id = ${TENANT} AND p.owner_user_id = ${SELLER} RETURNING id`
  const [o] = await sql<{ id: string }[]>`
    INSERT INTO app.opportunity
      (tenant_id, owner_user_id, contact_id, pipeline_id, stage_id, current_stage_type, created_from)
    SELECT ${TENANT}, ${SELLER}, ${contactId}, p.id, ${st?.id ?? null}, 'open', 'manual'
    FROM app.pipeline p WHERE p.tenant_id = ${TENANT} AND p.owner_user_id = ${SELLER}
    RETURNING id`
  opportunityId = o?.id ?? ''

  const [m] = await sql<{ id: string }[]>`
    INSERT INTO app.meeting
      (tenant_id, owner_user_id, contact_id, opportunity_id, starts_at_utc, contact_timezone, created_via)
    VALUES (${TENANT}, ${SELLER}, ${contactId}, ${opportunityId},
            '2026-09-10T18:00:00Z', 'America/New_York', 'wrap_up')
    RETURNING id`
  meetingId = m?.id ?? ''
})

afterAll(async () => {
  await sql?.end()
})

describe('one live reminder per meeting, ever', () => {
  it('schedules at T-1h with the episode key the brief demands', async () => {
    await withTenant({ tenantId: TENANT, userId: SELLER }, (tx) =>
      tx.execute(raw`SELECT app.schedule_meeting_reminder(${meetingId}::uuid)`),
    )

    const [row] = await sql<{ key: string; fire: string; kind: string }[]>`
      SELECT idempotency_key AS key, fire_at::text AS fire, kind::text AS kind
      FROM app.scheduled_job
      WHERE tenant_id = ${TENANT} AND canceled_at IS NULL`

    expect(row?.kind).toBe('meeting_reminder')
    expect(row?.key).toBe(`${meetingId}:t_minus_60m`)
    expect(row?.fire).toContain('17:00:00')
  })

  it('moves the reminder on reschedule instead of adding a second', async () => {
    // A second live reminder is a second SMS to a consumer, which is a second
    // billable message and, if consent lapsed between them, a second exposure.
    await withTenant({ tenantId: TENANT, userId: SELLER }, (tx) =>
      tx.execute(raw`SELECT app.schedule_meeting_reminder(${meetingId}::uuid)`),
    )

    const live = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM app.scheduled_job
      WHERE tenant_id = ${TENANT} AND canceled_at IS NULL`
    expect(live[0]?.n).toBe('1')

    // The superseded row is retained, not deleted: it is the evidence of what
    // was scheduled and when it stopped being scheduled.
    const canceled = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM app.scheduled_job
      WHERE tenant_id = ${TENANT} AND canceled_at IS NOT NULL AND status = 'canceled'`
    expect(canceled[0]?.n).toBe('1')
  })

  it('keeps a skipped job as a first-class terminal state with its reason', async () => {
    // The product launches SMS-dark. A skipped reminder must be an auditable
    // outcome rather than an error, or the dark rehearsal cannot pass.
    const [job] = await sql<{ id: string }[]>`
      SELECT id FROM app.scheduled_job
      WHERE tenant_id = ${TENANT} AND canceled_at IS NULL LIMIT 1`

    await withTenant({ tenantId: TENANT, userId: SELLER }, (tx) =>
      tx.execute(
        raw`SELECT app.scheduled_job_resolve(${job?.id ?? null}::uuid,
                                             'skipped'::app.job_status,
                                             'skipped: sms_disabled')`,
      ),
    )

    const [row] = await sql<{ status: string; reason: string }[]>`
      SELECT status::text AS status, terminal_reason AS reason
      FROM app.scheduled_job WHERE tenant_id = ${TENANT} AND id = ${job?.id ?? null}`

    expect(row?.status).toBe('skipped')
    expect(row?.reason).toBe('skipped: sms_disabled')
  })
})

describe('one tenant cannot starve another tenant of its reminders', () => {
  it('gives a quiet tenant its due job in the first claim, behind a 60-job backlog', async () => {
    // Residual risk #2, and it has a compliance edge rather than an
    // operational one: a reminder delayed behind another tenant's recovery
    // storm can fire OUTSIDE the legal calling window.
    await sql`
      INSERT INTO app.scheduled_job (tenant_id, kind, idempotency_key, subject_type, subject_id, fire_at)
      SELECT ${NOISY}, 'cold_sweep', 'storm:' || g, 'opportunity', gen_random_uuid(),
             clock_timestamp() - interval '1 hour' + (g * interval '1 second')
      FROM generate_series(1, 60) g`

    // Queued LAST and due LATEST, so pure fire_at ordering would put it 61st.
    await sql`
      INSERT INTO app.scheduled_job (tenant_id, kind, idempotency_key, subject_type, subject_id, fire_at)
      VALUES (${TENANT}, 'meeting_reminder', 'quiet:one', 'meeting', ${meetingId},
              clock_timestamp() - interval '1 second')`

    const claimed = await sql<{ tenant_id: string }[]>`
      SELECT tenant_id FROM app.scheduled_job_claim(10)`

    expect(claimed.map((c) => c.tenant_id)).toContain(TENANT)
  })
})

describe("a meeting's timezone is a snapshot, not a join", () => {
  it('refuses a zone that is not a real IANA name', async () => {
    expect(
      await rejectionChain(
        sql`
          INSERT INTO app.meeting
            (tenant_id, owner_user_id, contact_id, opportunity_id, starts_at_utc, contact_timezone, created_via)
          VALUES (${TENANT}, ${SELLER}, ${contactId}, ${opportunityId},
                  '2026-09-11T18:00:00Z', 'America/Nowhere', 'manual')`,
      ),
    ).toMatch(/TZ002/)
  })

  it('does not move a booked meeting when the contact is later edited', async () => {
    // A contact edit must not retroactively change a past meeting's local time
    // — or, far worse, retroactively change whether a reminder that already
    // fired was legal to send.
    await sql`
      UPDATE app.contact SET lead_local_tz = 'America/Los_Angeles'
      WHERE tenant_id = ${TENANT} AND id = ${contactId}`

    const [row] = await sql<{ tz: string }[]>`
      SELECT contact_timezone AS tz FROM app.meeting
      WHERE tenant_id = ${TENANT} AND id = ${meetingId}`

    expect(row?.tz).toBe('America/New_York')
  })

  it('refuses a duplicate booking for the same contact at the same instant', async () => {
    // The two-click Quick Schedule needs a guard a double tap cannot outrun.
    expect(
      await rejectionChain(
        sql`
          INSERT INTO app.meeting
            (tenant_id, owner_user_id, contact_id, opportunity_id, starts_at_utc, contact_timezone, created_via)
          VALUES (${TENANT}, ${SELLER}, ${contactId}, ${opportunityId},
                  '2026-09-10T18:00:00Z', 'America/New_York', 'quick_schedule')`,
      ),
    ).toMatch(/meeting_no_duplicate_uidx/)
  })
})

describe('needs_outcome is derived and therefore never stale', () => {
  it('surfaces a past meeting with no outcome, with nothing having been written', async () => {
    await sql`
      INSERT INTO app.meeting
        (tenant_id, owner_user_id, contact_id, opportunity_id, starts_at_utc, contact_timezone, created_via)
      VALUES (${TENANT}, ${SELLER}, ${contactId}, ${opportunityId},
              clock_timestamp() - interval '2 hours', 'America/New_York', 'manual')`

    const rows = await withTenant({ tenantId: TENANT, userId: SELLER }, async (tx) => {
      const r = await tx.execute<{ id: string }>(raw`SELECT id FROM app.meeting_needs_outcome`)
      return [...r]
    })

    expect(rows).toHaveLength(1)
  })
})

describe('the one activity object', () => {
  it('refuses a task with no due time', async () => {
    // A scheduled callback has a hard due time by construction; without one,
    // My Day has nowhere to put it.
    expect(
      await rejectionChain(
        sql`
          INSERT INTO app.activity (tenant_id, owner_user_id, contact_id, type, title, created_by)
          VALUES (${TENANT}, ${SELLER}, ${contactId}, 'task', 'Call back', 'human')`,
      ),
    ).toMatch(/activity_task_has_due_at/)
  })

  it('refuses machine-created work that cannot say why it exists', async () => {
    expect(
      await rejectionChain(
        sql`
          INSERT INTO app.activity (tenant_id, owner_user_id, contact_id, type, title, created_by, due_at)
          VALUES (${TENANT}, ${SELLER}, ${contactId}, 'task', 'Mystery', 'automation', clock_timestamp())`,
      ),
    ).toMatch(/activity_machine_work_is_explainable/)
  })

  it('exposes app.task without a second source of truth', async () => {
    await sql`
      INSERT INTO app.activity (tenant_id, owner_user_id, contact_id, type, title, created_by, due_at)
      VALUES (${TENANT}, ${SELLER}, ${contactId}, 'task', 'Real callback', 'human', clock_timestamp())`

    const rows = await withTenant({ tenantId: TENANT, userId: SELLER }, async (tx) => {
      const r = await tx.execute<{ title: string }>(raw`SELECT title FROM app.task`)
      return [...r]
    })

    expect(rows.map((r) => r.title)).toEqual(['Real callback'])
  })
})

describe('scheduling intent is written by definers only', () => {
  it('denies crm_app the ability to enqueue or resolve a job by hand', async () => {
    const insert = await sql<{ privilege_type: string }[]>`
      SELECT privilege_type FROM information_schema.table_privileges
      WHERE grantee = 'crm_app' AND table_schema = 'app' AND table_name = 'scheduled_job'
        AND privilege_type = 'INSERT'`
    expect(insert).toEqual([])

    // Read stays owner-scoped, so My Day can still explain why a reminder was
    // skipped. What a seller cannot do is change that answer.
    const statusUpdate = await sql<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.column_privileges
      WHERE grantee = 'crm_app' AND table_schema = 'app' AND table_name = 'scheduled_job'
        AND privilege_type = 'UPDATE' AND column_name IN ('status', 'fire_at', 'terminal_reason')`
    expect(statusUpdate).toEqual([])
  })
})
