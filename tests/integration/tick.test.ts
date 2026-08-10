import { describe, expect, it } from 'vitest'

import { FRESH_WINDOW_SECONDS, mmss } from '~/lib/board/tick'

/**
 * The clock's pure half.
 *
 * The store itself needs `document` and a real interval, so its behaviour —
 * that it ticks, that it ticks ONCE per second, that it expires at the window —
 * is asserted in `tests/e2e/new-clock.spec.ts` against a browser. Splitting it
 * here rather than reaching for a fake DOM keeps this file about the one thing
 * a node process can actually answer: the formatting, which is what the SERVER
 * calls to render the first frame of the string.
 */

describe('mm:ss, as §2.7 draws it', () => {
  it('zero-pads both halves', () => {
    // `NEW 4:1` for a lead four minutes and one second old is the shape this
    // padding exists to prevent, and it is worse than ugly: the chip changes
    // WIDTH as the digits roll, so the card title beside it moves.
    expect(mmss(0)).toBe('00:00')
    expect(mmss(1)).toBe('00:01')
    expect(mmss(61)).toBe('01:01')
    expect(mmss(4 * 60 + 12)).toBe('04:12')
  })

  it('renders the exact string §2.7 draws', () => {
    // The literal from the mock, so a change to this format is a change
    // somebody has to make on purpose.
    expect(`NEW ${mmss(252)}`).toBe('NEW 04:12')
  })

  it('does not wrap minutes at sixty', () => {
    // Deliberate. The caller stops rendering at the fresh window, so a value
    // that reads `60:00` means the expiry did not fire — clamping it here would
    // turn a visible bug into an invisible one.
    expect(mmss(FRESH_WINDOW_SECONDS)).toBe('60:00')
    expect(mmss(FRESH_WINDOW_SECONDS + 59)).toBe('60:59')
  })

  it('floors a fractional second rather than rounding it up', () => {
    // The server rounds down too. Rounding to nearest in either place makes the
    // chip read one second AHEAD of the lead's real age half the time, on the
    // one number ruling R calls "the one number that justifies the lead spend".
    expect(mmss(59.9)).toBe('00:59')
  })

  it('clamps a negative age to zero', () => {
    // Reachable: the server measures the age, the browser adds its own elapsed
    // time, and the two origins are a round trip apart. `-1:59` on a card that
    // just arrived is the failure this prevents.
    expect(mmss(-1)).toBe('00:00')
    expect(mmss(-90)).toBe('00:00')
  })

  it('survives a non-finite age instead of rendering NaN:NaN', () => {
    expect(mmss(Number.NaN)).toBe('00:00')
    expect(mmss(Number.POSITIVE_INFINITY)).toBe('00:00')
  })
})

describe('the fresh window', () => {
  it('is the sixty minutes §2.7 gates the chip on', () => {
    // One number, in one place, read by the SERVER's gate and by the client's
    // expiry. Two copies is how a chip stops existing at fifty-nine minutes on
    // one side and sixty-one on the other.
    expect(FRESH_WINDOW_SECONDS).toBe(3_600)
  })
})
