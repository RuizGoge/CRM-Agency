import { useCallback, useEffect, useRef, useState } from 'react'

import { cardPitchPx } from '~/styles/tokens/geometry'
import { BREAKPOINTS } from '~/styles/tokens/timing'

/**
 * The column virtualizer — `04b` §2.1, the rendering half of its contract.
 *
 * A seller with a full book has 125 cards in a column. Every one of them was a
 * mounted `<article>` with its rail, its chip and its link until now, on all six
 * columns at once, and P6 measured what that costs: a max frame of 33.3 ms
 * against a 34 ms budget, which is not headroom, it is luck. It is also why the
 * ticking `NEW` clock was refused twice — five hundred simultaneous timers are
 * not survivable, and §2.1's own answer is that there should never be five
 * hundred nodes to time.
 *
 *   > "The rendered window is capped and knowable. At a 900px column viewport:
 *   > `ceil(900 / pitch) + 2` overscan. Six columns = 60 card nodes maximum on
 *   > screen, whether the board holds 40 leads or 500."
 *
 * WHAT THIS IS NOT, said here rather than left to be discovered. §2.1's contract
 * has a second half — *"the server returns 20 cards per column plus a
 * server-computed count and annualized sum; the rest is fetched on scroll"* —
 * and that half is NOT built. The server still sends every card, so this saves
 * DOM nodes and frames, not bytes or database work. The column count and the
 * column total have always been server-computed, so the property that half of
 * the contract exists to protect — *"a column sum is never wrong because of the
 * window"* — holds today for a different reason: nothing here can affect a total
 * it does not compute.
 *
 * THE SCROLL CONTAINER IS THE PAGE, deliberately, and that is a departure from
 * the `04b` C-32 sketch of a column with its own viewport and a sticky header.
 * Per-column scrollers would mean giving the board a bounded height, which means
 * changing the shell layout for every screen, on the one change whose entire
 * point is that a seller sees no difference. The board scrolls exactly as it did
 * this morning; what changed is how much of it is in the DOM. The sticky header
 * is a UX story and it is not this one.
 */

/**
 * Below this a column renders plainly, with no window and no spacers.
 *
 * D3's number, and the strictest of the three §2.1 weighed. It is already three
 * screens of content, so nothing a demo tenant shows is ever virtualized — which
 * is the reason every existing board spec still measures a real, whole column.
 */
export const VIRTUALIZE_ABOVE = 30

/** Cards kept mounted beyond each edge of the viewport. §2.1's `+ 2`. */
export const OVERSCAN = 2

/**
 * What renders before the viewport has been measured — the server pass and the
 * first client render, which must agree byte for byte or hydration tears.
 *
 * Sized to overfill any real viewport (16 × 120px desktop, 16 × 156px mobile) so
 * the effect that follows a frame later never has to fill a visible gap.
 */
export const SSR_WINDOW_CARDS = 16

export interface BoardWindow {
  /** Index of the first card to mount, shared by every column. */
  readonly first: number
  /** How many to mount from there. */
  readonly count: number
  /** `card height + gap`. Zero until measured, which makes every spacer zero. */
  readonly pitchPx: number
  /** False on the server and for one frame after hydration. */
  readonly measured: boolean
}

const UNMEASURED: BoardWindow = {
  first: 0,
  count: SSR_WINDOW_CARDS,
  pitchPx: 0,
  measured: false,
}

export interface ColumnSlice {
  readonly first: number
  /** Exclusive. */
  readonly last: number
  /** Stands in for the cards above the window, so the scrollbar stays honest. */
  readonly padTopPx: number
  /** And for the ones below it. */
  readonly padBottomPx: number
  readonly virtualized: boolean
}

/**
 * The slice of one column to mount.
 *
 * The spacers are PADDING on the list rather than two empty children, and the
 * arithmetic is what makes that work: a grid of `n` cards is `n × pitch − gap`
 * tall, so `first × pitch` above and `(n − last) × pitch` below adds back
 * exactly the height the unmounted cards would have occupied. Two spacer
 * elements would each have become grid items with their own gap, and the column
 * would have grown by 16px per redraw — the kind of drift that reads as a
 * rendering bug and is arithmetic.
 */
export function sliceFor(total: number, win: BoardWindow): ColumnSlice {
  if (total <= VIRTUALIZE_ABOVE) {
    return { first: 0, last: total, padTopPx: 0, padBottomPx: 0, virtualized: false }
  }

  const first = Math.min(win.first, Math.max(0, total - 1))
  const last = Math.min(total, first + win.count)

  return {
    first,
    last,
    padTopPx: first * win.pitchPx,
    padBottomPx: (total - last) * win.pitchPx,
    virtualized: true,
  }
}

export interface BoardWindowBinding {
  readonly window: BoardWindow
  /**
   * Attach to every column's card list. The origin is the SMALLEST top across
   * them, so a column whose header wraps to a second line can only ever cause
   * cards to be over-rendered, never under-rendered — the direction that shows a
   * seller a gap where a lead should be.
   */
  readonly registerList: (element: HTMLElement | null) => void
}

export function useBoardWindow(): BoardWindowBinding {
  const [boardWindow, setBoardWindow] = useState<BoardWindow>(UNMEASURED)
  const lists = useRef<Set<HTMLElement>>(new Set())

  const registerList = useCallback((element: HTMLElement | null): void => {
    // React hands this null on detach, which is what keeps the set from holding
    // elements belonging to a board that is no longer on screen.
    if (element === null) return
    lists.current.add(element)
  }, [])

  useEffect(() => {
    const mounted = lists.current
    const density = window.matchMedia(`(max-width: ${BREAKPOINTS.md - 1}px)`)

    // CACHED, and that is the whole reason this hook exists in this shape. The
    // scroll handler below reads no layout at all: §2.1 puts layout reads in the
    // drag path as "the single most common cause of a dropped frame", and a
    // fixed pitch removes the reason to read one. These three are re-measured on
    // resize and on a density change, neither of which happens mid-drag.
    let pitchPx = cardPitchPx(density.matches)
    let listTopPx = 0
    let count = SSR_WINDOW_CARDS

    const firstIndex = (): number =>
      Math.max(0, Math.floor((window.scrollY - listTopPx) / pitchPx) - OVERSCAN)

    const measure = (): void => {
      pitchPx = cardPitchPx(density.matches)
      const tops = [...mounted].map((el) => el.getBoundingClientRect().top + window.scrollY)
      listTopPx = tops.length === 0 ? 0 : Math.min(...tops)
      count = Math.ceil(window.innerHeight / pitchPx) + OVERSCAN * 2 + 1
      setBoardWindow({ first: firstIndex(), count, pitchPx, measured: true })
    }

    const onScroll = (): void => {
      const next = firstIndex()
      // THE ONLY RE-RENDER THIS HOOK CAUSES, and it is one per pitch of scroll
      // rather than one per event. A wheel tick fires scroll dozens of times per
      // second; re-rendering six columns on each of them would spend precisely
      // the frame budget the window is here to save.
      setBoardWindow((current) =>
        current.measured && current.first === next
          ? current
          : { first: next, count, pitchPx, measured: true },
      )
    }

    measure()
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', measure)
    density.addEventListener('change', measure)

    return () => {
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', measure)
      density.removeEventListener('change', measure)
    }
  }, [])

  return { window: boardWindow, registerList }
}
