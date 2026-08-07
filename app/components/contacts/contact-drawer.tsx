import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'

import { format, fromWireString } from '~/lib/money/money'
import type { DialOutcome } from '~/routes/api/calls'
import type { ContactRecord } from '~/routes/api/contact'

/**
 * The record drawer — a seller's first glance at a contact, from the board.
 *
 * §6.1 already names this surface ("a component inside the board route dies the
 * moment the seller opens the record drawer"), so it is a drawer rather than a
 * modal by the corpus rather than by taste.
 *
 * NO ROUTE, DELIBERATELY. `ui.loader_whitelist` is `shrink_only` with three
 * routes registered, so a fourth UI route carrying data would be refused by
 * `AP005`. This fetches its own data, exactly as the full contact screen does,
 * and nothing about it can take the board down.
 *
 * ⚠️ ESCAPE RETURNS FOCUS TO WHAT OPENED IT. That is the rule everyone skips
 * and the one a mouse never tests — the search overlay already carries it, and
 * this is the second surface that has to.
 */

type State =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly contact: ContactRecord }
  | { readonly status: 'not_found' }
  | { readonly status: 'error' }

export function ContactDrawer({
  contactId,
  onClose,
}: {
  contactId: string
  onClose: () => void
}): React.JSX.Element {
  const [state, setState] = useState<State>({ status: 'loading' })
  const panel = useRef<HTMLDivElement | null>(null)
  /** Whatever had focus when the drawer opened. Restored on every exit path. */
  const opener = useRef<HTMLElement | null>(null)

  useEffect(() => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    panel.current?.focus()
    return () => opener.current?.focus()
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    const controller = new AbortController()
    const apply = (next: State): void => {
      if (!controller.signal.aborted) setState(next)
    }

    void fetch(`/api/contacts/${contactId}`, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    })
      .then(async (response): Promise<State> => {
        if (response.status === 404) return { status: 'not_found' }
        if (!response.ok) return { status: 'error' }
        return { status: 'ready', contact: (await response.json()) as ContactRecord }
      })
      .then(apply, () => apply({ status: 'error' }))

    return () => controller.abort()
  }, [contactId])

  return (
    <div
      // The scrim. Clicking it closes — a drawer that can only be dismissed by
      // a button is a drawer sellers get stuck in on a phone.
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 40,
        background: 'var(--color-overlay)',
        display: 'flex',
        justifyContent: 'flex-end',
      }}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label="Contact"
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
        style={{
          width: 'min(28rem, 100%)',
          height: '100%',
          overflowY: 'auto',
          background: 'var(--color-canvas)',
          borderLeft: '1px solid var(--color-border-default)',
          padding: 'var(--space-6)',
        }}
      >
        <div
          style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 'var(--space-2)' }}
        >
          <button
            type="button"
            onClick={onClose}
            style={{
              background: 'none',
              border: 'none',
              padding: 'var(--space-1)',
              fontSize: 'var(--type-sm)',
              color: 'var(--color-text-link)',
              cursor: 'pointer',
            }}
          >
            Close
          </button>
        </div>

        {state.status === 'loading' ? <Skeleton /> : null}

        {/* One sentence for "not yours" and "does not exist" alike. Two would be
            the 403 this rule exists to prevent, in softer words. */}
        {state.status === 'not_found' ? (
          <Notice
            heading="That contact isn't in your book"
            body="It may have moved to another seller."
          />
        ) : null}

        {state.status === 'error' ? (
          <Notice
            heading="This contact could not load"
            body="Nothing was lost. Close and try again."
          />
        ) : null}

        {state.status === 'ready' ? (
          <FirstView contact={state.contact} contactId={contactId} />
        ) : null}
      </div>
    </div>
  )
}

function FirstView({
  contact,
  contactId,
}: {
  contact: ContactRecord
  contactId: string
}): React.JSX.Element {
  const primary = contact.phones.find((p) => p.isPrimary) ?? contact.phones[0]

  return (
    <>
      <h2
        style={{
          fontSize: 'var(--type-xl)',
          fontWeight: 'var(--font-weight-bold)',
          letterSpacing: '-0.015em',
        }}
      >
        {contact.fullName}
      </h2>

      <CallControl contactId={contactId} firstName={contact.fullName.split(' ')[0] ?? 'them'} />

      <dl
        style={{
          display: 'grid',
          gridTemplateColumns: 'auto 1fr',
          gap: 'var(--space-2) var(--space-4)',
          marginTop: 'var(--space-5)',
          fontSize: 'var(--type-sm)',
        }}
      >
        {primary === undefined ? (
          <Row label="Phone" value="No number on file" />
        ) : (
          contact.phones.map((phone) => (
            <Row key={phone.e164} label={phone.isPrimary ? 'Phone' : 'Also'} value={phone.e164} />
          ))
        )}
        {contact.email === null ? null : <Row label="Email" value={contact.email} />}
        {contact.stateCode === null ? null : <Row label="State" value={contact.stateCode} />}
        <Row
          label="Last touch"
          value={
            contact.daysSinceTouch === null
              ? 'Not called yet'
              : contact.daysSinceTouch === 0
                ? 'Today'
                : `${contact.daysSinceTouch} days ago`
          }
        />
      </dl>

      <h3
        style={{
          marginTop: 'var(--space-6)',
          fontSize: 'var(--type-sm)',
          fontWeight: 'var(--font-weight-semibold)',
        }}
      >
        Deals
      </h3>

      {contact.deals.length === 0 ? (
        <p
          style={{
            marginTop: 'var(--space-2)',
            fontSize: 'var(--type-sm)',
            color: 'var(--color-text-secondary)',
          }}
        >
          No open deal. Start one from your board.
        </p>
      ) : (
        <ul
          style={{
            margin: 'var(--space-3) 0 0',
            padding: 0,
            listStyle: 'none',
            display: 'grid',
            gap: 'var(--space-2)',
          }}
        >
          {contact.deals.map((deal) => (
            <li
              key={deal.id}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                gap: 'var(--space-4)',
                padding: 'var(--space-3) var(--space-4)',
                background: 'var(--color-surface-1)',
                border: '1px solid var(--color-border-subtle)',
                borderRadius: 'var(--radius-md)',
                fontSize: 'var(--type-sm)',
              }}
            >
              <span>{deal.stageName}</span>
              {deal.premiumCents === null ? (
                <span style={{ color: 'var(--color-text-tertiary)' }}>No value yet</span>
              ) : (
                <span
                  className="money"
                  style={{
                    color:
                      deal.stageType === 'earning'
                        ? 'var(--color-money-positive)'
                        : 'var(--color-money-neutral)',
                  }}
                >
                  {format(fromWireString(deal.premiumCents))}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}

      {/* The way out of the glance and into the record. The drawer is a first
          view by design; everything else lives on the full screen. */}
      <Link
        to={`/contacts/${contactId}`}
        style={{
          display: 'inline-block',
          marginTop: 'var(--space-6)',
          fontSize: 'var(--type-sm)',
          color: 'var(--color-text-link)',
        }}
      >
        Open the full record
      </Link>
    </>
  )
}

/**
 * The Call control and every outcome it can reach.
 *
 * 🔴 IT NEVER RENDERS A SUCCESS IT DID NOT GET. The provider's 202 means the
 * call was ESTABLISHED, not answered, and its 422 means no call exists at all —
 * so the copy for each branch says a different true thing rather than one
 * hopeful thing.
 */
function CallControl({
  contactId,
  firstName,
}: {
  contactId: string
  firstName: string
}): React.JSX.Element {
  const [outcome, setOutcome] = useState<DialOutcome | null>(null)
  const [pending, setPending] = useState(false)

  const dial = useCallback(async (): Promise<void> => {
    setPending(true)
    setOutcome(null)
    try {
      const body = new FormData()
      body.set('contactId', contactId)
      const response = await fetch('/api/calls', { method: 'POST', body })
      setOutcome(
        response.ok
          ? ((await response.json()) as DialOutcome)
          : { status: 'degraded', reason: 'provider_error' },
      )
    } catch {
      setOutcome({ status: 'degraded', reason: 'provider_error' })
    } finally {
      setPending(false)
    }
  }, [contactId])

  return (
    <div style={{ marginTop: 'var(--space-4)' }}>
      <button
        type="button"
        onClick={() => void dial()}
        disabled={pending}
        style={{
          minHeight: '2.75rem',
          padding: '0 var(--space-5)',
          borderRadius: 'var(--radius-md)',
          border: 'none',
          background: pending
            ? 'var(--color-action-disabled-bg)'
            : 'var(--color-action-primary-bg)',
          color: pending ? 'var(--color-action-disabled-fg)' : 'var(--color-action-primary-fg)',
          fontSize: 'var(--type-sm)',
          fontWeight: 'var(--font-weight-semibold)',
          cursor: pending ? 'default' : 'pointer',
        }}
      >
        {/* `Checking` is a11y-only per Ruling E — a visible state that flashes
            for under the API p95 reads as a bug on a projector. The label does
            not change while the request is in flight. */}
        Call {firstName}
      </button>

      <span aria-live="polite" style={{ display: 'block' }}>
        {pending ? <span className="sr-only">Checking the calling window.</span> : null}
        {outcome === null ? null : (
          <span
            style={{
              display: 'block',
              marginTop: 'var(--space-2)',
              fontSize: 'var(--type-xs)',
              color:
                outcome.status === 'dispatched'
                  ? 'var(--color-text-secondary)'
                  : 'var(--color-caution-text)',
            }}
          >
            {dialMessage(outcome, firstName)}
          </span>
        )}
      </span>
    </div>
  )
}

/**
 * One sentence per outcome, and each says only what is known.
 *
 * `no_agent` is separated from `degraded` because the provider separates them:
 * a 422 in ~2 s is the seller's own softphone being closed, and telling them
 * "we couldn't reach the phone system" would send them to look at the wrong
 * thing entirely.
 */
function dialMessage(outcome: DialOutcome, firstName: string): string {
  switch (outcome.status) {
    case 'dispatched':
      return `Calling ${firstName} — answer your phone first. Then we dial them.`
    case 'no_agent':
      return 'Your phone isn’t connected to Aloware. Open the Aloware app, then try again.'
    case 'degraded':
      return 'We couldn’t reach the phone system. Call from your phone and we’ll log it.'
    case 'blocked':
      switch (outcome.reason) {
        case 'no_number':
          return 'Your calling number isn’t set up yet, so we can’t dial from here.'
        case 'no_credentials':
          // Distinct from `no_number` because the seller can do nothing about
          // this one. Naming it "your number" would send them to a setup screen
          // that is already finished.
          return 'Calling isn’t connected on this environment yet. Nothing on your side is missing.'
        case 'no_capability':
          return 'Calling isn’t switched on for this account yet.'
        case 'no_phone':
          return 'This contact has no phone number on file.'
        case 'not_found':
          return 'That contact isn’t in your book.'
      }
  }
}

function Row({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <>
      <dt style={{ color: 'var(--color-text-tertiary)' }}>{label}</dt>
      <dd style={{ margin: 0 }}>{value}</dd>
    </>
  )
}

function Notice({ heading, body }: { heading: string; body: string }): React.JSX.Element {
  return (
    <div
      role="status"
      style={{
        padding: 'var(--space-5)',
        borderRadius: 'var(--radius-lg)',
        background: 'var(--color-surface-1)',
        border: '1px dashed var(--color-border-default)',
      }}
    >
      <h2 style={{ fontSize: 'var(--type-md)', fontWeight: 'var(--font-weight-semibold)' }}>
        {heading}
      </h2>
      <p
        style={{
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

function Skeleton(): React.JSX.Element {
  return (
    <div aria-hidden="true" style={{ display: 'grid', gap: 'var(--space-3)' }}>
      {[0, 1, 2, 3, 4].map((i) => (
        <span
          key={i}
          style={{
            height: i === 0 ? 'var(--space-8)' : 'var(--space-5)',
            width: `${70 - i * 8}%`,
            borderRadius: 'var(--radius-sm)',
            background: 'var(--color-surface-3)',
          }}
        />
      ))}
    </div>
  )
}
