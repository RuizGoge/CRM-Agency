import { useEffect, useRef, useState } from 'react'

/**
 * The poll, for a surface whose loader already rendered it once.
 *
 * `CLAUDE.md`: SSE carries exactly two channels and *"everything else is
 * conditional-GET polling, and the poller never stops when push is connected:
 * push is a hint, the poll is the truth."* Three surfaces are on a poll and
 * until now ONE was — the leaderboard, and it polled by revalidating its own UI
 * loader, which is a `.data` request carrying no tag and answering `200` every
 * time. My Day and the board did not poll at all.
 *
 * THE TAG COMES FROM THE FIRST TICK, NOT FROM THE LOADER, and that costs one
 * `200` per page load. The loader rendered its payload through the framework,
 * not through `jsonConditional`, so there is no entity tag to inherit. Closing
 * that would mean teaching the SSR path to emit one, which is a bigger change
 * than the one request it saves.
 *
 * WHAT A FAILED TICK DOES: nothing. It is skipped and the next one supersedes
 * it, because a poll that lost a race is not an error a seller can act on.
 * ⚠️ The consequence is worth stating rather than discovering: a poll that
 * fails PERSISTENTLY — a dropped session, a downed API — leaves the seller
 * looking at data that stops moving, with nothing on screen saying so. The
 * tenant-banner SSE channel is where that notice belongs and it is not built,
 * so this is a real gap and not a decision.
 */
export function useConditionalPoll<T>(options: {
  readonly path: string
  /** The loader's payload. Rendered until a tick returns something newer. */
  readonly initial: T
  readonly intervalMs: number
}): T {
  const { path, initial, intervalMs } = options

  const [polled, setPolled] = useState<T | null>(null)
  const [seenInitial, setSeenInitial] = useState<T>(initial)

  // THE LOADER WINS WHENEVER IT RUNS AGAIN. Without this the screen keeps
  // rendering whatever the last tick happened to fetch, and a seller watches
  // their own completed move undo itself.
  //
  // Adjusting state during render rather than in an effect is deliberate: an
  // effect would render the stale value once first, which on the board is a
  // visible flash of the card in its old column.
  //
  // 🔬 NOT CURRENTLY REACHABLE, and saying so is better than the comment I first
  // wrote here. Every path that revalidates these two screens today also
  // NAVIGATES — a move redirects, so the component remounts and `polled` starts
  // at null anyway. Deleting these three lines leaves `polling.spec.ts` green,
  // measured by mutation rather than assumed. They stay because the first
  // revalidation that does not navigate makes them load-bearing, and there is
  // already one such call in the tree (`useRevalidator` on the leaderboard) plus
  // one planned: moving that poller onto this hook. A test that would catch it
  // needs that path to exist first.
  //
  // What `polling.spec.ts` DOES prove is the property rather than the
  // mechanism: a completed move survives the next tick. That is true here for
  // two reasons instead of one, and it is the reason a seller cares about.
  if (initial !== seenInitial) {
    setSeenInitial(initial)
    setPolled(null)
  }

  const tag = useRef<string | null>(null)
  const inFlight = useRef(false)

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setInterval> | undefined

    // A HELD TAG BELONGS TO A PATH. The leaderboard's path carries the selected
    // period, so without this a seller switching to Today would send All-time's
    // tag. The server would answer 200 rather than anything wrong, so the cost
    // is one request — but a tag that outlives the resource it describes is the
    // shape of a stale-304 bug, and it is cheaper to not have one.
    tag.current = null

    const tick = (): void => {
      // NEVER TWO AT ONCE. A slow response on a 15-second interval would
      // otherwise stack requests against a server that is already the reason
      // they are slow.
      if (inFlight.current) return
      inFlight.current = true

      const held = tag.current
      void fetch(path, held === null ? undefined : { headers: { 'if-none-match': held } })
        .then(async (res) => {
          if (cancelled) return
          // The whole point of the tag: nothing changed, nothing to parse,
          // nothing to re-render. A 304 must not touch state at all, or the
          // saving is undone by React.
          if (res.status === 304) return
          if (!res.ok) return

          // A signed-out seller's fetch follows the redirect to the sign-in
          // page and comes back as HTML with a 200. Parsing that as JSON throws
          // where the real answer is "the session ended" — so the content type
          // is checked rather than assumed.
          if (!(res.headers.get('content-type') ?? '').includes('application/json')) return

          const next = (await res.json()) as T
          if (cancelled) return
          tag.current = res.headers.get('etag')
          setPolled(next)
        })
        .catch(() => {
          // Swallowed ON PURPOSE, and this is the one place in the tree where
          // that is the right answer: a tick that failed is a tick, and the
          // next one supersedes it. There is nothing here a seller could act on
          // and nothing to correct — the screen keeps its last good data. Not a
          // `catch {}` to make a test pass; see the gap noted above the hook.
        })
        .finally(() => {
          inFlight.current = false
        })
    }

    const start = (): void => {
      timer ??= setInterval(tick, intervalMs)
    }
    const stop = (): void => {
      if (timer !== undefined) {
        clearInterval(timer)
        timer = undefined
      }
    }

    // VISIBLE TAB ONLY, the same rule §4.9 puts on every poll: a backgrounded
    // board is requests nobody is reading. It fires immediately on refocus so a
    // seller who comes back to the tab never reads a stale screen while waiting
    // out the rest of an interval.
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') {
        tick()
        start()
      } else {
        stop()
      }
    }

    if (document.visibilityState === 'visible') start()
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      cancelled = true
      stop()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [path, intervalMs])

  return polled ?? initial
}
