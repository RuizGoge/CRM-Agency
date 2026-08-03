import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { readPipelineFor, type BoardCard } from '~/routes/api/board'

import { TEST_URL } from './setup/urls'

/**
 * The health rail and the signal slot — `04b` §2.4 element ④, §2.7 and §2.8.
 *
 * Both are SERVER-COMPUTED, and the reason is one sentence in §2.8: the board,
 * My Book and My Day must be byte-identical about whether a lead is decaying.
 * Three screens each deciding for themselves is three answers to a question a
 * seller asks once.
 *
 * The rules worth testing are the ones a reader would call bugs:
 *
 *   * THE TWO PRECEDENCE ORDERS DIFFER, on purpose. The rail is
 *     `blocked > overdue > fresh > going_cold > ok` (§2.8); the slot is
 *     `recent contact > fresh > overdue > going cold > needs reply > no next
 *     step` (§2.7). A lead that arrived minutes ago with an already-late
 *     callback shows a red rail and a `NEW` chip, and that is both documents
 *     being followed rather than one being wrong.
 *   * EXACTLY ONE SIGNAL, never two. The slot is one fixed-width box on a
 *     264px card.
 *   * SUPPRESSION on `earning` and `lost` stages, which §2.7 calls
 *     non-negotiable and gives the reason for: otherwise every card is amber
 *     on the first Monday and the signal becomes wallpaper.
 */

const TENANT = '00000000-0000-7000-8000-0000000000fb'
const SELLER = '00000000-0000-7000-8000-00000000fb01'

let sql: postgres.Sql
let openStage = ''
let wonStage = ''
let lostStage = ''

/** One card, with its age and history stated rather than defaulted. */
async function card(
  name: string,
  o: {
    stage: () => string
    ageDays?: number
    touchedDays?: number
    attempts?: number
    overdueHours?: number
    futureActivity?: boolean
    minutesOld?: number
  },
): Promise<void> {
  const [contact] = await sql<{ id: string }[]>`
    INSERT INTO app.contact (tenant_id, owner_user_id, full_name, created_via)
    VALUES (${TENANT}, ${SELLER}, ${name}, 'lead_intake') RETURNING id`

  const age = o.minutesOld ?? (o.ageDays ?? 0) * 24 * 60
  const touched = (o.touchedDays ?? 0) * 24 * 60

  const [opp] = await sql<{ id: string }[]>`
    INSERT INTO app.opportunity
      (tenant_id, owner_user_id, contact_id, pipeline_id, stage_id, current_stage_type,
       created_from, created_at, stage_entered_at, last_activity_at, attempt_count,
       premium_annual_cents, premium_mode, lost_reason_id)
    SELECT ${TENANT}, ${SELLER}, ${contact?.id ?? null}, p.id, ${o.stage()},
           (SELECT stage_type FROM app.stage WHERE tenant_id = ${TENANT} AND id = ${o.stage()}),
           'lead_intake',
           clock_timestamp() - (${age} || ' minutes')::interval,
           clock_timestamp() - (${age} || ' minutes')::interval,
           clock_timestamp() - (${touched} || ' minutes')::interval,
           ${o.attempts ?? 0},
           CASE WHEN ${o.stage()} = ${wonStage} THEN 100000 ELSE NULL END,
           CASE WHEN ${o.stage()} = ${wonStage}
                THEN 'annual'::app.premium_mode ELSE NULL END,
           CASE WHEN ${o.stage()} = ${lostStage}
                THEN (SELECT id FROM app.lost_reason
                       WHERE tenant_id = ${TENANT} LIMIT 1) ELSE NULL END
    FROM app.pipeline p WHERE p.tenant_id = ${TENANT} AND p.owner_user_id = ${SELLER}
    RETURNING id`

  if (o.overdueHours !== undefined) {
    await sql`
      INSERT INTO app.activity
        (tenant_id, owner_user_id, contact_id, opportunity_id, type, title, due_at, created_by)
      VALUES (${TENANT}, ${SELLER}, ${contact?.id ?? null}, ${opp?.id ?? null}, 'task',
              'Late task', clock_timestamp() - (${o.overdueHours} || ' hours')::interval, 'human')`
  }
  if (o.futureActivity === true) {
    await sql`
      INSERT INTO app.activity
        (tenant_id, owner_user_id, contact_id, opportunity_id, type, title, due_at, created_by)
      VALUES (${TENANT}, ${SELLER}, ${contact?.id ?? null}, ${opp?.id ?? null}, 'task',
              'Next step', clock_timestamp() + interval '2 days', 'human')`
  }
}

async function board(): Promise<Map<string, BoardCard>> {
  const payload = await readPipelineFor({ tenantId: TENANT, userId: SELLER })
  return new Map(payload.columns.flatMap((c) => c.cards).map((k) => [k.contactName, k]))
}

beforeAll(async () => {
  sql = postgres(TEST_URL, { max: 1, onnotice: () => {} })

  await sql`
    INSERT INTO app.tenant (id, name, business_tz, cold_threshold_days)
    VALUES (${TENANT}, 'Health Agency', 'America/New_York', 7)`
  await sql`
    INSERT INTO app.app_user (tenant_id, id, email, full_name, display_name, role)
    VALUES (${TENANT}, ${SELLER}, 'h@health.test', 'Hana Rail', 'Hana R.', 'seller')`
  await sql`
    INSERT INTO app.pipeline (tenant_id, owner_user_id, name)
    VALUES (${TENANT}, ${SELLER}, 'My Board')`
  await sql`
    INSERT INTO app.lost_reason (tenant_id, code, label, sort_order)
    VALUES (${TENANT}, 'no_funds', 'No funds', 0)`

  for (const [name, type, order] of [
    ['New Lead', 'open', 0],
    ['Closed Won', 'earning', 1],
    ['Closed Lost', 'lost', 2],
  ] as const) {
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO app.stage (tenant_id, pipeline_id, owner_user_id, name, stage_type, sort_order)
      SELECT ${TENANT}, p.id, ${SELLER}, ${name}, ${type}::app.stage_type, ${order}
      FROM app.pipeline p WHERE p.tenant_id = ${TENANT} AND p.owner_user_id = ${SELLER}
      RETURNING id`
    if (name === 'New Lead') openStage = row?.id ?? ''
    if (name === 'Closed Won') wonStage = row?.id ?? ''
    if (name === 'Closed Lost') lostStage = row?.id ?? ''
  }

  await card('Fresh Lead', { stage: () => openStage, minutesOld: 5, attempts: 0 })
  await card('Worked Lead', {
    stage: () => openStage,
    minutesOld: 5,
    attempts: 2,
    futureActivity: true,
  })
  await card('Cold Lead', { stage: () => openStage, ageDays: 30, touchedDays: 9, attempts: 3 })
  await card('Decaying Lead', {
    stage: () => openStage,
    ageDays: 30,
    touchedDays: 4,
    attempts: 1,
    futureActivity: true,
  })
  await card('Late Lead', {
    stage: () => openStage,
    ageDays: 30,
    touchedDays: 1,
    attempts: 4,
    overdueHours: 3,
  })
  await card('New But Late', {
    stage: () => openStage,
    minutesOld: 5,
    attempts: 0,
    overdueHours: 2,
  })
  await card('Won Deal', { stage: () => wonStage, ageDays: 30, touchedDays: 20, attempts: 6 })
  await card('Lost Deal', { stage: () => lostStage, ageDays: 30, touchedDays: 20, attempts: 6 })
})

afterAll(async () => {
  await sql?.end()
})

describe('the rail says which state, and the fill says how far', () => {
  it('reads fresh for a lead that arrived and was never worked', async () => {
    const c = (await board()).get('Fresh Lead')
    expect(c?.health).toBe('fresh')
    expect(c?.signal?.kind).toBe('fresh')
  })

  it('stops calling a lead fresh the moment somebody has dialled it', async () => {
    // Age alone is not freshness. A lead that arrived five minutes ago and has
    // been dialled twice is a lead somebody is already on, and a NEW chip
    // there sends a second seller at the same household.
    const c = (await board()).get('Worked Lead')
    expect(c?.health).toBe('ok')
    expect(c?.signal).toBeNull()
  })

  it('reads going cold at the threshold, and states the day count', async () => {
    const c = (await board()).get('Cold Lead')
    expect(c?.health).toBe('going_cold')
    expect(c?.decay).toBe(1)
    expect(c?.signal?.chip).toBe('Going cold · 9d')
    // R11's full sentence, for the accessible name. One concept, two
    // renderings — and the banned word is in neither.
    expect(c?.signal?.full).toBe('Going cold — 9 days since last touch')
    expect(c?.signal?.full).not.toMatch(/Rotting/)
  })

  it('draws a PARTIAL rail before the threshold, which is the gradient R6 kept', async () => {
    // The half a threshold-only design cannot show. Four days against a
    // seven-day threshold is a rail most of the way up, so a seller watches
    // decay coming instead of finding it arrived.
    const c = (await board()).get('Decaying Lead')
    expect(c?.health).toBe('ok')
    expect(c?.decay).toBeCloseTo(4 / 7, 5)
    expect(c?.decay).toBeGreaterThan(0)
    expect(c?.decay).toBeLessThan(1)
  })

  it('puts overdue above fresh on the RAIL and below it in the SLOT', async () => {
    // THE ASSERTION THIS FILE EXISTS FOR, because it looks like a bug.
    // §2.8's health order is blocked > overdue > fresh; §2.7's signal order is
    // fresh > overdue. A lead that arrived minutes ago with an already-late
    // callback is both, and each document decides its own surface.
    const c = (await board()).get('New But Late')
    expect(c?.health, 'the rail should say late').toBe('overdue')
    expect(c?.signal?.kind, 'the slot should say new').toBe('fresh')
  })

  it('never renders two signals', async () => {
    // The slot is one fixed-width box on a 264px card. `signal` is a single
    // value rather than an array precisely so a second one cannot be added
    // without a type change somebody has to look at.
    for (const c of (await board()).values()) {
      expect(Array.isArray(c.signal)).toBe(false)
    }
  })

  it('falls back to no next step only when nothing louder is true', async () => {
    const c = (await board()).get('Late Lead')
    // Late Lead has no future activity either, but overdue outranks it.
    expect(c?.signal?.kind).toBe('overdue')
    expect(c?.signal?.chip).toBe('Due 3 h ago')
  })
})

describe('signals are suppressed where they would become wallpaper', () => {
  it('shows no signal and no decay on a won or lost card', async () => {
    // MVP item 32, non-negotiable. Both of these are twenty days untouched
    // with six attempts, which would be the loudest going-cold chip on the
    // board — on the two cards nobody is working.
    for (const name of ['Won Deal', 'Lost Deal']) {
      const c = (await board()).get(name)
      expect(c?.signal, `${name} still carries a signal`).toBeNull()
      expect(c?.decay, `${name} still shows decay`).toBe(0)
    }
  })

  it('does not call a closed deal fresh or cold on the rail either', async () => {
    // A reading of a silence rather than a ruling, and recorded as one in the
    // code: §2.8 suppresses nothing, but a blue "dial this now" rail on the
    // money column is misinformation, and a going-cold rail on a won deal is
    // a decay verdict about a deal that already paid.
    for (const name of ['Won Deal', 'Lost Deal']) {
      expect((await board()).get(name)?.health).toBe('ok')
    }
  })
})
