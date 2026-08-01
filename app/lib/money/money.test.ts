import { describe, expect, it } from 'vitest'

import {
  add,
  annualize,
  assertWithinDealRange,
  format,
  fromCents,
  fromWireString,
  MoneyError,
  parseUserAmount,
  sum,
  toWireString,
} from './money'

describe('parseUserAmount', () => {
  it('accepts the shapes a seller actually types', () => {
    expect(parseUserAmount('1200')).toBe(120_000n)
    expect(parseUserAmount('1,200')).toBe(120_000n)
    expect(parseUserAmount('$1,200.50')).toBe(120_050n)
    expect(parseUserAmount('  89.9 ')).toBe(8_990n)
  })

  it('refuses sub-cent precision instead of rounding it', () => {
    // Rounding money is a domain decision; this function is not authorised
    // to make one silently.
    expect(() => parseUserAmount('10.005')).toThrow(MoneyError)
  })

  it('refuses junk', () => {
    expect(() => parseUserAmount('')).toThrow(MoneyError)
    expect(() => parseUserAmount('abc')).toThrow(MoneyError)
    expect(() => parseUserAmount('1.2.3')).toThrow(MoneyError)
  })
})

describe('annualize — the D2 gate', () => {
  it('is exact where a float would drift', () => {
    // $249.99/month. In floats: 249.99 * 12 = 2999.8799999999997 -> $2,999.88
    // on a public leaderboard. In integer cents it cannot drift.
    const monthly = parseUserAmount('249.99')
    expect(annualize(monthly)).toBe(299_988n)
    expect(format(annualize(monthly))).toBe('$2,999.88')
  })

  it('is exact across a thousand awkward premiums', () => {
    for (let c = 1; c <= 1000; c++) {
      const monthly = fromCents(BigInt(c))
      expect(annualize(monthly)).toBe(BigInt(c) * 12n)
    }
  })
})

describe('the JSON seam', () => {
  it('crosses as a string of whole cents, never as a JS number', () => {
    const value = parseUserAmount('3000')
    const wire = toWireString(value)
    expect(wire).toBe('300000')
    expect(typeof wire).toBe('string')
    expect(fromWireString(wire)).toBe(value)
  })

  it('survives an amount that would lose precision as a double', () => {
    const huge = fromCents(9_007_199_254_740_993n) // Number.MAX_SAFE_INTEGER + 2
    expect(fromWireString(toWireString(huge))).toBe(huge)
  })

  it('refuses a wire value that is not whole cents', () => {
    expect(() => fromWireString('12.50')).toThrow(MoneyError)
  })
})

describe('arithmetic', () => {
  it('adds and sums exactly', () => {
    expect(add(parseUserAmount('0.10'), parseUserAmount('0.20'))).toBe(30n)
    expect(sum([parseUserAmount('19.99'), parseUserAmount('0.01')])).toBe(2_000n)
  })

  it('sums an empty ledger to zero, not NaN', () => {
    expect(sum([])).toBe(0n)
  })
})

describe('format', () => {
  it('groups thousands and hides trailing zero cents', () => {
    expect(format(parseUserAmount('3000'))).toBe('$3,000')
    expect(format(parseUserAmount('1234567.89'))).toBe('$1,234,567.89')
    expect(format(parseUserAmount('0'))).toBe('$0')
  })

  it('shows cents on request', () => {
    expect(format(parseUserAmount('3000'), { showCents: true })).toBe('$3,000.00')
  })

  it('renders a reversal as negative', () => {
    expect(format(parseUserAmount('-500'))).toBe('-$500')
  })
})

describe('deal-value guard rail', () => {
  it('accepts the range and rejects outside it', () => {
    expect(() => assertWithinDealRange(parseUserAmount('1'))).not.toThrow()
    expect(() => assertWithinDealRange(parseUserAmount('100000'))).not.toThrow()
    expect(() => assertWithinDealRange(parseUserAmount('0.99'))).toThrow(MoneyError)
    expect(() => assertWithinDealRange(parseUserAmount('100000.01'))).toThrow(MoneyError)
  })
})
