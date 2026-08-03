import type { Period } from '~/routes/api/leaderboard'

/**
 * The four ratified leaderboard empty states — `lb.empty.alltime` · `.today` ·
 * `.week` · `.month`, from `04b` §4.10.
 *
 * The rule that table opens with: an empty state has a HEADLINE (what is true)
 * and a BODY (what to do first), and *"a state that only reports absence is a
 * defect"*. The version these replace reported absence twice — `Nothing closed
 * in this period yet` over `Try All time to see the full history` — and the
 * second line sent a seller AWAY from the board on the one morning the product
 * most needs them to close something.
 *
 * THE FOUR ARE DELIBERATELY DIFFERENT SENTENCES, and §4.10 says why in as many
 * words: *"so the seller knows the FILTER changed, not the data."* One shared
 * line across the bounded periods reads, at 9 a.m. on a Monday, exactly like a
 * board that lost its numbers — and the seller's next move is to ask whether
 * their sale was recorded.
 *
 * A plain data module rather than a constant inside the route, so the property
 * that matters — four distinct lines, not one line four times — can be
 * asserted without rendering anything.
 */
export const BOARD_EMPTY: Readonly<Record<Period, readonly [headline: string, body: string]>> = {
  all_time: ['No earnings yet', 'First sale of the day owns the top spot.'],
  day: [
    'Nothing on the board yet today',
    'First sale today takes #1. Today resets at midnight, agency time.',
  ],
  week: [
    'Nothing on the board yet this week',
    'First sale this week takes #1. All time still holds your full record.',
  ],
  month: [
    'Nothing on the board yet this month',
    'First sale this month takes #1. All time still holds your full record.',
  ],
}
