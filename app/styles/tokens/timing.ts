/**
 * Product timing constants — the single source for every duration the product
 * reasons about. Source of truth: docs/04b-design-system.md §4.9.
 *
 * Different jobs may share a number; they NEVER share a token. That rule is not
 * stylistic. Phase 5 errata E7/NEW-1 record what happens when one name is asked
 * to mean two intervals: one branch silently refuses every celebration claim,
 * the other reveals a still-undoable win on a public board — and a drift test
 * that compares names instead of values stays green in both.
 *
 * The undo window in particular exists in four places (this file, a CSS custom
 * property, the SQL predicate behind the public leaderboard, and the celebration
 * scheduler). They are generated from here. A CI test fails if any of the four
 * diverges — see CLAUDE.md, "Money and time".
 */

/** The undo window, and the undo toast's exact lifetime. One number a seller
 *  learns. Never shortened by reduced motion or a slow network. */
export const UNDO_WINDOW_MS = 5_000

/** Added to UNDO_WINDOW_MS for the PUBLIC projection predicate only, so no
 *  viewer ever sees a number that later corrects itself (ruling R1.3).
 *  It is NOT part of the celebration claim deadline. */
export const UNDO_PROJECTION_GUARD_MS = 500

/** Leaderboard and notifications. Visible tab only: stops on `visibilitychange`,
 *  fires immediately on refocus. */
export const POLL_FAST_MS = 5_000

/** My Day and board deltas — these cover only what other systems did. */
export const POLL_SLOW_MS = 15_000

/** Aloware health probe, only while a degraded banner is showing. */
export const POLL_HEALTH_MS = 30_000

/** Live call state. The one genuinely sub-second surface in the product. */
export const POLL_CALL_STATE_MS = 2_000

/** A skeleton renders only if data has not arrived within this. */
export const SKELETON_DELAY_MS = 120

/** Once shown, a skeleton stays at least this long — prevents a strobe. */
export const SKELETON_MIN_MS = 320

/** Then the surface's error state with `Try again`. A skeleton that never
 *  resolves is a spinner with better manners. */
export const SKELETON_TIMEOUT_MS = 8_000

/** The 2px route progress bar appears only after this; below it, it is noise. */
export const ROUTE_BAR_DELAY_MS = 400

/** Informational toasts. Error toasts never auto-dismiss. */
export const TOAST_DEFAULT_MS = 6_000

/** Leaves 80ms of the 200ms perceived-search budget for the round trip. */
export const SEARCH_DEBOUNCE_MS = 120

/** Debounce after the last keystroke; hard-flushed on blur, close, route change
 *  and `pagehide`. */
export const NOTE_AUTOSAVE_MS = 800

/** The speed-to-lead clock and the call-state elapsed timer. */
export const CLOCK_TICK_MS = 1_000

/** The two-legged gap. The call-state banner must change copy at least twice
 *  inside this window: fifteen silent seconds at minute six of the demo is the
 *  worst moment in the product. */
export const DIAL_SILENCE_MAX_MS = 15_000

/** Breakpoints. CSS custom properties cannot be used inside `@media`, so these
 *  are the single source and the build injects them. Two hard-coded breakpoint
 *  numbers anywhere in the codebase is a build failure. */
export const BREAKPOINTS = {
  /** Single column, bottom action bar pinned. */
  sm: 480,
  /** Density boundary: below is mobile type and 44px targets. */
  md: 768,
  /** Drag boundary — and only in combination with `(pointer: fine)`. */
  lg: 1024,
  /** Board shows 6 columns; leaderboard podium sits side-by-side. */
  xl: 1440,
} as const

export type Breakpoint = keyof typeof BREAKPOINTS
