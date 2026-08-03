import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { readHomeSetupFor } from '~/routes/api/home-setup'

import { TEST_URL } from './setup/urls'

/**
 * The first-run checklist's conditions, asked of the database.
 *
 * US-9.14's rule is that every item checks off by itself, which means each one
 * is a QUESTION ASKED OF THE DATA rather than a flag anybody sets. The failure
 * that would follow from getting that wrong is quiet and specific: a checklist
 * that reports a seller is set up when they are not, on the one screen an
 * owner reads as a setup report — and nothing about the screen would look
 * broken.
 *
 * `readHomeSetup` is exercised directly, with the request seam removed the
 * same way the standing suite removes it, so these run the endpoint's own SQL.
 */

const TENANT = '00000000-0000-7000-8000-0000000000fa'
const SET_UP = '00000000-0000-7000-8000-00000000fa01'
const NO_EARNING_STAGE = '00000000-0000-7000-8000-00000000fa02'
const EMPTY_BOOK = '00000000-0000-7000-8000-00000000fa03'
const SUPERVISOR = '00000000-0000-7000-8000-00000000fa09'

let sql: postgres.Sql

const setup = (userId: string) => readHomeSetupFor({ tenantId: TENANT, userId })

beforeAll(async () => {
  sql = postgres(TEST_URL, { max: 1, onnotice: () => {} })

  await sql`
    INSERT INTO app.tenant (id, name, business_tz)
    VALUES (${TENANT}, 'Setup Agency', 'America/New_York')`

  await sql`
    INSERT INTO app.app_user (tenant_id, id, email, full_name, display_name, role) VALUES
      (${TENANT}, ${SET_UP},           'up@setup.test',   'Uma Prepared', 'Uma P.', 'seller'),
      (${TENANT}, ${NO_EARNING_STAGE}, 'nos@setup.test',  'Nora Stage',   'Nora S.', 'seller'),
      (${TENANT}, ${EMPTY_BOOK},       'eb@setup.test',   'Evan Book',    'Evan B.', 'seller'),
      (${TENANT}, ${SUPERVISOR},       'sup@setup.test',  'Sol Vega',     'Sol V.',  'supervisor')`

  await sql`
    INSERT INTO app.pipeline (tenant_id, owner_user_id, name) VALUES
      (${TENANT}, ${SET_UP}, 'My Board'),
      (${TENANT}, ${NO_EARNING_STAGE}, 'My Board'),
      (${TENANT}, ${EMPTY_BOOK}, 'My Board')`

  // Uma is set up. Nora has stages but NONE that count as Earnings — a board
  // that can never pay her, which is the misconfiguration item 2's hint names.
  await sql`
    INSERT INTO app.stage (tenant_id, pipeline_id, owner_user_id, name, stage_type, sort_order)
    SELECT p.tenant_id, p.id, p.owner_user_id, s.name, s.stage_type::app.stage_type, s.sort_order
      FROM app.pipeline p
      JOIN (VALUES ('New Lead', 'open', 0), ('Closed Won', 'earning', 1)) AS s(name, stage_type, sort_order)
        ON p.owner_user_id IN (${SET_UP}, ${EMPTY_BOOK})
     WHERE p.tenant_id = ${TENANT}`

  await sql`
    INSERT INTO app.stage (tenant_id, pipeline_id, owner_user_id, name, stage_type, sort_order)
    SELECT p.tenant_id, p.id, p.owner_user_id, 'New Lead', 'open'::app.stage_type, 0
      FROM app.pipeline p
     WHERE p.tenant_id = ${TENANT} AND p.owner_user_id = ${NO_EARNING_STAGE}`

  // Uma and Nora own a book. Evan owns nothing.
  await sql`
    INSERT INTO app.contact (tenant_id, owner_user_id, full_name, created_via) VALUES
      (${TENANT}, ${SET_UP}, 'Doris Whitfield', 'manual'),
      (${TENANT}, ${NO_EARNING_STAGE}, 'Bernard Cole', 'manual')`
})

afterAll(async () => {
  await sql?.end()
})

describe('every checklist item is a question asked of the data', () => {
  it('checks the seller who is actually set up', async () => {
    const state = await setup(SET_UP)

    expect(state.isSeller).toBe(true)
    expect(state.stagesConfigured).toBe(true)
    expect(state.bookImported).toBe(true)
  })

  it('refuses item 2 to a seller whose stages count nothing as Earnings', async () => {
    // Stages exist. None of them is an `earning`, so no deal this seller ever
    // closes can reach the ledger — and "set up your stages" being ticked
    // would be the checklist telling them the opposite.
    const state = await setup(NO_EARNING_STAGE)

    expect(state.stagesConfigured).toBe(false)
    expect(state.bookImported).toBe(true)
  })

  it('refuses item 3 to a seller with an empty book', async () => {
    const state = await setup(EMPTY_BOOK)

    expect(state.stagesConfigured).toBe(true)
    expect(state.bookImported).toBe(false)
  })

  it('leaves item 1 unverified for everyone, because nothing can verify it', async () => {
    // Not a stub with a TODO. `aloware_number_mapping` (`05b` §782) does not
    // exist in this tree, so `false` is the true answer for every seller in
    // every tenant. The assertion is here so the day that table lands, a
    // hardcoded `false` left behind turns the build red.
    for (const userId of [SET_UP, NO_EARNING_STAGE, EMPTY_BOOK]) {
      expect((await setup(userId)).numberVerified).toBe(false)
    }
  })

  it('tells a supervisor they are not a seller, so the checklist never renders', async () => {
    // A supervisor has no book to set up, and `04b` §4.1's no-permission row
    // says they never see this block. The answer is computed here rather than
    // in the component, because the component is not where a role decision
    // belongs.
    const state = await setup(SUPERVISOR)

    expect(state.isSeller).toBe(false)
  })

  it('answers about the CALLER, never about whoever the policy would allow', async () => {
    // The trap `readMyDay` documents, one screen over: the `owner_scoped`
    // policy grants a supervisor global read, which is right for the board and
    // wrong for a personal setup checklist. Every predicate filters on
    // `app.current_user_id()` explicitly — so Evan's empty book stays empty
    // even though Uma's, in the same tenant, is not.
    expect((await setup(EMPTY_BOOK)).bookImported).toBe(false)
    expect((await setup(SET_UP)).bookImported).toBe(true)
  })
})
