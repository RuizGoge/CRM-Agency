import { sql } from 'drizzle-orm'

import { withTenant, type SessionIdentity } from '~/db'
import { requireIdentity } from '~/lib/auth/identity'
import { decayOf, healthOf, signalOf } from '~/lib/card-health/card-health'
import { jsonConditional } from '~/lib/http/conditional'
import type { CardHealth, CardSignal } from '~/lib/card-health/card-health'
import { defineEndpoint } from '~/lib/endpoint/define'

/**
 * The pipeline board.
 *
 * Money leaves as a string of whole cents, like everywhere else. The card
 * carries the three things Phase 1 found sellers actually scan for — value,
 * days untouched, and what happens next — and nothing else.
 */

export interface BoardCard {
  readonly id: string
  readonly contactName: string
  /**
   * The contact behind the card, so opening the record needs no second lookup.
   *
   * Nullable because the join is a LEFT JOIN and always was: an opportunity can
   * outlive its contact row, and the card already renders `Unnamed lead` for
   * that case. A card with no contact cannot open a record and must not offer
   * to — which is why this is `string | null` rather than a string the UI
   * would have to guess about.
   */
  readonly contactId: string | null
  readonly premiumCents: string | null
  readonly daysUntouched: number
  /**
   * Dial attempts on this deal — element ⑤ of the card anatomy, and half of
   * the fact `04b` §2.4 says is *"the only thing between this floor and a
   * harassment claim"*. Rendered as `3 attempts`; zero replaces the whole line
   * with `Not called yet`, which is a different sentence and not a `0`.
   */
  readonly attempts: number
  readonly nextActivity: string | null
  /**
   * The health rail — `04b` §2.8, and **server-computed on purpose**: the
   * board, My Book and My Day must be byte-identical about whether a lead is
   * decaying, and three screens each deciding for themselves is three answers.
   *
   * Precedence, highest first: `blocked` > `overdue` > `fresh` > `going_cold`
   * > `ok`. `blocked` is NOT produced yet — it means STOP, DNC or a bad
   * number, and the compliance gate that decides those needs Aloware. It is in
   * the type because leaving it out would make adding it a change to every
   * consumer instead of one new arm here.
   */
  readonly health: CardHealth
  /**
   * How far this card has decayed toward the threshold, 0..1 — the rail's FILL
   * fraction. §2.8: *"the rail is a two-signal gradient, not a colour"*, so a
   * card at day 5 of 7 already shows most of a rail rather than nothing at
   * all, and a seller sees decay coming instead of arriving.
   *
   * Computed here because it is a ratio of a lead's age to a TENANT SETTING,
   * and the client has no business knowing either number.
   */
  readonly decay: number
  /**
   * The signal slot — §2.4 element ④ and §2.7. **Exactly one, or none.**
   *
   * Not the same list as `health`, and the difference is the point:
   * `no_next_step` is never a rail state because it coexists with every health
   * value, and `going_cold` is both. Two vocabularies for two jobs.
   */
  readonly signal: CardSignal | null
}

/** `blocked` is declared and never produced yet — see `BoardCard.health`. */

export interface BoardColumn {
  readonly id: string
  readonly name: string
  readonly stageType: 'open' | 'earning' | 'lost'
  readonly cards: readonly BoardCard[]
  /** Whole cents. Summed by the database, never in the client. */
  readonly totalCents: string
}

export type { CardHealth, CardSignal } from '~/lib/card-health/card-health'

export interface PipelinePayload {
  readonly columns: readonly BoardColumn[]
}

export async function readPipeline(request: Request): Promise<PipelinePayload> {
  return readPipelineFor(await requireIdentity(request))
}

/**
 * The read with the request seam removed, so the health suite exercises THIS
 * SQL and these derivations rather than a test-local copy that would agree
 * with itself whatever shipped.
 */
export async function readPipelineFor(identity: SessionIdentity): Promise<PipelinePayload> {
  return withTenant(identity, async (tx) => {
    const stages = await tx.execute<{
      id: string
      name: string
      stage_type: 'open' | 'earning' | 'lost'
    }>(sql`
      SELECT id, name, stage_type::text AS stage_type
      FROM app.stage
      WHERE tenant_id = app.current_tenant()
        AND owner_user_id = app.current_user_id()
        AND deleted_at IS NULL
      ORDER BY sort_order`)

    const cards = await tx.execute<{
      id: string
      stage_id: string
      stage_type: 'open' | 'earning' | 'lost'
      contact_name: string
      contact_id: string | null
      premium_cents: string | null
      days_untouched: number
      attempts: number
      next_activity: string | null
      seconds_since_arrival: number
      overdue_minutes: number | null
      cold_threshold_days: number
    }>(sql`
      SELECT o.id,
             o.stage_id,
             s.stage_type::text AS stage_type,
             coalesce(c.full_name, 'Unnamed lead') AS contact_name,
             -- Read from the CONTACT row, not from o.contact_id. RLS scopes the
             -- join, so a contact the seller cannot see comes back NULL here
             -- and the card offers no way in — rather than rendering a link
             -- that answers not-found, which is a slower way of telling
             -- somebody a record exists.
             c.id AS contact_id,
             o.premium_annual_cents::text AS premium_cents,
             greatest(0, extract(day from clock_timestamp()
               - coalesce(o.last_activity_at, o.stage_entered_at))::integer) AS days_untouched,
             o.attempt_count AS attempts,
             -- The lead's own age, for the NEW clock. Distinct from
             -- days_untouched: a lead that arrived an hour ago and was never
             -- worked is FRESH, not decaying, and the two must never share a
             -- number.
             --
             -- SECONDS, not minutes, since the chip renders mm:ss and the
             -- client ticks forward from this. Rounded DOWN, so the first
             -- second the browser adds moves it to a value the server would
             -- also have produced — rounding to nearest would make the chip
             -- read one second ahead of the lead's real age for half of them.
             greatest(0, floor(extract(epoch from clock_timestamp() - o.created_at))::integer)
               AS seconds_since_arrival,
             -- The MOST overdue open activity, in minutes. NULL when nothing
             -- is past due; a future-dated activity is not lateness.
             (SELECT greatest(0, (extract(epoch from clock_timestamp() - a.due_at) / 60)::integer)
                FROM app.activity a
               WHERE a.tenant_id = o.tenant_id AND a.opportunity_id = o.id
                 AND a.completed_at IS NULL AND a.canceled_at IS NULL
                 AND a.due_at < clock_timestamp()
               ORDER BY a.due_at LIMIT 1) AS overdue_minutes,
             (SELECT a.title FROM app.activity a
               WHERE a.tenant_id = o.tenant_id AND a.opportunity_id = o.id
                 AND a.completed_at IS NULL AND a.canceled_at IS NULL
               ORDER BY a.due_at LIMIT 1) AS next_activity,
             -- THE ONE DECAY THRESHOLD (R1.7). Read per row from the tenant so
             -- an admin changing it moves every card on the next render, which
             -- is what "derived at render time" means in the flow table.
             t.cold_threshold_days
      FROM app.opportunity_live o
      JOIN app.stage s ON s.tenant_id = o.tenant_id AND s.id = o.stage_id
      JOIN app.tenant t ON t.id = o.tenant_id
      LEFT JOIN app.contact c ON c.tenant_id = o.tenant_id AND c.id = o.contact_id
      WHERE o.tenant_id = app.current_tenant()
        AND o.owner_user_id = app.current_user_id()
      ORDER BY o.stage_entered_at DESC`)

    const byStage = new Map<string, BoardCard[]>()
    const totals = new Map<string, bigint>()

    for (const row of cards) {
      const list = byStage.get(row.stage_id) ?? []
      list.push({
        id: row.id,
        contactName: row.contact_name,
        contactId: row.contact_id,
        premiumCents: row.premium_cents,
        daysUntouched: row.days_untouched,
        attempts: row.attempts,
        nextActivity: row.next_activity,
        health: healthOf(row),
        decay: decayOf(row),
        signal: signalOf(row),
      })
      byStage.set(row.stage_id, list)
      // Summed as BigInt, never as a float, and never on the client.
      totals.set(row.stage_id, (totals.get(row.stage_id) ?? 0n) + BigInt(row.premium_cents ?? '0'))
    }

    return {
      columns: [...stages].map((s) => ({
        id: s.id,
        name: s.name,
        stageType: s.stage_type,
        cards: byStage.get(s.id) ?? [],
        totalCents: (totals.get(s.id) ?? 0n).toString(),
      })),
    }
  })
}

/**
 * The board's payload, with the running clock taken out.
 *
 * WITHOUT THIS THE BOARD COULD NEVER ANSWER A 304. `tickFromSeconds` and the
 * `NEW mm:ss` strings move every second, so the serialized body differs on
 * every poll whether or not a single card changed — and a conditional GET whose
 * tag always differs is strictly more work than none.
 *
 * Dropping them from the TAG is only safe because the clock ticks in the
 * browser: a client holding a 304 keeps counting from the value it already has,
 * which is the number it should be showing anyway. Everything a client cannot
 * re-derive for itself stays in — `signal.kind` included, so a card crossing
 * the fresh window still changes the tag and still gets re-sent.
 */
function etagSourceOf(payload: PipelinePayload): unknown {
  return {
    columns: payload.columns.map((column) => ({
      ...column,
      cards: column.cards.map((card) =>
        card.signal === null || card.signal.tickFromSeconds === null
          ? card
          : { ...card, signal: { ...card.signal, chip: '', full: '', tickFromSeconds: 0 } },
      ),
    })),
  }
}

export async function loader({ request }: { request: Request }): Promise<Response> {
  // Conditional GET, which this route did not have. The board is one of the
  // three surfaces `04b` §4.9 puts on a poll — 15 s for board deltas — and it
  // answered a full 200 with a database round trip and a full serialization
  // every time, which is the opposite of what §1183's cost model assumes.
  const payload = await readPipeline(request)
  return jsonConditional(request, payload, etagSourceOf(payload))
}

/**
 * The pipeline board. The one anchor surface, and the widest owner-scoped read
 * in the product.
 */
export const endpoint = defineEndpoint({
  method: 'GET',
  path: '/api/board',
  role: 'web',
  audience: 'owner',
  scope: 'owner',
  surface: 'json',
  summary: 'The seller own kanban board, with card health computed server-side.',
  // The board payload carries the NEW clock's starting second, so a tag over
  // the body would be fresh on every poll forever. jsonConditional takes a
  // projection for exactly this surface.
  etag: {
    kind: 'custom',
    reason: 'tag is over a projection, not the body: the NEW clock ticks in the payload',
  },
  siloProbe: { kind: 'listing', canary: true },
})
