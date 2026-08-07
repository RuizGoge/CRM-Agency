import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { dialFor } from '~/routes/api/calls'

import { TEST_URL } from './setup/urls'

/**
 * `POST /api/calls` — the decision path, asked of the database.
 *
 * Gate G2 measured THREE provider outcomes where the design had two, and the
 * refusals below are the branches that come before any of them. Each exists
 * because a specific way of dialling something we should not has to stop
 * working.
 *
 * ⚠️ THE TENANT ID IS DELIBERATELY OUTSIDE THE `00..ff` RANGE. `crm_test` is
 * shared between files, the ids are hand-assigned, and nothing prevents a
 * collision — CONTEXT.md records one already. That whole range is now taken.
 */

const TENANT = '00000000-0000-7000-8000-0000000d1a10'
const OWNER = '00000000-0000-7000-8000-0000000d1a01'
const OTHER_SELLER = '00000000-0000-7000-8000-0000000d1a02'

const WITH_PHONE = '00000000-0000-7000-8000-0000000d1ac1'
const WITHOUT_PHONE = '00000000-0000-7000-8000-0000000d1ac2'
const SOMEONE_ELSES = '00000000-0000-7000-8000-0000000d1ac3'

let sql: postgres.Sql

const dial = (contactId: string) => dialFor({ tenantId: TENANT, userId: OWNER }, { contactId })

beforeAll(async () => {
  sql = postgres(TEST_URL, { max: 1, onnotice: () => {} })

  await sql`
    INSERT INTO app.tenant (id, name, business_tz)
    VALUES (${TENANT}, 'Dial Agency', 'America/Chicago')`

  await sql`
    INSERT INTO app.app_user (tenant_id, id, email, full_name, display_name, role) VALUES
      (${TENANT}, ${OWNER},         'owner@dial.test', 'Dana Reyes',   'Dana R.',  'seller'),
      (${TENANT}, ${OTHER_SELLER},  'other@dial.test', 'Marcus Bell',  'Marcus B.', 'seller')`

  await sql`
    INSERT INTO app.contact (tenant_id, id, owner_user_id, full_name, created_via) VALUES
      (${TENANT}, ${WITH_PHONE},    ${OWNER},        'Callable Lead',  'lead_intake'),
      (${TENANT}, ${WITHOUT_PHONE}, ${OWNER},        'No Number Lead', 'lead_intake'),
      (${TENANT}, ${SOMEONE_ELSES}, ${OTHER_SELLER}, 'Not Yours',      'lead_intake')`

  await sql`
    INSERT INTO app.contact_phone (tenant_id, contact_id, owner_user_id, phone_e164, is_primary)
    VALUES (${TENANT}, ${WITH_PHONE}, ${OWNER}, '+12025550101', true),
           (${TENANT}, ${SOMEONE_ELSES}, ${OTHER_SELLER}, '+12025550102', true)`
})

afterAll(async () => {
  await sql.end()
})

/**
 * 🔴 THE ASSERTION THAT WOULD HAVE CAUGHT A DEFECT I SHIPPED FOR ONE COMMIT.
 *
 * `app.aloware_number_mapping` was first classified `owner_scoped` with
 * `app_can_insert = false`, and the migration's own comment claimed that gave
 * `crm_app` "SELECT and nothing else". Reading the grants back said **SELECT
 * and UPDATE**: `app_can_insert` governs INSERT alone, and `harden()` grants
 * UPDATE to every class that is not immutable and not read-only.
 *
 * A seller updating their OWN row sounds harmless because RLS scopes it to
 * their own. It is not: the row is which caller ID they present and which
 * inbound callbacks route to them, so UPDATE means pointing it at a number
 * nobody verified they hold, or writing their own `verified_at`.
 *
 * The comment was documentation and it was wrong. This is the mechanism.
 */
describe('the number mapping cannot be written by the application', () => {
  it('grants crm_app SELECT and no write of any kind', async () => {
    const grants = await sql<{ privilege_type: string }[]>`
      SELECT privilege_type
        FROM information_schema.role_table_grants
       WHERE grantee = 'crm_app'
         AND table_schema = 'app'
         AND table_name = 'aloware_number_mapping'
       ORDER BY privilege_type`

    expect([...grants].map((g) => g.privilege_type)).toEqual(['SELECT'])
  })

  it('grants no column-level UPDATE either, which a table-level check would miss', async () => {
    // Postgres does not decompose a table grant, so a column-level privilege is
    // a separate row and a test that only looked at `role_table_grants` would
    // pass while individual columns stayed writable.
    const columns = await sql<{ column_name: string }[]>`
      SELECT column_name
        FROM information_schema.column_privileges
       WHERE grantee = 'crm_app'
         AND table_schema = 'app'
         AND table_name = 'aloware_number_mapping'
         AND privilege_type = 'UPDATE'`

    expect([...columns]).toEqual([])
  })
})

describe('the refusals that come before the provider', () => {
  it('never dials a contact that is not in the seller book, and does not say why', async () => {
    // 🔴 THE SILO ASSERTION. `SOMEONE_ELSES` exists, has a phone, and is
    // perfectly dialable — by its owner. For this seller it must be
    // indistinguishable from a contact that does not exist, because the
    // alternative confirms that somebody else's record is real.
    const foreign = await dial(SOMEONE_ELSES)
    const missing = await dial('00000000-0000-7000-8000-0000000d1aff')

    expect(foreign).toEqual({ status: 'blocked', reason: 'not_found' })
    expect(missing).toEqual(foreign)
  })

  it('refuses a contact with no phone number, in its own words', async () => {
    // Distinct from `not_found` on purpose: the seller owns this lead and can
    // fix it by adding a number. Collapsing the two would send them looking
    // for a record they are already holding.
    expect(await dial(WITHOUT_PHONE)).toEqual({ status: 'blocked', reason: 'no_phone' })
  })

  /**
   * 🔴 A GUARDIAN THAT RECORDS WHERE THE DIAL STOPS TODAY.
   *
   * `two_legged_call` is `verified` and the contact is dialable, so every check
   * ahead of the provider passes — and the endpoint still refuses, because §5's
   * `aloware_number_mapping` does not exist and there is no number to present
   * as caller ID nor a `user_id` to route the agent leg to.
   *
   * When that table lands this test goes red, and that is the point: the next
   * value is `dispatched` or one of the two measured failures, and somebody has
   * to look at which. A test asserting only "it does not throw" would have
   * stayed green through the whole change.
   */
  it('stops at the missing number mapping, with the capability already verified', async () => {
    expect(await dial(WITH_PHONE)).toEqual({ status: 'blocked', reason: 'no_number' })
  })
})

describe('with an outbound identity in place', () => {
  const MAPPED = '+12025550188'

  afterAll(async () => {
    await sql`DELETE FROM app.aloware_number_mapping WHERE tenant_id = ${TENANT}`
  })

  it('an UNVERIFIED mapping is inert — the dial still refuses', async () => {
    // 🔴 THE COLUMN IS THE WHOLE CONTROL. ADR-042's three-way verification is not
    // built, so `verified_at` is the only thing between a row somebody inserted
    // and a seller presenting a number nobody confirmed they hold. A row that
    // exists is NOT permission.
    await sql`
      INSERT INTO app.aloware_number_mapping
        (tenant_id, owner_user_id, aloware_user_id, aloware_line_id, from_number_e164)
      VALUES (${TENANT}, ${OWNER}, 120776, 63949, ${MAPPED})`

    expect(await dial(WITH_PHONE)).toEqual({ status: 'blocked', reason: 'no_number' })
  })

  /**
   * 🎯 THE GUARDIAN MOVES ONE STEP. With a verified mapping every check ahead of
   * the provider passes, and the dial stops on the credential and the unwritten
   * adapter instead. When the adapter lands this goes red and the next value is
   * `dispatched` or one of the two measured failures — which is somebody's
   * decision to make, because every dial is billable.
   */
  it('a VERIFIED mapping carries the dial to the last refusal before the socket', async () => {
    await sql`
      UPDATE app.aloware_number_mapping
         SET verified_at = clock_timestamp()
       WHERE tenant_id = ${TENANT} AND from_number_e164 = ${MAPPED}`

    expect(await dial(WITH_PHONE)).toEqual({ status: 'blocked', reason: 'no_credentials' })
  })

  it('still refuses a contact that is not in the book, mapping or no mapping', async () => {
    // The silo does not get weaker because the seller is now dialable.
    expect(await dial(SOMEONE_ELSES)).toEqual({ status: 'blocked', reason: 'not_found' })
  })
})
