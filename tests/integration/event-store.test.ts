import { readFileSync } from 'node:fs'

import { sql as raw } from 'drizzle-orm'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { withTenant } from '~/db'

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

let sql: postgres.Sql

const EVENT_A = '01999999-0000-7000-8000-00000000ea01'
const EVENT_B = '01999999-0000-7000-8000-00000000ea02'

async function emit(
  tenantId: string,
  userId: string,
  eventId: string,
  name = 'opportunity.won',
): Promise<void> {
  await withTenant({ tenantId, userId }, async (tx) => {
    await tx.execute(raw`
      SELECT app.event_emit(${eventId}::uuid, ${userId}::uuid, ${name}::app.event_name,
                            'opportunity', ${eventId}::uuid, ${'nat-' + eventId},
                            '{"deal_value_annual_premium":"120000"}'::jsonb)`)
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
    // Exactly the catalog's consumers for this event — the registry is the
    // fan-out list, which is what the foreign key makes true rather than hoped.
    expect(out?.n).toBe(WON_CONSUMERS)
    expect(WON_CONSUMERS).toBeGreaterThan(5)
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
    expect(out?.n).toBe(WON_CONSUMERS)
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
  it('returns four columns and none of them is the event body', async () => {
    // A claim that returned the payload would be a cross-tenant read of every
    // event body in the system wearing the costume of a queue.
    const cols = await sql<{ name: string }[]>`
      SELECT p.proargnames[i] AS name
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace,
             generate_subscripts(p.proargnames, 1) i
       WHERE n.nspname = 'app' AND p.proname = 'outbox_claim'
         AND p.proargmodes[i] IN ('o', 't')`
    expect(cols.map((c) => c.name).sort()).toEqual([
      'consumer_name',
      'event_id',
      'event_name',
      'tenant_id',
    ])
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
