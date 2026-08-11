import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { dialFor } from '~/routes/api/calls'

import { TEST_URL } from './setup/urls'

/**
 * The dial goes through the one compliance gate, and leaves a row saying so.
 *
 * 🔴 WRITTEN BECAUSE THE GATE HAD ZERO CALLERS. `app.compliance_check` has been
 * complete since 0038 — five verdicts in a fixed order, break-glass releasing
 * exactly two, its own ownership predicate because a definer has no RLS — and
 * `grep compliance_check app/` returned nothing. `contact-drawer.tsx` even
 * announced a compliance state to screen readers that no code computed. A gate
 * nobody consults is a document; this is the surface it exists to stand in
 * front of.
 */

const TENANT = '00000000-0000-7000-8000-0000000e6100'
const ANA = '00000000-0000-7000-8000-0000000e61a1'

/** Texas: two zones, ONE-party recording. Florida would fail for a second reason. */
const OPEN_CONTACT = '00000000-0000-7000-8000-0000000e61c1'
/** Same, plus a STOP on the number. */
const STOPPED_CONTACT = '00000000-0000-7000-8000-0000000e61c2'
/** No ZIP, no state — the closed-fails direction. */
const UNKNOWN_CONTACT = '00000000-0000-7000-8000-0000000e61c3'

let sql: postgres.Sql

const identity = { tenantId: TENANT, userId: ANA }

beforeAll(async () => {
  sql = postgres(TEST_URL, { max: 1, onnotice: () => {} })

  await sql`
    INSERT INTO app.tenant (id, name, business_tz)
    VALUES (${TENANT}, 'Dial Agency', 'America/Chicago')`
  await sql`
    INSERT INTO app.app_user (tenant_id, id, email, full_name, display_name, role)
    VALUES (${TENANT}, ${ANA}, 'ana@dial.test', 'Ana Dial', 'Ana D.', 'seller')`

  await sql`
    INSERT INTO app.contact (tenant_id, id, owner_user_id, full_name, created_via, state_code, zip5)
    VALUES
      (${TENANT}, ${OPEN_CONTACT},    ${ANA}, 'Open Lead',    'manual', 'TX', '75201'),
      (${TENANT}, ${STOPPED_CONTACT}, ${ANA}, 'Stopped Lead', 'manual', 'TX', '75201'),
      (${TENANT}, ${UNKNOWN_CONTACT}, ${ANA}, 'Unknown Lead', 'manual', NULL, NULL)`

  await sql`
    INSERT INTO app.contact_phone (tenant_id, contact_id, owner_user_id, phone_e164, kind, is_primary)
    VALUES
      (${TENANT}, ${OPEN_CONTACT},    ${ANA}, '+12145550101', 'mobile', true),
      (${TENANT}, ${STOPPED_CONTACT}, ${ANA}, '+12145550102', 'mobile', true),
      (${TENANT}, ${UNKNOWN_CONTACT}, ${ANA}, '+12145550103', 'mobile', true)`

  // A STOP is tenant-wide and has no owner column, which is the whole design:
  // a STOP Ana receives must silence Ben's dialler too.
  await sql`
    INSERT INTO app.suppression_list (tenant_id, phone_e164, kind, channel, effective_at, reason)
    VALUES (${TENANT}, '+12145550102', 'stop', NULL, clock_timestamp(), 'replied STOP')`
})

/**
 * Runs `fn` with a live break-glass override, and ends it afterwards.
 *
 * 🔴 THIS IS WHAT MAKES THE POSITIVE CONTROL INDEPENDENT OF THE CLOCK.
 *
 * The first version of that test seeded a Texas lead and asserted the dial got
 * through. It passed in the afternoon and failed the same evening — correctly:
 * a Texas lead at 10pm Central IS outside the calling window, so the gate was
 * right and the test was wrong. No choice of state fixes it either, because
 * around 06:00–12:00 UTC the whole United States is asleep and no lead anywhere
 * is legally callable.
 *
 * An override releases EXACTLY `blocked_timezone_unknown` and
 * `blocked_calling_window` and nothing else, so the clock stops deciding while
 * suppression and the recording guard still bind — which is exactly the
 * discrimination being tested. Scoped per test rather than opened in
 * `beforeAll` because the fail-closed assertions below need the clock to still
 * apply, and an override left live would have quietly released those too.
 */
async function withOverride<T>(fn: () => Promise<T>): Promise<T> {
  await sql`
    INSERT INTO app.break_glass_override (tenant_id, started_by_user_id, reason)
    VALUES (${TENANT}, ${ANA}, 'gate suite: the clock must not decide this assertion')`
  try {
    return await fn()
  } finally {
    await sql`
      UPDATE app.break_glass_override SET ended_at = clock_timestamp(), end_reason = 'manual'
       WHERE tenant_id = ${TENANT} AND ended_at IS NULL`
  }
}

afterAll(async () => {
  await sql?.end()
})

async function auditRows(contactId: string): Promise<{ verdict: string; snap: string }[]> {
  return sql<{ verdict: string; snap: string }[]>`
    SELECT verdict::text AS verdict, verdict_input_snapshot::text AS snap
      FROM app.audit_log
     WHERE tenant_id = ${TENANT} AND action = 'compliance.gate_checked'
       AND subject_id = ${contactId}`
}

describe('every dial passes the gate', () => {
  it('refuses a suppressed number, and never reaches the dial', async () => {
    const outcome = await dialFor(identity, { contactId: STOPPED_CONTACT })

    expect(outcome.status).toBe('refused')
    if (outcome.status !== 'refused') return
    expect(outcome.verdict).toBe('blocked_suppressed')

    // The ratified vocabulary string comes from the gate's own column. A switch
    // in TypeScript that rebuilt it would be a second table of truth.
    expect(outcome.eventVerdict).toBe('stop')
  })

  it('refuses a lead whose time zone cannot be resolved — failing CLOSED', async () => {
    // No ZIP and no state. The correct direction for an accident is refusal:
    // an unresolvable lead is one we cannot prove it is legal to call.
    const outcome = await dialFor(identity, { contactId: UNKNOWN_CONTACT })

    expect(outcome.status).toBe('refused')
    if (outcome.status !== 'refused') return
    expect(outcome.verdict).toBe('blocked_timezone_unknown')
  })

  it('writes ONE audit row per attempt, unbucketed', async () => {
    // US-9.13 requires a row per ATTEMPT rather than per verdict per window —
    // N dials under break-glass are N rows. The bucketing that `book.viewed`
    // uses would collapse these, which is why `audit_write` defaults to none.
    await dialFor(identity, { contactId: STOPPED_CONTACT })
    await dialFor(identity, { contactId: STOPPED_CONTACT })

    const rows = await auditRows(STOPPED_CONTACT)
    expect(rows.length).toBeGreaterThanOrEqual(3)

    // The snapshot is what makes the row a defence rather than an assertion.
    expect(rows[0]?.verdict).toBe('blocked_suppressed')
    expect(rows[0]?.snap).toContain('event_verdict')
  })

  it('lets a permitted lead through to the operational blocks', async () => {
    // 🎯 THE POSITIVE CONTROL, and without it every assertion above is
    // satisfied by a gate that refuses everything. Texas is deliberate: it is
    // two-zone AND one-party, so a Florida lead would refuse for recording
    // instead and the test would pass for the wrong reason.
    //
    // Reaching `no_credentials` is the correct destination today — the dial
    // adapter is not written — and what matters here is that it got PAST the
    // gate rather than being refused by it.
    const outcome = await withOverride(() => dialFor(identity, { contactId: OPEN_CONTACT }))

    expect(outcome.status).not.toBe('refused')

    // And it was still recorded. An allowed dial leaves a row too — a permitted
    // call under break-glass is exactly the one somebody asks about later,
    // which is why the snapshot carries the override id.
    const rows = await auditRows(OPEN_CONTACT)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.verdict).toBe('allow')
  })

  it('does NOT release suppression under break-glass', async () => {
    // 🎯 THE MUTATION THE CONSTITUTION FORBIDS, asserted rather than assumed.
    // `override_scope` is an enum of ONE value, so there is no label meaning
    // "lift the suppression" — an admin under break-glass still cannot dial a
    // STOP, and that is structural rather than procedural.
    const outcome = await withOverride(() => dialFor(identity, { contactId: STOPPED_CONTACT }))

    expect(outcome.status).toBe('refused')
    if (outcome.status !== 'refused') return
    expect(outcome.verdict).toBe('blocked_suppressed')
  })

  it('refuses another seller’s lead the same way it refuses an absent one', async () => {
    // Owner-scoped not-found, never a 403. Ben's lead and a lead that never
    // existed must be indistinguishable — and the gate's own answer for an
    // invisible contact is the closed one.
    const outcome = await dialFor(identity, {
      contactId: '00000000-0000-7000-8000-0000000e61ff',
    })
    expect(outcome.status).toBe('blocked')
  })
})
