import { useCallback, useEffect, useState } from 'react'

import { NoteComposer } from '~/components/contacts/note-composer'
import { StartDeal } from '~/components/contacts/start-deal'
import { Timeline } from '~/components/contacts/timeline'
import { useParams } from 'react-router'

import { AlowareCapturePanel } from '~/components/communications/aloware-capture-panel'
import { format, fromWireString } from '~/lib/money/money'
import type { ContactRecord } from '~/routes/api/contact'

/**
 * The contact record — where Ctrl+K lands.
 *
 * NO LOADER, and that is not a style choice. `05-architecture.md` §1.2
 * sanctions exactly ONE UI route carrying application data through a loader
 * and three already exist, so `ref.ci_ratchet`'s `ui.loader_whitelist` arm —
 * `shrink_only` — would refuse a fourth with `AP005`. The engine forced the
 * architecture §1.1 asked for anyway: this fetches its own data, with its own
 * error state, and nothing about it can take another screen down.
 *
 * 🔴 A FOREIGN ID READS AS NOT FOUND, NEVER FORBIDDEN — protected item
 * `DEMO-04`. This is the screen a pasted URL lands on, so it is the screen
 * where a 403 would confirm that somebody else's record exists. The endpoint
 * answers 404 for "not yours" and "does not exist" identically, and this
 * renders one sentence for both.
 */

type State =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly contact: ContactRecord }
  | { readonly status: 'not_found' }
  | { readonly status: 'error' }

export function meta() {
  return [{ title: 'Contact — CRM Leads' }]
}

export default function Contact(): React.JSX.Element {
  const { contactId } = useParams()
  const [state, setState] = useState<State>({ status: 'loading' })
  // Bumping this re-runs the fetch below, so a newly started deal appears
  // through the SAME read path that drew the list — no second source of truth
  // for what deals this contact has, and no client-side splice to drift.
  const [attempt, setAttempt] = useState(0)

  const read = useCallback(async (id: string, signal: AbortSignal): Promise<State> => {
    const response = await fetch(`/api/contacts/${id}`, {
      signal,
      headers: { accept: 'application/json' },
    })
    if (response.status === 404) return { status: 'not_found' }
    if (!response.ok) return { status: 'error' }
    return { status: 'ready', contact: (await response.json()) as ContactRecord }
  }, [])

  useEffect(() => {
    if (contactId === undefined) return
    const controller = new AbortController()
    const apply = (next: State): void => {
      if (!controller.signal.aborted) setState(next)
    }

    void read(contactId, controller.signal).then(apply, () => apply({ status: 'error' }))
    return () => controller.abort()
  }, [contactId, read, attempt])

  return (
    <main
      style={{ maxWidth: '44rem', margin: '0 auto', padding: 'var(--space-10) var(--space-6)' }}
    >
      {state.status === 'loading' ? <Skeleton /> : null}

      {/* ONE sentence for "not yours" and "does not exist" alike. Two
          sentences would be the 403 this rule exists to prevent, written in
          softer words. */}
      {state.status === 'not_found' ? (
        <Notice
          heading="That contact isn't in your book"
          body="Check the link, or find them from My Book."
        />
      ) : null}

      {state.status === 'error' ? (
        <Notice
          heading="This contact could not load"
          body="Nothing was lost. Try again, or find them from My Book."
        />
      ) : null}

      {state.status === 'ready' ? (
        <Record contact={state.contact} onChanged={() => setAttempt((n) => n + 1)} />
      ) : null}
    </main>
  )
}

function Record({
  contact,
  onChanged,
}: {
  contact: ContactRecord
  onChanged: () => void
}): React.JSX.Element {
  const [noteKey, setNoteKey] = useState(0)

  return (
    <>
      <h1
        style={{
          fontSize: 'var(--type-2xl)',
          fontWeight: 'var(--font-weight-bold)',
          letterSpacing: '-0.015em',
        }}
      >
        {contact.fullName}
      </h1>

      <dl
        style={{
          display: 'grid',
          gridTemplateColumns: 'auto 1fr',
          gap: 'var(--space-2) var(--space-4)',
          marginTop: 'var(--space-4)',
          fontSize: 'var(--type-sm)',
        }}
      >
        {contact.phones.map((phone) => (
          <Row key={phone.e164} label={phone.isPrimary ? 'Phone' : 'Also'} value={phone.e164} />
        ))}
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

      {/* 🔴 THE TIMELINE FETCHES ITS OWN DATA, and it is not a style choice.
          `ui.loader_whitelist` sanctions ONE SSR loader and three exist, so
          `AP005` refuses a fourth — the ratchet forced the architecture §1.1
          wanted anyway. It also buys the error state this surface needs: the
          history can fail without taking the header and the action bar with
          it, so a seller can still dial. */}
      {/* Keyed, so a second contact is a second INSTANCE. Without it the stream
          would keep the previous lead's rows on screen while the new one loads,
          which on this surface is not a flicker but somebody else's history
          under this person's name. */}
      {/* The composer sits ABOVE the history: the Activity region is reverse
          chronological, so typing at the bottom and watching the line appear at
          the top would be two ends of the same screen. `noteKey` remounts the
          Timeline after a save, so the new line arrives through the SAME read
          that drew the rest — no second source of truth for a seller's own
          history. */}
      <NoteComposer contactId={contact.id} onLogged={() => setNoteKey((n) => n + 1)} />
      <Timeline key={`${contact.id}:${String(noteKey)}`} contactId={contact.id} />

      <h2
        style={{
          marginTop: 'var(--space-8)',
          fontSize: 'var(--type-md)',
          fontWeight: 'var(--font-weight-semibold)',
        }}
      >
        Deals
      </h2>

      {contact.deals.length === 0 ? (
        <p
          style={{
            marginTop: 'var(--space-2)',
            fontSize: 'var(--type-sm)',
            color: 'var(--color-text-secondary)',
          }}
        >
          {/* ⚠️ THIS USED TO SAY "Start one from your board", WHICH WAS A DEAD
              END: `app.opportunity` had no writer anywhere in the product, so
              the board could not start one either. The button below is that
              sentence, made true. */}
          No open deal yet.
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
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 'var(--space-4)',
                padding: 'var(--space-3) var(--space-4)',
                background: 'var(--color-surface-1)',
                border: '1px solid var(--color-border-subtle)',
                borderRadius: 'var(--radius-md)',
              }}
            >
              <span style={{ fontSize: 'var(--type-sm)' }}>{deal.stageName}</span>
              {deal.premiumCents === null ? (
                <span style={{ fontSize: 'var(--type-sm)', color: 'var(--color-text-tertiary)' }}>
                  No value yet
                </span>
              ) : (
                <span
                  className="money"
                  style={{
                    fontSize: 'var(--type-sm)',
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

      {/* Under the list rather than inside the empty state: one contact
          legitimately buys twice, so starting a second deal is an ordinary
          action rather than something that disappears once the first exists. */}
      <StartDeal contactId={contact.id} hasDeals={contact.deals.length > 0} onStarted={onChanged} />

      {/* The Aloware inspection surface. It sits on the FULL contact view and
          deliberately not in the drawer: the drawer is a seller's first glance
          and this is a reference wall. It is the same panel on every contact
          because it renders the Gate-2 capture, not this contact's history —
          which the panel's own first paragraph says rather than implying. */}
      <AlowareCapturePanel />
    </>
  )
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
        padding: 'var(--space-6)',
        borderRadius: 'var(--radius-lg)',
        background: 'var(--color-surface-1)',
        border: '1px dashed var(--color-border-default)',
      }}
    >
      <h1 style={{ fontSize: 'var(--type-lg)', fontWeight: 'var(--font-weight-semibold)' }}>
        {heading}
      </h1>
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
      {[0, 1, 2, 3].map((i) => (
        <span
          key={i}
          style={{
            height: i === 0 ? 'var(--space-8)' : 'var(--space-5)',
            width: `${60 - i * 10}%`,
            borderRadius: 'var(--radius-sm)',
            background: 'var(--color-surface-3)',
          }}
        />
      ))}
    </div>
  )
}
