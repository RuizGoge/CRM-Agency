/**
 * The My Book chip — one chip per contact, computed on the server.
 *
 * `04b` §1253 and `04-ux-flows.md` §673 agree on the rule that matters: one
 * computed field feeds My Book, the card face and My Day so all three are
 * byte-identical. "Is this lead going cold" cannot be true on the board and
 * false in the book.
 *
 * ⚠️ THE PHASE-4 TABLE THIS COMES FROM CONTAINS STRUCK TEXT, and following it
 * literally would have re-introduced a design two rulings deleted. Its rows say:
 *
 *   * `days_since_touch >= 2 × cold_threshold_days — default 14` → a second,
 *     redder tier. That is the TWO-THRESHOLD model **R6 deleted** and **R1.7**
 *     replaced with one sentence: *"One threshold: `cold_threshold_days`,
 *     default 7, configurable. There is no separate 'rot' threshold."*
 *     Migration 0025 already dropped the column and the CHECK that encoded it.
 *   * the amber flag spelled with the word **R11 bans**, which
 *     `one-decay-threshold.test.ts` greps this whole tree for.
 *
 * CLAUDE.md is explicit that Part I rulings outrank Phase 2–4, so neither is
 * implemented here. What survives from that table is implemented exactly.
 */

/** What the chip needs, and nothing else. */
export interface BookChipInput {
  /** Days since the last HUMAN touch, or null when the contact has never been worked. */
  readonly daysSinceHumanTouch: number | null
  /** Open opportunities on this contact. */
  readonly openDeals: number
  /** Opportunities in a stage whose `stage_type` is `earning`. */
  readonly wonDeals: number
  /** Opportunities of any kind, so "no open deal" is distinguishable from "never had one". */
  readonly totalDeals: number
  readonly coldThresholdDays: number
}

export type BookChipKind = 'uncalled' | 'client' | 'no_open_deal' | 'going_cold' | 'working'

export interface BookChip {
  readonly kind: BookChipKind
  /** en-US, and short: this renders in a 48px table row and a 72px list row. */
  readonly label: string
}

/**
 * Precedence, highest first: client → uncalled → no open deal → going cold →
 * working.
 *
 * `client` outranks everything because it is a fact about the relationship
 * rather than about the work: a client who has not been touched in nine days is
 * still a client, and labelling them `Uncalled` would read as a reproach for
 * work that is finished. §2.7 makes the same call on the card face, where decay
 * signals are suppressed entirely on `earning` and `lost` stages.
 *
 * `uncalled` outranks decay for the reason `04-ux-flows.md` gives directly: the
 * onboarding import creates contacts and deliberately creates no
 * opportunities, so a 400-row book must not become 400 instantly-decaying rows.
 * Never worked is a different state from neglected, and only one of them is the
 * seller's fault.
 */
export function bookChipOf(row: BookChipInput): BookChip {
  if (row.wonDeals > 0) return { kind: 'client', label: 'Client' }

  if (row.daysSinceHumanTouch === null) return { kind: 'uncalled', label: 'Uncalled' }

  if (row.openDeals === 0) return { kind: 'no_open_deal', label: 'No open deal' }

  // ONE threshold. See the note at the top of this file for the two-tier design
  // that used to sit here in the Phase-4 table and no longer exists anywhere.
  if (row.coldThresholdDays > 0 && row.daysSinceHumanTouch >= row.coldThresholdDays) {
    return { kind: 'going_cold', label: `Going cold · ${row.daysSinceHumanTouch}d` }
  }

  return { kind: 'working', label: `${row.daysSinceHumanTouch}d since touch` }
}

/**
 * ⚠️ NOT IMPLEMENTED, and named rather than silently skipped.
 *
 * The same table offers `Callback due` and `No answer` for a contact worked
 * inside the threshold. Both need data this tree does not have yet: a
 * future-dated scheduled callback, and a call outcome. `working` stands in for
 * both, and the day the activity outcome lands this is the function that grows
 * the two branches — not a second chip computed somewhere else.
 */
export const UNIMPLEMENTED_CHIPS = ['callback_due', 'no_answer'] as const
