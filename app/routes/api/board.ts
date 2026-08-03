import { sql } from 'drizzle-orm'

import { withTenant, type SessionIdentity } from '~/db'
import { requireIdentity } from '~/lib/auth/identity'

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
export type CardHealth = 'blocked' | 'overdue' | 'fresh' | 'going_cold' | 'ok'

export interface CardSignal {
  readonly kind: 'fresh' | 'overdue' | 'going_cold' | 'no_next_step'
  /** The ≤16-character card face (§2.7). */
  readonly chip: string
  /** R11's full sentence, for the accessible name and the tooltip (§2.7). */
  readonly full: string
}

export interface BoardColumn {
  readonly id: string
  readonly name: string
  readonly stageType: 'open' | 'earning' | 'lost'
  readonly cards: readonly BoardCard[]
  /** Whole cents. Summed by the database, never in the client. */
  readonly totalCents: string
}

export interface PipelinePayload {
  readonly columns: readonly BoardColumn[]
}

/** What the three derivations below need, and nothing else. */
interface HealthInput {
  readonly stage_type: 'open' | 'earning' | 'lost'
  readonly days_untouched: number
  readonly attempts: number
  readonly next_activity: string | null
  readonly minutes_since_arrival: number
  readonly overdue_minutes: number | null
  readonly cold_threshold_days: number
}

/**
 * MVP item 32, non-negotiable, and it is one rule doing all the work.
 *
 * §2.7: signals are *"never rendered on a card in an `earning` or `lost`
 * stage"*. A won deal is not going cold and a lost one cannot be saved, so a
 * decay chip there is noise attached to a card nobody is working — and §2.7
 * gives the consequence in one sentence: *"otherwise every card is amber on
 * the first Monday and the signal becomes wallpaper."*
 *
 * The second half of that rule — never on imported cards never worked
 * (`imported_at != null && attempt_count = 0`) — is NOT implemented, because
 * `imported_at` arrives with the intake module. Said here rather than silently
 * half-applied: the day a CSV import lands, a thousand untouched cards go
 * amber at once unless this function grows that clause.
 */
function signalsSuppressed(row: HealthInput): boolean {
  return row.stage_type !== 'open'
}

/**
 * The rail's health, by the precedence in §2.8: `blocked` > `overdue` >
 * `fresh` > `going_cold` > `ok`.
 *
 * `blocked` is absent by construction, not by omission — it means STOP, DNC or
 * a bad number and nothing in this tree can decide those yet.
 */
function healthOf(row: HealthInput): CardHealth {
  if (row.overdue_minutes !== null) return 'overdue'

  // ⚠️ A READING OF A SILENCE, not a ruling, and flagged as such. §2.7
  // suppresses SIGNALS on `earning` and `lost` stages and §2.8 says nothing
  // about the rail — so a closed-won card was rendering a blue `fresh` rail,
  // found by looking at the board. Both of these states are about WORKING a
  // lead: a won deal is not a fresh lead needing a dial and a lost one is not
  // going cold, so on the money column that rail is misinformation.
  //
  // `overdue` deliberately survives the same suppression, and stays above this
  // line: an activity past due on a closed deal is still something the seller
  // owes somebody. A verdict about obligation is not a verdict about decay.
  if (row.stage_type !== 'open') return 'ok'

  // Fresh is about the LEAD's age and about never having been worked. A lead
  // that arrived twenty minutes ago and has been dialled twice is not fresh —
  // it is a lead somebody is already on.
  if (row.attempts === 0 && row.minutes_since_arrival < 60) return 'fresh'
  if (row.days_untouched >= row.cold_threshold_days) return 'going_cold'
  return 'ok'
}

/**
 * How full the going-cold rail is drawn, 0..1.
 *
 * §2.8 is explicit that this is *"a two-signal gradient, not a colour"*: below
 * the threshold the rail fills from the top at `days_since_touch ÷
 * cold_threshold_days`, and at or above it the fill is complete. R6 deleted
 * the two boundaries and kept the gradient — which is what the old two-tier
 * design was actually buying.
 *
 * Zero for anything not decaying, so the rail draws its own state and never a
 * fraction of somebody else's.
 */
function decayOf(row: HealthInput): number {
  if (signalsSuppressed(row) || row.cold_threshold_days <= 0) return 0
  if (row.days_untouched <= 0) return 0
  return Math.min(1, row.days_untouched / row.cold_threshold_days)
}

/**
 * EXACTLY ONE SIGNAL, or none — §2.4 element ④.
 *
 * Precedence, highest first: recent contact (R3) → fresh → overdue → going
 * cold → needs reply → no next step. Two of those six cannot fire yet and
 * both are named where they are missing rather than quietly skipped:
 *
 *   * **recent contact** is priority 1 by design, because ping-post sells the
 *     same consumer to two sellers in the same hour and the moment it matters
 *     is the moment a seller decides to dial. It needs tenant-wide call
 *     history — Aloware. Its absence is the one gap here that costs something
 *     real rather than cosmetic.
 *   * **needs reply** needs inbound SMS.
 *
 * Two renderings per signal, which §2.7 ratifies as one concept: a ≤16
 * character `chip` for a 264px card face, and R11's full sentence for the
 * accessible name and the tooltip. The word R11 bans appears in neither, and
 * is not spelled here either: `one-decay-threshold.test.ts` enforces that ban
 * by grep across this tree, and a comment is exactly where it creeps back.
 */
function signalOf(row: HealthInput): CardSignal | null {
  if (signalsSuppressed(row)) return null

  if (row.attempts === 0 && row.minutes_since_arrival < 60) {
    const mm = String(Math.floor(row.minutes_since_arrival)).padStart(2, '0')
    return {
      kind: 'fresh',
      chip: `NEW ${mm}m`,
      full: `New — ${mm} minutes since arrival`,
    }
  }

  if (row.overdue_minutes !== null) {
    const age = humanAge(row.overdue_minutes)
    return { kind: 'overdue', chip: `Due ${age} ago`, full: `Due ${age} ago` }
  }

  if (row.days_untouched >= row.cold_threshold_days) {
    return {
      kind: 'going_cold',
      chip: `Going cold · ${row.days_untouched}d`,
      full: `Going cold — ${row.days_untouched} days since last touch`,
    }
  }

  // Lowest priority, and never a rail state: §2.8 says it coexists with every
  // health value, so it is a slot entry only.
  if (row.next_activity === null) {
    return { kind: 'no_next_step', chip: 'No next step', full: 'No next step' }
  }

  return null
}

/** `25 min` · `3 h` · `2 d`, so the chip stays inside sixteen characters. */
function humanAge(minutes: number): string {
  if (minutes < 60) return `${minutes} min`
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)} h`
  return `${Math.floor(minutes / (60 * 24))} d`
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
      premium_cents: string | null
      days_untouched: number
      attempts: number
      next_activity: string | null
      minutes_since_arrival: number
      overdue_minutes: number | null
      cold_threshold_days: number
    }>(sql`
      SELECT o.id,
             o.stage_id,
             s.stage_type::text AS stage_type,
             coalesce(c.full_name, 'Unnamed lead') AS contact_name,
             o.premium_annual_cents::text AS premium_cents,
             greatest(0, extract(day from clock_timestamp()
               - coalesce(o.last_activity_at, o.stage_entered_at))::integer) AS days_untouched,
             o.attempt_count AS attempts,
             -- The lead's own age, for the NEW clock. Distinct from
             -- days_untouched: a lead that arrived an hour ago and was never
             -- worked is FRESH, not decaying, and the two must never share a
             -- number.
             greatest(0, (extract(epoch from clock_timestamp() - o.created_at) / 60)::integer)
               AS minutes_since_arrival,
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

export async function loader({ request }: { request: Request }): Promise<Response> {
  const payload = await readPipeline(request)
  return new Response(JSON.stringify(payload), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'private, no-store',
    },
  })
}
