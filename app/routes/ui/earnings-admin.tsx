import { useCallback, useEffect, useState } from 'react'

import type { BoardPayload } from '~/routes/api/leaderboard'
import type { CorrectionResult } from '~/routes/api/ledger-corrections'

import type { Route } from './+types/earnings-admin'

/**
 * `/admin/earnings` — correcting a wrong number on the public board.
 *
 * 🔴 THE LEDGER IS APPEND-ONLY AND STAYS THAT WAY. This screen does not edit
 * anything. It appends a compensating entry, so the board reads right while the
 * history of how it got there survives — which is what Jorge chose (2026-08-12)
 * over removing the rule.
 *
 * ⚠️ IT READS `/api/leaderboard` RATHER THAN A NEW ADMIN ENDPOINT. The board
 * already returns exactly what an admin needs before correcting — every seller,
 * their id, and their current total as a string of whole cents — and a second
 * read of the same rows would be a second thing to keep true.
 */

export function meta(_: Route.MetaArgs) {
  return [{ title: 'Correct earnings — CRM Leads' }]
}

/**
 * NO LOADER, and the ratchet is why: §1.2 sanctions exactly ONE SSR UI loader
 * and three exist, so a fourth is refused with `AP005`. The engine forces the
 * architecture §1.1 wanted anyway — a failing read renders inline instead of
 * taking the shell down.
 */
type State =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly board: BoardPayload }
  | { readonly status: 'forbidden' }
  | { readonly status: 'error' }

const CARD = {
  border: '1px solid var(--color-border-subtle)',
  borderRadius: 'var(--radius-md)',
  padding: 'var(--space-5)',
  background: 'var(--color-surface-1)',
} as const

const FIELD = {
  display: 'block',
  marginTop: 'var(--space-2)',
  padding: 'var(--space-2)',
  width: '100%',
  maxWidth: '24rem',
  border: '1px solid var(--color-border-subtle)',
  borderRadius: 'var(--radius-sm)',
  background: 'var(--color-surface-1)',
  color: 'var(--color-text-primary)',
} as const

export default function EarningsAdmin(_: Route.ComponentProps): React.JSX.Element {
  const [state, setState] = useState<State>({ status: 'loading' })

  const read = useCallback(async (signal?: AbortSignal): Promise<State> => {
    const response = await fetch('/api/leaderboard?period=all_time', {
      ...(signal ? { signal } : {}),
      headers: { accept: 'application/json' },
    })
    if (response.status === 403) return { status: 'forbidden' }
    if (!response.ok) return { status: 'error' }
    return { status: 'ready', board: (await response.json()) as BoardPayload }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    void read(controller.signal).then(setState, () => {
      if (!controller.signal.aborted) setState({ status: 'error' })
    })
    return () => {
      controller.abort()
    }
  }, [read])

  const refresh = useCallback(() => {
    void read().then(setState, () => setState({ status: 'error' }))
  }, [read])

  if (state.status === 'loading') {
    // A skeleton, never a spinner.
    return (
      <Shell>
        <div aria-busy="true" aria-live="polite">
          <span style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden' }}>
            Loading the board
          </span>
          {[0, 1].map((i) => (
            <div
              key={i}
              style={{
                ...CARD,
                marginTop: 'var(--space-3)',
                height: '5rem',
                background: 'var(--color-surface-2)',
              }}
            />
          ))}
        </div>
      </Shell>
    )
  }

  if (state.status === 'error') {
    return (
      <Shell>
        <p style={{ ...CARD, color: 'var(--color-text-secondary)' }}>
          We couldn&rsquo;t load the board. Nothing has been changed.
        </p>
      </Shell>
    )
  }

  if (state.status === 'forbidden') {
    return (
      <Shell>
        <p style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--type-lg)' }}>
          This page is for admins. If a number looks wrong, ask your admin to correct it.
        </p>
      </Shell>
    )
  }

  const rows = state.board.rows
  if (rows.length === 0) {
    // EMPTY STATE that says what empty MEANS, rather than reporting absence
    // twice — §4.10: "a state that only reports absence is a defect."
    return (
      <Shell>
        <p
          style={{
            ...CARD,
            textAlign: 'center',
            padding: 'var(--space-10) var(--space-6)',
            color: 'var(--color-text-secondary)',
          }}
        >
          Nobody is on the board yet. There is no number to correct until the first sale lands.
        </p>
      </Shell>
    )
  }

  return (
    <Shell>
      <Correction rows={rows} onApplied={refresh} />
    </Shell>
  )
}

function Shell({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <main
      style={{ maxWidth: '52rem', margin: '0 auto', padding: 'var(--space-10) var(--space-6)' }}
    >
      <h1
        style={{
          fontSize: 'var(--type-3xl)',
          fontWeight: 'var(--font-weight-bold)',
          letterSpacing: '-0.015em',
          marginBottom: 'var(--space-3)',
        }}
      >
        Correct earnings
      </h1>
      {/* ⚠️ THE STANDING LINE. An admin arriving here should know before they
          type that this does not erase anything — the original entry stays and
          the correction sits beside it. */}
      <p style={{ marginBottom: 'var(--space-6)', color: 'var(--color-text-secondary)' }}>
        Corrections are added, never erased. The original entry stays on the record and your
        correction sits beside it with your name and your reason.
      </p>
      {children}
    </main>
  )
}

function Correction({
  rows,
  onApplied,
}: {
  rows: BoardPayload['rows']
  onApplied: () => void
}): React.JSX.Element {
  const [ownerUserId, setOwnerUserId] = useState(rows[0]?.userId ?? '')
  const [amount, setAmount] = useState('')
  const [direction, setDirection] = useState<'add' | 'remove'>('remove')
  const [reason, setReason] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [applied, setApplied] = useState<string | null>(null)

  // 🔴 ONE KEY PER OPEN FORM. It rides into `app.ledger_adjust` as
  // `source_event_id`, so a double submit lands on the ledger's own dedupe index
  // instead of crediting twice. Regenerated only after a correction lands, which
  // is what makes a SECOND, deliberate correction possible.
  const [key, setKey] = useState(() => crypto.randomUUID())

  const target = rows.find((r) => r.userId === ownerUserId)

  const submit = useCallback(async (): Promise<void> => {
    setBusy(true)
    setProblem(null)
    try {
      const response = await fetch('/api/ledger-corrections', {
        method: 'POST',
        headers: { accept: 'application/json' },
        body: new URLSearchParams({
          ownerUserId,
          amount,
          direction,
          reason,
          idempotencyKey: key,
        }),
      })
      const result = (await response.json()) as CorrectionResult

      if (result.status === 'applied') {
        setApplied(result.deltaCents)
        setAmount('')
        setReason('')
        setConfirming(false)
        setKey(crypto.randomUUID())
        onApplied()
      } else if (result.status === 'invalid') {
        setProblem(result.reason)
      } else if (result.status === 'not_found') {
        setProblem('That seller is not on this team any more. Reload the page.')
      } else {
        setProblem('Only admins can correct the board.')
      }
    } catch {
      // 🔴 A SILENT FAILURE HERE READS AS "nothing happened" while the admin
      // believes the board moved. The server disagreeing must always be visible.
      setProblem('We couldn’t reach the server. Nothing was changed.')
    } finally {
      setBusy(false)
    }
  }, [amount, direction, key, onApplied, ownerUserId, reason])

  const ready = ownerUserId !== '' && amount.trim() !== '' && reason.trim().length >= 10

  return (
    <section aria-labelledby="correction-heading" style={CARD}>
      <h2
        id="correction-heading"
        style={{ fontSize: 'var(--type-lg)', fontWeight: 'var(--font-weight-semibold)' }}
      >
        Add a correction
      </h2>

      {applied !== null && (
        <p
          role="status"
          style={{
            ...CARD,
            marginTop: 'var(--space-3)',
            borderColor: 'var(--color-success-stroke)',
            background: 'var(--color-success-fill)',
          }}
        >
          Correction recorded. The board has been updated.
        </p>
      )}

      {problem !== null && (
        <p role="alert" style={{ marginTop: 'var(--space-3)', color: 'var(--color-danger-text)' }}>
          {problem}
        </p>
      )}

      <label htmlFor="seller" style={{ display: 'block', marginTop: 'var(--space-4)' }}>
        Whose total
      </label>
      <select
        id="seller"
        value={ownerUserId}
        disabled={busy}
        onChange={(e) => setOwnerUserId(e.target.value)}
        style={FIELD}
      >
        {rows.map((row) => (
          <option key={row.userId} value={row.userId}>
            {row.displayName}
          </option>
        ))}
      </select>

      <fieldset style={{ marginTop: 'var(--space-4)', border: 0, padding: 0 }}>
        <legend style={{ fontWeight: 'var(--font-weight-semibold)' }}>Add or remove</legend>
        {/* POSITIVE AMOUNT PLUS A DIRECTION rather than a typed minus sign: a
            dropped `-` would silently double the number instead of halving it. */}
        {(['remove', 'add'] as const).map((d) => (
          <label key={d} style={{ marginRight: 'var(--space-4)' }}>
            <input
              type="radio"
              name="direction"
              value={d}
              checked={direction === d}
              disabled={busy}
              onChange={() => setDirection(d)}
            />{' '}
            {d === 'remove' ? 'Remove from their total' : 'Add to their total'}
          </label>
        ))}
      </fieldset>

      <label htmlFor="amount" style={{ display: 'block', marginTop: 'var(--space-4)' }}>
        How much
      </label>
      <input
        id="amount"
        value={amount}
        disabled={busy}
        inputMode="decimal"
        placeholder="$310.00"
        onChange={(e) => setAmount(e.target.value)}
        style={FIELD}
      />

      <label htmlFor="reason" style={{ display: 'block', marginTop: 'var(--space-4)' }}>
        Why
      </label>
      <p
        style={{
          marginTop: 'var(--space-1)',
          fontSize: 'var(--type-sm)',
          color: 'var(--color-text-tertiary)',
        }}
      >
        This note is the only record of why the board moved without a deal. At least 10 characters.
      </p>
      <textarea
        id="reason"
        value={reason}
        disabled={busy}
        rows={2}
        onChange={(e) => setReason(e.target.value)}
        style={FIELD}
      />

      {/* ⚠️ A CONFIRM STEP, NOT OPTIMISTIC-WITH-UNDO, and the exception is
          argued rather than assumed. The house rule prefers a 5 s undo "where it
          is safe"; here it is not. This moves a PUBLIC board that fifty people
          compete on, and the undo slot on a ledger entry belongs to the seller's
          own five-second window — an admin correction must not consume it. Two
          clicks beat a silent wrong number in front of the whole floor. */}
      {confirming ? (
        <div style={{ marginTop: 'var(--space-5)' }}>
          <p style={{ fontWeight: 'var(--font-weight-semibold)' }}>
            {direction === 'remove' ? 'Remove' : 'Add'} {amount}{' '}
            {direction === 'remove' ? 'from' : 'to'} {target?.displayName ?? 'this seller'}&rsquo;s
            total?
          </p>
          <p
            style={{
              marginTop: 'var(--space-1)',
              fontSize: 'var(--type-sm)',
              color: 'var(--color-text-tertiary)',
            }}
          >
            This shows on the public board right away, with your name on the record.
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={() => void submit()}
            style={{ marginTop: 'var(--space-3)' }}
          >
            {busy ? 'Recording…' : 'Yes, correct it'}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => setConfirming(false)}
            style={{ marginTop: 'var(--space-3)', marginLeft: 'var(--space-2)' }}
          >
            Go back
          </button>
        </div>
      ) : (
        <button
          type="button"
          disabled={!ready || busy}
          onClick={() => setConfirming(true)}
          style={{ marginTop: 'var(--space-5)' }}
        >
          Review this correction
        </button>
      )}
    </section>
  )
}
