/**
 * One second-hand for the whole board.
 *
 * `04b` §4.2 registers `board.card.new_clock` as *"Ticks client-side from the
 * server timestamp, `aria-live="off"`"*, and §2.7 draws it as `NEW 04:12`. The
 * first attempt at this shipped nothing: P6 refused it twice, at 116.7 ms a
 * frame with every chip ticking and still 50.0 ms with the tick narrowed to
 * what was on screen, against a 34 ms budget. The conclusion recorded then was
 * that *"500 simultaneous clocks are not viable without virtualization"*.
 *
 * Virtualization landed, so the premise changed rather than the approach: a
 * column mounts about seven cards, so the worst case is roughly forty chips on
 * screen instead of five hundred, whatever the book holds.
 *
 * WHY THIS FILE IS IN `app/lib/**` AND NOT NEXT TO THE DERIVATION IT SERVES.
 * The previous attempt exported its `mmss` helper from `app/routes/api/board.ts`
 * — beside the code that produces the string, which reads well and is wrong —
 * and a component importing it dragged postgres, drizzle and better-auth into
 * the CLIENT bundle. The symptom was a 500-card board that rendered and then
 * simply never armed the drag, with nothing in the console. That is what
 * `scripts/client-server-boundary.test.ts` was written for, and this module
 * sits where that gate says it must: importing nothing from the server.
 *
 * ONE INTERVAL, and a `Set`. The same file that recorded the P6 refusal also
 * recorded why: a subscriber list copied per subscriber is O(n²), which cost
 * ~125,000 array copies during hydration on the 500-card fixture.
 */

/** How often the clock advances. One second, because it renders `mm:ss`. */
const TICK_MS = 1_000

/**
 * The fresh window, and the reason this module knows about it at all.
 *
 * §2.7 gates the chip on `age < 60 min`. The SERVER decides that, once, per
 * loader run — but a board left open all morning is the normal case, not an
 * edge one, and a chip that keeps counting past the hour renders a state the
 * server says does not exist. So the clock expires on its own and the slot
 * collapses. The card then carries no signal until the next loader run, which
 * is incomplete rather than wrong: the client cannot compute what should
 * replace it, because §2.8 puts that precedence on the server precisely so the
 * board, My Book and My Day cannot disagree.
 */
export const FRESH_WINDOW_SECONDS = 60 * 60

const subscribers = new Set<() => void>()

let handle: ReturnType<typeof setInterval> | null = null
let baseline = 0
/**
 * CACHED, never computed inside `getSnapshot`.
 *
 * `useSyncExternalStore` calls the snapshot more than once around a commit and
 * compares the results. Reading `performance.now()` in there returns a slightly
 * different number every call, which React treats as a store that will not
 * settle — it re-renders in a loop and warns about it.
 */
let elapsed = 0

function measure(): void {
  const next = Math.floor((performance.now() - baseline) / 1_000)
  if (next === elapsed) return
  elapsed = next
  for (const fn of subscribers) fn()
}

function start(): void {
  if (handle !== null) return
  handle = setInterval(measure, TICK_MS)
}

function stop(): void {
  if (handle === null) return
  clearInterval(handle)
  handle = null
}

/**
 * Nothing ticks in a tab nobody is looking at, which is the same rule every
 * poll in §4.9 already follows.
 *
 * Correct on return with no catch-up logic, because `elapsed` is DERIVED from a
 * monotonic origin rather than accumulated. A tab hidden for twenty minutes
 * comes back twenty minutes later, once, instead of firing twelve hundred
 * missed intervals — which is what an accumulating counter would owe.
 */
function onVisibility(): void {
  if (document.visibilityState === 'hidden') {
    stop()
    return
  }
  measure()
  if (subscribers.size > 0) start()
}

/** Subscribes to the shared clock. The interval exists only while someone listens. */
export function subscribeToTick(fn: () => void): () => void {
  if (subscribers.size === 0) {
    baseline = performance.now()
    elapsed = 0
    document.addEventListener('visibilitychange', onVisibility)
    if (document.visibilityState !== 'hidden') start()
  }
  subscribers.add(fn)

  return () => {
    subscribers.delete(fn)
    if (subscribers.size === 0) {
      stop()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }
}

/** Whole seconds since the first subscriber armed the clock. */
export function tickSnapshot(): number {
  return elapsed
}

/**
 * ZERO ON THE SERVER, and that is what makes the chip hydrate rather than warn.
 *
 * The server renders the string from the age it measured itself; the client's
 * FIRST render adds zero to that same age and produces the same characters.
 * Any other server snapshot is a hydration mismatch on the one screen this
 * project measures LCP and TTI against.
 */
export function tickServerSnapshot(): number {
  return 0
}

/**
 * `mm:ss`, zero-padded, as §2.7 draws it — `NEW 04:12`.
 *
 * Minutes are NOT wrapped at 60: the caller stops rendering at the fresh
 * window, so a value that would read `60:00` is a bug upstream, and clamping it
 * here would hide it. Negative input clamps to zero — a card whose server age
 * is a second or two ahead of this browser's monotonic origin must read
 * `00:00`, never `-1:59`.
 */
export function mmss(totalSeconds: number): string {
  const safe = Number.isFinite(totalSeconds) ? Math.max(0, Math.floor(totalSeconds)) : 0
  const minutes = Math.floor(safe / 60)
  const seconds = safe % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}
