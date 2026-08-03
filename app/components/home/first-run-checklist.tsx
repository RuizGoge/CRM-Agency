import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'

import type { HomeSetup } from '~/routes/api/home-setup'

/**
 * `FirstRunChecklist` (C-41) — US-9.14's four items, on the seller home.
 *
 * Three rules, and each one removes a control rather than adding one:
 *
 *   1. EVERY ITEM CHECKS OFF BY ITSELF. There is no "mark done" — US-9.14 and
 *      C-41 both say so — because a checklist a seller can tick is a checklist
 *      that says "verified" about a number nobody verified.
 *   2. IT COLLAPSES WHEN ALL FOUR ARE DONE AND NEVER RETURNS. Since it is a
 *      function of four conditions that do not go backwards, "never returns"
 *      is arithmetic and not a flag somebody has to remember to set.
 *   3. SUPERVISORS AND ADMINS NEVER SEE IT (`04b` §4.1, no-permission). They
 *      have no book to set up, and flow row 9 says they never saw it.
 *
 * ⚠️ IT CANNOT COMPLETE IN THIS BUILD, and that is the honest state rather
 * than a defect of this file. Item 1 asks whether the seller's calling number
 * is verified, and `aloware_number_mapping` does not exist yet — so the answer
 * is no, for everyone, and rule 2 never fires. A checklist that collapsed
 * anyway would be claiming a seller can dial when nothing can.
 *
 * Its own fetch, like every other block on this screen (`05-architecture.md`
 * §1.1 reason 2). The failure mode it is defending against is the same one:
 * setup state is the least important thing on the page, and it must not be
 * able to cost a seller their day.
 */

type State =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly setup: HomeSetup }
  | { readonly status: 'error' }

/** Item 4 lives in the browser, not the database. `null` before it is read. */
type AlertsState = 'granted' | 'denied' | 'default' | 'unsupported' | null

/**
 * `Notification.permission` is external state, so it is read through the hook
 * that exists for external state rather than copied into `useState` by an
 * effect. The server has no such object; `getServerSnapshot` returns `null` and
 * React reconciles the real value on hydration, which is the whole reason this
 * hook takes a third argument.
 *
 * The browser fires no event when a permission changes, so the store is
 * notified by the one thing in this file that can change it.
 */
let permissionListeners: ReadonlyArray<() => void> = []

function subscribeToPermission(onChange: () => void): () => void {
  permissionListeners = [...permissionListeners, onChange]
  return () => {
    permissionListeners = permissionListeners.filter((l) => l !== onChange)
  }
}

function permissionSnapshot(): AlertsState {
  return 'Notification' in window ? Notification.permission : 'unsupported'
}

/** Not yet known — never a guess. Guessing here flickers on first paint. */
function permissionServerSnapshot(): AlertsState {
  return null
}

export function FirstRunChecklist(): React.JSX.Element | null {
  const [state, setState] = useState<State>({ status: 'loading' })
  const alerts = useSyncExternalStore(
    subscribeToPermission,
    permissionSnapshot,
    permissionServerSnapshot,
  )

  const read = useCallback(async (signal: AbortSignal): Promise<State> => {
    const response = await fetch('/api/home-setup', {
      signal,
      headers: { accept: 'application/json' },
    })
    if (!response.ok) return { status: 'error' }
    return { status: 'ready', setup: (await response.json()) as HomeSetup }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    const apply = (next: State): void => {
      if (!controller.signal.aborted) setState(next)
    }

    void read(controller.signal).then(apply, () => apply({ status: 'error' }))

    return () => controller.abort()
  }, [read])

  const turnOnAlerts = useCallback((): void => {
    if (!('Notification' in window)) return

    const settle = (): void => {
      for (const listener of permissionListeners) listener()
    }
    // Resolved or rejected, the permission is re-read from the browser rather
    // than from the promise: a seller who dismisses the prompt leaves it at
    // `default`, and taking the answer from anywhere but the source is how a
    // checklist ends up claiming an alert channel that is not on.
    void Notification.requestPermission().then(settle, settle)
  }, [])

  // An error here is silence, deliberately, and it is the one block on this
  // screen where that is right. The checklist tells a seller what they have
  // NOT done yet; a red box claiming it could not find out is louder than the
  // thing it is reporting on, on the screen with the LCP budget.
  if (state.status !== 'ready') return null

  // Rule 3.
  if (!state.setup.isSeller) return null

  const alertsOn = alerts === 'granted'
  // `filter(Boolean).length` rather than summing casts: `Number(` is a build
  // error outside `app/lib/money/**`, and the rule is worth more than the
  // shorter spelling of a count of four booleans.
  const done = [
    state.setup.numberVerified,
    state.setup.stagesConfigured,
    state.setup.bookImported,
    alertsOn,
  ].filter(Boolean).length

  // Rule 2. `alerts === null` means the permission has not been read yet, so
  // a checklist at 3 of 4 does not flash away and back on the first paint.
  if (done === 4) return null

  return (
    <section
      aria-label="Get set up"
      style={{
        marginTop: 'var(--space-4)',
        padding: 'var(--space-4) var(--space-5)',
        background: 'var(--color-surface-1)',
        border: '1px solid var(--color-border-subtle)',
        borderRadius: 'var(--radius-lg)',
      }}
    >
      <h2
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: 'var(--space-3)',
          margin: 0,
          fontSize: 'var(--type-md)',
          fontWeight: 'var(--font-weight-semibold)',
        }}
      >
        Get set up
        <span
          style={{
            fontSize: 'var(--type-sm)',
            fontWeight: 'var(--font-weight-regular)',
            color: 'var(--color-text-secondary)',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {done} of 4
        </span>
      </h2>

      <ul style={{ margin: 'var(--space-3) 0 0', padding: 0, listStyle: 'none' }}>
        {/* Item 1. Unchecked for everyone until the Aloware module lands, and
            the sub-line says what that costs rather than leaving a bare ○. */}
        <Item done={state.setup.numberVerified} label="Test your calling number">
          {state.setup.numberVerified ? null : (
            <Hint>Not verified &mdash; leads won&rsquo;t route here yet.</Hint>
          )}
        </Item>

        <Item done={state.setup.stagesConfigured} label="Set up your stages">
          <Hint>Pick which ones count as Earnings.</Hint>
        </Item>

        {/* `home.checklist.3.waiting`. A seller cannot import their own book —
            the run is the admin's — so an unchecked item with no action would
            read as something they forgot to do. */}
        <Item done={state.setup.bookImported} label="Import your book">
          {state.setup.bookImported ? null : <Hint>Waiting on your admin</Hint>}
        </Item>

        <Item
          done={alertsOn}
          label="Turn on desktop alerts"
          action={
            alerts === 'default' ? (
              <button type="button" onClick={turnOnAlerts} style={BUTTON}>
                Turn on
              </button>
            ) : null
          }
        >
          {/* The browser will not ask twice, so the only honest thing left is
              to say what the seller loses — flow row 8's exact sentence. */}
          {alerts === 'denied' ? (
            <Hint>
              Desktop alerts are off. You&rsquo;ll only see new leads while this tab is open.
            </Hint>
          ) : null}
        </Item>
      </ul>
    </section>
  )
}

const BUTTON = {
  padding: 'var(--space-1) var(--space-3)',
  borderRadius: 'var(--radius-md)',
  border: '1px solid var(--color-action-secondary-border)',
  background: 'var(--color-action-secondary-bg)',
  color: 'var(--color-action-secondary-fg)',
  fontSize: 'var(--type-sm)',
  cursor: 'pointer',
} as const

/**
 * One row. C-41 gives every row a 44px target, which is the mobile minimum
 * and is not a preference: this screen is read one-handed on a phone.
 */
function Item({
  done,
  label,
  action,
  children,
}: {
  done: boolean
  label: string
  action?: React.ReactNode
  children?: React.ReactNode
}): React.JSX.Element {
  return (
    <li
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--space-3)',
        minHeight: 'var(--size-target-min)',
        padding: 'var(--space-1) 0',
      }}
    >
      {/* A mark AND a word. `Done` is the ratified label and it is what makes
          the state survive for a seller who cannot tell ✓ from ○. */}
      <span
        aria-hidden="true"
        style={{
          width: 'var(--size-icon-lg)',
          textAlign: 'center',
          color: done ? 'var(--color-success-text)' : 'var(--color-text-tertiary)',
        }}
      >
        {done ? '✓' : '○'}
      </span>

      <span style={{ flex: 1, minWidth: 0 }}>
        <span
          style={{
            fontSize: 'var(--type-base)',
            color: done ? 'var(--color-text-secondary)' : 'var(--color-text-primary)',
          }}
        >
          {label}
        </span>
        {children}
      </span>

      {done ? (
        <span
          style={{
            fontSize: 'var(--type-xs)',
            fontWeight: 'var(--font-weight-semibold)',
            color: 'var(--color-success-text)',
            whiteSpace: 'nowrap',
          }}
        >
          Done
        </span>
      ) : (
        action
      )}
    </li>
  )
}

function Hint({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <span
      style={{
        display: 'block',
        fontSize: 'var(--type-xs)',
        color: 'var(--color-text-tertiary)',
      }}
    >
      {children}
    </span>
  )
}
