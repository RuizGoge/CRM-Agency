import { sql as raw } from 'drizzle-orm'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { withTenant } from '~/db'
import { assertTimelineWriterIsDefinerOnly } from '~/db/boot-assert'

import { TEST_URL } from './setup/urls'

/**
 * THE ACTIVITY REGION STOPS TAKING ANSWERS AND STARTS TAKING SUBJECTS.
 *
 * 🔴 WHAT 0064 CLOSED. `app.timeline_upsert` was granted to `crm_app` and took
 * the contact, the owner, the ACTOR, the instant, the kind, the ref, the
 * payload and the provenance as caller parameters, with NO ownership predicate
 * anywhere in its body — verified: it checked a tenant, and for blocked rows a
 * verdict, and nothing else. So a route could write onto a colleague's history
 * with `actor_user_id` set to that colleague, and `app.timeline_read` renders
 * exactly that as `timeline.actor.you`: the forgery appeared in the victim's
 * own Activity region as her own action.
 *
 * Of everything hardened in 0060-0064, this is the only one with an (a)-class
 * symptom — a wrong line on a seller's screen — which is why it is the one that
 * mattered most and the one that was closed last.
 *
 * ⚠️ AND WHAT IT DOES NOT CLOSE, because the honest sentence is one notch
 * narrower. `app.outbox_claim` is granted to `crm_app` and has no tenant
 * predicate — it is on `definer-tenancy.test.ts`'s exempt list for that reason
 * — so a seller-scope transaction can obtain every undelivered event id in
 * every tenant and hand one to `app.timeline_project`. What that achieves is
 * causing a TRUE event to be projected, which the relay was going to do anyway;
 * the migration's order-independent merge is what makes the result identical
 * either way. FABRICATION is closed. CAUSING A PROJECTION is not.
 */

const TENANT = '00000000-0000-7000-8000-0000000f0100'
const ANA = '00000000-0000-7000-8000-0000000f01a1'
const BEN = '00000000-0000-7000-8000-0000000f01b1'
const BENS_CONTACT = '00000000-0000-7000-8000-0000000f01c1'

let sql: postgres.Sql

beforeAll(async () => {
  sql = postgres(TEST_URL, { max: 1, onnotice: () => {} })

  await sql`
    INSERT INTO app.tenant (id, name, business_tz)
    VALUES (${TENANT}, 'Forgery Agency', 'America/New_York')`
  await sql`
    INSERT INTO app.app_user (tenant_id, id, email, full_name, display_name, role) VALUES
      (${TENANT}, ${ANA}, 'ana@fg.test', 'Ana Forgery', 'Ana F.', 'seller'),
      (${TENANT}, ${BEN}, 'ben@fg.test', 'Ben Forgery', 'Ben F.', 'seller')`
  await sql`
    INSERT INTO app.contact (tenant_id, id, owner_user_id, full_name, created_via)
    VALUES (${TENANT}, ${BENS_CONTACT}, ${BEN}, 'Bens Lead', 'manual')`
})

afterAll(async () => {
  await sql?.end()
})

describe('a route cannot write a seller a history', () => {
  it('refuses crm_app EXECUTE on timeline_upsert, and grants only the door', async () => {
    // 🎯 THE TEST OF MIGRATION 0064. Mutation: `GRANT EXECUTE ON FUNCTION
    // app.timeline_upsert(…) TO crm_app` in a later migration. Every other test
    // in the tree stays green and the forgery is reachable again.
    const rows = await sql<{ proname: string; granted: boolean; nargs: number }[]>`
      SELECT p.proname, has_function_privilege('crm_app', p.oid, 'EXECUTE') AS granted,
             p.pronargs AS nargs
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'app' AND p.proname IN ('timeline_upsert', 'timeline_project')`
    const byName = Object.fromEntries(rows.map((r) => [r.proname, r]))

    expect(byName['timeline_upsert']?.granted).toBe(false)
    // The door has to stay open or the Activity region silently stops growing.
    expect(byName['timeline_project']?.granted).toBe(true)

    // 🔴 AND IT TAKES EXACTLY ONE ARGUMENT. `CREATE OR REPLACE
    // app.timeline_project(p_event_id uuid, p_owner_override uuid DEFAULT NULL)`
    // leaves the one-argument signature resolvable, so a privilege check and a
    // `to_regprocedure` check both stay green over a door that has grown a way
    // to be lied to. The whole safety argument is that there is nothing to
    // supply but an event id.
    expect(byName['timeline_project']?.nargs).toBe(1)
  })

  it('rejects the application role writing a timeline row', async () => {
    const error = await withTenant({ tenantId: TENANT, userId: ANA }, async (tx) =>
      tx.execute(raw`
        SELECT app.timeline_upsert(
          ${BENS_CONTACT}::uuid, ${BEN}::uuid, clock_timestamp(),
          'note'::app.timeline_kind, 'forged', gen_random_uuid(),
          '{}'::jsonb, gen_random_uuid(), clock_timestamp(), ${BEN}::uuid, NULL)`),
    ).catch((e: unknown) => e)

    // Drizzle rewraps the driver error one level down; the text is in `.cause`.
    const parts: string[] = []
    let cursor: unknown = error
    while (cursor instanceof Error) {
      parts.push(cursor.message)
      cursor = cursor.cause
    }
    expect(parts.join(' | ')).toMatch(/permission denied/i)

    // AND BEN'S HISTORY IS UNTOUCHED. The privilege is the mechanism; this is
    // the symptom it prevents, asserted rather than assumed.
    const [row] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM app.timeline_entry
       WHERE tenant_id = ${TENANT} AND contact_id = ${BENS_CONTACT}`
    expect(row?.n).toBe(0)
  })

  it('keeps the projection map in the database, tied to a real subscription', async () => {
    // 🔴 THE FOREIGN KEY IS THE POINT, NOT THE TABLE. `app.event_consumer` is
    // one row per (consumer, event) subscription and `event_emit` only fans out
    // to rows that exist there, so a projection rule for an event `contacts`
    // does not receive is dead configuration — and with the FK it is UNWRITABLE
    // rather than merely wrong.
    //
    // ⚠️ IT CAUGHT ONE ON THE WAY IN: `consent.updated` was in the TypeScript
    // map and `contacts` has never subscribed to it, so the `consent` timeline
    // kind has been unreachable since 0059 and nothing said so.
    const [count] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM ref.timeline_projection`
    expect(count?.n).toBeGreaterThan(0)

    await expect(
      sql`
        INSERT INTO ref.timeline_projection (event_name, kind, ref_mode)
        VALUES ('consent.updated', 'consent', 'subject')`,
    ).rejects.toThrow(/timeline_projection_subscribed_fk/)
  })

  it('refuses to boot when the raw writer is reachable', async () => {
    const args =
      'uuid, uuid, timestamptz, app.timeline_kind, text, uuid, jsonb, uuid, ' +
      'timestamptz, uuid, app.gate_verdict'

    await expect(assertTimelineWriterIsDefinerOnly(sql)).resolves.toBeUndefined()

    await sql.unsafe(`GRANT EXECUTE ON FUNCTION app.timeline_upsert(${args}) TO crm_app`)
    try {
      await expect(assertTimelineWriterIsDefinerOnly(sql)).rejects.toThrow(/BOOT014/)
    } finally {
      // ⚠️ Load-bearing: `fileParallelism` is off, so a grant left behind here
      // turns the first test in this file green for the wrong reason.
      await sql.unsafe(`REVOKE EXECUTE ON FUNCTION app.timeline_upsert(${args}) FROM crm_app`)
    }

    await expect(assertTimelineWriterIsDefinerOnly(sql)).resolves.toBeUndefined()
  })
})
