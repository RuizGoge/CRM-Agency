/**
 * Which cards a column mounts, as integer arithmetic over a fixed row pitch.
 *
 * `04b` §2.1 states the whole design in one line: *"Offsets become integer
 * arithmetic. The virtualizer never calls `getBoundingClientRect()`, never
 * mounts a `ResizeObserver`, and never reads layout inside a `pointermove`
 * handler. Layout reads in the drag path are the single most common cause of a
 * dropped frame, and a fixed pitch removes the REASON to read."*
 *
 * That is why ruling N17 fixed the card height as a foundation decision rather
 * than a component one, and why `05c` §10.7 B7(b) declares the failure
 * criterion in advance: *"If 120/156 cannot hold the mandated anatomy at 500
 * cards while meeting P6, the anatomy is cut, not the height. The height is what
 * makes the virtualization arithmetic true; the anatomy is negotiable and the
 * arithmetic is not."*
 *
 * NOTHING HERE POSITIONS ANYTHING. The rendered offsets are CSS `calc()` over
 * `--card-pitch`, so a card lands where the stylesheet says even if the numbers
 * below are wrong — a bad measurement can only pick the wrong cards to mount,
 * which the overscan absorbs and the R2-2 gate catches. Position and selection
 * are separated on purpose: one of them is allowed to be approximate.
 *
 * ⚠️ `04b` §2.1 publishes `topOfCard(i) = i × 120` and it is STALE. That 120 is
 * the pitch of a 112px card, which is the THIRD height the document carried and
 * the one finding C11 never looked at — C11 only weighed §3.6's 108/92 against
 * §1's 120/156, so N17 struck 108 and left 112 standing. With N17's 120px card
 * and `--space-2`, the real desktop pitch is 128 (§4.1's own "row stride =
 * 128 px"), and 164 on mobile. Copying §2.1's constant would misplace every card
 * by 8px, accumulating down the column: card 40 would sit 320px from where the
 * scroll container thinks it is.
 */

/**
 * Below this a column is plain DOM, per `04b` §2.1: *"columns virtualize above
 * 30 cards (D3's number, the strictest of the three, and already three screens
 * of content)"*.
 *
 * The demo tenant is far below it, which is why every existing board spec keeps
 * measuring the un-windowed path. That is a coverage hole, not a reassurance:
 * the two paths must agree on geometry, and only `perf-500` exercises the one
 * a real seller's book will use.
 */
export const VIRTUALIZE_ABOVE = 30

/**
 * Rows kept mounted beyond each edge of the viewport.
 *
 * `04b` §2.1 computes its window as `ceil(900 / pitch) + 2`, so its `+2` is the
 * TOTAL — one row above and one below, not two of each. Read as two-per-side it
 * doubles the overscan and walks the window straight through R2-2's ceiling on
 * a tall monitor.
 */
export const OVERSCAN_ROWS = 1

/**
 * `04b` §9 R2-2, restated by `05c` §10.6: *"> 28 DOM nodes per card, or > 14
 * cards rendered per column at any viewport"* breaks the build.
 *
 * ⚠️ "AT ANY VIEWPORT" IS NOT ACHIEVABLE BY ARITHMETIC, and saying so is
 * cheaper than a gate that quietly means something narrower. The window is
 * about `viewportH / pitch + 3`, so 14 holds up to a column viewport of roughly
 * 1400px and is exceeded above it — a 4K monitor at 100% zoom gets there. The
 * two ways out are both worse than the overflow: capping the window renders
 * fewer cards than fill the column, which is a visible band of empty space at
 * the bottom, and raising the number is weakening a budget. So the gate asserts
 * this at the viewports the profiles actually run, and the ceiling is written
 * down here rather than discovered by whoever first plugs in a big monitor.
 */
export const MAX_RENDERED_PER_COLUMN = 14

/**
 * What the SERVER renders, and what the client's FIRST render must reproduce.
 *
 * The server cannot know the viewport height, and it cannot know whether
 * `--card-h` resolves to 120 or 156 — that swap is a media query. So the first
 * render on both sides is this constant, and the measured window only takes over
 * in an effect. Any other choice is a hydration mismatch on the one screen this
 * project measures LCP and TTI against.
 *
 * Ten, because it is under R2-2's 14 and covers a 1080p column viewport at the
 * desktop pitch (~850px of column ÷ 128 ≈ 7). A taller monitor renders one
 * frame of a short column before the effect extends it.
 */
export const SSR_WINDOW = 10

/** A contiguous run of card indices: `[first, first + count)`. */
export interface CardWindow {
  readonly first: number
  readonly count: number
}

/**
 * The cards a column should mount at a given scroll offset.
 *
 * `pitch` and `viewportH` come from a measurement, so both are allowed to be
 * absent or nonsense. A pitch that did not resolve falls back to mounting the
 * WHOLE column: a board that is slow is a budget failure the gates will report,
 * and a board that is missing cards is a seller losing a lead. Those two are not
 * the same kind of wrong, so the fallback is not symmetric.
 */
export function windowFor(input: {
  readonly count: number
  readonly scrollTop: number
  readonly viewportH: number
  readonly pitch: number
}): CardWindow {
  const { count } = input
  if (count <= 0) return { first: 0, count: 0 }

  const pitch = Number.isFinite(input.pitch) ? input.pitch : 0
  if (pitch <= 0) return { first: 0, count }

  const viewportH = Number.isFinite(input.viewportH) ? Math.max(0, input.viewportH) : 0
  const raw = Number.isFinite(input.scrollTop) ? Math.max(0, input.scrollTop) : 0

  // CLAMPED TO THE END OF THE COLUMN, and this line is a defect the unit test
  // found rather than a precaution.
  //
  // Without it, a scroll offset past the content produced `first` beyond the
  // last index and a count of zero: A BLANK COLUMN. Overscroll bounce reports
  // that on iOS and macOS for a few frames, which would have looked like a
  // flicker — but the reachable version is worse and permanent. Drag a card out
  // of a column you have scrolled to the bottom of: the optimistic update
  // removes it, the content shrinks under the held scroll offset, and the
  // column the seller is looking at empties. Every card is still there and none
  // of them render.
  const maxScroll = Math.max(0, count * pitch - viewportH)
  const scrollTop = Math.min(raw, maxScroll)

  const first = Math.max(0, Math.floor(scrollTop / pitch) - OVERSCAN_ROWS)
  const end = Math.min(count, Math.ceil((scrollTop + viewportH) / pitch) + OVERSCAN_ROWS)

  return { first, count: Math.max(0, end - first) }
}

/**
 * The window widened to keep `focusedIndex` mounted.
 *
 * `04b` §1.9 is a ratified rule and it is unconditional: *"Focus is never
 * dropped to `<body>`"*. Virtualization is the one thing in this product that
 * can violate it without anybody writing a bug — a seller tabs onto a card's
 * Move link, spins the wheel, and the element holding focus is unmounted out
 * from under them.
 *
 * Tabbing alone does not need this: the browser scrolls a newly focused element
 * into view, that fires scroll, and the window follows. It is scrolling with
 * focus parked elsewhere in the column that drops it.
 *
 * The corpus specifies nothing about virtualized focus — no roving tabindex, no
 * `aria-setsize`, no rule for what a screen reader hears when the virtualizer
 * unmounts the focused card. This closes the one hole that a RATIFIED rule
 * already forbids, and invents none of the rest.
 *
 * Widening a contiguous range rather than mounting a second island keeps DOM
 * order equal to visual order, which is what keeps Tab moving down the column
 * instead of jumping. The cost is that a far-away focused card can push the
 * mounted count past R2-2 for as long as focus stays there; that requires a
 * programmatic scroll, and a correct tab order is worth more than a node.
 */
export function withFocusHeld(window: CardWindow, focusedIndex: number | null): CardWindow {
  if (focusedIndex === null || focusedIndex < 0) return window
  if (window.count === 0) return { first: focusedIndex, count: 1 }

  const first = Math.min(window.first, focusedIndex)
  const end = Math.max(window.first + window.count, focusedIndex + 1)
  return { first, count: end - first }
}
