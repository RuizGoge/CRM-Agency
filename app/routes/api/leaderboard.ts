import { sql } from 'drizzle-orm'

import { withTenant, type SessionIdentity } from '~/db'
import { requireIdentity } from '~/lib/auth/identity'
import { jsonConditional } from '~/lib/http/conditional'
import { fromWireString, subtract, sum, toWireString } from '~/lib/money/money'

/**
 * The public board.
 *
 * Money leaves here as a STRING of whole cents and never as a JSON number: a
 * large bigint widened by `JSON.parse` is a lossy double, and the client
 * performs no money arithmetic at all — it formats what it is given.
 *
 * The response is deliberately thin. This is one of exactly two sanctioned
 * cross-silo reads, and it is safe because of what is absent from it: no lead,
 * no contact, no opportunity, no premium of any individual deal. The thing
 * that cannot leak is the thing that is not there.
 */

const PERIODS = ['day', 'week', 'month', 'all_time'] as const
export type Period = (typeof PERIODS)[number]

export interface BoardRow {
  readonly rank: number
  readonly userId: string
  readonly displayName: string
  readonly avatarUrl: string | null
  /** Whole cents, as a string. Never a number. */
  readonly totalCents: string
  readonly entryCount: number
  readonly isSelf: boolean
}

/**
 * The seller directly above the viewer, and the distance to them.
 *
 * Feature 4 of the leaderboard module — "rank alone is a verdict; a dollar gap
 * is a goal" — and the half of protected item 10 that does the entire pitch
 * before a word is spoken: `You're #2 · $41,300 · $6,900 behind Dana R.`
 *
 * `gapCents` is SUBTRACTED HERE, on the server, and crosses the wire already
 * computed. The client is handed a number to format and never two numbers to
 * take the difference of — that is the rule in CLAUDE.md, and this line is the
 * most tempting place in the product to break it, because both operands are
 * already sitting in the same response.
 */
export interface NextUp {
  readonly rank: number
  readonly displayName: string
  /** Whole cents, as a string. Never a number, and never negative. */
  readonly gapCents: string
}

export interface BoardPayload {
  readonly period: Period
  /**
   * When this tenant's ledger begins — protected item 9's "Earnings tracked
   * since". ISO date; the client formats it.
   *
   * Ruling D8 is what makes this honest rather than decorative: the ledger
   * starts at go-live and imported history is NOT counted, so the board has to
   * say what window it is describing. Without the label the same screen reads
   * as "these are your totals", and the first question after the meeting is the
   * one whose true answer is no.
   */
  readonly trackedSince: string | null
  /** Renders the seeded-numbers footnote. Never true for a real tenant. */
  readonly isDemo: boolean
  readonly rows: readonly BoardRow[]
  /** The viewer's own row, always present even when outside the visible slice. */
  readonly self: BoardRow | null
  /** `null` when the viewer leads the board, or is not ranked on it at all. */
  readonly nextUp: NextUp | null
  /**
   * The margin over rank 2 — `lb.self.leading`, `Leading by {amount}`.
   *
   * Non-null only when the viewer IS rank 1, so it is the leader's own gap
   * and never a fact about someone else's position. Subtracted on the server
   * for the same reason `NextUp.gapCents` is.
   */
  readonly leadCents: string | null
  /**
   * `lb.supervisor_total` — `Floor total — {amount}`.
   *
   * The board gives supervisors and admins no self-row, because they cannot
   * write into a seller's book and a permanent `$0` reads as last place rather
   * than as not competing. This is what their slot renders instead. It adds no
   * information a viewer could not sum from `rows` themselves — which is
   * precisely why summing it here rather than there is the rule: money
   * arithmetic is server-side, including the kind that looks harmless.
   */
  readonly floorTotalCents: string
}

function parsePeriod(value: string | null): Period {
  // D7: the default is all-time. On day one a Today board is fifty rows of $0.
  const found = PERIODS.find((p) => p === value)
  return found ?? 'all_time'
}

/**
 * The standing, derived from the board's OWN rows rather than from a second
 * query.
 *
 * That is errata E2 satisfied structurally instead of by discipline. E2's
 * finding is that two functions computing rank independently diverge on ties
 * and on all-time roster population; its ruling is one shared ordering
 * expression and one shared population predicate for both reads. Here there is
 * only one of each — `app.leaderboard_board`, already fetched — so there is no
 * second implementation that could disagree, and no fixture could ever catch
 * one because none exists.
 *
 * "Directly above" is the PREVIOUS ROW in the board's own order, not
 * `rank - 1`. Said plainly: the two are indistinguishable today and no test
 * here can tell them apart, because the window orders by `(total DESC, id)`
 * and a unique id makes every rank distinct and contiguous. It is defensive,
 * not load-bearing — verified by mutation, which stayed green. It differs only
 * if the ordering ever admits a true tie, and then the previous row is still
 * the seller a viewer sees above them while `rank - 1` resolves to nobody and
 * the gap silently disappears from the screen.
 */
export function nextUpFrom(rows: readonly BoardRow[]): NextUp | null {
  const selfIndex = rows.findIndex((r) => r.isSelf)
  if (selfIndex < 1) return null // Not on the board, or already leading it.

  const self = rows[selfIndex]
  const above = rows[selfIndex - 1]
  if (!self || !above) return null

  return {
    rank: above.rank,
    displayName: above.displayName,
    gapCents: toWireString(
      subtract(fromWireString(above.totalCents), fromWireString(self.totalCents)),
    ),
  }
}

/**
 * The leader's margin over rank 2 — the amount in `Leading by {amount}`.
 *
 * Null for everyone who is not rank 1, and null for a leader with nobody
 * behind them: a one-seller board has no margin, and "Leading by $0" on a
 * board of one is a sentence about nothing.
 */
export function leadFrom(rows: readonly BoardRow[]): string | null {
  const selfIndex = rows.findIndex((r) => r.isSelf)
  if (selfIndex !== 0) return null

  const self = rows[0]
  const second = rows[1]
  if (!self || !second) return null

  return toWireString(subtract(fromWireString(self.totalCents), fromWireString(second.totalCents)))
}

export async function readBoard(request: Request): Promise<BoardPayload> {
  return readBoardFor(
    await requireIdentity(request),
    parsePeriod(new URL(request.url).searchParams.get('period')),
  )
}

/**
 * The read itself, with the request seam removed.
 *
 * Split out so the standing assertions can exercise THIS code — the same SQL,
 * the same mapping and the same derivation the endpoint runs — instead of a
 * test-local re-implementation that would agree with itself no matter what the
 * product did. Errata E2's whole finding is about two implementations of one
 * ranking drifting apart; a test that builds a third would be the same defect
 * wearing a lab coat.
 */
export async function readBoardFor(
  identity: SessionIdentity,
  period: Period,
): Promise<BoardPayload> {
  return withTenant(identity, async (tx) => {
    const rows = await tx.execute<{
      rank: string
      user_id: string
      display_name: string
      avatar_url: string | null
      total_cents: string
      entry_count: number
    }>(sql`SELECT * FROM app.leaderboard_board(${period}::app.period_type)`)

    const mapped: BoardRow[] = [...rows].map((r) => ({
      // rank arrives as a bigint and therefore as a string; it is a position,
      // not money, so parsing it is safe — but it goes through BigInt rather
      // than Number so the money lint rule keeps its meaning everywhere.
      rank: Number.parseInt(r.rank, 10),
      userId: r.user_id,
      displayName: r.display_name,
      avatarUrl: r.avatar_url,
      totalCents: r.total_cents,
      entryCount: r.entry_count,
      isSelf: r.user_id === identity.userId,
    }))

    // Tenant-level facts, read in the same unit of work. The date is the
    // ledger's beginning, which under ruling D8 is go-live: history imported
    // from a spreadsheet is NOT counted, and the board has to say so rather
    // than let the number imply otherwise.
    const meta = await tx.execute<{ tracked_since: string | null; is_demo: boolean }>(
      sql`SELECT to_char(created_at AT TIME ZONE business_tz, 'Mon DD, YYYY') AS tracked_since,
                 is_demo
            FROM app.tenant WHERE id = app.current_tenant()`,
    )

    return {
      period,
      rows: mapped,
      self: mapped.find((r) => r.isSelf) ?? null,
      nextUp: nextUpFrom(mapped),
      leadCents: leadFrom(mapped),
      floorTotalCents: toWireString(sum(mapped.map((r) => fromWireString(r.totalCents)))),
      trackedSince: meta[0]?.tracked_since ?? null,
      isDemo: meta[0]?.is_demo ?? false,
    }
  })
}

export async function loader({ request }: { request: Request }): Promise<Response> {
  // Conditional GET. This route had the only working implementation in the
  // tree, inline; it now shares the one in `~/lib/http/conditional` with the
  // two surfaces that had none. The reason it must stay derived from the
  // RENDERED BODY is preserved there: the public value is time-dependent
  // because entries younger than the undo window are excluded, so a purely
  // write-derived tag would answer 304 while the visible number changed as a
  // pending entry aged out.
  //
  // ⚠️ Nothing in the product calls this route. The seller's board polls by
  // revalidating the UI route's loader, which is a `/earnings.data` request
  // that carries no tag and answers 200 every time — measured, three ticks out
  // of three. See CONTEXT.md.
  return jsonConditional(request, await readBoard(request))
}
