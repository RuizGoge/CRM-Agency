/**
 * The card's health, decay and signal — ONE computation, three screens.
 *
 * `04b` §1253 rules that `health` is a **server-computed enum on the card
 * payload so the board, My Book and My Day are byte-identical**, and §2.8 gives
 * the reason in a sentence: three screens deciding separately are three answers
 * to a question the seller asks once. "Is this lead going cold" cannot be true
 * on the board and false in My Book.
 *
 * WHY IT LIVES HERE AND NOT IN THE ROUTE. It was inside
 * `app/routes/api/board.ts`, which imports `~/db` and `~/lib/auth` — so the
 * moment a second surface needed it, importing it would have dragged postgres,
 * drizzle and better-auth into the client bundle. That is not hypothetical:
 * `client-server-boundary.test.ts` exists BECAUSE it happened, twice, and its
 * failure message names this exact remedy — "move it to `app/lib/**`, which
 * imports nothing from the server".
 *
 * Everything below is verbatim from the route it came out of, comments
 * included, because the comments carry the rulings.
 *
 * IT ALSO CARRIES THE NEW CLOCK, which arrived on a branch while this module
 * was being extracted on another. `~/lib/board/tick` is where the shared
 * one-second tick and the `mm:ss` formatter live; both sides are under
 * `app/lib/**`, so this import is exactly what the boundary gate permits and
 * the reason the extraction happened in the first place.
 */

import { FRESH_WINDOW_SECONDS, mmss } from '~/lib/board/tick'

/** `blocked` is declared and never produced yet — see the note in `healthOf`. */
export type CardHealth = 'blocked' | 'overdue' | 'fresh' | 'going_cold' | 'ok'

export interface CardSignal {
  readonly kind: 'fresh' | 'overdue' | 'going_cold' | 'no_next_step'
  /** The ≤16-character card face (§2.7). */
  readonly chip: string
  /** R11's full sentence, for the accessible name and the tooltip (§2.7). */
  readonly full: string
  /**
   * The lead's age in seconds when the server rendered this, or `null` for a
   * signal that does not move.
   *
   * The client adds its own elapsed time to this rather than reading a
   * timestamp off its own clock. A seller whose machine is three minutes fast
   * would otherwise open the board to `NEW 03:00` on a lead that arrived a
   * moment ago — and speed-to-lead is *"the one number that justifies the lead
   * spend"* (ruling R), so it is the last number allowed to be approximately
   * right.
   */
  readonly tickFromSeconds: number | null
}

/** What the three derivations below need, and nothing else. */
export interface HealthInput {
  readonly stage_type: 'open' | 'earning' | 'lost'
  readonly days_untouched: number
  readonly attempts: number
  readonly next_activity: string | null
  readonly seconds_since_arrival: number
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
export function signalsSuppressed(row: HealthInput): boolean {
  return row.stage_type !== 'open'
}

/**
 * The rail's health, by the precedence in §2.8: `blocked` > `overdue` >
 * `fresh` > `going_cold` > `ok`.
 *
 * `blocked` is absent by construction, not by omission — it means STOP, DNC or
 * a bad number and nothing in this tree can decide those yet.
 */
export function healthOf(row: HealthInput): CardHealth {
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
  if (isFresh(row)) return 'fresh'
  if (row.days_untouched >= row.cold_threshold_days) return 'going_cold'
  return 'ok'
}

/**
 * The fresh gate, in ONE place because two derivations read it — the rail in
 * §2.8 and the signal slot in §2.7 — and they had drifted apart once already.
 *
 * ⚠️ `attempts === 0` IS NOT THE GATE THE CORPUS RATIFIES, and this is the
 * honest note rather than a silent substitution. `04b` §2.7 conditions the chip
 * on `first_touch_at IS NULL`, and Part I ruling **R** is explicit about the
 * difference: *"the `NEW · mm:ss` clock keeps ticking until `call.completed`
 * lands with a `connected` or `voicemail` outcome"*, and §2.7 spells out the
 * case this gets wrong — *"a no-answer dial increments attempts and the clock
 * keeps running"*.
 *
 * So a seller who dials and gets no answer loses the chip here and should not.
 * The reason is not a shortcut: there is no `first_touch_at` column.
 * `opportunity.first_touch_latency_seconds` is a derived duration, not the
 * timestamp the gate needs.
 *
 * ⚠️ RE-CHECK THIS NOW THAT PUERTA 2 IS IN. It was blocked on `call.completed`
 * having nowhere to come from; the webhook ingest that lands it is on master as
 * of this merge, so the column this gate wants may now be buildable.
 */
function isFresh(row: HealthInput): boolean {
  return row.attempts === 0 && row.seconds_since_arrival < FRESH_WINDOW_SECONDS
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
export function decayOf(row: HealthInput): number {
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
export function signalOf(row: HealthInput): CardSignal | null {
  if (signalsSuppressed(row)) return null

  if (isFresh(row)) {
    // The clock a browser then advances. Both strings are rendered here at the
    // age the SERVER measured, so the client's first render — which adds zero —
    // produces the same characters and hydration is silent.
    const clock = mmss(row.seconds_since_arrival)
    return {
      kind: 'fresh',
      chip: `NEW ${clock}`,
      full: `New — ${clock} since arrival`,
      // The only signal that moves on its own. Everything else is measured in
      // hours or days and would be lying about its precision if it ticked.
      tickFromSeconds: row.seconds_since_arrival,
    }
  }

  if (row.overdue_minutes !== null) {
    const age = humanAge(row.overdue_minutes)
    return {
      kind: 'overdue',
      chip: `Due ${age} ago`,
      full: `Due ${age} ago`,
      tickFromSeconds: null,
    }
  }

  if (row.days_untouched >= row.cold_threshold_days) {
    return {
      kind: 'going_cold',
      chip: `Going cold · ${row.days_untouched}d`,
      full: `Going cold — ${row.days_untouched} days since last touch`,
      tickFromSeconds: null,
    }
  }

  // Lowest priority, and never a rail state: §2.8 says it coexists with every
  // health value, so it is a slot entry only.
  if (row.next_activity === null) {
    return {
      kind: 'no_next_step',
      chip: 'No next step',
      full: 'No next step',
      tickFromSeconds: null,
    }
  }

  return null
}

/** `25 min` · `3 h` · `2 d`, so the chip stays inside sixteen characters. */
function humanAge(minutes: number): string {
  if (minutes < 60) return `${minutes} min`
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)} h`
  return `${Math.floor(minutes / (60 * 24))} d`
}
