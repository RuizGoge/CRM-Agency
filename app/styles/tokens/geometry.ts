/**
 * Board geometry the VIRTUALIZER does arithmetic on.
 *
 * These numbers already exist twice — as CSS custom properties in
 * `theme.css`/`reset.css`, and pinned in `ref.ci_ratchet` under
 * `ui.card_h_desktop` / `ui.card_h_mobile` with the `pinned` arm. This is the
 * third representation, and it exists for one reason: the column window is
 * computed in JavaScript, and `04b` §2.1 forbids the virtualizer from reading
 * layout to find out how tall a card is.
 *
 *   > "Offsets become integer arithmetic. `topOfCard(i) = i × pitch`. The
 *   > virtualizer never calls `getBoundingClientRect()`, never mounts a
 *   > `ResizeObserver`, and never reads layout inside a `pointermove` handler.
 *   > Layout reads in the drag path are the single most common cause of a
 *   > dropped frame, and a fixed pitch removes the *reason* to read."
 *
 * A third copy of a number is a drift hazard, so it is treated the way this
 * project treats the undo window's four copies: `tests/integration/card-height.test.ts`
 * compares all three by VALUE — never by name, per errata E7/NEW-1 — and goes
 * red if any one of them moves alone. The failure that guards against is not a
 * card that looks wrong: it is a virtualizer dividing by 120 while the browser
 * renders 156, which puts every card in a mobile column at the wrong offset and
 * leaves gaps a seller reads as missing leads.
 *
 * The alternative considered and rejected was reading `--card-h` off the
 * computed style at mount. It cannot drift, but it needs a float parse of a CSS
 * string, and the parse helpers are banned outside `app/lib/money/**` — reaching
 * for the member-expression spelling to slip past that selector would be
 * evading a guard rather than satisfying one.
 */

/** Ruling N17, desktop. `--size-card-h` in theme.css. */
export const CARD_H_DESKTOP_PX = 120

/** Ruling N17, below the density breakpoint. `--size-card-h-mobile`. */
export const CARD_H_MOBILE_PX = 156

/**
 * The gap between two cards in a column — `--space-2`, 0.5rem at the 16px root.
 *
 * Part of the PITCH and not decoration: `pitch = card height + gap` is the
 * number every offset in the window is a multiple of, so this belongs next to
 * the heights rather than being remembered separately by whoever writes the
 * next spacer.
 */
export const CARD_GAP_PX = 8

/** `topOfCard(i) = i × cardPitchPx(...)`. The whole of the virtualizer's maths. */
export function cardPitchPx(mobile: boolean): number {
  return (mobile ? CARD_H_MOBILE_PX : CARD_H_DESKTOP_PX) + CARD_GAP_PX
}
