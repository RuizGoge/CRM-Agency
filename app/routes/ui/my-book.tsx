import { useCallback, useEffect, useState } from 'react'

import { BookList } from '~/components/book/book-list'
import { BookTable } from '~/components/book/book-table'
import { BREAKPOINTS } from '~/styles/tokens/timing'
import type { BookPayload } from '~/routes/api/my-book'

/**
 * My Book — MVP item 24. ONE list, ONE status chip.
 *
 * It replaces the five seeded working lists discovery found, and the
 * replacement is the point: five lists is five places a lead can be missing
 * from, and a seller who has to check five checks two.
 *
 * 🔴 NO LOADER, AND NOT BY STYLE. `ui.loader_whitelist` sanctions exactly one
 * data loader and already carries two over budget; a fourth is rejected with
 * `AP005`. So this screen fetches its own data, which is what §1.1 wanted
 * anyway — the ratchet forced the architecture the register had already argued
 * for. The same thing happened to the contact screen.
 */

type State =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly book: BookPayload }
  | { readonly status: 'error' }

export function meta() {
  return [{ title: 'My Book — CRM Leads' }]
}

export default function MyBook(): React.JSX.Element {
  const [state, setState] = useState<State>({ status: 'loading' })
  const [wide, setWide] = useState(false)

  useEffect(() => {
    const query = window.matchMedia(`(min-width: ${String(BREAKPOINTS.lg)}px)`)
    const apply = (): void => {
      setWide(query.matches)
    }
    apply()
    query.addEventListener('change', apply)
    return () => {
      query.removeEventListener('change', apply)
    }
  }, [])

  const read = useCallback(async (signal: AbortSignal): Promise<State> => {
    const response = await fetch('/api/my-book', {
      signal,
      headers: { accept: 'application/json' },
    })
    if (!response.ok) return { status: 'error' }
    return { status: 'ready', book: (await response.json()) as BookPayload }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    const apply = (next: State): void => {
      if (!controller.signal.aborted) setState(next)
    }
    void read(controller.signal).then(apply, () => {
      apply({ status: 'error' })
    })
    return () => {
      controller.abort()
    }
  }, [read])

  return (
    <main style={{ maxWidth: '64rem', margin: '0 auto', padding: 'var(--space-8) var(--space-4)' }}>
      <h1 style={{ fontSize: 'var(--type-xl)', marginBottom: 'var(--space-4)' }}>My Book</h1>

      {/* SKELETONS, NEVER A SPINNER. A spinner says "something is happening";
          a skeleton says "four rows are coming", and the layout does not jump
          when they arrive. */}
      {state.status === 'loading' ? <BookSkeleton /> : null}

      {state.status === 'error' ? (
        <Notice
          heading="Your book could not load"
          body="Nothing was lost. Try again in a moment."
        />
      ) : null}

      {state.status === 'ready' && state.book.total === 0 ? (
        <Notice
          heading="Your book is empty."
          body="Add your first lead or ask your admin to import your list."
          action="Quick-add lead"
        />
      ) : null}

      {state.status === 'ready' && state.book.total > 0 ? (
        wide ? (
          <BookTable rows={state.book.rows} />
        ) : (
          <BookList rows={state.book.rows} />
        )
      ) : null}
    </main>
  )
}

function BookSkeleton(): React.JSX.Element {
  return (
    <div aria-hidden="true" data-testid="book-skeleton">
      {[0, 1, 2, 3, 4].map((i) => (
        <div
          key={i}
          style={{
            height: '48px',
            marginBottom: 'var(--space-2)',
            borderRadius: 'var(--radius-sm)',
            background: 'var(--color-surface-2)',
          }}
        />
      ))}
    </div>
  )
}

/**
 * An empty state that only reports absence is a defect — §4.10. So the body
 * says what to do next, and the action is the thing that does it.
 */
function Notice({
  heading,
  body,
  action,
}: {
  readonly heading: string
  readonly body: string
  readonly action?: string
}): React.JSX.Element {
  return (
    <div
      style={{
        padding: 'var(--space-8)',
        textAlign: 'center',
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-md)',
      }}
    >
      <p style={{ fontWeight: 'var(--font-weight-semibold)', marginBottom: 'var(--space-2)' }}>
        {heading}
      </p>
      <p style={{ color: 'var(--color-text-muted)' }}>{body}</p>
      {action === undefined ? null : (
        <a
          href="/board"
          style={{
            display: 'inline-block',
            marginTop: 'var(--space-4)',
            color: 'var(--color-accent)',
          }}
        >
          {action}
        </a>
      )}
    </div>
  )
}
