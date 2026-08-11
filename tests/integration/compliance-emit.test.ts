import { sql as raw } from 'drizzle-orm'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { withSystemWork, withTenant } from '~/db'
import { relayOnce } from '~/modules/events/relay'
import { assertGateIsRecording } from '~/db/boot-assert'
import { dialFor } from '~/routes/api/calls'
import { readTimelineFor } from '~/routes/api/timeline'

import { TEST_URL } from './setup/urls'

/**
 * THE GATE RECORDS ITSELF. MVP item 11, the compliance half.
 *
 * `compliance.send_blocked` sat in the canonical catalog from 0042 with NO
 * EMITTER. §580 calls it "the number that proves the gate works": until 0060
 * the product could count sends and count failures and could not count
 * REFUSALS, and the seller was told why on a panel that vanishes on navigation.
 *
 * 🔴 WHAT MAKES IT A RULE RATHER THAN A HABIT IS A REVOKED PRIVILEGE, and most
 * of this file exists to prove that privilege rather than the behaviour.
 * `crm_app` cannot execute `app.compliance_check`. The only reachable door
 * writes the audit row and emits the event before it returns a verdict — so
 * "remember to record the refusal" was replaced by "there is no way to get the
 * answer without the record".
 */

const TENANT = '00000000-0000-7000-8000-0000000ce000'
const ANA = '00000000-0000-7000-8000-0000000ce0a1'
const BEN = '00000000-0000-7000-8000-0000000ce0b1'

/** Texas: two zones, ONE-party recording. Florida would block for a second reason. */
const OPEN_CONTACT = '00000000-0000-7000-8000-0000000ce0c1'
/** Same, plus a STOP on the primary number. */
const STOPPED_CONTACT = '00000000-0000-7000-8000-0000000ce0c2'
/** New York: exactly ONE zone, which is what `local_time_at_contact` needs. */
const ONE_ZONE_CONTACT = '00000000-0000-7000-8000-0000000ce0c3'
/** Ben's. Ana may not see it, and must not be able to write to his history. */
const BENS_CONTACT = '00000000-0000-7000-8000-0000000ce0c4'
/**
 * No state, no ZIP — the CLOSED direction, and it is the only reminder verdict
 * that does not depend on what time the suite runs. A Texas lead is genuinely
 * outside the calling window at night, which is the fixture trap this project
 * has now paid for three times.
 */
const NO_ZONE_CONTACT = '00000000-0000-7000-8000-0000000ce0c5'

let sql: postgres.Sql
const identity = { tenantId: TENANT, userId: ANA }

interface EventRow {
  event_id: string
  idempotency_key: string
  correlation_id: string
  actor_user_id: string | null
  owner_user_id: string
  source_system: string
  payload: Record<string, unknown>
}

async function eventsFor(contactId: string): Promise<EventRow[]> {
  return sql<EventRow[]>`
    SELECT event_id, idempotency_key, correlation_id, actor_user_id, owner_user_id,
           source_system::text AS source_system, payload
      FROM app.event_log
     WHERE tenant_id = ${TENANT}
       AND event_name = 'compliance.send_blocked'
       AND subject_id = ${contactId}
     ORDER BY occurred_at`
}

async function auditFor(contactId: string): Promise<{ id: string; verdict: string | null }[]> {
  return sql<{ id: string; verdict: string | null }[]>`
    SELECT id, verdict::text AS verdict
      FROM app.audit_log
     WHERE tenant_id = ${TENANT} AND action = 'compliance.gate_checked'
       AND subject_id = ${contactId}`
}

/** See dial-gate.test.ts: an override is what stops the clock deciding. */
async function withOverride<T>(fn: () => Promise<T>): Promise<T> {
  await sql`
    INSERT INTO app.break_glass_override (tenant_id, started_by_user_id, reason)
    VALUES (${TENANT}, ${ANA}, 'emit suite: the clock must not decide this assertion')`
  try {
    return await fn()
  } finally {
    await sql`
      UPDATE app.break_glass_override SET ended_at = clock_timestamp(), end_reason = 'manual'
       WHERE tenant_id = ${TENANT} AND ended_at IS NULL`
  }
}

beforeAll(async () => {
  sql = postgres(TEST_URL, { max: 1, onnotice: () => {} })

  // 🔴 SMS ON, and it is load-bearing for the reminder assertions. With the
  // dark-launch default the gate stops at `blocked_sms_disabled`, whose single
  // sentence already says "Text not sent" — so the channel-aware wording would
  // never be exercised and the split would look tested while proving nothing.
  await sql`
    INSERT INTO app.tenant (id, name, business_tz, sms_enabled)
    VALUES (${TENANT}, 'Emit Agency', 'America/Chicago', true)`
  await sql`
    INSERT INTO app.app_user (tenant_id, id, email, full_name, display_name, role) VALUES
      (${TENANT}, ${ANA}, 'ana@emit.test', 'Ana Emit', 'Ana E.', 'seller'),
      (${TENANT}, ${BEN}, 'ben@emit.test', 'Ben Emit', 'Ben E.', 'seller')`

  await sql`
    INSERT INTO app.contact (tenant_id, id, owner_user_id, full_name, created_via, state_code, zip5)
    VALUES
      (${TENANT}, ${OPEN_CONTACT},     ${ANA}, 'Open Lead',   'manual', 'TX', '75201'),
      (${TENANT}, ${STOPPED_CONTACT},  ${ANA}, 'Stopped',     'manual', 'TX', '75201'),
      (${TENANT}, ${ONE_ZONE_CONTACT}, ${ANA}, 'One Zone',    'manual', 'NY', '10001'),
      (${TENANT}, ${BENS_CONTACT},     ${BEN}, 'Bens Lead',   'manual', 'TX', '75201'),
      (${TENANT}, ${NO_ZONE_CONTACT},  ${ANA}, 'No Zone',     'manual', NULL, NULL)`

  // 🎯 THE NON-PRIMARY PHONE IS WRITTEN FIRST, ON PURPOSE. `contact_phone_id`
  // must name the row the gate actually judged — which is the PRIMARY, by the
  // gate's own `ORDER BY is_primary DESC, created_at ASC`. Insertion order
  // being the opposite is what makes the assertion mean something.
  await sql`
    INSERT INTO app.contact_phone (tenant_id, contact_id, owner_user_id, phone_e164, kind, is_primary)
    VALUES (${TENANT}, ${STOPPED_CONTACT}, ${ANA}, '+12145550902', 'landline', false)`
  await sql`
    INSERT INTO app.contact_phone (tenant_id, contact_id, owner_user_id, phone_e164, kind, is_primary)
    VALUES
      (${TENANT}, ${STOPPED_CONTACT},  ${ANA}, '+12145550901', 'mobile', true),
      (${TENANT}, ${OPEN_CONTACT},     ${ANA}, '+12145550903', 'mobile', true),
      (${TENANT}, ${ONE_ZONE_CONTACT}, ${ANA}, '+12125550904', 'mobile', true),
      (${TENANT}, ${BENS_CONTACT},     ${BEN}, '+12145550905', 'mobile', true),
      (${TENANT}, ${NO_ZONE_CONTACT},  ${ANA}, '+12145550906', 'mobile', true)`

  // The STOP is on the PRIMARY. If the gate resolved the other number the
  // verdict itself would change, so the phone-id assertion has a positive
  // control built into it.
  await sql`
    INSERT INTO app.suppression_list (tenant_id, phone_e164, kind, channel, effective_at, reason)
    VALUES (${TENANT}, '+12145550901', 'stop', NULL, clock_timestamp(), 'replied STOP')`
})

afterAll(async () => {
  await sql?.end()
})

describe('the raw gate is unreachable, and that absence is the mechanism', () => {
  it('refuses crm_app EXECUTE on compliance_check and compliance_record', async () => {
    // 🎯 THE TEST OF THE DESIGN. Mutation: add `GRANT EXECUTE ON FUNCTION
    // app.compliance_check … TO crm_app` in a later migration. Every behavioural
    // test in the tree stays green — the gate still refuses correctly, every
    // seller sentence is unchanged — and refusals silently stop being counted.
    const rows = await sql<{ proname: string; granted: boolean }[]>`
      SELECT p.proname, has_function_privilege('crm_app', p.oid, 'EXECUTE') AS granted
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'app'
         AND p.proname IN ('compliance_check', 'compliance_record',
                           'compliance_attempt', 'reminder_gate', 'gate_verdict_of')`

    const granted = Object.fromEntries(rows.map((r) => [r.proname, r.granted]))

    expect(granted['compliance_check']).toBe(false)
    expect(granted['compliance_record']).toBe(false)
    // The doors, and they must stay open or the product cannot dial at all.
    expect(granted['compliance_attempt']).toBe(true)
    expect(granted['reminder_gate']).toBe(true)
    expect(granted['gate_verdict_of']).toBe(true)
  })

  it('rejects the application role calling the raw gate', async () => {
    // The privilege above, observed from the outside. A `REVOKE … FROM PUBLIC`
    // dropped after the DROP/CREATE would leave EXECUTE granted to PUBLIC —
    // which the catalog query above catches and this catches again, behaviourally.
    //
    // The message lives in `.cause`: Drizzle rewraps the driver error one level
    // down and the outer text is only "Failed query". Same reason
    // compliance-gate.test.ts carries a `chain()` helper.
    const error = await withTenant(identity, async (tx) =>
      tx.execute(raw`SELECT * FROM app.compliance_check(${OPEN_CONTACT}::uuid,
                                                        'call'::app.channel)`),
    ).catch((e: unknown) => e)

    const parts: string[] = []
    let cursor: unknown = error
    while (cursor instanceof Error) {
      parts.push(cursor.message)
      cursor = cursor.cause
    }
    expect(parts.join(' | ')).toMatch(/permission denied/i)
  })

  it('has exactly two functions in the whole database that ask the gate', async () => {
    // 🔴 STRONGER THAN THE PRIVILEGE CHECK, and it catches what that one cannot:
    // a THIRD definer wrapper added later that reads the gate and records
    // nothing. Comments are stripped first — the same precedent as
    // `definer-tenancy.test.ts`, which went red on the prose explaining its own
    // rule.
    const rows = await sql<{ proname: string }[]>`
      SELECT p.proname
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'app'
         AND regexp_replace(p.prosrc, '--[^\n]*', '', 'g') LIKE '%compliance_check(%'
       ORDER BY p.proname`

    expect(rows.map((r) => r.proname)).toEqual(['compliance_attempt', 'reminder_gate'])
  })

  it('refuses to boot when the gate is reachable', async () => {
    // The re-assertion, exercised by granting and revoking from the OWNER
    // connection. Boot-time is the third of the three properties that survive
    // an unread migration diff; this is the test that it is wired.
    await expect(assertGateIsRecording(sql)).resolves.toBeUndefined()

    await sql`GRANT EXECUTE ON FUNCTION app.compliance_check(uuid, app.channel, timestamptz) TO crm_app`
    try {
      await expect(assertGateIsRecording(sql)).rejects.toThrow(/BOOT004/)
    } finally {
      await sql`REVOKE EXECUTE ON FUNCTION app.compliance_check(uuid, app.channel, timestamptz) FROM crm_app`
    }

    await expect(assertGateIsRecording(sql)).resolves.toBeUndefined()
  })
})

describe('a refusal is one audit row and one event, joined', () => {
  it('emits compliance.send_blocked with the CATALOG vocabulary, not the enum', async () => {
    // 🎯 THE SINGLE MOST LIKELY IMPLEMENTATION ERROR. Two vocabularies exist:
    // `app.gate_verdict` is a gate OUTCOME (`blocked_suppressed`, and it has an
    // `allow`), the catalog's `verdict` is a refusal REASON (`stop`, `dnc`, …).
    // Putting the enum on the wire produces a payload that validates against
    // nothing and a timeline entry that dead-letters.
    const outcome = await dialFor(identity, { contactId: STOPPED_CONTACT })
    expect(outcome.status).toBe('refused')

    const events = await eventsFor(STOPPED_CONTACT)
    expect(events).toHaveLength(1)

    const payload = events[0]?.payload ?? {}
    expect(payload['verdict']).toBe('stop')
    expect(String(payload['verdict'])).not.toMatch(/^blocked_/)
    expect(payload['channel']).toBe('call')
    expect(payload['attempted_via']).toBe('dial_button')
  })

  it('names the phone the gate judged, not a re-resolved one', async () => {
    // Mutation: flip the gate's `ORDER BY is_primary DESC` to ASC. The verdict
    // still reads `stop` — the fixture's STOP is on the primary — while the
    // payload points at the other row. Only a behavioural assertion catches it.
    const [primary] = await sql<{ id: string }[]>`
      SELECT id FROM app.contact_phone
       WHERE tenant_id = ${TENANT} AND contact_id = ${STOPPED_CONTACT} AND is_primary`

    const events = await eventsFor(STOPPED_CONTACT)
    expect(events[0]?.payload['contact_phone_id']).toBe(primary?.id)
  })

  it('carries exactly the payload fields the contract declares', async () => {
    // NOTHING ELSE IN THE TREE CHECKS AN EMITTED PAYLOAD. The contract test
    // validates the catalog against itself; this compares a real emission
    // against the catalog, in both directions.
    const catalog = (await import('node:fs')).readFileSync('contracts/events/catalog.json', 'utf8')
    const parsed = JSON.parse(catalog) as {
      events: { name: string; payload: Record<string, unknown> }[]
    }
    const declared = parsed.events.find((e) => e.name === 'compliance.send_blocked')
    expect(declared).toBeDefined()

    const events = await eventsFor(STOPPED_CONTACT)
    expect(Object.keys(events[0]?.payload ?? {}).sort()).toEqual(
      Object.keys(declared?.payload ?? {}).sort(),
    )
  })

  it('keys the event on the audit row it belongs to, and shares its story', async () => {
    // One attempt, one story. `idempotency_key = 'gate_block:' || audit_log.id`
    // makes "one audit row per attempt" and "one event per refusal" the same
    // counting rule — mutation: key on the contact id, and attempts two and
    // three dedupe away while every screen still looks right.
    await dialFor(identity, { contactId: STOPPED_CONTACT })
    await dialFor(identity, { contactId: STOPPED_CONTACT })

    const events = await eventsFor(STOPPED_CONTACT)
    const audits = await auditFor(STOPPED_CONTACT)

    expect(events).toHaveLength(3)
    expect(audits).toHaveLength(3)
    expect(new Set(events.map((e) => e.idempotency_key)).size).toBe(3)

    const auditIds = new Set(audits.map((a) => a.id))
    for (const event of events) {
      expect(event.idempotency_key).toMatch(/^gate_block:/)
      expect(auditIds.has(event.idempotency_key.slice('gate_block:'.length))).toBe(true)
      expect(event.actor_user_id).toBe(ANA)
      expect(event.source_system).toBe('app')
    }

    // The lawyer's row and the seller's row join on the correlation.
    const stories = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n
        FROM app.audit_log a
        JOIN app.event_log e ON e.tenant_id = a.tenant_id AND e.correlation_id = a.correlation_id
       WHERE a.tenant_id = ${TENANT} AND a.subject_id = ${STOPPED_CONTACT}
         AND e.event_name = 'compliance.send_blocked'`
    expect(stories[0]?.n).toBe(3)
  })

  it('writes the audit row for an ALLOW and emits nothing', async () => {
    // The guard is `p_event_verdict IS NULL`, which is true on exactly one
    // branch of the gate. Mutation: move the emit above it, and a permitted
    // dial writes a refusal onto the seller's history.
    const before = (await eventsFor(OPEN_CONTACT)).length
    const outcome = await withOverride(() => dialFor(identity, { contactId: OPEN_CONTACT }))

    // Blocked on a later, operational reason is fine — what matters is the gate.
    expect(outcome.status).not.toBe('refused')

    const audits = await auditFor(OPEN_CONTACT)
    expect(audits.some((a) => a.verdict === 'allow')).toBe(true)
    expect(await eventsFor(OPEN_CONTACT)).toHaveLength(before)
  })

  it('gives a one-zone lead a local time and a two-zone lead none', async () => {
    // `calling_window_check` judges the whole zone set with `bool_and`, so a
    // Texas lead genuinely has two simultaneous local times and no one string
    // can hold them. Mutation: emit `zones[1]` unconditionally.
    await dialFor(identity, { contactId: ONE_ZONE_CONTACT })

    const oneZone = await eventsFor(ONE_ZONE_CONTACT)
    const twoZone = await eventsFor(STOPPED_CONTACT)

    // A Texas refusal: two zones, so null.
    expect(twoZone[0]?.payload['local_time_at_contact']).toBeNull()

    // New York resolves to one zone. It only carries a time when the gate got
    // far enough to resolve the window at all — a suppression refusal returns
    // before that, which is why this asserts the shape rather than a value.
    const local = oneZone[0]?.payload['local_time_at_contact']
    if (typeof local === 'string') {
      expect(local).toMatch(/^\d{2}:\d{2} America\/New_York$/)
    }
  })

  it('never reaches the gate at all for a lead the dial cannot see', async () => {
    // Owner-scoped not-found, and it happens BEFORE the gate: `dialFor` resolves
    // the contact first and answers `blocked / not_found` identically for Ben's
    // lead and for a uuid that never existed. So there is no attempt to record.
    const outcome = await dialFor(identity, { contactId: BENS_CONTACT })
    expect(outcome.status).toBe('blocked')

    expect(await eventsFor(BENS_CONTACT)).toHaveLength(0)
    expect(await auditFor(BENS_CONTACT)).toHaveLength(0)
  })

  it('records the probe but emits nothing when the door itself is asked', async () => {
    // 🔴 THE SILO AT THE EMIT POINT, driven through the door rather than the
    // route — because the route short-circuits above and the raw API path does
    // not. `event_log.owner_user_id` is NOT NULL and is the RLS silo column:
    // without the owner guard in `compliance_record` this either raises, or —
    // worse — writes a timeline entry into BEN's silo because Ana guessed a
    // uuid. The lawyer still wants the probe, so the audit row is written.
    const bensBefore = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM app.timeline_entry
       WHERE tenant_id = ${TENANT} AND contact_id = ${BENS_CONTACT}`

    const rows = await withTenant(identity, async (tx) =>
      tx.execute<{ verdict: string }>(raw`
        SELECT verdict::text AS verdict
          FROM app.compliance_attempt(${BENS_CONTACT}::uuid, 'call'::app.channel,
                                      'api'::app.attempt_origin)`),
    )
    // The gate's own closed answer for an invisible contact.
    expect(rows[0]?.verdict).toBe('blocked_timezone_unknown')

    expect(await eventsFor(BENS_CONTACT)).toHaveLength(0)
    expect(await auditFor(BENS_CONTACT)).toHaveLength(1)

    await relayOnce()
    const bensAfter = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM app.timeline_entry
       WHERE tenant_id = ${TENANT} AND contact_id = ${BENS_CONTACT}`
    expect(bensAfter[0]?.n).toBe(bensBefore[0]?.n)
  })
})

describe('the inverse map agrees with the gate on every branch it can produce', () => {
  it('round-trips every verdict the gate actually returns', async () => {
    // 🎯 COMPARED AGAINST THE GATE'S OWN OUTPUT, never against a second
    // hand-written table. Mutation: flip one `WHEN` arm in `gate_verdict_of`,
    // or change a branch of 0038's `event_verdict` — either way the pair stops
    // agreeing and this is red.
    const pairs = await sql<{ verdict: string; event_verdict: string }[]>`
      SELECT DISTINCT verdict::text AS verdict,
             (verdict_input_snapshot ->> 'event_verdict') AS event_verdict
        FROM app.audit_log
       WHERE tenant_id = ${TENANT} AND action = 'compliance.gate_checked'
         AND verdict_input_snapshot ->> 'event_verdict' IS NOT NULL`

    expect(pairs.length).toBeGreaterThan(0)
    for (const pair of pairs) {
      const [row] = await sql<{ back: string }[]>`
        SELECT app.gate_verdict_of(${pair.event_verdict})::text AS back`
      expect(row?.back).toBe(pair.verdict)
    }
  })

  it('raises rather than returning NULL for a value no branch produces', async () => {
    // `no_consent` and `bad_number` are ratified in the catalog and no branch of
    // the gate produces them. Mutation: replace the RAISE with RETURN NULL — the
    // failure then surfaces as a TL002 dead letter three layers away, about a
    // missing verdict rather than an unmapped one.
    for (const value of ['no_consent', 'bad_number', 'blocked_suppressed', 'allow']) {
      await expect(sql`SELECT app.gate_verdict_of(${value})`).rejects.toThrow(/CG011/)
    }
  })
})

describe('the refusal reaches the seller as one line with a reason', () => {
  it('projects a blocked dial into a send_blocked entry with its verdict', async () => {
    await relayOnce()

    const page = await readTimelineFor(identity, STOPPED_CONTACT, null)
    const blocked = page.entries.filter((e) => e.kind === 'send_blocked')

    // 🎯 THREE ATTEMPTS, ONE LINE. The 60-second window collapses the seller's
    // view while `audit_log` keeps one row per attempt — the governing sentence
    // expressed as two tables, now driven end to end through the real projector
    // for the first time.
    expect(blocked).toHaveLength(1)
    expect(blocked[0]?.summaryKey).toBe('gate.block.opted_out.timeline')
    expect(blocked[0]?.actorLabelKey).toBe('timeline.actor.you')

    const rows = await sql<{ ref_type: string; ref_id: string; verdict: string | null }[]>`
      SELECT ref_type, ref_id, verdict::text AS verdict
        FROM app.timeline_entry
       WHERE tenant_id = ${TENANT} AND contact_id = ${STOPPED_CONTACT}
         AND kind = 'send_blocked'`
    expect(rows[0]?.ref_type).toBe('compliance_block')
    expect(rows[0]?.verdict).toBe('blocked_suppressed')

    // The ref is the EVENT id. Mutation: `ref: 'subject'` writes
    // ('contact', contactId), which collides with that contact's own
    // lead_created row on `timeline_ref_uidx` and dead-letters silently.
    const eventIds = new Set((await eventsFor(STOPPED_CONTACT)).map((e) => e.event_id))
    expect(eventIds.has(rows[0]?.ref_id ?? '')).toBe(true)

    // And nothing was quietly dropped on the way.
    const dead = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM app.dead_letter WHERE tenant_id = ${TENANT}`
    expect(dead[0]?.n).toBe(0)
  })

  it('does not collide with a lead_created entry on the same contact', async () => {
    // The mutation that ONLY this catches. A same-verdict-same-minute repeat is
    // absorbed by the blocked arbiter, so it would pass with the wrong ref and
    // give false confidence; a DIFFERENT ref_type on the same subject is what
    // exposes the collision.
    await withTenant(identity, async (tx) => {
      await tx.execute(raw`
        SELECT app.timeline_upsert(
          ${STOPPED_CONTACT}::uuid, ${ANA}::uuid, clock_timestamp() - interval '1 day',
          'lead_created'::app.timeline_kind, 'contact', ${STOPPED_CONTACT}::uuid,
          '{}'::jsonb, gen_random_uuid(), ${ANA}::uuid, NULL)`)
    })

    const page = await readTimelineFor(identity, STOPPED_CONTACT, null)
    expect(page.entries.filter((e) => e.kind === 'lead_created')).toHaveLength(1)
    expect(page.entries.filter((e) => e.kind === 'send_blocked')).toHaveLength(1)

    const dead = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM app.dead_letter WHERE tenant_id = ${TENANT}`
    expect(dead[0]?.n).toBe(0)
  })

  it('adds no timeline row when the same delivery is replayed', async () => {
    const before = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM app.timeline_entry WHERE tenant_id = ${TENANT}`

    await relayOnce()
    await relayOnce()

    const after = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM app.timeline_entry WHERE tenant_id = ${TENANT}`
    expect(after[0]?.n).toBe(before[0]?.n)
  })

  it('writes exactly ONE audit row per attempt after the relay has drained', async () => {
    // 🔴 THE DOUBLING GATE, and it is the reason `compliance.send_blocked` had
    // to be removed from the relay's AUDITED map. The gate now writes its own
    // row synchronously; left in that map the relay wrote a SECOND row per
    // refusal on delivery — same action, NULL verdict, actor_type 'system'.
    //
    // The pre-existing count assertion in dial-gate.test.ts is
    // `toBeGreaterThanOrEqual(3)`, so the doubling would have gone GREEN.
    const audits = await auditFor(STOPPED_CONTACT)
    const events = await eventsFor(STOPPED_CONTACT)

    expect(audits).toHaveLength(events.length)
    for (const row of audits) expect(row.verdict).not.toBeNull()
  })
})

describe('a machine’s refusal reads as a machine, in the right words', () => {
  /** job → meeting → contact, the chain `app.reminder_gate` walks. */
  async function reminderFor(contactId: string): Promise<string> {
    const [pipeline] = await sql<{ id: string }[]>`
      INSERT INTO app.pipeline (tenant_id, owner_user_id, name)
      VALUES (${TENANT}, ${ANA}, 'Emit Board') RETURNING id`
    const [stage] = await sql<{ id: string }[]>`
      INSERT INTO app.stage (tenant_id, pipeline_id, owner_user_id, name, stage_type, sort_order)
      VALUES (${TENANT}, ${pipeline?.id ?? ''}, ${ANA}, 'Working', 'open', 0) RETURNING id`
    const [opportunity] = await sql<{ id: string }[]>`
      INSERT INTO app.opportunity
        (tenant_id, owner_user_id, contact_id, pipeline_id, stage_id, current_stage_type,
         created_from, stage_entered_at)
      VALUES (${TENANT}, ${ANA}, ${contactId}, ${pipeline?.id ?? ''}, ${stage?.id ?? ''},
              'open', 'manual', clock_timestamp()) RETURNING id`
    const [meeting] = await sql<{ id: string }[]>`
      INSERT INTO app.meeting (tenant_id, owner_user_id, contact_id, opportunity_id,
                               starts_at_utc, contact_timezone, created_via)
      VALUES (${TENANT}, ${ANA}, ${contactId}, ${opportunity?.id ?? ''},
              clock_timestamp() + interval '1 hour', 'America/Chicago', 'manual')
      RETURNING id`

    return withSystemWork(TENANT, async (tx) => {
      const rows = await tx.execute<{ id: string }>(raw`
        SELECT app.schedule_job('meeting_reminder'::app.scheduled_kind,
                                ${`emit-${contactId}`}, 'meeting',
                                ${meeting?.id ?? ''}::uuid,
                                clock_timestamp() + interval '5 minutes',
                                ${ANA}::uuid) AS id`)
      const id = rows[0]?.id
      if (id === undefined) throw new Error('schedule_job returned nothing')
      return id
    })
  }

  it('stamps no actor and the scheduler’s source on a blocked reminder', async () => {
    // 🔴 THE ORDERING GATE, AND NOTHING ELSE PINS IT. `reminder_gate` elevates
    // to the owner to ask the question, then RESTORES, then records. Recording
    // one line earlier — while still elevated — puts the seller's uuid on a
    // decision a scheduler made, and nothing errors.
    const jobId = await reminderFor(NO_ZONE_CONTACT)

    await withSystemWork(TENANT, async (tx) => {
      await tx.execute(raw`SELECT * FROM app.reminder_gate(${jobId}::uuid)`)
    })

    const events = await eventsFor(NO_ZONE_CONTACT)
    const fromScheduler = events.filter((e) => e.source_system === 'scheduler')

    expect(fromScheduler).toHaveLength(1)
    expect(fromScheduler[0]?.actor_user_id).toBeNull()
    expect(fromScheduler[0]?.owner_user_id).toBe(ANA)
    expect(fromScheduler[0]?.payload['channel']).toBe('sms')
    expect(fromScheduler[0]?.payload['attempted_via']).toBe('reminder_dispatch')
  })

  it('renders it as System, and says Text rather than Call', async () => {
    // 🎯 THE ON-SCREEN SYMPTOM, and this change is what made it reachable.
    // Before 0060 nothing emitted, so the only blocked row a seller could see
    // came from a dial and one flat set of sentences was honest. A refused TEXT
    // reading "Call not placed" is a wrong sentence on a seller's screen.
    //
    // Mutations: revert argument 9 of `timeline_upsert` to `d.ownerUserId` and
    // this reads "You" for a decision no human made; collapse the SMS map back
    // into the call map and it says "Call not placed" about a text.
    await relayOnce()

    const page = await readTimelineFor(identity, NO_ZONE_CONTACT, null)
    const blocked = page.entries.filter((e) => e.kind === 'send_blocked')

    expect(blocked.length).toBeGreaterThan(0)
    expect(blocked[0]?.actorLabelKey).toBe('timeline.actor.system')
    expect(blocked[0]?.summaryKey).toMatch(/\.timeline_sms$/)

    const dead = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM app.dead_letter WHERE tenant_id = ${TENANT}`
    expect(dead[0]?.n).toBe(0)
  })
})
