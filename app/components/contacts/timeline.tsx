import { useCallback, useEffect, useState } from 'react'

import { format, fromWireString } from '~/lib/money/money'
import type {
  TimelineActorKey,
  TimelineEntry,
  TimelinePage,
  TimelineSummaryKey,
} from '~/routes/api/timeline'

/**
 * The Activity stream. Component C-20, and the read surface of MVP item 20.
 *
 * ONE reverse-chronological stream, per CONTACT and not per opportunity: two
 * deals on the same person share a history that "does not restart, does not fork
 * and does not duplicate". No day separators — §4.5's own layout has none, and
 * each row carries a short relative timestamp instead.
 *
 * 🔴 A COMPLIANCE REASON IS NEVER TRUNCATED. Every other line here may wrap; a
 * blocked-send row may not be clipped, because that entry IS the audit record a
 * year later and an ellipsis in it is a defect rather than a layout choice. This
 * file therefore contains no `textOverflow`, no `WebkitLineClamp` and no fixed
 * row height — the row grows to the reason.
 *
 * NO NO-PERMISSION STATE, and that is the silo rule rather than an omission.
 * A contact this seller does not own reads as not-found on the parent screen and
 * this component never mounts; `app.timeline_read` answers an empty stream for
 * the same id. There is no verdict this surface could render that would not be
 * the 403 the constitution forbids, written in softer words.
 */

/** The states this surface owes. Loading, error and empty are all below. */
type State =
  | { readonly status: 'loading' }
  | {
      readonly status: 'ready'
      readonly entries: readonly TimelineEntry[]
      readonly nextCursor: string | null
    }
  | { readonly status: 'error' }

/** The state of the NEXT page, which fails on its own without losing this one. */
type More = 'idle' | 'loading' | 'error'

/**
 * The en-US strings, in one place.
 *
 * ⚠️ AN INTERIM CATALOG, AND SAID SO RATHER THAN IMPLIED. ARR-MVP-28 routes
 * every user-facing string through an ICU catalog keyed by id, and that catalog
 * does not exist in this tree — the register already carries its absence as
 * debt. Keeping the KEYS here means the day it arrives this file changes in one
 * place instead of being re-read line by line for phrases.
 *
 * 🔴 A TOTAL RECORD OF THE WIRE UNION, which is what makes it a mechanism. The
 * endpoint derives `TimelineSummaryKey` from two exhaustive maps, so a tenth
 * `timeline_kind` or a seventh `gate_verdict` breaks the build HERE as well as
 * there. The version this replaced was `Record<string, string>` with a
 * `?? entry.summaryKey` fallback — which renders `gate.block.…` to a seller and
 * goes green.
 */
const COPY: Readonly<Record<TimelineSummaryKey | TimelineActorKey, string>> = {
  'timeline.kind.call': 'Call',
  'timeline.kind.message': 'Text',
  'timeline.kind.note': 'Note',
  'timeline.kind.meeting': 'Appointment',
  'timeline.kind.stage_move': 'Moved',
  'timeline.kind.consent': 'Consent',
  'timeline.kind.send_blocked': 'Not sent',
  'timeline.kind.lead_created': 'Lead created',
  'timeline.kind.repost': 'Re-posted',

  // The blocked copy. These are the strings §11 requires written to the
  // timeline, and they are the reason the row never truncates.
  'gate.block.opted_out.timeline': 'Call not placed — this number opted out.',
  'gate.block.outside_window.timeline': 'Call not placed — outside the lead’s calling window.',
  'gate.block.tz_unknown.timeline': 'Call not placed — we couldn’t confirm this lead’s time zone.',
  'gate.block.recording_paused.timeline':
    'Call not placed — this state needs everyone’s consent and recording isn’t verified here.',
  'gate.block.channel_off.timeline': 'Text not sent — texting is pending carrier registration.',

  'timeline.actor.you': 'You',
  'timeline.actor.system': 'System',
  // R3.5, blocked copy: it says a colleague acted without saying which one.
  'timeline.actor.previous_owner': 'Handled before this record moved to you',
}

const ICON: Readonly<Record<string, string>> = {
  call: '📞',
  message: '💬',
  note: '📝',
  meeting: '📅',
  stage_move: '↗',
  consent: '✓',
  send_blocked: '⛔',
  lead_created: '✨',
  repost: '↻',
}

/** `Today 12:07 PM` / `Jul 12`, in the SELLER's own clock and unqualified. */
function shortTime(iso: string): string {
  const at = new Date(iso)
  const today = new Date()
  const sameDay =
    at.getFullYear() === today.getFullYear() &&
    at.getMonth() === today.getMonth() &&
    at.getDate() === today.getDate()

  return sameDay
    ? `Today ${at.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`
    : at.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

/** One line of detail, when the payload carries something worth a second line. */
function detailOf(entry: TimelineEntry): string | null {
  const to = entry.payload['to_stage_name']
  const premium = entry.payload['deal_value_annual_premium']

  if (entry.kind === 'stage_move' && typeof to === 'string') {
    // 🔴 MONEY GOES THROUGH `app/lib/money/**` AND NOWHERE ELSE. It arrives as a
    // string of whole cents, `fromWireString` brands it as a bigint and `format`
    // groups it from integers — the client performs no money arithmetic, ever.
    // The shape test is not a swallowed error: `render_payload` is jsonb, so
    // this is untrusted input at a client boundary, and a value that is not
    // whole cents renders no money rather than throwing the history away.
    if (typeof premium === 'string' && /^-?\d+$/.test(premium)) {
      return `to ${to} · ${format(fromWireString(premium))}`
    }
    return `to ${to}`
  }
  return null
}

async function fetchPage(
  contactId: string,
  cursor: string | null,
  signal: AbortSignal,
): Promise<TimelinePage | null> {
  const query = cursor === null ? '' : `?cursor=${encodeURIComponent(cursor)}`
  const response = await fetch(`/api/contacts/${contactId}/timeline${query}`, {
    signal,
    headers: { accept: 'application/json' },
  })
  if (!response.ok) return null
  return (await response.json()) as TimelinePage
}

export function Timeline({ contactId }: { contactId: string }): React.JSX.Element {
  const [state, setState] = useState<State>({ status: 'loading' })
  const [more, setMore] = useState<More>('idle')
  // Bumping this re-runs the effect, so RETRY REUSES THE SAME ABORT PATH as the
  // first load instead of starting a fetch nothing can cancel — an unmount in
  // the middle of a retry would otherwise set state on a dead component. The
  // reset to `loading` happens in the click handler and NOT in the effect body:
  // `react-hooks/set-state-in-effect` is an error here, and it is right — a
  // second contact is a second instance, keyed at the call site.
  const [attempt, setAttempt] = useState(0)

  const retry = useCallback(() => {
    setState({ status: 'loading' })
    setMore('idle')
    setAttempt((n) => n + 1)
  }, [])

  useEffect(() => {
    const controller = new AbortController()

    void fetchPage(contactId, null, controller.signal)
      .then((page) => {
        if (controller.signal.aborted) return
        setState(
          page === null
            ? { status: 'error' }
            : { status: 'ready', entries: page.entries, nextCursor: page.nextCursor },
        )
      })
      .catch(() => {
        if (!controller.signal.aborted) setState({ status: 'error' })
      })

    return () => controller.abort()
  }, [contactId, attempt])

  const loadMore = useCallback(() => {
    if (state.status !== 'ready' || state.nextCursor === null) return
    const cursor = state.nextCursor
    setMore('loading')

    void fetchPage(contactId, cursor, new AbortController().signal)
      .then((page) => {
        if (page === null) {
          setMore('error')
          return
        }
        setMore('idle')
        // Appended, never replaced: a seller who scrolled to 2019 does not get
        // sent back to today because the next page arrived.
        setState((current) =>
          current.status === 'ready'
            ? {
                status: 'ready',
                entries: [...current.entries, ...page.entries],
                nextCursor: page.nextCursor,
              }
            : current,
        )
      })
      .catch(() => setMore('error'))
  }, [contactId, state])

  return (
    <section style={{ marginTop: 'var(--space-8)' }}>
      <h2 style={{ fontSize: 'var(--type-lg)', fontWeight: 'var(--font-weight-semibold)' }}>
        Activity
      </h2>

      {state.status === 'loading' ? <Skeleton /> : null}

      {/* 🔴 THE ERROR IS INLINE, IN THIS REGION ONLY. The header and the deal
          list above stay usable on purpose: a seller has to be able to read the
          phone number and dial even when the history fetch fails, and a
          full-screen error takes that away for a reason that has nothing to do
          with the call. */}
      {state.status === 'error' ? (
        <div role="status" style={{ marginTop: 'var(--space-4)' }}>
          <p style={{ fontSize: 'var(--type-sm)' }}>We couldn’t load this history.</p>
          <p
            style={{
              marginTop: 'var(--space-1)',
              fontSize: 'var(--type-sm)',
              color: 'var(--color-text-secondary)',
            }}
          >
            Nothing was lost. Everything else on this contact still works.
          </p>
          <RetryButton onClick={retry} label="Retry" />
        </div>
      ) : null}

      {state.status === 'ready' && state.entries.length === 0 ? (
        /* The empty state TEACHES rather than reports, like every other one
           here: it names the first action instead of saying "no data". */
        <div role="status" style={{ marginTop: 'var(--space-4)' }}>
          <p style={{ fontSize: 'var(--type-base)' }}>Nothing has happened yet</p>
          <p
            style={{
              marginTop: 'var(--space-1)',
              fontSize: 'var(--type-sm)',
              color: 'var(--color-text-secondary)',
            }}
          >
            Calls and texts log themselves here. Start with a call.
          </p>
        </div>
      ) : null}

      {state.status === 'ready' && state.entries.length > 0 ? (
        <>
          {/* An ORDERED list, because the order carries meaning — a11y C-20. */}
          <ol style={{ marginTop: 'var(--space-4)', listStyle: 'none', padding: 0, margin: 0 }}>
            {state.entries.map((entry) => (
              <Entry key={entry.id} entry={entry} />
            ))}
          </ol>

          {/* 🔴 NO SILENT TRUNCATION. The page is fifty and a lead worked for a
              year has more; ending the list without saying so would read as
              "this is everything" for the one surface where that claim is the
              product. The cursor is keyset, so this button is an index range
              scan rather than a deeper and deeper OFFSET. */}
          {state.nextCursor === null ? null : (
            <div style={{ marginTop: 'var(--space-4)' }}>
              {more === 'error' ? (
                <p
                  role="status"
                  style={{
                    marginBottom: 'var(--space-2)',
                    fontSize: 'var(--type-sm)',
                    color: 'var(--color-text-secondary)',
                  }}
                >
                  We couldn’t load more. The history above is unchanged.
                </p>
              ) : null}
              <RetryButton
                onClick={loadMore}
                label={more === 'loading' ? 'Loading…' : 'Show older activity'}
                disabled={more === 'loading'}
              />
            </div>
          )}
        </>
      ) : null}
    </section>
  )
}

function Entry({ entry }: { entry: TimelineEntry }): React.JSX.Element {
  const detail = detailOf(entry)
  const blocked = entry.kind === 'send_blocked'
  // No `??` on either: `COPY` is a TOTAL record of the two wire unions, so a key
  // with no sentence behind it is a type error rather than a raw id on screen.
  const summary = COPY[entry.summaryKey]
  const actor = COPY[entry.actorLabelKey]

  return (
    <li
      style={{
        display: 'grid',
        gridTemplateColumns: 'var(--size-icon-md) 1fr auto',
        gap: 'var(--space-3)',
        padding: 'var(--space-3) 0',
        borderTop: '1px solid var(--color-border-subtle)',
        alignItems: 'start',
      }}
    >
      <span aria-hidden="true" style={{ fontSize: 'var(--type-base)' }}>
        {ICON[entry.kind] ?? '•'}
      </span>

      <div style={{ minWidth: 0 }}>
        <p
          style={{
            fontSize: 'var(--type-base)',
            // Wraps to as many lines as it needs. A blocked reason is the audit
            // record, so it is coloured to be found and never clipped to fit.
            overflowWrap: 'anywhere',
            color: blocked ? 'var(--color-danger-text)' : 'var(--color-text-primary)',
          }}
        >
          {summary}
        </p>
        {detail === null ? null : (
          <p
            style={{
              marginTop: 'var(--space-1)',
              fontSize: 'var(--type-sm)',
              color: 'var(--color-text-secondary)',
            }}
          >
            {detail}
          </p>
        )}
        {entry.actorLabelKey === 'timeline.actor.system' ? null : (
          <p
            style={{
              marginTop: 'var(--space-1)',
              fontSize: 'var(--type-sm)',
              color: 'var(--color-text-tertiary)',
            }}
          >
            {actor}
          </p>
        )}
      </div>

      {/* `<time datetime>` on every timestamp: the machine-readable instant is
          what a screen reader and a test both read, and the short form is for
          the eye. The seller's own clock, unqualified — the lead's clock is
          qualified "their time" in the header and nowhere else. */}
      <time
        dateTime={entry.occurredAt}
        style={{
          fontSize: 'var(--type-sm)',
          color: 'var(--color-text-tertiary)',
          whiteSpace: 'nowrap',
        }}
      >
        {shortTime(entry.occurredAt)}
      </time>
    </li>
  )
}

function RetryButton({
  onClick,
  label,
  disabled = false,
}: {
  onClick: () => void
  label: string
  disabled?: boolean
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        marginTop: 'var(--space-2)',
        minHeight: 'var(--size-target-min)',
        padding: 'var(--space-2) var(--space-4)',
        fontSize: 'var(--type-sm)',
        borderRadius: 'var(--radius-md)',
        border: '1px solid var(--color-action-secondary-border)',
        background: 'var(--color-action-secondary-bg)',
        color: disabled ? 'var(--color-action-disabled-fg)' : 'var(--color-action-secondary-fg)',
      }}
    >
      {label}
    </button>
  )
}

/** Four rows, not a spinner. Skeletons, per the constitution. */
function Skeleton(): React.JSX.Element {
  return (
    <div aria-hidden="true" style={{ marginTop: 'var(--space-4)' }}>
      {[0, 1, 2, 3].map((row) => (
        <div
          key={row}
          style={{
            height: 'var(--space-10)',
            marginTop: 'var(--space-2)',
            borderRadius: 'var(--radius-sm)',
            background: 'var(--color-surface-3)',
          }}
        />
      ))}
    </div>
  )
}
