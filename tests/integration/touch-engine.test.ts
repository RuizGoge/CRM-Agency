import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { sql as raw } from 'drizzle-orm'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { withTenant } from '~/db'

import { TEST_URL } from './setup/urls'

/**
 * The canonical touch engine (MVP item 25).
 *
 * Five events claimed the right to reset `last_activity_at`; 05b ruled a
 * deterministic max(). One trigger function, registered per source table with
 * whatever that table calls the moment work happened, writing
 * GREATEST(old, new) — monotonic, never decremented.
 *
 * MONOTONIC IS NOT DEFENSIVE CODING. `last_activity_at` is the input to the
 * cold-episode key, and a value that can move backwards makes
 * `opportunity.went_cold` fire twice for one episode: the difference between a
 * badge and a notification firehose.
 */

const TENANT = '00000000-0000-7000-8000-0000000707c0'
const ANA = '00000000-0000-7000-8000-0000000707a1'
const PHONE = '+19045550160'

let sql: postgres.Sql
let contactId: string
let oppId: string

/**
 * `Date`, not `string` — postgres.js parses timestamptz for us. The first
 * version of this typed them as strings and `toBe` then compared object
 * identity, failing with two timestamps printed identically.
 */
type Touches = {
  last_activity_at: Date | null
  last_human_touch_at: Date | null
  last_touch_at: Date | null
}

const ms = (d: Date | null): number => (d === null ? 0 : d.getTime())

async function touches(): Promise<Touches> {
  const [row] = await sql<Touches[]>`
    SELECT o.last_activity_at, o.last_human_touch_at, c.last_touch_at
      FROM app.opportunity o
      JOIN app.contact c ON c.tenant_id = o.tenant_id AND c.id = o.contact_id
     WHERE o.tenant_id = ${TENANT} AND o.id = ${oppId}`
  if (row === undefined) throw new Error('fixture opportunity vanished')
  return row
}

/** Completes an activity, which is what a touch actually is. */
async function completeActivity(
  createdBy: 'human' | 'automation',
  completedAgo: string,
): Promise<void> {
  // `activity_machine_work_is_explainable` refuses machine-created work with no
  // source_event_name, which is the constraint form of "why is this on my list
  // today" always having an answer. Human work owes nothing.
  await sql`
    INSERT INTO app.activity
      (tenant_id, owner_user_id, contact_id, opportunity_id, type, title,
       created_by, source_event_name, completed_at)
    VALUES (${TENANT}, ${ANA}, ${contactId}, ${oppId}, 'call', 'Dial',
            ${createdBy}::app.actor_type,
            ${createdBy === 'human' ? null : 'sequence.enrolled'},
            clock_timestamp() - ${completedAgo}::interval)`
}

beforeAll(async () => {
  sql = postgres(TEST_URL, { max: 1, onnotice: () => {} })

  await sql`
    INSERT INTO app.tenant (id, name, business_tz)
    VALUES (${TENANT}, 'Touch Agency', 'America/New_York')`
  await sql`
    INSERT INTO app.app_user (tenant_id, id, email, full_name, display_name, role)
    VALUES (${TENANT}, ${ANA}, 'ana@touch.test', 'Ana Seller', 'Ana A.', 'seller')`

  const [contact] = await sql<{ id: string }[]>`
    INSERT INTO app.contact (tenant_id, owner_user_id, full_name, created_via)
    VALUES (${TENANT}, ${ANA}, 'Marisol Vega', 'lead_intake') RETURNING id`
  contactId = contact?.id ?? ''

  await sql`
    INSERT INTO app.contact_phone (tenant_id, contact_id, owner_user_id, phone_e164, is_primary)
    VALUES (${TENANT}, ${contactId}, ${ANA}, ${PHONE}, true)`

  await sql`
    INSERT INTO app.pipeline (tenant_id, owner_user_id, name)
    VALUES (${TENANT}, ${ANA}, 'My Board')`
  const [stage] = await sql<{ id: string }[]>`
    INSERT INTO app.stage (tenant_id, pipeline_id, owner_user_id, name, stage_type, sort_order)
    SELECT ${TENANT}, p.id, ${ANA}, 'New Lead', 'open'::app.stage_type, 0
      FROM app.pipeline p WHERE p.tenant_id = ${TENANT} AND p.owner_user_id = ${ANA}
    RETURNING id`

  const [opp] = await sql<{ id: string }[]>`
    INSERT INTO app.opportunity
      (tenant_id, owner_user_id, contact_id, pipeline_id, stage_id, current_stage_type,
       created_from, stage_entered_at)
    SELECT ${TENANT}, ${ANA}, ${contactId}, p.id, ${stage?.id ?? null}, 'open',
           'lead_intake', clock_timestamp()
      FROM app.pipeline p WHERE p.tenant_id = ${TENANT} AND p.owner_user_id = ${ANA}
    RETURNING id`
  oppId = opp?.id ?? ''
})

afterAll(async () => {
  await sql?.end()
})

describe('a completed activity is what a touch is', () => {
  it('starts with nothing touched', async () => {
    // The positive control for everything below: these columns begin null, so a
    // later non-null value is the trigger working rather than a default.
    const t = await touches()
    expect(t.last_activity_at).toBeNull()
    expect(t.last_human_touch_at).toBeNull()
    expect(t.last_touch_at).toBeNull()
  })

  it('does NOT touch when the activity is only scheduled', async () => {
    // Work booked for Thursday is not work done. Counting it would reset the
    // cold clock for a lead nobody has spoken to — which is the whole failure
    // the going-cold signal exists to surface.
    await sql`
      INSERT INTO app.activity
        (tenant_id, owner_user_id, contact_id, opportunity_id, type, title, created_by, due_at)
      VALUES (${TENANT}, ${ANA}, ${contactId}, ${oppId}, 'task', 'Call Thursday',
              'human', clock_timestamp() + interval '2 days')`

    const t = await touches()
    expect(t.last_activity_at).toBeNull()
  })

  it('advances the opportunity AND the contact when work is completed', async () => {
    await completeActivity('human', '30 minutes')
    const t = await touches()
    expect(t.last_activity_at).not.toBeNull()
    expect(t.last_human_touch_at).not.toBeNull()
    // THE COLUMN THAT WAS DEAD. contact.last_touch_at has existed since
    // migration 0010 and nothing in the tree ever wrote it, which meant the
    // recent-contact signal could never fire in production while passing every
    // one of its own tests — the fixtures set it by hand.
    expect(t.last_touch_at).not.toBeNull()
  })
})

describe('the max is deterministic and never goes backwards', () => {
  it('refuses to decrement when an older touch lands later', async () => {
    // THE ASSERTION THE RULING EXISTS FOR. A late webhook, a backfilled import
    // or a wrap-up saved out of order all insert an OLDER completed_at after a
    // newer one. Taking the new value would move the cold clock backwards and
    // re-open a cold episode that already fired.
    const before = await touches()
    await completeActivity('human', '10 hours')
    const after = await touches()

    expect(ms(after.last_activity_at)).toBe(ms(before.last_activity_at))
    expect(ms(after.last_touch_at)).toBe(ms(before.last_touch_at))
  })

  it('advances when a newer touch lands', async () => {
    const before = await touches()
    await completeActivity('human', '1 minute')
    const after = await touches()

    expect(ms(after.last_activity_at)).toBeGreaterThan(ms(before.last_activity_at))
  })
})

describe('automation touches, but it is not a human touch', () => {
  it('moves last_activity_at and leaves last_human_touch_at alone', async () => {
    // If cold keyed on any activity, a sequence texting a dead lead every four
    // days would keep it looking warm forever: automation would MASK
    // abandonment instead of surfacing it. Two columns is what stops that.
    const before = await touches()
    await completeActivity('automation', '0 seconds')
    const after = await touches()

    expect(ms(after.last_activity_at)).toBeGreaterThan(ms(before.last_activity_at))
    expect(ms(after.last_human_touch_at)).toBe(ms(before.last_human_touch_at))
  })
})

describe('a held meeting touches too', () => {
  it('counts as human, because nothing automated attends one', async () => {
    const before = await touches()
    await sql`
      INSERT INTO app.meeting
        (tenant_id, owner_user_id, contact_id, opportunity_id, starts_at_utc,
         contact_timezone, meeting_type, created_via, outcome_at)
      VALUES (${TENANT}, ${ANA}, ${contactId}, ${oppId}, clock_timestamp(),
              'America/New_York', 'phone', 'quick_schedule', clock_timestamp())`

    const after = await touches()
    expect(ms(after.last_human_touch_at)).toBeGreaterThan(ms(before.last_human_touch_at))
  })
})

describe('the signal that reads these columns now has something to read', () => {
  it('reports the office touch that the touch engine wrote', async () => {
    // END TO END, and the reason this migration could not wait for the
    // communications module: item 13 shipped reading a column nothing wrote.
    // Here a real completed activity moves it, and the signal sees it — with a
    // second seller asking, so the cross-silo half is exercised too.
    const BEN = '00000000-0000-7000-8000-0000000707b1'
    await sql`
      INSERT INTO app.app_user (tenant_id, id, email, full_name, display_name, role)
      VALUES (${TENANT}, ${BEN}, 'ben@touch.test', 'Ben Seller', 'Ben B.', 'seller')
      ON CONFLICT DO NOTHING`
    const [bens] = await sql<{ id: string }[]>`
      INSERT INTO app.contact (tenant_id, owner_user_id, full_name, created_via)
      VALUES (${TENANT}, ${BEN}, 'Marisol Vega', 'lead_intake') RETURNING id`
    await sql`
      INSERT INTO app.contact_phone (tenant_id, contact_id, owner_user_id, phone_e164, is_primary)
      VALUES (${TENANT}, ${bens?.id ?? ''}, ${BEN}, ${PHONE}, true)`

    // Through withTenant, not a bare statement: app.begin_request sets its GUC
    // transaction-locally, so a session established in one call is already gone
    // by the next one.
    const rows = await withTenant({ tenantId: TENANT, userId: BEN }, async (tx) =>
      tx.execute<{ status: string }>(
        raw`SELECT status FROM app.recent_contact_signal(${bens?.id ?? ''}::uuid)`,
      ),
    )
    expect(rows[0]?.status).toBe('recent')
  })
})

describe('the set of touch sources is pinned', () => {
  it('holds exactly the two tables that can touch today', () => {
    // 05b names four sources: activity, call, message and meeting. Two exist.
    // Adding the other two is registering them against the same function — and
    // pinning the set here is what makes FORGETTING them a red build instead of
    // a lead that silently never goes cold. Read from the migrations, not the
    // catalogue: the question is static and `crm_test` is shared.
    const sql_ = readdirSync('app/db/migrations')
      .filter((f) => f.endsWith('.sql'))
      .map((f) => readFileSync(join('app/db/migrations', f), 'utf8'))
      .join('\n')

    const registered = [...sql_.matchAll(/CREATE TRIGGER t_touch_(\w+)/g)].map((m) => m[1]).sort()
    expect(registered).toEqual(['activity', 'meeting'])
  })
})
