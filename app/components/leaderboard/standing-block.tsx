import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router'

import { RankAndGap } from '~/components/leaderboard/rank-and-gap'
import type { BoardPayload } from '~/routes/api/leaderboard'

/**
 * The rank-and-gap block on the seller home.
 *
 * IT FETCHES ITS OWN DATA, and that is the whole reason it is a component
 * rather than three lines in My Day's loader. `05-architecture.md` §1.1 gives
 * four register-anchored reasons why application data must not travel through
 * a UI-route loader, and reason 2 names THIS SCREEN: every block on My Day is
 * an independent fetch with its own error and its own retry, so a downed
 * ranking block cannot take My Day down with it. A page loader is precisely
 * the pattern the register forbids here — and the standings read is the block
 * most likely to fail, because it is the one that crosses the silo.
 *
 * All four states are here because a surface without them does not exist:
 * skeleton while it loads, an inline error that leaves the rest of the day
 * intact, the signed-out answer, and the not-ranked answer a supervisor gets.
 * None of them is a spinner.
 *
 * NO INTERVAL, deliberately. The Earnings board polls at the registered
 * leaderboard cadence (N6, 5,000 ms) and the request floor in P5.2 budgets
 * that channel at a 0.6 duty of ONE tab per seller. Making the seller home a
 * second permanent client of the same channel raises N20's signed ~898,000
 * req/day by roughly 13%, and moving a number in the P5.3 table is a ruling
 * rather than an implementation detail. So this refreshes on mount and when
 * the tab returns to the foreground — which covers every navigation and every
 * return from the dialer — and the live board stays one click away.
 */

type State =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly board: BoardPayload }
  | { readonly status: 'unauthorized' }
  | { readonly status: 'error' }

export function StandingBlock(): React.JSX.Element {
  const [state, setState] = useState<State>({ status: 'loading' })

  /**
   * Plain `fetch`, and NOT `useFetcher`, which is the idiom everywhere else in
   * this codebase. A thrown Response from a resource-route loader is rendered
   * by the nearest error boundary, and `api/leaderboard` is a top-level route
   * with none — so a 401 or a 500 read through a fetcher would surface on the
   * ROOT boundary and blank the seller's day. That is the precise failure this
   * block is shaped to prevent, arriving through the framework instead of
   * through a page loader.
   *
   * Returns the next state rather than setting it: a function that only
   * computes is one an effect can call without cascading a render, and the
   * two callers below each decide for themselves whether their answer is still
   * wanted by the time it arrives.
   */
  const read = useCallback(async (signal?: AbortSignal): Promise<State> => {
    const response = await fetch('/api/leaderboard', {
      ...(signal ? { signal } : {}),
      headers: { accept: 'application/json' },
    })

    if (response.status === 401) return { status: 'unauthorized' }
    if (!response.ok) return { status: 'error' }
    return { status: 'ready', board: (await response.json()) as BoardPayload }
  }, [])

  const retry = useCallback((): void => {
    setState({ status: 'loading' })
    void read().then(setState, () => setState({ status: 'error' }))
  }, [read])

  useEffect(() => {
    const controller = new AbortController()

    // An abort is this component unmounting, or a refocus superseding a read
    // still in flight. Neither is a failure and neither may paint like one —
    // but everything else does get the error state, because a silently empty
    // band is how a seller learns to distrust the number.
    const apply = (next: State): void => {
      if (!controller.signal.aborted) setState(next)
    }
    const run = (): void => {
      void read(controller.signal).then(apply, () => apply({ status: 'error' }))
    }
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') run()
    }

    run()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      controller.abort()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [read])

  if (state.status === 'loading') {
    return (
      <Frame>
        <StandingSkeleton />
      </Frame>
    )
  }

  if (state.status === 'unauthorized') {
    return (
      <Frame>
        <Muted>Sign in to see where you stand.</Muted>
      </Frame>
    )
  }

  if (state.status === 'error') {
    return (
      <Frame>
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            gap: 'var(--space-3)',
          }}
        >
          {/* The ratified sentence for this block's error state (`04b` §4.1),
              and it follows conflict ruling J's pattern exactly: the system
              takes the blame, and `your` states the silo in two letters. */}
          <Muted>We couldn&rsquo;t load your rank.</Muted>
          <button
            type="button"
            onClick={retry}
            style={{
              padding: 'var(--space-1) var(--space-3)',
              borderRadius: 'var(--radius-md)',
              border: '1px solid var(--color-action-secondary-border)',
              background: 'var(--color-action-secondary-bg)',
              color: 'var(--color-action-secondary-fg)',
              fontSize: 'var(--type-sm)',
              cursor: 'pointer',
            }}
          >
            Retry
          </button>
        </div>
      </Frame>
    )
  }

  return (
    <Frame>
      {/* Feature 28: the widget taps through to the full board. A rank with no
          way to see who is above you is a scoreboard with the names torn off. */}
      <Link
        to="/earnings"
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: 'var(--space-3)',
          width: '100%',
          textDecoration: 'none',
          color: 'inherit',
        }}
      >
        <RankAndGap board={state.board} />
        <span
          style={{
            fontSize: 'var(--type-sm)',
            fontWeight: 'var(--font-weight-semibold)',
            color: 'var(--color-text-link)',
            whiteSpace: 'nowrap',
          }}
        >
          See the board
        </span>
      </Link>
    </Frame>
  )
}

/**
 * The band, shared by all four states so the block holds its place from the
 * first paint rather than appearing after the eye has already found the day's
 * first row. The min-height covers the desktop case, where a resolved standing
 * is one line; a narrow phone can wrap it past that, and that is fine — it
 * grows, it does not appear from nothing.
 */
function Frame({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <section
      aria-label="Your standing"
      style={{
        marginTop: 'var(--space-4)',
        padding: 'var(--space-4) var(--space-5)',
        minHeight: 'var(--size-row-stack-h)',
        display: 'flex',
        alignItems: 'center',
        background: 'var(--color-surface-1)',
        border: '1px solid var(--color-border-subtle)',
        // The money rail, the same idiom the board uses to mark the viewer's
        // own row: a colour AND a shape, so the signal survives WCAG 1.4.1.
        borderLeft: '3px solid var(--color-action-money-bg)',
        borderRadius: 'var(--radius-lg)',
      }}
    >
      {children}
    </section>
  )
}

function Muted({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <span style={{ fontSize: 'var(--type-sm)', color: 'var(--color-text-secondary)' }}>
      {children}
    </span>
  )
}

/** A skeleton, never a spinner — the shape of the sentence that is arriving. */
function StandingSkeleton(): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}
    >
      <Bar width="5rem" />
      <Bar width="7rem" />
      <Bar width="11rem" />
    </span>
  )
}

function Bar({ width }: { width: string }): React.JSX.Element {
  return (
    <span
      style={{
        display: 'block',
        width,
        height: 'var(--space-5)',
        borderRadius: 'var(--radius-sm)',
        background: 'var(--color-surface-3)',
      }}
    />
  )
}
