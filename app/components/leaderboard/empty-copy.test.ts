import { describe, expect, it } from 'vitest'

import { BOARD_EMPTY } from './empty-copy'

/**
 * Protected item 9's last copy gap, made mechanical.
 *
 * `DEMO-09` recorded it in words — *"the four periods do not each have their
 * own line yet"* — and the shortcut that produces that state is not laziness,
 * it is tidiness: one sentence with `{period_label}` interpolated reads fine
 * in review and collapses the exact distinction §4.10 asks for. *"Deliberately
 * different from All time so the seller knows the FILTER changed, not the
 * data."*
 *
 * The failure it prevents is a seller opening a Today board at 9 a.m., reading
 * the same sentence their All-time board showed on go-live day, and concluding
 * their sale was not recorded.
 */
describe('the leaderboard empty state is four sentences, not one', () => {
  const periods = ['all_time', 'day', 'week', 'month'] as const

  it('carries a headline and a body for every period', () => {
    // §4.10's opening rule: a headline says what is true, a body says what to
    // do first, and "a state that only reports absence is a defect".
    for (const period of periods) {
      const [headline, body] = BOARD_EMPTY[period]
      expect(headline.length, `${period} has no headline`).toBeGreaterThan(10)
      expect(body.length, `${period} has no body`).toBeGreaterThan(20)
    }
  })

  it('never says the same thing twice', () => {
    // THE ASSERTION THIS FILE EXISTS FOR. Four periods, four distinct
    // headlines and four distinct bodies — so collapsing them back into one
    // interpolated string turns the build red instead of quietly undoing the
    // distinction.
    const headlines = periods.map((p) => BOARD_EMPTY[p][0])
    const bodies = periods.map((p) => BOARD_EMPTY[p][1])

    expect(new Set(headlines).size, 'two periods share a headline').toBe(4)
    expect(new Set(bodies).size, 'two periods share a body').toBe(4)
  })

  it('names its own period in the sentence a seller reads', () => {
    // The distinction has to be legible, not merely present. A seller who
    // cannot tell from the words which filter they are looking at gets no
    // benefit from four strings that happen to differ by punctuation.
    expect(BOARD_EMPTY.day.join(' ')).toContain('today')
    expect(BOARD_EMPTY.week.join(' ')).toContain('this week')
    expect(BOARD_EMPTY.month.join(' ')).toContain('this month')
  })

  it('sends a seller to the board rather than away from it', () => {
    // What the replaced copy got wrong. `Try All time to see the full history`
    // answers a bounded empty board by suggesting a different board — on the
    // one morning the product most needs the next action to be a sale. Every
    // bounded period now points at the same thing: first sale takes #1.
    for (const period of ['day', 'week', 'month'] as const) {
      expect(BOARD_EMPTY[period][1]).toMatch(/First sale .* takes #1\./)
    }
    for (const period of periods) {
      expect(BOARD_EMPTY[period].join(' '), `${period} sends the seller away`).not.toMatch(
        /Try All time/i,
      )
    }
  })

  it('tells a bounded period when it resets, and all-time nothing of the kind', () => {
    // Today is the only bounded board whose reset a seller feels the same day,
    // so it is the only one carrying the boundary inside its body. Week and
    // month point at All time instead, which is the record that does not move.
    expect(BOARD_EMPTY.day[1]).toContain('midnight, agency time')
    expect(BOARD_EMPTY.week[1]).toContain('All time still holds your full record')
    expect(BOARD_EMPTY.month[1]).toContain('All time still holds your full record')
    expect(BOARD_EMPTY.all_time.join(' ')).not.toContain('All time')
  })
})
