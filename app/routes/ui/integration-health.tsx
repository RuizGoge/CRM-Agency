import { useCallback, useEffect, useState } from 'react'

import type { HealthPayload } from '~/routes/api/integration-health'

import type { Route } from './+types/integration-health'

/**
 * `/admin/integration-health` — §4.6's five signals, rendered.
 *
 * *"The counter is a product surface, not a log."* Every number here is a row
 * somebody wrote at the moment something went wrong. Nothing is derived from a
 * log file, because a log is a thing nobody reads until after the outage it
 * described.
 *
 * 🔴 THE PERMANENT LINE IS THE POINT OF THIS SCREEN, not the counters. §4.2
 * ruling 3: *"the fact that we cannot verify is a permanent visible line on
 * /admin/integration-health, not an omission."* Gate G2 established Aloware
 * sends no signature, no timestamp and no nonce, so a captured request replays
 * for ever and the transport index is the only thing between it and us. A
 * screen that quietly showed "0 problems" would be lying by omission.
 */

export function meta(_: Route.MetaArgs) {
  return [{ title: 'Integration health — CRM Leads' }]
}

/**
 * 🔴 NO LOADER, AND THE RATCHET IS WHY. §1.2 sanctions exactly ONE SSR UI
 * loader (the pipeline) and three exist, so `ui.loader_whitelist` is registered
 * `shrink_only` and a fourth is refused with `AP005`. The contact screen was
 * shaped by the same refusal.
 *
 * The engine forced the architecture §1.1 wanted anyway: this screen fetches its
 * own data, so a failing health read renders an inline error instead of taking
 * the shell down through the framework's nearest error boundary.
 */
type State =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly payload: HealthPayload }
  | { readonly status: 'forbidden' }
  | { readonly status: 'error' }

const CARD = {
  border: '1px solid var(--color-border-subtle)',
  borderRadius: 'var(--radius-md)',
  padding: 'var(--space-5)',
  background: 'var(--color-surface-1)',
} as const

export default function IntegrationHealth(_: Route.ComponentProps): React.JSX.Element {
  const [state, setState] = useState<State>({ status: 'loading' })

  // Plain `fetch`, not `useFetcher`, for the same reason the standing block
  // gives: a thrown Response from a top-level resource route renders on the
  // ROOT boundary, and a 403 read through a fetcher would blank the shell
  // instead of rendering this screen's own no-permission state.
  const read = useCallback(async (signal?: AbortSignal): Promise<State> => {
    const response = await fetch('/api/integration-health', {
      ...(signal ? { signal } : {}),
      headers: { accept: 'application/json' },
    })
    if (response.status === 403) return { status: 'forbidden' }
    if (!response.ok) return { status: 'error' }
    return { status: 'ready', payload: (await response.json()) as HealthPayload }
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

  // Re-read after issuing or revoking. The credential list is the one part of
  // this screen the admin CHANGES, so it cannot be left showing what was true
  // before their click.
  const refresh = useCallback(() => {
    void read().then(setState, () => setState({ status: 'error' }))
  }, [read])

  // LOADING STATE — a skeleton, never a spinner.
  if (state.status === 'loading') {
    return (
      <Shell>
        <div aria-busy="true" aria-live="polite">
          <span
            style={{
              position: 'absolute',
              width: 1,
              height: 1,
              overflow: 'hidden',
              clip: 'rect(0 0 0 0)',
            }}
          >
            Loading integration health
          </span>
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              style={{
                ...CARD,
                marginTop: 'var(--space-3)',
                height: '4.5rem',
                background: 'var(--color-surface-2)',
              }}
            />
          ))}
        </div>
      </Shell>
    )
  }

  // ERROR STATE, inline, leaving the rest of the shell intact — and saying the
  // thing an admin actually needs to know, which is that nothing is being lost
  // while this screen is down.
  if (state.status === 'error') {
    return (
      <Shell>
        <p style={{ ...CARD, color: 'var(--color-text-secondary)' }}>
          We couldn&rsquo;t load integration health. Calls and texts are still being received and
          stored.
        </p>
      </Shell>
    )
  }

  // NO-PERMISSION STATE. A seller reaches this URL by typing it or following a
  // stale link; the rows are already unreachable to them by policy, so what is
  // left to decide is what they READ. A table of zeros would be
  // indistinguishable from a healthy tenant, which is the worse answer.
  if (state.status === 'forbidden') {
    return (
      <Shell>
        <p style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--type-lg)' }}>
          This page is for admins. Ask your admin if something looks wrong with calls or texts.
        </p>
      </Shell>
    )
  }

  const health = state.payload
  const quiet =
    health.alerts.length === 0 &&
    health.deadLetters.length === 0 &&
    health.unparsedDeliveries === 0 &&
    health.quarantinedCalls === 0

  return (
    <Shell>
      {/* ⚠️ ALWAYS RENDERED, INCLUDING WHEN EVERYTHING ELSE IS ZERO. This is the
          line §4.2 ruling 3 requires, and its killer shortcut is deleting it
          "because it is always there and always says the same thing". */}
      <section
        aria-labelledby="verification-heading"
        style={{
          ...CARD,
          borderColor: 'var(--color-caution-stroke)',
          background: 'var(--color-caution-fill)',
          marginBottom: 'var(--space-6)',
        }}
      >
        <h2
          id="verification-heading"
          style={{
            fontSize: 'var(--type-base)',
            fontWeight: 'var(--font-weight-semibold)',
            color: 'var(--color-caution-text)',
          }}
        >
          Webhook signatures can&rsquo;t be verified
        </h2>
        <p style={{ marginTop: 'var(--space-2)', color: 'var(--color-caution-text)' }}>
          Aloware doesn&rsquo;t sign the calls and texts it sends us, so we can&rsquo;t prove a
          delivery came from them. We keep every delivery and refuse repeats of the same bytes.
        </p>
      </section>

      <Endpoints endpoints={health.endpoints} onChanged={refresh} />

      {quiet ? (
        // EMPTY STATE, and it says what "empty" MEANS rather than reporting
        // absence twice. §4.10: "a state that only reports absence is a defect."
        <p
          style={{
            ...CARD,
            textAlign: 'center',
            padding: 'var(--space-10) var(--space-6)',
            color: 'var(--color-text-secondary)',
          }}
        >
          Nothing needs attention. Every call and text we received has landed in a seller&rsquo;s
          book.
        </p>
      ) : (
        <>
          <Counters health={health} />
          <Alerts alerts={health.alerts} />
          <DeadLetters items={health.deadLetters} />
        </>
      )}
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
          marginBottom: 'var(--space-6)',
        }}
      >
        Integration health
      </h1>
      {children}
    </main>
  )
}

/**
 * The ingest credential — issue, list, revoke.
 *
 * 🔴 THE EMPTY STATE IS THE REASON THIS SECTION EXISTS. With no live endpoint,
 * `app.webhook_ingest` resolves no tenant for any token, the edge answers 401 to
 * every delivery, and G2 measured that Aloware never retries. Every counter
 * above reads zero while that happens, because nothing was ever stored to count.
 * So "no connection" has to be the loudest thing on the screen, not a blank
 * list.
 */
function Endpoints({
  endpoints,
  onChanged,
}: {
  endpoints: HealthPayload['endpoints']
  onChanged: () => void
}): React.JSX.Element {
  const [label, setLabel] = useState('')
  const [busy, setBusy] = useState(false)
  const [issued, setIssued] = useState<{ token: string } | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)

  const live = endpoints.filter((e) => e.revokedAt === null)

  const post = useCallback(
    async (body: Record<string, string>): Promise<Response> =>
      fetch('/api/webhook-endpoints', {
        method: 'POST',
        headers: { accept: 'application/json' },
        body: new URLSearchParams(body),
      }),
    [],
  )

  const issue = useCallback(async (): Promise<void> => {
    setBusy(true)
    setProblem(null)
    try {
      const response = await post({ intent: 'issue', provider: 'aloware', label })
      const result = (await response.json()) as
        | { status: 'issued'; token: string }
        | { status: 'invalid'; reason: string }
        | { status: 'forbidden' }

      if (result.status === 'issued') {
        setIssued({ token: result.token })
        setLabel('')
        onChanged()
      } else if (result.status === 'invalid') {
        setProblem(result.reason)
      } else {
        setProblem('Only admins can change this.')
      }
    } catch {
      // 🔴 THE SERVER DISAGREEING MUST BE VISIBLE. A silent failure here reads
      // as "nothing happened" while the operator believes they have a token.
      setProblem('We couldn’t reach the server. Nothing was created.')
    } finally {
      setBusy(false)
    }
  }, [label, onChanged, post])

  const revoke = useCallback(
    async (endpointId: string): Promise<void> => {
      setBusy(true)
      setProblem(null)
      try {
        const response = await post({ intent: 'revoke', endpointId })
        if (!response.ok) setProblem('That endpoint is already gone.')
        setConfirming(null)
        onChanged()
      } catch {
        setProblem('We couldn’t reach the server. Nothing changed.')
      } finally {
        setBusy(false)
      }
    },
    [onChanged, post],
  )

  return (
    <section aria-labelledby="endpoints-heading" style={{ marginBottom: 'var(--space-6)' }}>
      <h2
        id="endpoints-heading"
        style={{ fontSize: 'var(--type-lg)', fontWeight: 'var(--font-weight-semibold)' }}
      >
        Aloware connection
      </h2>

      {live.length === 0 && (
        <p
          role="alert"
          style={{
            ...CARD,
            marginTop: 'var(--space-3)',
            borderColor: 'var(--color-danger-stroke)',
            background: 'var(--color-danger-fill)',
            color: 'var(--color-danger-text)',
          }}
        >
          <strong>Nothing is connected.</strong> Aloware can&rsquo;t reach us, so every call and
          text it sends is being turned away and is not kept. Create an endpoint below, then paste
          its URL into Aloware.
        </p>
      )}

      {/* THE TOKEN, ONCE. Only its digest is stored, so there is no second read
          and no recovery — an admin who loses it issues another and revokes
          this one. Saying so beside the value is the whole affordance. */}
      {issued !== null && (
        <div
          role="status"
          style={{
            ...CARD,
            marginTop: 'var(--space-3)',
            borderColor: 'var(--color-success-stroke)',
            background: 'var(--color-success-fill)',
          }}
        >
          <p style={{ fontWeight: 'var(--font-weight-semibold)' }}>
            Paste this URL into Aloware now — you won&rsquo;t be able to see it again.
          </p>
          <code
            style={{
              display: 'block',
              marginTop: 'var(--space-2)',
              padding: 'var(--space-3)',
              background: 'var(--color-surface-2)',
              borderRadius: 'var(--radius-sm)',
              fontSize: 'var(--type-sm)',
              overflowWrap: 'anywhere',
            }}
          >
            {`${globalThis.location?.origin ?? ''}/webhooks/aloware/v1/${issued.token}`}
          </code>
          <button
            type="button"
            onClick={() => setIssued(null)}
            style={{ marginTop: 'var(--space-3)' }}
          >
            I&rsquo;ve saved it
          </button>
        </div>
      )}

      {problem !== null && (
        <p role="alert" style={{ marginTop: 'var(--space-3)', color: 'var(--color-danger-text)' }}>
          {problem}
        </p>
      )}

      <ul style={{ listStyle: 'none', padding: 0, marginTop: 'var(--space-3)' }}>
        {endpoints.map((e) => (
          <li key={e.endpointId} style={{ ...CARD, marginTop: 'var(--space-3)' }}>
            <div style={{ fontWeight: 'var(--font-weight-semibold)' }}>{e.label}</div>
            <p
              style={{
                marginTop: 'var(--space-1)',
                fontSize: 'var(--type-sm)',
                color: 'var(--color-text-tertiary)',
              }}
            >
              {e.provider} · added {e.createdAt.slice(0, 10)}
              {e.revokedAt === null ? '' : ` · turned off ${e.revokedAt.slice(0, 10)}`}
            </p>

            {e.revokedAt === null &&
              // ⚠️ A CONFIRM STEP, NOT OPTIMISTIC-WITH-UNDO, and the exception is
              // argued rather than assumed. The house rule prefers a 5 s undo
              // "where it is safe"; here it is not. From the instant a revoke
              // commits the edge answers 401, and Aloware does not retry — so
              // everything sent during an undo window is lost for good rather
              // than replayed. Two clicks beat five seconds of silent loss.
              (confirming === e.endpointId ? (
                <div style={{ marginTop: 'var(--space-3)' }}>
                  <button type="button" disabled={busy} onClick={() => void revoke(e.endpointId)}>
                    Yes, turn it off
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setConfirming(null)}
                    style={{ marginLeft: 'var(--space-2)' }}
                  >
                    Keep it
                  </button>
                  <p
                    style={{
                      marginTop: 'var(--space-2)',
                      fontSize: 'var(--type-sm)',
                      color: 'var(--color-text-tertiary)',
                    }}
                  >
                    Calls and texts sent after this are turned away and can&rsquo;t be recovered.
                    Add the replacement in Aloware first.
                  </p>
                </div>
              ) : (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setConfirming(e.endpointId)}
                  style={{ marginTop: 'var(--space-3)' }}
                >
                  Turn off
                </button>
              ))}
          </li>
        ))}
      </ul>

      <div style={{ ...CARD, marginTop: 'var(--space-3)' }}>
        <label htmlFor="endpoint-label" style={{ fontWeight: 'var(--font-weight-semibold)' }}>
          Add an endpoint
        </label>
        <p
          style={{
            marginTop: 'var(--space-1)',
            fontSize: 'var(--type-sm)',
            color: 'var(--color-text-tertiary)',
          }}
        >
          Name it after where you&rsquo;ll paste it, so you know which one to turn off later.
        </p>
        <input
          id="endpoint-label"
          value={label}
          maxLength={80}
          disabled={busy}
          onChange={(event) => setLabel(event.target.value)}
          placeholder="Aloware production"
          style={{
            display: 'block',
            marginTop: 'var(--space-2)',
            padding: 'var(--space-2)',
            width: '100%',
            maxWidth: '24rem',
            border: '1px solid var(--color-border-subtle)',
            borderRadius: 'var(--radius-sm)',
            background: 'var(--color-surface-1)',
            color: 'var(--color-text-primary)',
          }}
        />
        <button
          type="button"
          disabled={busy || label.trim() === ''}
          onClick={() => void issue()}
          style={{ marginTop: 'var(--space-3)' }}
        >
          {busy ? 'Working…' : 'Create endpoint'}
        </button>
      </div>
    </section>
  )
}

function Counters({ health }: { health: HealthPayload }): React.JSX.Element {
  const items: readonly { label: string; value: number; note: string }[] = [
    {
      label: 'Calls with no owner',
      value: health.quarantinedCalls,
      note: 'Kept, and in nobody’s book. We never guess an owner.',
    },
    {
      label: 'Deliveries we couldn’t read',
      value: health.unparsedDeliveries,
      note: 'Stored exactly as they arrived, so they can be replayed.',
    },
  ]

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(14rem, 1fr))',
        gap: 'var(--space-4)',
        marginBottom: 'var(--space-6)',
      }}
    >
      {items.map((item) => (
        <div key={item.label} style={CARD}>
          <div style={{ fontSize: 'var(--type-3xl)', fontWeight: 'var(--font-weight-bold)' }}>
            {item.value}
          </div>
          <div style={{ fontWeight: 'var(--font-weight-semibold)' }}>{item.label}</div>
          <p
            style={{
              marginTop: 'var(--space-1)',
              fontSize: 'var(--type-sm)',
              color: 'var(--color-text-tertiary)',
            }}
          >
            {item.note}
          </p>
        </div>
      ))}
    </div>
  )
}

function Alerts({ alerts }: { alerts: HealthPayload['alerts'] }): React.JSX.Element | null {
  if (alerts.length === 0) return null

  return (
    <section aria-labelledby="alerts-heading" style={{ marginBottom: 'var(--space-6)' }}>
      <h2
        id="alerts-heading"
        style={{ fontSize: 'var(--type-lg)', fontWeight: 'var(--font-weight-semibold)' }}
      >
        Needs a decision
      </h2>
      <ul style={{ listStyle: 'none', padding: 0, marginTop: 'var(--space-3)' }}>
        {alerts.map((alert) => (
          <li
            key={`${alert.kind}:${alert.subjectKey}`}
            style={{ ...CARD, marginTop: 'var(--space-3)' }}
          >
            <p>{alert.detail}</p>
            <p
              style={{
                marginTop: 'var(--space-2)',
                fontSize: 'var(--type-sm)',
                color: 'var(--color-text-tertiary)',
              }}
            >
              {/* The count is the whole reason these are one row instead of
                  fifty. "Seen 50 times" is actionable; fifty identical rows are
                  a thing to scroll past. */}
              Seen {alert.occurrenceCount} {alert.occurrenceCount === 1 ? 'time' : 'times'}
              {alert.acknowledgeable ? '' : ' · This one stays until it’s fixed'}
            </p>
          </li>
        ))}
      </ul>
    </section>
  )
}

function DeadLetters({ items }: { items: HealthPayload['deadLetters'] }): React.JSX.Element | null {
  if (items.length === 0) return null

  return (
    <section aria-labelledby="dlq-heading">
      <h2
        id="dlq-heading"
        style={{ fontSize: 'var(--type-lg)', fontWeight: 'var(--font-weight-semibold)' }}
      >
        Held for review
      </h2>
      <ul style={{ listStyle: 'none', padding: 0, marginTop: 'var(--space-3)' }}>
        {items.map((item) => (
          <li
            key={`${item.origin}:${item.subjectType}:${item.lastSeenAt}`}
            style={{ ...CARD, marginTop: 'var(--space-3)' }}
          >
            <p>{item.reason}</p>
            <p
              style={{
                marginTop: 'var(--space-2)',
                fontSize: 'var(--type-sm)',
                color: 'var(--color-text-tertiary)',
              }}
            >
              Tried {item.attemptCount} {item.attemptCount === 1 ? 'time' : 'times'}
              {/* Honest about the retention clock: the DLQ holds the body BY
                  REFERENCE, so once the vault purges it there is nothing left to
                  replay. Saying so beats a Replay button that fails. */}
              {item.bodyRetained ? '' : ' · The original is past its retention window'}
            </p>
          </li>
        ))}
      </ul>
    </section>
  )
}
