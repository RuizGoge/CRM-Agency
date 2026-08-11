import { sql as raw } from 'drizzle-orm'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { withTenant } from '~/db'
import { relayOnce } from '~/modules/events/relay'

import { TEST_URL } from './setup/urls'

/**
 * The timeline. MVP item 20, and the root of the daily loop.
 *
 * It was blocked until the transport closed: `built_from_event_id` is NOT NULL,
 * its only writer is a projector over `event_log`, and until 0051–0054 there was
 * no relay and no emitter. Building it earlier would have meant relaxing a
 * provenance NOT NULL to hold an event id that never existed.
 *
 * THE SENTENCE THAT DECIDES ITS DESIGN: "the timeline is for the seller, the
 * audit log is for the lawyer." One entry per verdict per contact per 60-second
 * window here; one row per ATTEMPT there. Both built from the same events.
 */

const TENANT = '00000000-0000-7000-8000-0000000e9000'
const ANA = '00000000-0000-7000-8000-0000000e90a1'
const BEN = '00000000-0000-7000-8000-0000000e90b1'
const CONTACT = '00000000-0000-7000-8000-0000000e90c1'
const BENS_CONTACT = '00000000-0000-7000-8000-0000000e90c2'
const OPP = '00000000-0000-7000-8000-0000000e90d1'
const OPEN_STAGE = '00000000-0000-7000-8000-0000000e9001'
const WON_STAGE = '00000000-0000-7000-8000-0000000e9002'

let sql: postgres.Sql

async function move(toStage: string, premium: bigint | null): Promise<void> {
  await withTenant({ tenantId: TENANT, userId: ANA }, async (tx) => {
    await tx.execute(raw`
      SELECT * FROM app.stage_move(
        ${OPP}::uuid, ${toStage}::uuid, 'kanban_drag'::app.moved_via,
        'human'::app.actor_type, NULL,
        ${premium === null ? null : premium.toString()}::bigint,
        ${premium === null ? null : 'annual'}::app.premium_mode)`)
  })
}

async function readTimeline(
  userId: string,
  contactId: string,
): Promise<{ kind: string; actor_label_key: string; render_payload: Record<string, unknown> }[]> {
  return withTenant({ tenantId: TENANT, userId }, async (tx) => {
    const rows = await tx.execute<{
      kind: string
      actor_label_key: string
      render_payload: Record<string, unknown>
    }>(raw`SELECT kind::text AS kind, actor_label_key, render_payload
             FROM app.timeline_read(${contactId}::uuid)`)
    return [...rows]
  })
}

beforeAll(async () => {
  sql = postgres(TEST_URL, { max: 1, onnotice: () => {} })

  await sql`
    INSERT INTO app.tenant (id, name, business_tz)
    VALUES (${TENANT}, 'Timeline Agency', 'America/New_York')`
  await sql`
    INSERT INTO app.app_user (tenant_id, id, email, full_name, display_name, role) VALUES
      (${TENANT}, ${ANA}, 'ana@tl.test', 'Ana Timeline', 'Ana T.', 'seller'),
      (${TENANT}, ${BEN}, 'ben@tl.test', 'Ben Timeline', 'Ben T.', 'seller')`
  await sql`
    INSERT INTO app.contact (tenant_id, id, owner_user_id, full_name, created_via) VALUES
      (${TENANT}, ${CONTACT}, ${ANA}, 'Ruth Timeline', 'manual'),
      (${TENANT}, ${BENS_CONTACT}, ${BEN}, 'Bens Lead', 'manual')`
  await sql`
    INSERT INTO app.pipeline (tenant_id, owner_user_id, name)
    VALUES (${TENANT}, ${ANA}, 'Board')`
  await sql`
    INSERT INTO app.stage (tenant_id, id, pipeline_id, owner_user_id, name, stage_type, sort_order)
    SELECT ${TENANT}, ${OPEN_STAGE}, p.id, ${ANA}, 'Working', 'open', 0
      FROM app.pipeline p WHERE p.tenant_id = ${TENANT}`
  await sql`
    INSERT INTO app.stage (tenant_id, id, pipeline_id, owner_user_id, name, stage_type, sort_order)
    SELECT ${TENANT}, ${WON_STAGE}, p.id, ${ANA}, 'Closed Won', 'earning', 1
      FROM app.pipeline p WHERE p.tenant_id = ${TENANT}`
  await sql`
    INSERT INTO app.opportunity
      (tenant_id, id, owner_user_id, contact_id, pipeline_id, stage_id,
       current_stage_type, created_from, stage_entered_at)
    SELECT ${TENANT}, ${OPP}, ${ANA}, ${CONTACT}, p.id, ${OPEN_STAGE},
           'open', 'manual', clock_timestamp()
      FROM app.pipeline p WHERE p.tenant_id = ${TENANT}`
})

afterAll(async () => {
  await sql?.end()
})

describe('nobody can write the timeline directly', () => {
  it('gives crm_app no privilege on the table at all', async () => {
    // ARR-EVT-22 as a fact about PERMISSIONS rather than a rule in a document:
    // "nobody writes timeline rows directly". `definer_only` grants nothing.
    const grants = await sql<{ privilege_type: string }[]>`
      SELECT DISTINCT privilege_type FROM information_schema.role_table_grants
       WHERE table_schema = 'app' AND table_name = 'timeline_entry' AND grantee = 'crm_app'`
    expect(grants).toHaveLength(0)
  })

  it('gives crm_app no column privilege on actor_user_id, through any path', async () => {
    // 🎯 §10.8's whole point. The timeline says WHO without leaking who: the
    // seller sees "you" / "system" / "previous owner" and never a colleague's
    // name. `harden()` can restrict columns on UPDATE and has no equivalent for
    // SELECT, which is exactly why the class had to be `definer_only` rather
    // than the `owner_scoped` 05b originally specified.
    const cols = await sql<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.column_privileges
       WHERE table_schema = 'app' AND table_name = 'timeline_entry' AND grantee = 'crm_app'`
    expect(cols).toHaveLength(0)

    // And the view that exists for everything else does not carry it either.
    const viewCols = await sql<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'app' AND table_name = 'timeline_entry_live'
         AND column_name = 'actor_user_id'`
    expect(viewCols).toHaveLength(0)
  })

  it('refuses identity smuggled into render_payload', async () => {
    // The privilege above is defeated by moving a name into the JSON. The CHECK
    // names the keys, so that route is closed too.
    await expect(
      sql`
        INSERT INTO app.timeline_entry
          (tenant_id, contact_id, owner_user_id, occurred_at, kind, ref_type, ref_id,
           render_payload, built_from_event_id)
        VALUES (${TENANT}, ${CONTACT}, ${ANA}, clock_timestamp(), 'note', 'x',
                gen_random_uuid(), '{"actor_display_name":"Ben T."}'::jsonb,
                gen_random_uuid())`,
    ).rejects.toThrow(/timeline_no_actor_in_payload/)
  })
})

describe('a stage move becomes ONE entry, enriched by the sale', () => {
  it('projects the move and the win into a single row', async () => {
    await move(WON_STAGE, 120_000n)
    await relayOnce()

    const [row] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM app.timeline_entry
       WHERE tenant_id = ${TENANT} AND contact_id = ${CONTACT}`

    // 🎯 ONE, NOT TWO. `app.stage_move` emits `opportunity.stage_changed` AND
    // `opportunity.won` for the same drag, and 0054 gives both the same
    // correlation id precisely so a consumer can tie them together. The
    // projector refs on that correlation, so the seller reads one line — "moved
    // to Closed Won, $1,200.00" — instead of two a millisecond apart each
    // carrying half of it.
    expect(row?.n).toBe(1)

    const entries = await readTimeline(ANA, CONTACT)
    expect(entries).toHaveLength(1)
    expect(entries[0]?.kind).toBe('stage_move')

    // The merge is what carried the money across: `stage_changed` has no
    // premium field of its own on this path, and `won` does.
    expect(entries[0]?.render_payload['to_stage_name']).toBe('Closed Won')
    expect(entries[0]?.render_payload['deal_value_annual_premium']).toBe('120000')
  })

  it('adds a SECOND entry for a second move, rather than merging them', async () => {
    // The ref is the correlation and not the opportunity, and this is why: a
    // ref on the opportunity would merge every move that card ever made into
    // one row, and a lead that moved five times would read as one line.
    await move(OPEN_STAGE, null)
    await relayOnce()

    const [row] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM app.timeline_entry
       WHERE tenant_id = ${TENANT} AND contact_id = ${CONTACT}`
    expect(row?.n).toBe(2)
  })

  it('is idempotent: replaying the same events adds nothing', async () => {
    // §2722's L2 assertion, in miniature: "replaying the entire event_log twice
    // against a live system produces … zero new timeline rows." What makes it
    // true is the natural key, not the relay's bookkeeping.
    const before = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM app.timeline_entry WHERE tenant_id = ${TENANT}`

    await sql`
      UPDATE app.event_outbox SET status = 'pending', claimed_at = NULL, attempts = 0
       WHERE tenant_id = ${TENANT} AND consumer_name = 'contacts'`
    await relayOnce()

    const after = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM app.timeline_entry WHERE tenant_id = ${TENANT}`
    expect(after[0]?.n).toBe(before[0]?.n)
  })

  it('orders by when the thing HAPPENED, not by when it was projected', async () => {
    // `occurred_at` had to be added to the relay's Delivery for this. A
    // projector stamping `clock_timestamp()` would rebuild a replayed timeline
    // in the order we happened to replay it, which is the one thing a history
    // must not do.
    const rows = await sql<{ occurred_at: Date; built_at: Date }[]>`
      SELECT occurred_at, built_at FROM app.timeline_entry
       WHERE tenant_id = ${TENANT} ORDER BY occurred_at`
    expect(rows.length).toBeGreaterThan(1)
    for (const row of rows) {
      expect(row.occurred_at.getTime()).toBeLessThanOrEqual(row.built_at.getTime())
    }
  })
})

describe('the read is owner-scoped and says who without naming them', () => {
  it('labels the reader as "you" and never returns a name', async () => {
    const entries = await readTimeline(ANA, CONTACT)
    expect(entries[0]?.actor_label_key).toBe('timeline.actor.you')

    // The key is a catalog key, not a rendered phrase: §10.8 routes it through
    // the ICU string catalog, and 'timeline.actor.previous_owner' maps to a
    // string a snapshot test is allowed to break the build over.
    for (const entry of entries) {
      expect(entry.actor_label_key).toMatch(/^timeline\.actor\./)
    }
  })

  it('returns an EMPTY timeline for another seller’s contact, not a refusal', async () => {
    // 🎯 Owner-scoped not-found reaching the projection. Ben asking about his
    // own contact gets nothing because nothing happened there; Ben asking about
    // Ana's contact gets the same nothing. A different answer for "not yours"
    // would confirm the record exists.
    const bensOwn = await readTimeline(BEN, BENS_CONTACT)
    const anas = await readTimeline(BEN, CONTACT)

    expect(anas).toEqual([])
    expect(anas).toEqual(bensOwn)

    // The positive control: the same call as Ana is not empty, so this is
    // scoping rather than a read that never returns anything.
    expect((await readTimeline(ANA, CONTACT)).length).toBeGreaterThan(0)
  })
})

describe('the 60-second window applies to send_blocked and nothing else', () => {
  it('keeps ONE entry per verdict per contact per bucket', async () => {
    // The governing sentence, as two tables. `audit_log` gets a row per attempt
    // — asserted in dial-gate.test.ts — and the timeline gets one per window,
    // because a seller reading fifty identical "blocked" lines learns less than
    // one line, not more.
    //
    // Driven through the writer directly: `compliance.send_blocked` has no
    // emitter yet, so this is the only way to exercise the window today. Said
    // rather than hidden — the projector path for this kind is unreachable
    // until the gate emits.
    const at = new Date()
    const upsert = async (): Promise<void> => {
      await withTenant({ tenantId: TENANT, userId: ANA }, async (tx) => {
        await tx.execute(raw`
          SELECT app.timeline_upsert(
            ${CONTACT}::uuid, ${ANA}::uuid, ${at.toISOString()}::timestamptz,
            'send_blocked'::app.timeline_kind, 'contact_phone', gen_random_uuid(),
            '{}'::jsonb, gen_random_uuid(), ${ANA}::uuid,
            'blocked_suppressed'::app.gate_verdict)`)
      })
    }

    await upsert()
    await upsert()
    await upsert()

    const [row] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM app.timeline_entry
       WHERE tenant_id = ${TENANT} AND kind = 'send_blocked'`
    expect(row?.n).toBe(1)
  })

  it('refuses a send_blocked entry with no verdict', async () => {
    // 🔴 NULLS ARE DISTINCT IN A UNIQUE INDEX. A `send_blocked` row with a NULL
    // verdict conflicts with nothing, the window silently stops deduplicating,
    // and the timeline fills with one entry per attempt — looking correct right
    // up until somebody counts. The refusal is what makes the omission
    // impossible rather than remembered.
    await expect(
      withTenant({ tenantId: TENANT, userId: ANA }, async (tx) => {
        await tx.execute(raw`
          SELECT app.timeline_upsert(
            ${CONTACT}::uuid, ${ANA}::uuid, clock_timestamp(),
            'send_blocked'::app.timeline_kind, 'contact_phone', gen_random_uuid(),
            '{}'::jsonb, gen_random_uuid(), ${ANA}::uuid, NULL)`)
      }),
    ).rejects.toThrow()
  })
})
