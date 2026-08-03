import { useEffect } from 'react'
import { isRouteErrorResponse, useNavigation, useRevalidator, useRouteError } from 'react-router'

import { BoardSkeleton } from '~/components/leaderboard/board-skeleton'
import { BoardRow } from '~/components/leaderboard/board-row'
import { BOARD_EMPTY } from '~/components/leaderboard/empty-copy'
import { Podium } from '~/components/leaderboard/podium'
import { fromWireString, isZero } from '~/lib/money/money'
import { readBoard, type BoardPayload, type Period } from '~/routes/api/leaderboard'
import { POLL_FAST_MS } from '~/styles/tokens/timing'

import type { Route } from './+types/leaderboard'

export function meta(_: Route.MetaArgs) {
  return [{ title: 'Earnings — CRM Leads' }]
}

/**
 * The Earnings board.
 *
 * This is the one UI route allowed to serve board data as SSR HTML: it is the
 * screen with the LCP budget and the one every seller leaves open all day, so
 * a first paint that waits for a client fetch is the wrong trade here and only
 * here. Updates after that arrive by polling.
 */
export async function loader({ request }: Route.LoaderArgs): Promise<BoardPayload> {
  return readBoard(request)
}

const PERIOD_LABELS: ReadonlyArray<readonly [Period, string]> = [
  ['day', 'Today'],
  ['week', 'This week'],
  ['month', 'This month'],
  ['all_time', 'All time'],
]

export default function Leaderboard({ loaderData }: Route.ComponentProps): React.JSX.Element {
  const board = loaderData
  const revalidator = useRevalidator()
  const navigation = useNavigation()

  // The poll is the truth. It stops while the tab is hidden — a backgrounded
  // board is fifty requests a minute nobody is reading — and fires immediately
  // on refocus so a seller never looks at a stale number.
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined

    // `void`: a poll tick that loses the race is not an error to handle. The
    // next tick supersedes it, and the board is allowed to be one interval
    // stale — that is what "the poll is the truth" costs and buys.
    const start = (): void => {
      timer ??= setInterval(() => {
        void revalidator.revalidate()
      }, POLL_FAST_MS)
    }
    const stop = (): void => {
      if (timer !== undefined) {
        clearInterval(timer)
        timer = undefined
      }
    }
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') {
        void revalidator.revalidate()
        start()
      } else {
        stop()
      }
    }

    if (document.visibilityState === 'visible') start()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [revalidator])

  const switching = navigation.state === 'loading'
  const top = board.rows.slice(0, 3)
  const rest = board.rows.slice(3)
  const selfBelowFold = board.self !== null && board.self.rank > 3 && !rest.includes(board.self)

  /**
   * NOBODY HAS EARNED ANYTHING YET — which is not the same as "there are no
   * rows", and conflating the two is how the four empty states above became
   * unreachable copy.
   *
   * Migration 0017 made the board start from the ROSTER: every active seller
   * is listed, including the ones at $0, because the seller with the least to
   * celebrate was the only one who could not find themselves at all. So on
   * go-live day `rows` holds fifty names and is not empty — and the state the
   * §4.10 strings describe is the one where every one of those names reads
   * $0. That is protected item 9's board exactly: fifty names, fifty $0, the
   * footnote, and now a line that says what happens next.
   *
   * Read off `floorTotalCents`, which is zero precisely when every row is, and
   * through the money module's own predicate rather than a string comparison.
   */
  const nothingEarnedYet = isZero(fromWireString(board.floorTotalCents))

  return (
    <main
      style={{ maxWidth: '48rem', margin: '0 auto', padding: 'var(--space-10) var(--space-6)' }}
    >
      <header style={{ display: 'grid', gap: 'var(--space-4)' }}>
        <h1
          style={{
            fontSize: 'var(--type-3xl)',
            fontWeight: 'var(--font-weight-bold)',
            letterSpacing: '-0.015em',
          }}
        >
          Earnings
        </h1>

        <nav aria-label="Period" style={{ display: 'flex', gap: 'var(--space-2)' }}>
          {PERIOD_LABELS.map(([value, label]) => {
            const active = board.period === value
            return (
              <a
                key={value}
                href={`?period=${value}`}
                aria-current={active ? 'page' : undefined}
                style={{
                  padding: 'var(--space-2) var(--space-3)',
                  borderRadius: 'var(--radius-full)',
                  fontSize: 'var(--type-sm)',
                  fontWeight: active ? 'var(--font-weight-semibold)' : 'var(--font-weight-regular)',
                  textDecoration: 'none',
                  background: active ? 'var(--color-action-primary-bg)' : 'var(--color-surface-2)',
                  color: active ? 'var(--color-action-primary-fg)' : 'var(--color-text-secondary)',
                  border: '1px solid var(--color-border-subtle)',
                }}
              >
                {label}
              </a>
            )
          })}
        </nav>
      </header>

      <section style={{ marginTop: 'var(--space-8)' }}>
        {switching ? (
          <BoardSkeleton />
        ) : board.rows.length === 0 ? (
          <EmptyBoard period={board.period} />
        ) : (
          <>
            {/* ABOVE the roster, never instead of it. US-9.5 wants every
                active seller listed with nobody hidden, so this teaches and
                the names stay. */}
            {nothingEarnedYet ? (
              <div style={{ marginBottom: 'var(--space-6)' }}>
                <EmptyBoard period={board.period} />
              </div>
            ) : null}

            <Podium top={top} />

            <ul
              style={{
                margin: 'var(--space-8) 0 0',
                padding: 0,
                listStyle: 'none',
                display: 'grid',
                gap: 'var(--space-1)',
              }}
            >
              {rest.map((row) => (
                <BoardRow key={row.userId} row={row} />
              ))}
            </ul>

            {/* The viewer's own row is always reachable, even from rank 47.
                A board that hides you is a board you stop opening. */}
            {selfBelowFold && board.self ? (
              <>
                <hr
                  style={{
                    margin: 'var(--space-4) 0',
                    border: 0,
                    borderTop: '1px dashed var(--color-border-subtle)',
                  }}
                />
                <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
                  <BoardRow row={board.self} />
                </ul>
              </>
            ) : null}
          </>
        )}
      </section>

      <p
        style={{
          marginTop: 'var(--space-8)',
          fontSize: 'var(--type-xs)',
          color: 'var(--color-text-tertiary)',
        }}
      >
        Since launch. A win appears here about ten seconds after it is closed — the delay is the
        undo window, so a number on this board never corrects itself downward.
      </p>
      {/* PROTECTED ITEM 9, and it is the counterweight to the confetti.
          The permanent footnote is not clutter to be trimmed: ruling D8 says
          the ledger starts at go-live and imported history is not counted, and
          an owner who is not told that asks the question after the meeting
          instead of during it. The honest answer is no, and the dishonest
          answer is fifty spreadsheets of unverifiable numbers and a dispute on
          day one.

          The "silently lost" note on that item names the exact shortcut this
          resists — seeding the live ledger from a CSV import so the board is
          not blank at launch, which would make every number on a public board
          unverifiable forever. */}
      <footer
        style={{
          marginTop: 'var(--space-8)',
          paddingTop: 'var(--space-4)',
          borderTop: '1px solid var(--color-border-subtle)',
          display: 'grid',
          gap: 'var(--space-1)',
        }}
      >
        <p style={{ margin: 0, fontSize: 'var(--type-xs)', color: 'var(--color-text-tertiary)' }}>
          The board starts at go-live — imported history isn&rsquo;t counted.
        </p>

        {board.trackedSince ? (
          <p style={{ margin: 0, fontSize: 'var(--type-xs)', color: 'var(--color-text-tertiary)' }}>
            Earnings tracked since {board.trackedSince}
          </p>
        ) : null}

        {/* `lb.footnote.period_boundary`, and §4.8 calls it "the one place
            tenant_business_tz renders as a word". A bounded board is a
            question about WHEN it resets, and a seller in Phoenix reading a
            Today board stamped in the agency's timezone will otherwise answer
            it with their own — which is the wrong answer by up to three hours
            on the number they are judged by. All time has no boundary, so it
            gets no line. */}
        {board.period === 'all_time' ? null : (
          <p style={{ margin: 0, fontSize: 'var(--type-xs)', color: 'var(--color-text-tertiary)' }}>
            Periods reset at midnight, agency time.
          </p>
        )}

        {/* Only on the seeded tenant, and it says so in the seller's words
            rather than in a flag name. */}
        {board.isDemo ? (
          <p
            style={{
              margin: 0,
              marginTop: 'var(--space-1)',
              fontSize: 'var(--type-xs)',
              fontWeight: 'var(--font-weight-semibold)',
              color: 'var(--color-caution-text)',
            }}
          >
            Demo tenant — these numbers are seeded.
          </p>
        ) : null}
      </footer>
    </main>
  )
}

function EmptyBoard({ period }: { period: Period }): React.JSX.Element {
  const [headline, body] = BOARD_EMPTY[period]

  return (
    <div
      style={{
        padding: 'var(--space-8) var(--space-6)',
        textAlign: 'center',
        background: 'var(--color-surface-1)',
        border: '1px dashed var(--color-border-default)',
        borderRadius: 'var(--radius-lg)',
      }}
    >
      <p
        style={{
          margin: 0,
          fontSize: 'var(--type-lg)',
          fontWeight: 'var(--font-weight-semibold)',
        }}
      >
        {headline}
      </p>
      <p
        style={{
          margin: 0,
          marginTop: 'var(--space-2)',
          fontSize: 'var(--type-sm)',
          color: 'var(--color-text-secondary)',
        }}
      >
        {body}
      </p>
    </div>
  )
}

/**
 * Error and no-permission, which are different answers and must not look the
 * same. A surface without both does not exist, by the Definition of Done.
 */
export function ErrorBoundary(): React.JSX.Element {
  const error = useRouteError()
  const unauthorized = isRouteErrorResponse(error) && error.status === 401

  return (
    <main
      style={{ maxWidth: '32rem', margin: '0 auto', padding: 'var(--space-16) var(--space-6)' }}
    >
      <div
        role="alert"
        style={{
          padding: 'var(--space-6)',
          borderRadius: 'var(--radius-lg)',
          background: unauthorized ? 'var(--color-info-fill)' : 'var(--color-danger-fill)',
          border: `1px solid ${
            unauthorized ? 'var(--color-info-stroke)' : 'var(--color-danger-stroke)'
          }`,
        }}
      >
        <h1
          style={{
            fontSize: 'var(--type-lg)',
            fontWeight: 'var(--font-weight-semibold)',
            color: unauthorized ? 'var(--color-info-text)' : 'var(--color-danger-text)',
          }}
        >
          {unauthorized ? 'Sign in to see the board' : 'The board could not load'}
        </h1>

        <p
          style={{
            marginTop: 'var(--space-2)',
            fontSize: 'var(--type-sm)',
            color: 'var(--color-text-secondary)',
          }}
        >
          {unauthorized
            ? 'Earnings are visible to everyone on the team, but you need to be signed in.'
            : 'Nothing was lost. Your Earnings are recorded whether or not this screen can reach them.'}
        </p>

        {unauthorized ? null : (
          <a
            href="?"
            style={{
              display: 'inline-block',
              marginTop: 'var(--space-4)',
              padding: 'var(--space-2) var(--space-4)',
              borderRadius: 'var(--radius-md)',
              background: 'var(--color-action-primary-bg)',
              color: 'var(--color-action-primary-fg)',
              fontSize: 'var(--type-sm)',
              fontWeight: 'var(--font-weight-semibold)',
              textDecoration: 'none',
            }}
          >
            Try again
          </a>
        )}
      </div>
    </main>
  )
}
