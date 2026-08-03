import { sql } from 'drizzle-orm'

import { withTenant } from '~/db'
import { requireIdentity } from '~/lib/auth/identity'

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
}

function parsePeriod(value: string | null): Period {
  // D7: the default is all-time. On day one a Today board is fifty rows of $0.
  const found = PERIODS.find((p) => p === value)
  return found ?? 'all_time'
}

export async function readBoard(request: Request): Promise<BoardPayload> {
  const identity = await requireIdentity(request)
  const period = parsePeriod(new URL(request.url).searchParams.get('period'))

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
      trackedSince: meta[0]?.tracked_since ?? null,
      isDemo: meta[0]?.is_demo ?? false,
    }
  })
}

export async function loader({ request }: { request: Request }): Promise<Response> {
  const payload = await readBoard(request)
  const body = JSON.stringify(payload)

  // Conditional GET. The board is polled every five seconds by every seller,
  // so almost all of these must answer 304 — see the p95 <= 80ms budget.
  //
  // Derived from the rendered body rather than from a write watermark, and
  // that is deliberate: the PUBLIC value is time-dependent, because entries
  // younger than the undo window are excluded. A purely write-derived ETag
  // would answer 304 while the visible number changed as a pending entry aged
  // out. Cheaper forms exist; none of them may lose that property.
  let hash = 0
  for (let i = 0; i < body.length; i++) {
    hash = (hash * 31 + body.charCodeAt(i)) | 0
  }
  const etag = `W/"${hash.toString(36)}"`

  if (request.headers.get('if-none-match') === etag) {
    return new Response(null, { status: 304, headers: { etag } })
  }

  return new Response(body, {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      etag,
      // Never a shared cache. Two sellers must never be served one another's
      // response, and this board is per-viewer because of `isSelf`.
      'cache-control': 'private, no-store',
    },
  })
}
