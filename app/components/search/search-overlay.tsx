import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'

import { MIN_QUERY_LENGTH } from '~/lib/search/query'
import type { QuickAddResult } from '~/routes/api/quick-add'
import type { SearchPayload } from '~/routes/api/search'

/**
 * Global search — `DEMO-08`, opened with Ctrl/Cmd+K from any surface.
 *
 * §7's recovery path is the moment it exists for, and every rule below comes
 * from it: a seller's handset is ringing from a number she does not recognise,
 * the inbound call will log itself but only after it ends, and she needs the
 * file NOW. Two interactions from anywhere in the app to a record with
 * forty-four days of history, while the phone is still ringing.
 *
 * THE KEYBOARD CONTRACT, from `04b` §3 and `04-ux-flows` §7:
 *   Ctrl/Cmd+K  opens from any surface, focus LANDS IN THE INPUT
 *   ↑ / ↓       move the result list without leaving the input
 *   Enter       opens the highlighted record
 *   Escape      closes and RESTORES FOCUS to whatever opened it
 *
 * That last one is the one everybody skips. A seller who opens search from a
 * card, changes their mind and presses Escape must get their place back — an
 * overlay that dumps focus on `<body>` costs a keyboard user their position on
 * a 500-card board, and it is invisible to anyone testing with a mouse.
 *
 * SKELETON ROWS PAINT ON THE KEYSTROKE. §7's budget is under 200 ms perceived
 * and 500 ms committed, so the list must not wait for the server to say
 * anything. What is NOT here: that budget as a measured gate. It is not
 * asserted anywhere yet, and saying so beats implying a number nobody checked.
 */

/**
 * `null` is "nothing has come back for the CURRENT query yet".
 *
 * Deliberately not an `idle | searching` state pair set from the effect: both
 * are DERIVED from the query and whether the overlay is open, so storing them
 * would be React state that duplicates React state — and setting them in the
 * effect body is a cascading render the compiler rejects outright. The only
 * thing worth storing is the answer, and the answer carries the query it
 * belongs to so a late response for a query the seller has moved past is
 * discarded rather than rendered.
 */
type Answer =
  | { readonly status: 'ready'; readonly forQuery: string; readonly result: SearchPayload }
  | { readonly status: 'error'; readonly forQuery: string }

/** Long enough to not fire per keystroke, short enough to feel like none. */
const DEBOUNCE_MS = 120

export function SearchOverlay(): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [answer, setAnswer] = useState<Answer | null>(null)
  const [highlight, setHighlight] = useState(0)
  /** The quick-add sheet, opened from the empty state with the number in hand. */
  const [adding, setAdding] = useState<string | null>(null)

  const inputRef = useRef<HTMLInputElement | null>(null)
  /** Whatever had focus when the overlay opened. Escape gives it back. */
  const openerRef = useRef<Element | null>(null)
  const navigate = useNavigate()

  const close = useCallback((): void => {
    setOpen(false)
    setQuery('')
    setAnswer(null)
    setAdding(null)
    // RESTORE, and only if the element is still in the document — a card that
    // was dragged away while the overlay was open is not somewhere to return
    // to, and focusing a detached node silently does nothing.
    const opener = openerRef.current
    if (opener instanceof HTMLElement && opener.isConnected) opener.focus()
  }, [])

  // Ctrl/Cmd+K from any surface. Bound to the document rather than to a
  // button, because "from any surface" is the requirement and a shortcut that
  // only works where somebody remembered to wire it is not one.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        openerRef.current = document.activeElement
        setOpen(true)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])

  const trimmed = query.trim()
  const searching = open && trimmed.length >= MIN_QUERY_LENGTH

  useEffect(() => {
    if (!searching) return

    const controller = new AbortController()
    const timer = setTimeout(() => {
      void fetch(`/api/search?q=${encodeURIComponent(trimmed)}`, {
        signal: controller.signal,
        headers: { accept: 'application/json' },
      })
        .then(async (response) => {
          if (!response.ok) throw new Error(`search failed: ${String(response.status)}`)
          return (await response.json()) as SearchPayload
        })
        .then(
          (result) => {
            if (!controller.signal.aborted)
              setAnswer({ status: 'ready', forQuery: trimmed, result })
          },
          () => {
            if (!controller.signal.aborted) setAnswer({ status: 'error', forQuery: trimmed })
          },
        )
    }, DEBOUNCE_MS)

    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [searching, trimmed])

  if (!open) return null

  // The answer only counts if it belongs to what is in the box right now.
  const current = answer !== null && answer.forQuery === trimmed ? answer : null
  const hits = current?.status === 'ready' ? current.result.hits : []

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      close()
      return
    }
    // The list moves WITHOUT the input losing focus, so a seller keeps typing
    // to narrow while arrowing to choose. Roving focus into the list would
    // make every correction a trip back to the field.
    if (e.key === 'ArrowDown' && hits.length > 0) {
      e.preventDefault()
      setHighlight((i) => (i + 1) % hits.length)
      return
    }
    if (e.key === 'ArrowUp' && hits.length > 0) {
      e.preventDefault()
      setHighlight((i) => (i - 1 + hits.length) % hits.length)
      return
    }
    if (e.key === 'Enter') {
      const hit = hits[highlight]
      if (hit !== undefined) {
        e.preventDefault()
        close()
        void navigate(`/contacts/${hit.contactId}`)
      }
    }
  }

  return (
    <div
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) close()
      }}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'var(--color-overlay)',
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'flex-start',
        paddingTop: 'var(--space-16)',
        zIndex: 40,
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Search"
        style={{
          width: 'min(36rem, calc(100vw - var(--space-8)))',
          background: 'var(--color-surface-1)',
          border: '1px solid var(--color-border-default)',
          borderRadius: 'var(--radius-lg)',
          overflow: 'hidden',
        }}
      >
        {adding !== null ? (
          <QuickAdd
            phone={adding}
            onCancel={() => setAdding(null)}
            onCreated={(contactId) => {
              close()
              void navigate(`/contacts/${contactId}`)
            }}
          />
        ) : null}

        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          aria-label="Search your book"
          placeholder="Search your book"
          // The list is the input's business, which is what lets focus stay
          // here while the highlight moves.
          role="combobox"
          aria-expanded={hits.length > 0}
          aria-controls="search-results"
          aria-activedescendant={hits[highlight] ? `search-hit-${highlight}` : undefined}
          style={{
            width: '100%',
            padding: 'var(--space-4) var(--space-5)',
            border: 0,
            borderBottom: '1px solid var(--color-border-subtle)',
            background: 'transparent',
            fontSize: 'var(--type-md)',
            outline: 'none',
            display: adding === null ? 'block' : 'none',
          }}
        />

        <div
          id="search-results"
          role="listbox"
          aria-label="Results"
          style={{ display: adding === null ? undefined : 'none' }}
        >
          {!searching ? (
            <Teaching
              headline="Search your book"
              body="By name, phone or email. Any phone format works."
            />
          ) : null}

          {/* Skeletons, never a spinner, and they are rows rather than a bar:
              the shape of what is arriving is the whole reason for them. */}
          {searching && current === null ? <ResultSkeleton /> : null}

          {current?.status === 'error' ? (
            <Teaching headline="Search is down." body="Try the contact from My Book." />
          ) : null}

          {current?.status === 'ready' && hits.length === 0 ? (
            current.result.global ? (
              // Distinct from the seller's empty on purpose, so a supervisor
              // does not misread a global zero as a scoping bug.
              <Teaching
                headline="No matches in any book"
                body="Try a different name or a full phone number."
              />
            ) : (
              <Teaching
                headline="No matches in your book"
                body="Add this number and start a deal in one step."
                action={current.result.asPhone === null ? null : 'Quick-add this number'}
                onAction={
                  current.result.asPhone === null
                    ? undefined
                    : () => setAdding(current.result.asPhone)
                }
              />
            )
          ) : null}

          {hits.map((hit, index) => (
            <button
              key={hit.contactId}
              id={`search-hit-${index}`}
              type="button"
              role="option"
              aria-selected={index === highlight}
              onMouseEnter={() => setHighlight(index)}
              onClick={() => {
                close()
                void navigate(`/contacts/${hit.contactId}`)
              }}
              style={{
                display: 'flex',
                alignItems: 'baseline',
                gap: 'var(--space-3)',
                width: '100%',
                minHeight: 'var(--size-target-min)',
                padding: 'var(--space-3) var(--space-5)',
                border: 0,
                textAlign: 'left',
                cursor: 'pointer',
                background:
                  index === highlight ? 'var(--color-selected-bg)' : 'var(--color-surface-1)',
              }}
            >
              <span
                style={{ fontSize: 'var(--type-base)', fontWeight: 'var(--font-weight-semibold)' }}
              >
                {hit.fullName}
              </span>
              <span style={{ fontSize: 'var(--type-sm)', color: 'var(--color-text-secondary)' }}>
                {hit.phone ?? hit.email ?? ''}
              </span>
              {/* §7: a global result set without an owner on every row is a
                  supervisor reading fifty books as if they were one. */}
              {hit.ownerName === null ? null : (
                <span
                  style={{
                    marginLeft: 'auto',
                    padding: '0 var(--space-15)',
                    borderRadius: 'var(--radius-xs)',
                    background: 'var(--color-neutral-state-fill)',
                    color: 'var(--color-neutral-state-text)',
                    fontSize: 'var(--type-micro)',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {hit.ownerName}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

/**
 * Every empty state teaches — §4.10's rule, and the one it opens with: *"a
 * state that only reports absence is a defect."*
 */
function Teaching({
  headline,
  body,
  action,
  onAction,
}: {
  headline: string
  body: string
  action?: string | null
  onAction?: (() => void) | undefined
}): React.JSX.Element {
  return (
    <div style={{ padding: 'var(--space-6) var(--space-5)' }}>
      <p
        style={{
          margin: 0,
          fontSize: 'var(--type-base)',
          fontWeight: 'var(--font-weight-semibold)',
        }}
      >
        {headline}
      </p>
      <p
        style={{
          margin: 0,
          marginTop: 'var(--space-1)',
          fontSize: 'var(--type-sm)',
          color: 'var(--color-text-secondary)',
        }}
      >
        {body}
      </p>
      {action == null || onAction === undefined ? null : (
        <button
          type="button"
          onClick={onAction}
          style={{
            marginTop: 'var(--space-3)',
            minHeight: 'var(--size-target-min)',
            padding: 'var(--space-2) var(--space-4)',
            borderRadius: 'var(--radius-md)',
            border: 0,
            background: 'var(--color-action-primary-bg)',
            color: 'var(--color-action-primary-fg)',
            fontSize: 'var(--type-sm)',
            fontWeight: 'var(--font-weight-semibold)',
            cursor: 'pointer',
          }}
        >
          {action}
        </button>
      )}
    </div>
  )
}

function ResultSkeleton(): React.JSX.Element {
  return (
    <div aria-hidden="true" style={{ padding: 'var(--space-2) var(--space-5)' }}>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          style={{
            display: 'block',
            height: 'var(--space-5)',
            margin: 'var(--space-3) 0',
            width: `${70 - i * 15}%`,
            borderRadius: 'var(--radius-sm)',
            background: 'var(--color-surface-3)',
          }}
        />
      ))}
    </div>
  )
}

/**
 * `Quick-add lead` — the far end of the loop section 7 opens.
 *
 * The seller searched a number, it was not in the book, and the one thing the
 * product knows for certain is the number. It arrives PREFILLED and read-only
 * for that reason: retyping it is the step that makes a seller close the sheet
 * and decide to do it later.
 *
 * TWO FIELDS, NOT FOUR. 4.11 ratifies `Name / Phone / Lead source / Note`, and
 * the two that are missing are missing honestly: `lead_source_id` is deferred
 * to the intake module and the `activity_type` enum has no `note` label, so
 * neither has a column to land in. A field that silently discards what a
 * seller typed is worse than a field that is not there.
 *
 * `Save`, not `Save & call` — 4.11 makes the dialling variant primary and it
 * needs the Aloware gate, which does not exist. Shipping `Save & call` as a
 * button that saves and does not call would be the one lie this sheet could
 * tell.
 */
function QuickAdd({
  phone,
  onCancel,
  onCreated,
}: {
  phone: string
  onCancel: () => void
  onCreated: (contactId: string) => void
}): React.JSX.Element {
  const [name, setName] = useState('')
  const [result, setResult] = useState<QuickAddResult | null>(null)
  const [saving, setSaving] = useState(false)
  const nameRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    nameRef.current?.focus()
  }, [])

  const save = useCallback((): void => {
    setSaving(true)
    const body = new FormData()
    body.set('name', name)
    body.set('phone', phone)

    void fetch('/api/quick-add', { method: 'POST', body })
      .then(async (response) => (await response.json()) as QuickAddResult)
      .then(
        (answer) => {
          setSaving(false)
          setResult(answer)
          if (answer.status === 'created') onCreated(answer.contactId)
        },
        () => setSaving(false),
      )
  }, [name, phone, onCreated])

  return (
    <div style={{ padding: 'var(--space-5)' }}>
      <h2
        style={{ margin: 0, fontSize: 'var(--type-md)', fontWeight: 'var(--font-weight-semibold)' }}
      >
        Quick-add lead
      </h2>

      <label style={{ display: 'block', marginTop: 'var(--space-4)' }}>
        <span style={{ fontSize: 'var(--type-xs)', color: 'var(--color-text-tertiary)' }}>
          Name
        </span>
        <input
          ref={nameRef}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') save()
          }}
          style={FIELD}
        />
      </label>

      <label style={{ display: 'block', marginTop: 'var(--space-3)' }}>
        <span style={{ fontSize: 'var(--type-xs)', color: 'var(--color-text-tertiary)' }}>
          Phone
        </span>
        {/* Read-only: it is the one fact the search already established, and
            re-entering it is how a seller decides to do this later. */}
        <input value={phone} readOnly style={{ ...FIELD, color: 'var(--color-text-secondary)' }} />
      </label>

      {/* The inline block section 7 names, and it is what a CONSTRAINT looks
          like on screen: the duplicate was never written, and this says whose
          it is. */}
      {result?.status === 'duplicate' ? (
        <div
          role="status"
          style={{
            marginTop: 'var(--space-3)',
            padding: 'var(--space-3)',
            borderRadius: 'var(--radius-md)',
            background: 'var(--color-caution-fill)',
            border: '1px solid var(--color-caution-stroke)',
          }}
        >
          <p style={{ margin: 0, fontSize: 'var(--type-sm)', color: 'var(--color-caution-text)' }}>
            {result.name === ''
              ? 'That number is already in use.'
              : `You already have ${result.name} with this number.`}
          </p>
          {result.contactId === '' ? null : (
            <button
              type="button"
              onClick={() => onCreated(result.contactId)}
              style={{
                marginTop: 'var(--space-2)',
                minHeight: 'var(--size-target-min)',
                padding: 0,
                border: 0,
                background: 'transparent',
                color: 'var(--color-text-link)',
                fontSize: 'var(--type-sm)',
                fontWeight: 'var(--font-weight-semibold)',
                cursor: 'pointer',
              }}
            >
              Open existing
            </button>
          )}
        </div>
      ) : null}

      {result?.status === 'invalid' ? (
        <p
          style={{
            marginTop: 'var(--space-3)',
            fontSize: 'var(--type-sm)',
            color: 'var(--color-danger-text)',
          }}
        >
          {result.reason === 'name' ? 'Add a name for this lead.' : 'That is not a phone number.'}
        </p>
      ) : null}

      <div style={{ display: 'flex', gap: 'var(--space-2)', marginTop: 'var(--space-4)' }}>
        <button
          type="button"
          onClick={save}
          disabled={saving}
          style={{
            minHeight: 'var(--size-target-min)',
            padding: 'var(--space-2) var(--space-4)',
            borderRadius: 'var(--radius-md)',
            border: 0,
            background: 'var(--color-action-primary-bg)',
            color: 'var(--color-action-primary-fg)',
            fontSize: 'var(--type-sm)',
            fontWeight: 'var(--font-weight-semibold)',
            cursor: 'pointer',
          }}
        >
          Save
        </button>
        <button
          type="button"
          onClick={onCancel}
          style={{
            minHeight: 'var(--size-target-min)',
            padding: 'var(--space-2) var(--space-4)',
            borderRadius: 'var(--radius-md)',
            border: '1px solid var(--color-action-secondary-border)',
            background: 'var(--color-action-secondary-bg)',
            color: 'var(--color-action-secondary-fg)',
            fontSize: 'var(--type-sm)',
            cursor: 'pointer',
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  )
}

const FIELD = {
  display: 'block',
  width: '100%',
  marginTop: 'var(--space-1)',
  padding: 'var(--space-2) var(--space-3)',
  borderRadius: 'var(--radius-md)',
  border: '1px solid var(--color-border-default)',
  background: 'var(--color-surface-1)',
  fontSize: 'var(--type-md)',
} as const
