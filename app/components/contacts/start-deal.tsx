import { useCallback, useState } from 'react'

import type { StartDealResult } from '~/routes/api/opportunities'

/**
 * Start a deal — the affordance two screens have been pointing at.
 *
 * 🔴 THE COPY IT REPLACES WAS A DEAD END. Both this screen and the drawer said
 * "No open deal. Start one from your board", and the board has never had a way
 * to start one: `app.opportunity` had no writer anywhere in `app/`. A sentence
 * that names an action the product cannot perform is worse than an empty state
 * that says nothing, because the seller goes looking.
 *
 * ONE CONTACT LEGITIMATELY BUYS TWICE, so this is not hidden once a deal
 * exists — it sits under the list as a second action rather than an empty
 * state. That is also why the endpoint declares itself non-idempotent: there
 * is no key that separates a cross-sell from a double tap.
 *
 * ⚠️ NO OPTIMISTIC UI AND NO UNDO HERE, deliberately. The 5-second undo is for
 * moves, where the server holds the row and can walk it back. A created deal
 * has an id the client does not know until the server answers, and inventing
 * one to render early would mean a card that changes identity underneath a
 * seller. So this is the honest shape: disabled while in flight, then the row
 * arrives.
 */

type State =
  | { readonly status: 'idle' }
  | { readonly status: 'saving' }
  | { readonly status: 'error' }
  /** The contact is not this seller's, or is gone. One sentence for both. */
  | { readonly status: 'not_found' }

export function StartDeal({
  contactId,
  onStarted,
  hasDeals,
}: {
  contactId: string
  onStarted: () => void
  hasDeals: boolean
}): React.JSX.Element {
  const [state, setState] = useState<State>({ status: 'idle' })

  const start = useCallback(async () => {
    setState({ status: 'saving' })
    try {
      const response = await fetch('/api/opportunities', {
        method: 'POST',
        body: new URLSearchParams({ contactId }),
        headers: { accept: 'application/json' },
      })
      if (response.status === 404) {
        setState({ status: 'not_found' })
        return
      }
      if (!response.ok) {
        setState({ status: 'error' })
        return
      }
      const result = (await response.json()) as StartDealResult
      if (result.status !== 'created') {
        setState({ status: 'not_found' })
        return
      }
      setState({ status: 'idle' })
      onStarted()
    } catch {
      setState({ status: 'error' })
    }
  }, [contactId, onStarted])

  return (
    <div style={{ marginTop: 'var(--space-3)' }}>
      <button
        type="button"
        onClick={() => void start()}
        disabled={state.status === 'saving'}
        style={{
          minHeight: 'var(--size-target-min)',
          padding: 'var(--space-2) var(--space-4)',
          fontSize: 'var(--type-sm)',
          fontWeight: 'var(--font-weight-medium)',
          borderRadius: 'var(--radius-md)',
          border: '1px solid var(--color-action-secondary-border)',
          background:
            state.status === 'saving'
              ? 'var(--color-action-disabled-bg)'
              : 'var(--color-action-primary-bg)',
          color:
            state.status === 'saving'
              ? 'var(--color-action-disabled-fg)'
              : 'var(--color-action-primary-fg)',
        }}
      >
        {state.status === 'saving' ? 'Starting…' : hasDeals ? 'Start another deal' : 'Start a deal'}
      </button>

      {/* 🔴 THE ERROR IS VISIBLE AND INLINE. A button that silently does nothing
          is how a seller learns to distrust the screen — the same rule the
          board's optimistic correction follows. */}
      {state.status === 'error' ? (
        <p
          role="status"
          style={{
            marginTop: 'var(--space-2)',
            fontSize: 'var(--type-sm)',
            color: 'var(--color-text-secondary)',
          }}
        >
          That didn’t save. Nothing was lost — try again.
        </p>
      ) : null}

      {/* ONE sentence for "not yours" and "no longer there" alike. Two would be
          the 403 the silo rule exists to prevent, in softer words. */}
      {state.status === 'not_found' ? (
        <p
          role="status"
          style={{
            marginTop: 'var(--space-2)',
            fontSize: 'var(--type-sm)',
            color: 'var(--color-text-secondary)',
          }}
        >
          That contact isn’t in your book any more.
        </p>
      ) : null}
    </div>
  )
}
