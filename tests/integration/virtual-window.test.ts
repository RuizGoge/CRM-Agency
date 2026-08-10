import { describe, expect, it } from 'vitest'

import {
  MAX_RENDERED_PER_COLUMN,
  OVERSCAN_ROWS,
  SSR_WINDOW,
  VIRTUALIZE_ABOVE,
  windowFor,
  withFocusHeld,
} from '~/lib/board/virtual-window'

/**
 * The window arithmetic, checked without a browser.
 *
 * The property that matters is not "the numbers are right" — it is that NO CARD
 * CAN BE LOST. A virtualizer that renders the wrong ten cards looks like a
 * scrolling glitch; one that can never render card 431 is a seller who cannot
 * reach a lead, and neither the type checker nor a screenshot would say so.
 *
 * `04b` §9 R2-2's other half — the ≤14 ceiling — is asserted here as arithmetic
 * and again in tests/e2e/board-virtualization.spec.ts against a real browser.
 * Both are needed and neither is redundant: this one covers every viewport and
 * scroll offset a loop can enumerate, and that one covers whether the component
 * actually uses the arithmetic.
 */

const DESKTOP_PITCH = 128
const MOBILE_PITCH = 164

describe('the window never loses a card', () => {
  it('reaches every index in a 500-card column by scrolling', () => {
    // The whole point, stated as coverage. Walk the column a row at a time and
    // collect every index the window ever offers; the union must be all 500.
    //
    // The failure this catches is an off-by-one at the BOTTOM, which is where
    // it always is: a `Math.floor` where the end needs `Math.ceil` leaves the
    // last card of every column permanently unreachable, and there is no
    // viewport at which that looks wrong on screen — the column simply ends one
    // card early, exactly as a column with one fewer card would.
    const count = 500
    const viewportH = 900
    const seen = new Set<number>()

    const maxScroll = count * DESKTOP_PITCH
    for (let scrollTop = 0; scrollTop <= maxScroll; scrollTop += 8) {
      const w = windowFor({ count, scrollTop, viewportH, pitch: DESKTOP_PITCH })
      for (let i = w.first; i < w.first + w.count; i += 1) seen.add(i)
    }

    expect(seen.size, 'some card is unreachable at every scroll offset').toBe(count)
    expect(Math.min(...seen)).toBe(0)
    expect(Math.max(...seen), 'the LAST card is never mounted').toBe(count - 1)
  })

  it('mounts the last card when the column is scrolled to its end', () => {
    // Stated on its own rather than left to the sweep above, because this is the
    // exact assertion the e2e mirrors on a real board and the two must agree on
    // what "the end" means.
    const count = 500
    const viewportH = 900
    const contentH = (count - 1) * DESKTOP_PITCH + 120
    const w = windowFor({ count, scrollTop: contentH - viewportH, viewportH, pitch: DESKTOP_PITCH })

    expect(w.first + w.count).toBe(count)
  })

  it('covers the visible band with at least one row of overscan on each side', () => {
    const count = 500
    const viewportH = 900
    const scrollTop = 5_000
    const w = windowFor({ count, scrollTop, viewportH, pitch: DESKTOP_PITCH })

    // Everything the eye can see is mounted...
    const firstVisible = Math.floor(scrollTop / DESKTOP_PITCH)
    const lastVisible = Math.floor((scrollTop + viewportH) / DESKTOP_PITCH)
    expect(w.first).toBeLessThanOrEqual(firstVisible)
    expect(w.first + w.count).toBeGreaterThan(lastVisible)

    // ...plus a row beyond each edge, so a fast wheel does not scroll into a
    // blank band before React has re-rendered.
    expect(firstVisible - w.first).toBe(OVERSCAN_ROWS)
  })
})

describe('R2-2 · the mounted count stays inside the node budget', () => {
  it('holds ≤14 per column across every viewport the profiles run', () => {
    // desktop-ci, dnd-ci and lh-ci are all ≤1080 tall, and the column viewport
    // is smaller again once the shell header, the page heading and the column
    // header are taken out. mobile-ci is shorter still and pays a taller pitch.
    const cases = [
      { label: 'phone', viewportH: 700, pitch: MOBILE_PITCH },
      { label: 'laptop', viewportH: 560, pitch: DESKTOP_PITCH },
      { label: '1080p', viewportH: 850, pitch: DESKTOP_PITCH },
      { label: '1440p', viewportH: 1_150, pitch: DESKTOP_PITCH },
    ]

    for (const { label, viewportH, pitch } of cases) {
      let worst = 0
      for (let scrollTop = 0; scrollTop <= 500 * pitch; scrollTop += 7) {
        worst = Math.max(worst, windowFor({ count: 500, scrollTop, viewportH, pitch }).count)
      }
      expect(worst, `${label} mounts ${worst} cards per column`).toBeLessThanOrEqual(
        MAX_RENDERED_PER_COLUMN,
      )
    }
  })

  it('names the viewport at which the arithmetic outgrows the ceiling', () => {
    // ⚠️ R2-2 says "at any viewport" and arithmetic cannot deliver that. This
    // test does not assert a pass — it PINS the height at which the window
    // exceeds 14, so the day somebody plugs in a 4K monitor and the e2e goes
    // red, the number is already written down and the diagnosis is not a
    // morning's work. The two alternatives are both worse than the overflow:
    // capping the window leaves a visible band of empty column, and raising the
    // budget is weakening a budget.
    const ceiling = (() => {
      for (let viewportH = 200; viewportH < 4_000; viewportH += 1) {
        for (let scrollTop = 0; scrollTop < 40 * DESKTOP_PITCH; scrollTop += 7) {
          const w = windowFor({ count: 500, scrollTop, viewportH, pitch: DESKTOP_PITCH })
          if (w.count > MAX_RENDERED_PER_COLUMN) return viewportH
        }
      }
      return null
    })()

    expect(ceiling, 'the window now exceeds R2-2 at a different height').toBe(1410)
  })

  it('keeps the server-rendered window under the same ceiling', () => {
    // SSR_WINDOW is the one window nothing measures, so nothing catches it
    // drifting. It ships on every first paint of the board.
    expect(SSR_WINDOW).toBeLessThanOrEqual(MAX_RENDERED_PER_COLUMN)
    expect(SSR_WINDOW).toBeGreaterThan(0)
  })
})

describe('the degenerate inputs, which all arrive from a measurement', () => {
  it('mounts the WHOLE column when the pitch did not resolve', () => {
    // Deliberately asymmetric, and the asymmetry is the decision. A board that
    // is slow is a budget failure the gates report by name; a board that is
    // missing cards is a seller losing a lead and nobody finding out. Those are
    // not the same kind of wrong, so the fallback is not a smaller window — it
    // is no window at all.
    for (const pitch of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(windowFor({ count: 500, scrollTop: 0, viewportH: 900, pitch }).count).toBe(500)
    }
  })

  it('survives an unmeasured viewport without rendering a blank column', () => {
    // viewportH 0 is what a display:none column reports. One row plus overscan
    // is thin, but it is not empty, and it corrects on the next resize.
    const w = windowFor({ count: 500, scrollTop: 0, viewportH: 0, pitch: DESKTOP_PITCH })
    expect(w.count).toBeGreaterThan(0)
  })

  it('clamps a negative or overshot scroll rather than emptying the column', () => {
    // 🔴 THE OVERSHOT CASE IS A DEFECT THIS TEST FOUND, and it is reachable
    // without any overscroll: drag a card out of a column scrolled to its
    // bottom and the content shrinks under a held scroll offset. The first
    // version computed `first` past the last index and a count of zero — every
    // card present, none of them rendered, a blank column on screen.
    expect(windowFor({ count: 40, scrollTop: -400, viewportH: 900, pitch: 128 }).first).toBe(0)

    const past = windowFor({ count: 40, scrollTop: 999_999, viewportH: 900, pitch: 128 })
    expect(past.count, 'a column past its end renders nothing').toBeGreaterThan(0)
    expect(past.first + past.count, 'the end of the column is mounted').toBe(40)

    // And it is not merely non-empty: it shows what the bottom of the column
    // should show, which is a full viewport of cards and not just the last one.
    expect(past.count).toBeGreaterThan(5)
  })

  it('returns an empty window for an empty column', () => {
    expect(windowFor({ count: 0, scrollTop: 0, viewportH: 900, pitch: 128 })).toEqual({
      first: 0,
      count: 0,
    })
  })
})

describe('focus is never dropped to body', () => {
  it('holds a focused card that has scrolled far out of the window', () => {
    // `04b` §1.9 is unconditional. A seller tabs to card 3's Move link, spins
    // the wheel, and without this the element holding focus is unmounted — the
    // browser then puts focus on <body> and the next Tab restarts at the top of
    // the document.
    const w = windowFor({ count: 500, scrollTop: 40_000, viewportH: 900, pitch: DESKTOP_PITCH })
    expect(w.first).toBeGreaterThan(3)

    const held = withFocusHeld(w, 3)
    expect(held.first).toBe(3)
    expect(held.first + held.count).toBe(w.first + w.count)
  })

  it('holds a focused card BELOW the window as well as above it', () => {
    const w = windowFor({ count: 500, scrollTop: 0, viewportH: 900, pitch: DESKTOP_PITCH })
    const held = withFocusHeld(w, 400)
    expect(held.first).toBe(w.first)
    expect(held.first + held.count).toBe(401)
  })

  it('changes nothing when the focused card is already mounted, or when nothing has focus', () => {
    const w = windowFor({ count: 500, scrollTop: 5_000, viewportH: 900, pitch: DESKTOP_PITCH })
    expect(withFocusHeld(w, w.first + 1)).toEqual(w)
    expect(withFocusHeld(w, null)).toEqual(w)
  })
})

describe('the threshold below which a column is plain DOM', () => {
  it('is the number 04b §2.1 states, and the demo tenant sits under it', () => {
    // Not a tuning knob. It is why every existing board spec — card anatomy,
    // axe, the functional drag — keeps measuring the un-windowed path on the
    // demo tenant, and why the windowed path needs gates of its own on
    // perf-500 rather than being assumed covered.
    expect(VIRTUALIZE_ABOVE).toBe(30)
  })
})
