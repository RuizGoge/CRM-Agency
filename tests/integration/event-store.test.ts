import { readFileSync } from 'node:fs'

import { sql as raw } from 'drizzle-orm'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { withTenant } from '~/db'
import { assertEventEmitIsDefinerOnly } from '~/db/boot-assert'

import { TEST_URL } from './setup/urls'

/**
 * The event store, and the outbox that makes fan-out survive a process dying.
 *
 * The event row and its consumer rows are written in ONE transaction. That is
 * the whole argument for an outbox: without it, "the sale happened" and "the
 * consumers were told" are two commits, and a worker that dies between them
 * loses a celebration, an earnings append or a suppressed send — silently, and
 * only for the events that happened during the crash.
 *
 * The division of labour with pg-boss is total: the outbox owns fan-out,
 * pg-boss owns scheduling. Two systems that both believe they deliver is how a
 * lead gets texted twice.
 */

const TENANT = '00000000-0000-7000-8000-0000000e5e00'
const OTHER = '00000000-0000-7000-8000-0000000e5eff'
const ANA = '00000000-0000-7000-8000-0000000e5ea1'
const BEN = '00000000-0000-7000-8000-0000000e5eb1'

interface Catalog {
  readonly events: readonly { readonly name: string; readonly consumers: readonly string[] }[]
}
const catalog = JSON.parse(readFileSync('contracts/events/catalog.json', 'utf8')) as Catalog

/** How many consumers the registry declares for opportunity.won. */
const WON_CONSUMERS =
  catalog.events.find((e) => e.name === 'opportunity.won')?.consumers.length ?? 0

/**
 * 🔴 THE FAN-OUT IS NOT THE CONSUMER LIST. Migration 0051 filters it by
 * delivery tier, and `earnings` is `inline` for this event because
 * `app.stage_move` already appends to the ledger inside the emitting
 * transaction (0019_undo_pairs.sql:257). An outbox row for it would ask the
 * relay to credit the same sale a second time — permanently, since the ledger
 * is append-only with no recompute job.
 *
 * Derived rather than written down, so that promoting a consumer back to
 * `outbox` in a migration moves this number instead of leaving a stale literal.
 */
const WON_INLINE = ['earnings']

/**
 * And 0052 withholds a second group: a consumer whose handler does not exist in
 * the tree gets no fan-out row either, because an outbox row means "this
 * consumer still owes this event" and a module that was never built owes
 * nothing. Today `audit` is the only built handler, so the fan-out for any
 * event is exactly one row.
 *
 * READ FROM THE ENGINE rather than written down, so that building the second
 * handler moves this number instead of leaving a literal that lies. The
 * assertions below then check WHICH consumers are present and absent, which is
 * the part a count cannot express.
 */
async function fanoutWidth(eventName: string): Promise<number> {
  const [row] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM app.event_consumer
     WHERE event_name = ${eventName}::app.event_name
       AND delivery IN ('outbox', 'pgboss')
       AND handler_built`
  return row?.n ?? 0
}

let sql: postgres.Sql

const EVENT_A = '01999999-0000-7000-8000-00000000ea01'
const EVENT_B = '01999999-0000-7000-8000-00000000ea02'

/**
 * ⚠️ THE OWNER CONNECTION, AND THAT IS A LOSS RATHER THAN A FIX.
 *
 * This ran through `withTenant` — as `crm_app`, under the production privilege
 * set — until migration 0061 revoked EXECUTE on `app.event_emit` from that
 * role. The call is no longer expressible there, BY DESIGN, and what the old
 * wrapper demonstrated is now false: it is asserted as false below, in
 * 'rejects the application role calling the writer'.
 *
 * So these tests are RE-AIMED, not repaired. The describe block they live under
 * is titled "the store is append-only and the application role is not its
 * writer" — a title this file had been quietly contradicting since 0043 by
 * having `crm_app` call the writer. The repoint makes the title true.
 *
 * The write side loses nothing: the INSERTs were always the owner's, executed
 * inside the definer, so the caller's role never changed what got written. The
 * session side loses a little, and the `withTenant` tests further down still
 * carry it. Same shape as `gate-3-money-path.test.ts`, which drives
 * `app.stage_move` this way and passes today.
 */
async function emit(
  tenantId: string,
  userId: string,
  eventId: string,
  name = 'opportunity.won',
): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`SELECT app.begin_request(${tenantId}::uuid, ${userId}::uuid)`
    await tx`SELECT app.event_emit(${eventId}::uuid, ${userId}::uuid, ${name}::app.event_name,
                                   'opportunity', ${eventId}::uuid, ${'nat-' + eventId},
                                   '{"deal_value_annual_premium":"120000"}'::jsonb)`
  })
}

beforeAll(async () => {
  sql = postgres(TEST_URL, { max: 1, onnotice: () => {} })

  await sql`
    INSERT INTO app.tenant (id, name, business_tz) VALUES
      (${TENANT}, 'Event Agency', 'America/New_York'),
      (${OTHER},  'Other Agency', 'America/Chicago')`
  await sql`
    INSERT INTO app.app_user (tenant_id, id, email, full_name, display_name, role) VALUES
      (${TENANT}, ${ANA}, 'ana@ev.test', 'Ana Seller', 'Ana A.', 'seller'),
      (${TENANT}, ${BEN}, 'ben@ev.test', 'Ben Seller', 'Ben B.', 'seller'),
      (${OTHER},  ${ANA}, 'ana@ot.test', 'Ana Other',  'Ana O.', 'seller')`
})

afterAll(async () => {
  await sql?.end()
})

describe('the event and its fan-out land together', () => {
  it('writes one event row and one row per declared consumer', async () => {
    await emit(TENANT, ANA, EVENT_A)

    const [ev] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM app.event_log
       WHERE tenant_id = ${TENANT} AND event_id = ${EVENT_A}`
    expect(ev?.n).toBe(1)

    const [out] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM app.event_outbox
       WHERE tenant_id = ${TENANT} AND event_id = ${EVENT_A}`
    // The registry is the fan-out list — what the foreign key makes true rather
    // than hoped — minus the two groups that must not receive a row.
    expect(out?.n).toBe(await fanoutWidth('opportunity.won'))

    // The gap is REAL and it is the point: the catalog declares eight consumers
    // for this event and one of them can be delivered to. Asserted so that the
    // day it closes, somebody reads this line and understands why it moved.
    expect(WON_CONSUMERS).toBeGreaterThan(5)
    expect(await fanoutWidth('opportunity.won')).toBeLessThan(WON_CONSUMERS)
  })

  it('gives an INLINE consumer no fan-out row, so a sale is credited once', async () => {
    // 🎯 THE ASSERTION THAT STOPS A DOUBLE CREDIT, and it names the consumer
    // instead of counting rows. Before 0051 the fan-out ignored the delivery
    // tier, so `earnings` received an outbox row for a sale `app.stage_move`
    // had ALREADY appended to the ledger. Nothing was broken yet only because
    // no relay handler existed; the day one did, one sale would have produced
    // two credits and the public board would have read double, forever.
    //
    // Mutation: drop `AND ec.delivery IN ('outbox','pgboss')` from
    // app.event_emit and this goes red with earnings present.
    const rows = await sql<{ consumer_name: string }[]>`
      SELECT consumer_name FROM app.event_outbox
       WHERE tenant_id = ${TENANT} AND event_id = ${EVENT_A}`
    const names = rows.map((r) => r.consumer_name)

    for (const inline of WON_INLINE) {
      expect(names, `${inline} runs inline and must not be delivered again`).not.toContain(inline)
    }

    // THE POSITIVE CONTROL, and without it this test passes over an empty
    // outbox — the shape of assertion this project has already been bitten by,
    // where "sees nothing" is satisfied by there being nothing.
    expect(names).toContain('audit')

    // And the other withheld group, stated separately because it is withheld
    // for a different reason: `reporting` is declared for this event and has no
    // handler in the tree, so it gets no row either. Same absence, different
    // cause, and conflating them would hide the day one of them changes.
    expect(names).not.toContain('reporting')
  })

  it('is idempotent on event_id, and does not fan out twice', async () => {
    // A replayed job or a retried webhook reaching here twice must not deliver
    // the sale to Earnings twice. At-least-once is per EMISSION, and the second
    // emission of the same id is not one.
    await emit(TENANT, ANA, EVENT_A)

    const [ev] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM app.event_log
       WHERE tenant_id = ${TENANT} AND event_id = ${EVENT_A}`
    const [out] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM app.event_outbox
       WHERE tenant_id = ${TENANT} AND event_id = ${EVENT_A}`

    expect(ev?.n).toBe(1)
    expect(out?.n).toBe(await fanoutWidth('opportunity.won'))
  })

  it('refuses to emit outside a tenant session', async () => {
    await expect(
      sql`SELECT app.event_emit(${EVENT_B}::uuid, ${ANA}::uuid, 'opportunity.won'::app.event_name,
                                'opportunity', ${EVENT_B}::uuid, 'nat', '{}'::jsonb)`,
    ).rejects.toThrow(/EV001/)
  })
})

describe('the store is append-only and the application role is not its writer', () => {
  it('gives crm_app no INSERT, UPDATE or DELETE on event_log', async () => {
    for (const p of ['INSERT', 'UPDATE', 'DELETE'] as const) {
      const [priv] = await sql<{ ok: boolean }[]>`
        SELECT has_table_privilege('crm_app', 'app.event_log', ${p}) AS ok`
      expect(priv?.ok, `crm_app can ${p} event_log`).toBe(false)
    }
  })

  it('scopes reads to the owner', async () => {
    // append_only_owner: Ana reads her own events, Ben does not read them.
    const mine = await withTenant({ tenantId: TENANT, userId: ANA }, async (tx) =>
      tx.execute(raw`SELECT event_id FROM app.event_log WHERE event_id = ${EVENT_A}::uuid`),
    )
    const theirs = await withTenant({ tenantId: TENANT, userId: BEN }, async (tx) =>
      tx.execute(raw`SELECT event_id FROM app.event_log WHERE event_id = ${EVENT_A}::uuid`),
    )
    expect(mine).toHaveLength(1)
    expect(theirs).toHaveLength(0)
  })

  it('refuses crm_app EXECUTE on event_emit, and grants the two doors', async () => {
    // 🎯 THE TEST OF MIGRATION 0061, and the only thing in the tree pinning it.
    //
    // MUTATION: add `GRANT EXECUTE ON FUNCTION app.event_emit(…) TO crm_app` in
    // a later migration — one line, copied from 0043, in a diff nobody reads.
    // Every other test in this file stays green, the board is identical, no
    // seller sees anything, and any route can forge any of the 49 events into
    // an append-only table with no recompute job. This assertion is the only
    // thing that goes red.
    //
    // SECOND MUTATION, which matching `proacl` would miss: DROP FUNCTION +
    // CREATE FUNCTION with no REVOKE, leaving EXECUTE TO PUBLIC — wider than
    // before the revoke. `has_function_privilege` resolves PUBLIC membership.
    const rows = await sql<{ proname: string; granted: boolean }[]>`
      SELECT p.proname, has_function_privilege('crm_app', p.oid, 'EXECUTE') AS granted
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'app'
         AND p.proname IN ('event_emit', 'compliance_record', 'stage_move')`
    const granted = Object.fromEntries(rows.map((r) => [r.proname, r.granted]))

    expect(granted['event_emit']).toBe(false)
    expect(granted['compliance_record']).toBe(false)
    // THE POSITIVE CONTROL, and it is not decoration: without it this passes
    // over a database where none of the three functions exist and `granted` is
    // an empty object — a vacuous green.
    expect(granted['stage_move']).toBe(true)
  })

  it('rejects the application role calling the writer', async () => {
    // The privilege above, observed from outside. Mutation: revert the revoke —
    // this goes red with `undefined` instead of a permission error.
    //
    // The message lives in `.cause`: Drizzle rewraps the driver error one level
    // down and the outer text is only "Failed query".
    const error = await withTenant({ tenantId: TENANT, userId: ANA }, async (tx) =>
      tx.execute(raw`
        SELECT app.event_emit(${EVENT_B}::uuid, ${ANA}::uuid, 'opportunity.won'::app.event_name,
                              'opportunity', ${EVENT_B}::uuid, 'forged', '{}'::jsonb)`),
    ).catch((e: unknown) => e)

    const parts: string[] = []
    let cursor: unknown = error
    while (cursor instanceof Error) {
      parts.push(cursor.message)
      cursor = cursor.cause
    }
    expect(parts.join(' | ')).toMatch(/permission denied/i)
  })

  it('has exactly three functions in the whole database that write the store', async () => {
    // 🔴 STRONGER THAN THE PRIVILEGE CHECK, and it catches what that one cannot.
    // `app.event_emit` is reachable by every SECURITY DEFINER the owner owns, so
    // a THIRD definer added later — one that emits `opportunity.won` with a
    // caller-supplied premium and no close gate in front of it — needs no GRANT
    // and trips nothing above.
    //
    // Comments are stripped first: the same precedent as
    // `definer-tenancy.test.ts`, which once went red on the prose explaining its
    // own rule.
    //
    // ✅ AND IT DID ITS JOB. `app.opportunity_create` (0065) turned this red the
    // moment it landed. That is the gate working rather than being in the way:
    // after 0061 emission is a SQL-only capability, so every new emitter is a
    // definer — and the point of this list is that adding one is a DELIBERATE
    // ACT visible in a diff. Growing it is fine; growing it unnoticed is what
    // this refuses.
    const rows = await sql<{ proname: string }[]>`
      SELECT p.proname
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'app'
         AND regexp_replace(p.prosrc, '--[^\n]*', '', 'g') LIKE '%event_emit(%'
       ORDER BY p.proname`

    expect(rows.map((r) => r.proname)).toEqual([
      'compliance_record',
      'opportunity_create',
      'stage_move',
    ])
  })

  it('refuses to boot when the writer is reachable', async () => {
    // The third of the three properties, exercised by granting and revoking from
    // the OWNER connection. This revoke has NO symptom on any screen, so a
    // deploy that will not come up is the only notice a regression gets.
    const args =
      'uuid, uuid, app.event_name, text, uuid, text, jsonb, timestamptz, ' +
      'app.source_system, uuid, app.retention_class, smallint'

    await expect(assertEventEmitIsDefinerOnly(sql)).resolves.toBeUndefined()

    await sql.unsafe(`GRANT EXECUTE ON FUNCTION app.event_emit(${args}) TO crm_app`)
    try {
      await expect(assertEventEmitIsDefinerOnly(sql)).rejects.toThrow(/BOOT006/)
    } finally {
      // ⚠️ LOAD-BEARING. `fileParallelism` is off, so a grant left behind by a
      // failed assertion leaks into every file that runs after this one and
      // turns the catalog test above green for the wrong reason.
      await sql.unsafe(`REVOKE EXECUTE ON FUNCTION app.event_emit(${args}) FROM crm_app`)
    }

    await expect(assertEventEmitIsDefinerOnly(sql)).resolves.toBeUndefined()
  })
})

describe('a partition inherits the parent, rather than escaping it', () => {
  it('carries FORCE row level security and the parent policy', async () => {
    // THE CORRECTION THIS MIGRATION RECORDS. The first attempt excluded
    // partition children from the managed set, and silo.test.ts caught it in
    // one run — a managed relation with RLS disabled. Inheriting the parent's
    // classification keeps the invariant true instead of trading it away.
    const rows = await sql<{ relname: string; forced: boolean; policies: number }[]>`
      SELECT c.relname,
             c.relforcerowsecurity AS forced,
             (SELECT count(*)::int FROM pg_policies p
               WHERE p.schemaname = 'app' AND p.tablename = c.relname) AS policies
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       -- relkind 'r' only: pg_class also holds the partition's INDEX, which is
       -- itself relispartition and has no RLS of its own to force.
       WHERE n.nspname = 'app' AND c.relispartition AND c.relkind = 'r'
         AND c.relname LIKE 'event_log_%'`

    expect(rows.length, 'no event_log partition exists').toBeGreaterThan(0)
    for (const r of rows) {
      expect(r.forced, `${r.relname} does not FORCE RLS`).toBe(true)
      expect(r.policies, `${r.relname} has no policy`).toBeGreaterThan(0)
    }
  })

  it('declares the parent even though partitions are created dynamically', () => {
    // The snapshot-chain gate asks that every table a migration CREATES be
    // declared. Partitions are created through format(), so its regex never
    // sees them — which is correct and worth stating rather than relying on:
    // a partition is storage for a declared parent, and the parent is declared.
    const schema = readFileSync('app/db/schema/event-store.ts', 'utf8')
    expect(schema).toContain("'event_log'")
    expect(schema).toContain("'event_outbox'")
  })
})

describe('the claim crosses tenants and carries no payload', () => {
  it('returns coordinates only, and none of them is the event body', async () => {
    // A claim that returned the payload would be a cross-tenant read of every
    // event body in the system wearing the costume of a queue.
    //
    // ⚠️ THIS LIST GREW FROM FOUR TO FIVE IN 0051, and the fifth is a partition
    // key rather than anything about the event. `created_day` is part of the
    // outbox primary key, so without it the ack cannot name the row it is
    // acknowledging and would have to search every partition for it.
    const cols = await sql<{ name: string }[]>`
      SELECT p.proargnames[i] AS name
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace,
             generate_subscripts(p.proargnames, 1) i
       WHERE n.nspname = 'app' AND p.proname = 'outbox_claim'
         AND p.proargmodes[i] IN ('o', 't')`
    const names = cols.map((c) => c.name).sort()

    expect(names).toEqual(['consumer_name', 'created_day', 'event_id', 'event_name', 'tenant_id'])

    // Stated as its own assertion rather than left implicit in the list above.
    // The list is what someone edits when they add a column; this is what
    // refuses the specific column that would matter, so widening the claim by
    // one convenient field cannot pass by bumping an array.
    for (const forbidden of ['payload', 'subject_id', 'owner_user_id', 'idempotency_key']) {
      expect(names, `the claim must not carry ${forbidden}`).not.toContain(forbidden)
    }
  })

  it('finds work in more than one agency in a single claim', async () => {
    await emit(OTHER, ANA, EVENT_B)

    const claimed = await sql<{ tenant_id: string }[]>`
      SELECT tenant_id FROM app.outbox_claim(500, interval '5 minutes', 'test-worker')`
    const tenants = new Set(claimed.map((r) => r.tenant_id))

    // Dispatch has to find work across every agency BEFORE it knows whose work
    // it is. That is why this is one of the four sanctioned cross-tenant paths
    // — and why it is on the definer-tenancy exemption list with a reason.
    expect(tenants.has(TENANT)).toBe(true)
    expect(tenants.has(OTHER)).toBe(true)
  })
})

describe('a fan-out row for an unknown consumer cannot exist', () => {
  it('is refused by the foreign key, not by a check somebody remembers', async () => {
    await expect(
      sql`INSERT INTO app.event_outbox (tenant_id, created_day, event_id, consumer_name, event_name)
          VALUES (${TENANT}, clock_timestamp()::date, ${EVENT_A}::uuid, 'a_module_nobody_declared',
                  'opportunity.won')`,
    ).rejects.toThrow(/outbox_consumer_fk|violates foreign key/i)
  })
})
