import { sql as raw } from 'drizzle-orm'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { withTenant } from '~/db'
import { readBoardFor, type BoardPayload } from '~/routes/api/leaderboard'

import { TEST_URL } from './setup/urls'

/**
 * The rank-and-gap line, asserted against the database that produces it.
 *
 * `You're #2 · $41,300 · $6,900 behind Dana R.` is protected item 10's last
 * missing piece and `04-ux-flows.md` §7 calls it the line that does the entire
 * pitch before a word is spoken. Two things about it can go wrong quietly, and
 * both produce a believable number rather than an error:
 *
 *   1. THE SUBTRACTION MOVES TO THE CLIENT. Both operands travel in the same
 *      response, so `above.total - self.total` in a component is one line away
 *      at all times — and in floating point it is one line away from a public
 *      board that is off by a cent for a whole afternoon.
 *   2. THE STANDING GETS ITS OWN QUERY. That is errata E2 exactly: two
 *      functions computing rank independently diverge on ties and on all-time
 *      roster population. The defence here is structural rather than tested —
 *      the standing is derived from the board's own rows — so what these
 *      assertions can do is prove the two have not been allowed to separate.
 *
 * Everything below runs through `readBoardFor`, which is the endpoint's own
 * code path minus the request seam. A test that re-implemented the mapping
 * would agree with itself no matter what shipped.
 */

const TENANT = '00000000-0000-7000-8000-0000000000f9'

/**
 * Ids are chosen, not random, because the board's window orders by
 * `(total DESC, id)`: the two sellers on identical money get their order from
 * these bytes, and a random pair would make the tie assertion depend on luck.
 */
const LEADER = '00000000-0000-7000-8000-00000000f901'
const RUNNER_UP = '00000000-0000-7000-8000-00000000f902'
const TIED_WITH_RUNNER_UP = '00000000-0000-7000-8000-00000000f903'
const NEVER_SOLD = '00000000-0000-7000-8000-00000000f904'
const SUPERVISOR = '00000000-0000-7000-8000-00000000f909'

const LEADER_CENTS = 500_000n
const MIDFIELD_CENTS = 300_000n

let sql: postgres.Sql

async function append(owner: string, sourceEventId: string, deltaCents: bigint): Promise<void> {
  await withTenant({ tenantId: TENANT, userId: owner }, (tx) =>
    tx.execute(
      raw`SELECT * FROM app.ledger_append(
            ${owner}::uuid, ${sourceEventId}::uuid, 'opportunity.won',
            'sale'::app.ledger_entry_type, ${deltaCents.toString()}::bigint,
            '2026-03-15T18:30:00Z'::timestamptz,
            '00000000-0000-7000-8000-00000000aad1'::uuid,
            '00000000-0000-7000-8000-00000000bbd1'::uuid,
            NULL, 'Closed Won', 1::bigint, NULL, NULL, NULL, NULL)`,
    ),
  )
}

const board = (userId: string): Promise<BoardPayload> =>
  readBoardFor({ tenantId: TENANT, userId }, 'all_time')

beforeAll(async () => {
  sql = postgres(TEST_URL, { max: 1, onnotice: () => {} })

  await sql`
    INSERT INTO app.tenant (id, name, business_tz)
    VALUES (${TENANT}, 'Standing Agency', 'America/New_York')`

  await sql`
    INSERT INTO app.app_user (tenant_id, id, email, full_name, display_name, role) VALUES
      (${TENANT}, ${LEADER},             'lena@standing.test', 'Lena Ortiz',   'Lena', 'seller'),
      (${TENANT}, ${RUNNER_UP},          'raul@standing.test', 'Raul Vega',    'Raul', 'seller'),
      (${TENANT}, ${TIED_WITH_RUNNER_UP},'tess@standing.test', 'Tess Ibarra',  'Tess', 'seller'),
      (${TENANT}, ${NEVER_SOLD},         'noah@standing.test', 'Noah Prieto',  'Noah', 'seller'),
      (${TENANT}, ${SUPERVISOR},         'sam@standing.test',  'Sam Delacroix','Sam',  'supervisor')`

  await append(LEADER, '00000000-0000-7000-8000-00000000f701', LEADER_CENTS)
  await append(RUNNER_UP, '00000000-0000-7000-8000-00000000f702', MIDFIELD_CENTS)
  await append(TIED_WITH_RUNNER_UP, '00000000-0000-7000-8000-00000000f703', MIDFIELD_CENTS)
  // NEVER_SOLD gets nothing at all, on purpose: he is the case migration 0017
  // exists for, and he has no projection row to be found by.

  // The public projection withholds every entry younger than the reveal delay,
  // which is right for the board and useless for a fixture — these rows are
  // seconds old and the standing would read as five sellers on $0. Collapsing
  // the constant is how the money-path suite handles the same problem; it also
  // proves the predicate READS the constant rather than hard-coding 5500.
  await sql`UPDATE ref.timing_constant SET value_ms = 0 WHERE key = 'projection_reveal_delay_ms'`
})

afterAll(async () => {
  // Restored even if the assertions failed. Left at 0 it would publish undoable
  // wins to every later file in the run — the exact defect migration 0019 shut,
  // reopened by a fixture.
  await sql`UPDATE ref.timing_constant SET value_ms = 5500 WHERE key = 'projection_reveal_delay_ms'`
  await sql?.end()
})

describe('the rank-and-gap line', () => {
  it('places the leader with nobody above them', async () => {
    const payload = await board(LEADER)

    expect(payload.self?.rank).toBe(1)
    // The branch that keeps "$0 behind" off the leader's screen. A gap of null
    // is a different sentence from a gap of zero, and the component renders
    // them differently on purpose.
    expect(payload.nextUp).toBeNull()
  })

  it('subtracts the gap on the SERVER and sends it as a string of whole cents', async () => {
    const payload = await board(RUNNER_UP)

    expect(payload.self?.rank).toBe(2)
    expect(payload.nextUp?.rank).toBe(1)
    expect(payload.nextUp?.displayName).toBe('Lena')
    expect(payload.nextUp?.gapCents).toBe((LEADER_CENTS - MIDFIELD_CENTS).toString())

    // Money crosses JSON as a STRING of whole cents, never as a JSON number: a
    // large bigint widened by JSON.parse is a lossy double. The quotes in the
    // serialized body are the assertion, not the value.
    expect(JSON.stringify(payload)).toContain(`"gapCents":"${LEADER_CENTS - MIDFIELD_CENTS}"`)
  })

  it('reports a tie as a tie, not as $0 behind', async () => {
    // Ranks are always distinct — the window breaks ties by user id — so a tie
    // on money is invisible in the rank and shows up only as a zero gap. Left
    // unhandled it renders as "$0 behind Lena.", which is the sentence a seller
    // screenshots and sends to their manager.
    const payload = await board(TIED_WITH_RUNNER_UP)

    expect(payload.self?.rank).toBe(3)
    expect(payload.self?.totalCents).toBe(MIDFIELD_CENTS.toString())
    expect(payload.nextUp?.rank).toBe(2)
    expect(payload.nextUp?.gapCents).toBe('0')
  })

  it('gives the seller who has never sold a real gap rather than nothing', async () => {
    // Migration 0017's finding, one screen further on: the seller with the
    // least to celebrate is the one this line is most for. A board that ranks
    // him and then shows him no target is a board that tells him to stop
    // opening it.
    const payload = await board(NEVER_SOLD)

    expect(payload.self?.rank).toBe(4)
    expect(payload.self?.totalCents).toBe('0')
    expect(payload.nextUp?.gapCents).toBe(MIDFIELD_CENTS.toString())
  })

  it('ranks nobody who cannot write into a seller book', async () => {
    // A supervisor has no book, so the board does not carry them and the block
    // must say so instead of rendering an empty band that reads as a failure.
    const payload = await board(SUPERVISOR)

    expect(payload.self).toBeNull()
    expect(payload.nextUp).toBeNull()
  })
})

describe('the standing and the board can never be two different rankings', () => {
  it('resolves nextUp to the row directly above self, for every seller', async () => {
    // Errata E2 made checkable. The property is not "the numbers happen to
    // match today" — it is that there is one ordering and one population, so
    // the standing is a coordinate INSIDE the board rather than a second
    // opinion about it. A future refactor that gives the standing its own
    // query fails here on the first tie or the first $0 seller.
    for (const userId of [LEADER, RUNNER_UP, TIED_WITH_RUNNER_UP, NEVER_SOLD]) {
      const payload = await board(userId)
      const rows = payload.rows
      const index = rows.findIndex((r) => r.isSelf)

      expect(index, `${userId} is missing from the rows it was ranked in`).toBeGreaterThan(-1)
      expect(rows[index]?.rank, 'self.rank disagrees with the row in rows').toBe(payload.self?.rank)

      const above = index > 0 ? rows[index - 1] : undefined
      if (!above) {
        expect(payload.nextUp).toBeNull()
        continue
      }

      expect(payload.nextUp?.rank).toBe(above.rank)
      expect(payload.nextUp?.displayName).toBe(above.displayName)
      expect(payload.nextUp?.gapCents).toBe(
        (BigInt(above.totalCents) - BigInt(rows[index]?.totalCents ?? '0')).toString(),
      )
    }
  })

  it('never reports a negative gap, which would mean the order is upside down', async () => {
    for (const userId of [RUNNER_UP, TIED_WITH_RUNNER_UP, NEVER_SOLD]) {
      const payload = await board(userId)
      expect(BigInt(payload.nextUp?.gapCents ?? '0')).toBeGreaterThanOrEqual(0n)
    }
  })
})
