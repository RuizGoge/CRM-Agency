import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { readBookFor } from '~/routes/api/my-book'

import { TEST_URL } from './setup/urls'

/**
 * My Book — ONE list, ONE status chip (MVP item 24).
 *
 * The chip is computed on the SERVER from the same touch data the board reads,
 * because `04b` §1253 requires the board, My Book and My Day to be
 * byte-identical about a lead's state. Three screens agree only if none of them
 * decides, so the derivation lives in `~/lib/card-health` beside the card's own.
 *
 * The suite runs `readBookFor` rather than a copy of its SQL, so what is
 * asserted is what ships.
 */

const TENANT = '00000000-0000-7000-8000-0000000b0040'
const ANA = '00000000-0000-7000-8000-0000000b00a1'
const BEN = '00000000-0000-7000-8000-0000000b00b1'

let sql: postgres.Sql
let stageOpen = ''
let stageWon = ''

async function contactWith(
  owner: string,
  name: string,
  opts: { touchedDaysAgo?: number; stage?: 'open' | 'won'; phone?: string; badNumber?: boolean },
): Promise<string> {
  const [c] = await sql<{ id: string }[]>`
    INSERT INTO app.contact (tenant_id, owner_user_id, full_name, created_via)
    VALUES (${TENANT}, ${owner}, ${name}, 'lead_intake') RETURNING id`
  const id = c?.id ?? ''

  if (opts.phone !== undefined) {
    await sql`
      INSERT INTO app.contact_phone (tenant_id, contact_id, owner_user_id, phone_e164, is_primary,
                                     bad_number_at, bad_number_reason)
      VALUES (${TENANT}, ${id}, ${owner}, ${opts.phone}, true,
              ${opts.badNumber === true ? sql`clock_timestamp()` : null},
              ${opts.badNumber === true ? 'carrier rejected' : null})`
  }

  if (opts.stage !== undefined) {
    await sql`
      INSERT INTO app.opportunity
        (tenant_id, owner_user_id, contact_id, pipeline_id, stage_id, current_stage_type,
         created_from, stage_entered_at, premium_annual_cents, premium_mode, last_human_touch_at)
      SELECT ${TENANT}, ${owner}, ${id}, p.id,
             ${opts.stage === 'won' ? stageWon : stageOpen},
             ${opts.stage === 'won' ? 'earning' : 'open'}, 'lead_intake', clock_timestamp(),
             -- opportunity_win_gate refuses an earning-stage row with no
             -- premium: the money is required BY THE SCHEMA, which is why
             -- Earnings can never be blank. Supplying it here is the fixture
             -- obeying the gate rather than the gate being relaxed for a test.
             ${opts.stage === 'won' ? 120000 : null},
             ${opts.stage === 'won' ? sql`'annual'::app.premium_mode` : null},
             ${
               opts.touchedDaysAgo === undefined
                 ? null
                 : sql`clock_timestamp() - make_interval(days => ${opts.touchedDaysAgo})`
             }
        FROM app.pipeline p WHERE p.tenant_id = ${TENANT} AND p.owner_user_id = ${owner}`
  }
  return id
}

beforeAll(async () => {
  sql = postgres(TEST_URL, { max: 1, onnotice: () => {} })

  await sql`
    INSERT INTO app.tenant (id, name, business_tz, cold_threshold_days)
    VALUES (${TENANT}, 'Book Agency', 'America/New_York', 7)`
  await sql`
    INSERT INTO app.app_user (tenant_id, id, email, full_name, display_name, role) VALUES
      (${TENANT}, ${ANA}, 'ana@bk.test', 'Ana Seller', 'Ana A.', 'seller'),
      (${TENANT}, ${BEN}, 'ben@bk.test', 'Ben Seller', 'Ben B.', 'seller')`

  for (const owner of [ANA, BEN]) {
    await sql`INSERT INTO app.pipeline (tenant_id, owner_user_id, name)
              VALUES (${TENANT}, ${owner}, 'My Board')`
  }
  const [so] = await sql<{ id: string }[]>`
    INSERT INTO app.stage (tenant_id, pipeline_id, owner_user_id, name, stage_type, sort_order)
    SELECT ${TENANT}, p.id, ${ANA}, 'New Lead', 'open'::app.stage_type, 0
      FROM app.pipeline p WHERE p.tenant_id = ${TENANT} AND p.owner_user_id = ${ANA}
    RETURNING id`
  const [sw] = await sql<{ id: string }[]>`
    INSERT INTO app.stage (tenant_id, pipeline_id, owner_user_id, name, stage_type, sort_order)
    SELECT ${TENANT}, p.id, ${ANA}, 'Sold', 'earning'::app.stage_type, 1
      FROM app.pipeline p WHERE p.tenant_id = ${TENANT} AND p.owner_user_id = ${ANA}
    RETURNING id`
  stageOpen = so?.id ?? ''
  stageWon = sw?.id ?? ''

  await contactWith(ANA, 'Never Worked', { phone: '+19045550201' })
  await contactWith(ANA, 'Cold Lead', { stage: 'open', touchedDaysAgo: 9, phone: '+19045550202' })
  await contactWith(ANA, 'Warm Lead', { stage: 'open', touchedDaysAgo: 2, phone: '+19045550203' })
  await contactWith(ANA, 'Sold Client', { stage: 'won', touchedDaysAgo: 30, phone: '+19045550204' })
  await contactWith(ANA, 'Bad Number', { phone: '+19045550205', badNumber: true })
  await contactWith(BEN, 'Not Ana Lead', {
    stage: 'open',
    touchedDaysAgo: 1,
    phone: '+19045550206',
  })
})

afterAll(async () => {
  await sql?.end()
})

async function book(userId: string) {
  return readBookFor({ tenantId: TENANT, userId })
}

describe("the book is one list, and it is the seller's own", () => {
  it("returns only the caller's contacts", async () => {
    const mine = await book(ANA)
    const names = mine.rows.map((r) => r.fullName)
    expect(names).not.toContain('Not Ana Lead')
    expect(mine.total).toBe(5)

    // The structural half: Ben's own book is his, so the exclusion above is the
    // silo working and not an empty database.
    const theirs = await book(BEN)
    expect(theirs.rows.map((r) => r.fullName)).toEqual(['Not Ana Lead'])
  })

  it('opens on the work nobody has started', async () => {
    // Never-worked first, then the coldest. A book sorted alphabetically makes
    // the seller do the triage the screen exists to do for them.
    const rows = (await book(ANA)).rows
    expect(rows[0]?.chip.kind).toBe('uncalled')
  })
})

describe('one chip, and it says what the board says', () => {
  it('calls a never-worked contact Uncalled rather than decaying', async () => {
    // The onboarding import creates contacts and deliberately no opportunities,
    // so a 400-row book must not become 400 instantly-decaying rows. Never
    // worked is a different state from neglected, and only one is the seller's
    // fault.
    const row = (await book(ANA)).rows.find((r) => r.fullName === 'Never Worked')
    expect(row?.chip.kind).toBe('uncalled')
    expect(row?.chip.label).toBe('Uncalled')
  })

  it('marks a lead past the ONE threshold as going cold', async () => {
    // Nine days against a seven-day threshold. There is no second, redder tier
    // at fourteen: R6 deleted that design and R1.7 replaced it with one
    // sentence, so the Phase-4 table that still shows it is struck text.
    const row = (await book(ANA)).rows.find((r) => r.fullName === 'Cold Lead')
    expect(row?.chip.kind).toBe('going_cold')
    expect(row?.chip.label).toContain('9d')
  })

  it('leaves a lead inside the threshold alone', async () => {
    const row = (await book(ANA)).rows.find((r) => r.fullName === 'Warm Lead')
    expect(row?.chip.kind).toBe('working')
  })

  it('calls a won contact Client, above every decay state', async () => {
    // Touched thirty days ago and still a client: a fact about the relationship
    // outranks a fact about the work. Labelling them Uncalled would read as a
    // reproach for work that is finished.
    const row = (await book(ANA)).rows.find((r) => r.fullName === 'Sold Client')
    expect(row?.chip.kind).toBe('client')
  })
})

describe('a bad number is not offered', () => {
  it('withholds the digits and says why instead', async () => {
    // The flag exists so a seller stops burning attempts on a line that cannot
    // connect. Rendering the number anyway would make the flag decorative.
    const row = (await book(ANA)).rows.find((r) => r.fullName === 'Bad Number')
    expect(row?.badNumber).toBe(true)
    expect(row?.phoneE164).toBeNull()
  })

  it('still offers a good one', async () => {
    const row = (await book(ANA)).rows.find((r) => r.fullName === 'Warm Lead')
    expect(row?.phoneE164).toBe('+19045550203')
  })
})
