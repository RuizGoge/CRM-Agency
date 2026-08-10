import { sql as raw } from 'drizzle-orm'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { withTenant } from '~/db'

import { TEST_URL } from './setup/urls'

/**
 * The ONE outbound compliance gate — D-SEC-4, in order.
 *
 * Every dial, message and reminder passes through here: card, detail, My Day,
 * appointment row, wrap-up, scheduler, the degraded manual path and the raw
 * API. A second place that decides is a second place that can be wrong, and the
 * wrong one is always the one nobody tested.
 *
 * ORDER IS THE POINT, and most of this suite asserts precedence rather than
 * individual verdicts. A gate that returns the right answers in the wrong order
 * is a gate where break-glass reaches a question it must never be asked.
 */

const TENANT = '00000000-0000-7000-8000-0000000ca7e0'
const NOSMS = '00000000-0000-7000-8000-0000000ca7ef'
const ADMIN = '00000000-0000-7000-8000-0000000ca7d1'
const ANA = '00000000-0000-7000-8000-0000000ca7a1'
const BEN = '00000000-0000-7000-8000-0000000ca7b1'

/** 23:30 UTC in July = 19:30 Eastern / 18:30 Central. Inside every zone. */
const INSIDE = '2026-07-15T23:30:00Z'
/** 13:30 UTC in July = 09:30 Eastern / 08:30 Central. Outside Central. */
const FL_MORNING = '2026-07-15T13:30:00Z'

let sql: postgres.Sql
let clean: string
let stopped: string
let florida: string
/**
 * Texas: two zones like Florida, but ONE-PARTY for recording.
 *
 * Florida cannot carry the break-glass tests, and finding out why was the
 * useful part: released from the calling window it lands on
 * `blocked_recording_unverified`, because FL is an all-party-consent state. The
 * gate was right and the fixture was wrong.
 */
let texas: string
let noWhere: string
let california: string
let bensLead: string

/** The whole error chain: Drizzle rewraps the driver error one level down. */
function chain(error: unknown): string {
  const parts: string[] = []
  let cursor: unknown = error
  while (cursor instanceof Error) {
    parts.push(cursor.message)
    cursor = cursor.cause
  }
  return parts.join(' | ')
}

/** Runs `fn` and returns the full error chain, or null when it did not throw. */
async function refusal(fn: () => Promise<unknown>): Promise<string | null> {
  return fn()
    .then(() => null)
    .catch((error: unknown) => chain(error))
}

type Row = {
  verdict: string
  event_verdict: string | null
  override_id: string | null
  zones: string[]
}

async function gate(
  userId: string,
  contactId: string,
  channel: 'call' | 'sms',
  at = INSIDE,
  tenantId = TENANT,
): Promise<Row> {
  const rows = await withTenant({ tenantId, userId }, async (tx) =>
    tx.execute<Row>(
      raw`SELECT verdict, event_verdict, override_id, zones
            FROM app.compliance_check(${contactId}::uuid, ${channel}::app.channel,
                                      ${at}::timestamptz)`,
    ),
  )
  const first = rows[0]
  if (first === undefined) throw new Error('compliance_check returned no row')
  return first
}

beforeAll(async () => {
  sql = postgres(TEST_URL, { max: 1, onnotice: () => {} })

  await sql`
    INSERT INTO app.tenant (id, name, business_tz, sms_enabled) VALUES
      (${TENANT}, 'Gate Agency',  'America/New_York', true),
      (${NOSMS},  'Quiet Agency', 'America/New_York', false)`

  await sql`
    INSERT INTO app.app_user (tenant_id, id, email, full_name, display_name, role) VALUES
      (${TENANT}, ${ADMIN}, 'adm@gate.test', 'Ada Admin',  'Ada A.', 'admin'),
      (${TENANT}, ${ANA},   'ana@gate.test', 'Ana Seller', 'Ana A.', 'seller'),
      (${TENANT}, ${BEN},   'ben@gate.test', 'Ben Seller', 'Ben B.', 'seller'),
      (${NOSMS},  ${ANA},   'ana@quiet.test','Ana Seller', 'Ana A.', 'seller')`

  const mk = async (
    tenantId: string,
    owner: string,
    state: string | null,
    phone: string | null,
  ): Promise<string> => {
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO app.contact (tenant_id, owner_user_id, full_name, created_via, state_code)
      VALUES (${tenantId}, ${owner}, 'Lead', 'lead_intake', ${state})
      RETURNING id`
    const id = row?.id ?? ''
    if (phone !== null) {
      await sql`
        INSERT INTO app.contact_phone (tenant_id, contact_id, owner_user_id, phone_e164, is_primary)
        VALUES (${tenantId}, ${id}, ${owner}, ${phone}, true)`
    }
    return id
  }

  clean = await mk(TENANT, ANA, 'NY', '+12125550101')
  stopped = await mk(TENANT, ANA, 'NY', '+12125550102')
  florida = await mk(TENANT, ANA, 'FL', '+13055550103')
  texas = await mk(TENANT, ANA, 'TX', '+12145550107')
  noWhere = await mk(TENANT, ANA, null, null)
  california = await mk(TENANT, ANA, 'CA', '+14155550105')
  bensLead = await mk(TENANT, BEN, 'NY', '+12125550106')

  await withTenant({ tenantId: TENANT, userId: ANA }, async (tx) => {
    await tx.execute(raw`
      SELECT app.suppression_append('+12125550102', 'stop', now() - interval '1 day', NULL,
                                    NULL, NULL, 'replied STOP')`)
  })
})

afterAll(async () => {
  await sql?.end()
})

describe('the happy path is the only one that reaches allow', () => {
  it('allows a clean lead inside the window', async () => {
    const v = await gate(ANA, clean, 'call')
    expect(v.verdict).toBe('allow')
    expect(v.event_verdict).toBeNull()
    expect(v.override_id).toBeNull()
  })
})

describe('order of precedence, which is most of the safety', () => {
  it('refuses a suppressed number INSIDE the window', async () => {
    // Suppression is evaluated before the clock, so a STOP is refused at 7:30pm
    // for exactly the reason it is refused at midnight. A gate that checked the
    // clock first would return `allow` here whenever the hour happened to be
    // legal.
    const v = await gate(ANA, stopped, 'call')
    expect(v.verdict).toBe('blocked_suppressed')
    expect(v.event_verdict).toBe('stop')
  })

  it('refuses SMS on a tenant with sms disabled, before anything else is asked', async () => {
    // The clean contact of a tenant whose 10DLC registration has not completed.
    // Nothing about the lead matters yet.
    const quiet = await sql<{ id: string }[]>`
      INSERT INTO app.contact (tenant_id, owner_user_id, full_name, created_via, state_code)
      VALUES (${NOSMS}, ${ANA}, 'Lead', 'lead_intake', 'NY') RETURNING id`
    const v = await gate(ANA, quiet[0]?.id ?? '', 'sms', INSIDE, NOSMS)
    expect(v.verdict).toBe('blocked_sms_disabled')
    expect(v.event_verdict).toBe('10dlc_pending')
  })

  it('blocks the Florida straddle through the gate, not just the window function', async () => {
    const v = await gate(ANA, florida, 'call', FL_MORNING)
    expect(v.verdict).toBe('blocked_calling_window')
    expect(v.event_verdict).toBe('outside_window')
  })

  it('fails closed when no timezone resolves', async () => {
    const v = await gate(ANA, noWhere, 'call')
    expect(v.verdict).toBe('blocked_timezone_unknown')
    expect(v.event_verdict).toBe('unknown_timezone')
  })

  it("gives a stranger's lead the closed answer and never an error", async () => {
    const v = await gate(ANA, bensLead, 'call')
    expect(v.verdict).toBe('blocked_timezone_unknown')
    const owned = await gate(BEN, bensLead, 'call')
    expect(owned.verdict).toBe('allow')
  })
})

describe('the recording guard is proportionate, not a floor-wide stop', () => {
  it('refuses a call to an all-party state while the guard is tripped', async () => {
    const v = await gate(ANA, california, 'call')
    expect(v.verdict).toBe('blocked_recording_unverified')
  })

  it('lets the same seller call a one-party state', async () => {
    // The point of the proportionality: New York proceeds. Stopping the floor
    // over an unverified provider setting is a bigger harm than the exposure.
    const v = await gate(ANA, clean, 'call')
    expect(v.verdict).toBe('allow')
  })

  it('does not apply to SMS', async () => {
    const v = await gate(ANA, california, 'sms')
    expect(v.verdict).toBe('allow')
  })
})

describe('break-glass releases exactly two verdicts and never a third', () => {
  it('is admin-only', async () => {
    const denied = await refusal(() =>
      withTenant({ tenantId: TENANT, userId: ANA }, async (tx) =>
        tx.execute(raw`SELECT app.break_glass_engage('a seller should not be able to do this')`),
      ),
    )
    expect(denied).toMatch(/BG001/)
  })

  it('demands a reason an auditor would accept', async () => {
    const denied = await refusal(() =>
      withTenant({ tenantId: TENANT, userId: ADMIN }, async (tx) =>
        tx.execute(raw`SELECT app.break_glass_engage('test')`),
      ),
    )
    expect(denied).toMatch(/override_reason_is_real/)
  })

  it('releases the calling window and stamps the override on the verdict', async () => {
    await withTenant({ tenantId: TENANT, userId: ADMIN }, async (tx) => {
      await tx.execute(
        raw`SELECT app.break_glass_engage('timezone dataset is wrong, floor stopped')`,
      )
    })

    const v = await gate(ANA, texas, 'call', FL_MORNING)
    expect(v.verdict).toBe('allow')
    // A permitted-under-break-glass send must never be indistinguishable from a
    // plain one in the record.
    expect(v.override_id).not.toBeNull()
  })

  it('releases an unresolved timezone too', async () => {
    const v = await gate(ANA, noWhere, 'call')
    expect(v.verdict).toBe('allow')
    expect(v.override_id).not.toBeNull()
  })

  it('DOES NOT release a suppressed number', async () => {
    // THE ASSERTION THE WHOLE FEATURE IS SHAPED AROUND. An admin under
    // break-glass still cannot dial a STOP, and the reason is structural rather
    // than procedural: the scope enum has no label for it.
    const v = await gate(ANA, stopped, 'call')
    expect(v.verdict).toBe('blocked_suppressed')
    expect(v.override_id).toBeNull()
  })

  it('DOES NOT release the recording guard', async () => {
    const v = await gate(ANA, california, 'call')
    expect(v.verdict).toBe('blocked_recording_unverified')
  })

  it('holds at most one live override per tenant', async () => {
    const denied = await refusal(() =>
      withTenant({ tenantId: TENANT, userId: ADMIN }, async (tx) =>
        tx.execute(raw`SELECT app.break_glass_engage('a second simultaneous override attempt')`),
      ),
    )
    expect(denied).toMatch(/override_one_live_per_tenant/)
  })

  it('expires on read at sixty minutes, with no job involved', async () => {
    // The override is live now; asked about an instant 61 minutes after it
    // started, it is not. Nothing ran in between — expires_at is generated from
    // started_at and evaluated by the query.
    const [row] = await sql<{ later: string }[]>`
      SELECT (started_at + interval '61 minutes')::text AS later
        FROM app.break_glass_override
       WHERE tenant_id = ${TENANT} AND ended_at IS NULL`

    const v = await gate(ANA, texas, 'call', row?.later ?? INSIDE)
    expect(v.verdict).toBe('blocked_calling_window')
  })

  it('ends manually and stops releasing anything', async () => {
    const ended = await withTenant({ tenantId: TENANT, userId: ADMIN }, async (tx) =>
      tx.execute<{ break_glass_end: number }>(raw`SELECT app.break_glass_end()`),
    )
    expect(ended[0]?.break_glass_end).toBe(1)

    const v = await gate(ANA, texas, 'call', FL_MORNING)
    expect(v.verdict).toBe('blocked_calling_window')
  })
})

describe('the schema is what makes "not overridable" true', () => {
  it('gives override_scope exactly one label', async () => {
    // Not a convention and not a code path: there is NO VALUE the column could
    // hold that means "override suppression". Adding one is ALTER TYPE — a
    // migration, a diff, a decision somebody makes on purpose.
    const [row] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
        JOIN pg_namespace n ON n.oid = t.typnamespace
       WHERE t.typname = 'override_scope' AND n.nspname = 'app'`
    expect(row?.n).toBe(1)
  })

  it('computes expiry as a generated column rather than storing a copy', async () => {
    const [row] = await sql<{ generated: string }[]>`
      SELECT is_generated AS generated FROM information_schema.columns
       WHERE table_schema = 'app' AND table_name = 'break_glass_override'
         AND column_name = 'expires_at'`
    expect(row?.generated).toBe('ALWAYS')
  })
})

describe('a START after a STOP re-opens the number', () => {
  it('allows the dial once the consumer opts back in', async () => {
    await withTenant({ tenantId: TENANT, userId: ANA }, async (tx) => {
      await tx.execute(raw`
        SELECT app.suppression_append('+12125550102', 'start', now(), NULL,
                                      NULL, NULL, 'replied START')`)
    })
    const v = await gate(ANA, stopped, 'call')
    expect(v.verdict).toBe('allow')
  })
})
