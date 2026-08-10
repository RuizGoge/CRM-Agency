import { useState } from 'react'

import {
  ALOWARE_CALL_FIELDS,
  ALOWARE_EVENTS,
  ALOWARE_FAN_OUT,
  FIELD_GROUP_LABEL,
} from '~/modules/communications/aloware-payload'
import type { AlowareField, FieldGroup } from '~/modules/communications/aloware-payload'
import {
  CAPTURED_CALL,
  CAPTURED_FAILED_CALL,
  CAPTURED_GUARANTEES,
  CAPTURE_SUBJECT,
} from '~/modules/communications/aloware-capture'
import type { CapturedDelivery } from '~/modules/communications/aloware-capture'

/**
 * WHAT THE ALOWARE INTEGRATION ACTUALLY YIELDS — an inspection surface.
 *
 * This is a reference panel, not a product screen. It renders the Gate-2
 * capture so the question "what do I have to work with" has a visible answer
 * instead of a markdown file nobody opens.
 *
 * ⚠️ IT IS NOT LIVE, AND THE PANEL SAYS SO IN ITS OWN HEADER rather than
 * leaving it to be inferred. The spike deleted its webhook subscription during
 * teardown, so no call placed today delivers anything. Everything here is the
 * 2026-08-05 capture.
 */

const GROUP_ORDER: readonly FieldGroup[] = [
  'identity',
  'routing',
  'outcome',
  'timing',
  'media',
  'compliance',
  'contact',
  'unused',
]

export function AlowareCapturePanel(): React.JSX.Element {
  const [open, setOpen] = useState(false)

  return (
    <section style={{ marginTop: 'var(--space-10)' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: 'var(--space-4)',
          flexWrap: 'wrap',
        }}
      >
        <h2 style={{ fontSize: 'var(--type-md)', fontWeight: 'var(--font-weight-semibold)' }}>
          Aloware — what a call actually gives us
        </h2>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          style={{
            background: 'none',
            border: 'none',
            padding: 0,
            fontSize: 'var(--type-xs)',
            color: 'var(--color-text-link)',
            cursor: 'pointer',
          }}
        >
          {open ? 'Hide the detail' : 'Show every field'}
        </button>
      </div>

      {/* The honesty line. It is first, and it is not collapsible. */}
      <p
        style={{
          marginTop: 'var(--space-2)',
          padding: 'var(--space-3) var(--space-4)',
          borderRadius: 'var(--radius-md)',
          background: 'var(--color-surface-1)',
          border: '1px dashed var(--color-border-default)',
          fontSize: 'var(--type-xs)',
          color: 'var(--color-text-secondary)',
        }}
      >
        <strong>Captured evidence, not a live feed.</strong> The Sprint-0 spike deleted its webhook
        subscription when it was torn down, so a call placed today delivers nothing anywhere. Every
        value below was recorded on 2026-08-05 from 22 real deliveries. The lead&rsquo;s personal
        details are replaced by a synthetic subject &mdash; {CAPTURE_SUBJECT.displayName},{' '}
        {CAPTURE_SUBJECT.phoneE164} &mdash; because this file is committed and their phone number is
        not ours to keep. <strong>Every non-personal value is real and unmodified.</strong>
      </p>

      <Timeline
        heading="A completed call · 63 seconds of talk"
        deliveries={CAPTURED_CALL}
        caption="Six deliveries. Read the gap between the first two."
      />

      {open ? (
        <>
          <Timeline
            heading="A failed dial · nobody answered the agent leg"
            deliveries={CAPTURED_FAILED_CALL}
            caption="Two deliveries. The lead&rsquo;s phone never rang at all."
          />

          <SubHeading>What the provider guarantees</SubHeading>
          <div style={{ display: 'grid', gap: 'var(--space-3)', marginTop: 'var(--space-3)' }}>
            {CAPTURED_GUARANTEES.map((g) => (
              <div
                key={g.question}
                style={{
                  padding: 'var(--space-3) var(--space-4)',
                  borderRadius: 'var(--radius-md)',
                  background: 'var(--color-surface-1)',
                  border: '1px solid var(--color-border-subtle)',
                }}
              >
                <p style={{ fontSize: 'var(--type-sm)', color: 'var(--color-text-tertiary)' }}>
                  {g.question}
                </p>
                <p
                  style={{
                    marginTop: 'var(--space-1)',
                    fontSize: 'var(--type-sm)',
                    fontWeight: 'var(--font-weight-semibold)',
                  }}
                >
                  {g.finding}
                </p>
                <p
                  style={{
                    marginTop: 'var(--space-2)',
                    fontSize: 'var(--type-xs)',
                    color: 'var(--color-text-secondary)',
                  }}
                >
                  {g.evidence}
                </p>
              </div>
            ))}
          </div>

          <SubHeading>Deliveries per call</SubHeading>
          <ul style={listStyle}>
            {ALOWARE_FAN_OUT.map((f) => (
              <li key={f.kind} style={rowStyle}>
                <span style={{ fontSize: 'var(--type-sm)' }}>{f.kind}</span>
                <span
                  style={{
                    fontSize: 'var(--type-sm)',
                    fontWeight: 'var(--font-weight-semibold)',
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  {f.deliveries}
                </span>
                <span
                  style={{
                    gridColumn: '1 / -1',
                    fontSize: 'var(--type-xs)',
                    color: 'var(--color-text-secondary)',
                  }}
                >
                  {f.note}
                </span>
              </li>
            ))}
          </ul>

          <SubHeading>Every event name observed on the wire</SubHeading>
          <p style={captionStyle}>
            Not the subscription form&rsquo;s checkboxes. What you subscribe to and what arrives are
            named differently, so a mapping built from the checkbox list matches nothing.
          </p>
          <ul style={listStyle}>
            {ALOWARE_EVENTS.map((e) => (
              <li key={e.name} style={rowStyle}>
                <code style={{ fontSize: 'var(--type-xs)' }}>{e.name}</code>
                <span style={{ fontSize: 'var(--type-xs)', color: 'var(--color-text-tertiary)' }}>
                  {e.canonical ?? 'maps to nothing'}
                </span>
                <span
                  style={{
                    gridColumn: '1 / -1',
                    fontSize: 'var(--type-xs)',
                    color: 'var(--color-text-secondary)',
                  }}
                >
                  {e.convention} &middot; {e.note}
                </span>
              </li>
            ))}
          </ul>

          <SubHeading>Every field, and what we do with it</SubHeading>
          {GROUP_ORDER.map((group) => {
            const fields = ALOWARE_CALL_FIELDS.filter((f) => f.group === group)
            if (fields.length === 0) return null
            return (
              <div key={group} style={{ marginTop: 'var(--space-5)' }}>
                <h4
                  style={{
                    fontSize: 'var(--type-sm)',
                    fontWeight: 'var(--font-weight-semibold)',
                    color: 'var(--color-text-secondary)',
                  }}
                >
                  {FIELD_GROUP_LABEL[group]}
                </h4>
                <ul style={listStyle}>
                  {fields.map((f) => (
                    <FieldRow key={f.path} field={f} />
                  ))}
                </ul>
              </div>
            )
          })}
        </>
      ) : null}
    </section>
  )
}

function Timeline({
  heading,
  deliveries,
  caption,
}: {
  heading: string
  deliveries: readonly CapturedDelivery[]
  caption: string
}): React.JSX.Element {
  return (
    <>
      <SubHeading>{heading}</SubHeading>
      <p style={captionStyle}>{caption}</p>
      <ol style={{ ...listStyle, gridTemplateColumns: 'none' }}>
        {deliveries.map((d, i) => {
          const previous = i === 0 ? null : deliveries[i - 1]
          const gapMs =
            previous === undefined || previous === null ? 0 : d.offsetMs - previous.offsetMs
          return (
            <li
              key={d.seq}
              style={{
                display: 'grid',
                gap: 'var(--space-1)',
                padding: 'var(--space-3) var(--space-4)',
                background: 'var(--color-surface-1)',
                border: '1px solid var(--color-border-subtle)',
                borderRadius: 'var(--radius-md)',
              }}
            >
              <span
                style={{
                  display: 'flex',
                  alignItems: 'baseline',
                  gap: 'var(--space-3)',
                  flexWrap: 'wrap',
                }}
              >
                <code
                  style={{ fontSize: 'var(--type-sm)', fontWeight: 'var(--font-weight-semibold)' }}
                >
                  {d.event}
                </code>
                <span
                  style={{
                    fontSize: 'var(--type-xs)',
                    color: 'var(--color-text-tertiary)',
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  +{formatOffset(d.offsetMs)} &middot; {d.bytes} B &middot; we answered {d.answered}
                </span>
              </span>

              {/* The gap is the finding on the completed call, so it is drawn
                  rather than left to arithmetic the reader has to do. */}
              {gapMs >= 10_000 ? (
                <span
                  style={{
                    fontSize: 'var(--type-xs)',
                    color: 'var(--color-caution-text)',
                    fontWeight: 'var(--font-weight-semibold)',
                  }}
                >
                  {formatOffset(gapMs)} of silence before this &mdash; nothing was delivered in it
                </span>
              ) : null}

              <dl
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'auto 1fr',
                  gap: '0 var(--space-3)',
                  margin: 0,
                  fontSize: 'var(--type-xs)',
                }}
              >
                {d.notable.map((n) => (
                  <span key={n.field} style={{ display: 'contents' }}>
                    <dt style={{ color: 'var(--color-text-tertiary)' }}>
                      <code>{n.field}</code>
                    </dt>
                    <dd style={{ margin: 0 }}>{n.value}</dd>
                  </span>
                ))}
              </dl>

              {d.comment === null ? null : (
                <p
                  style={{
                    margin: 0,
                    fontSize: 'var(--type-xs)',
                    color: 'var(--color-text-secondary)',
                  }}
                >
                  {d.comment}
                </p>
              )}
            </li>
          )
        })}
      </ol>
    </>
  )
}

function FieldRow({ field }: { field: AlowareField }): React.JSX.Element {
  return (
    <li style={rowStyle}>
      <code style={{ fontSize: 'var(--type-xs)' }}>{field.path}</code>
      <span
        style={{
          fontSize: 'var(--type-xs)',
          color: field.pii ? 'var(--color-caution-text)' : 'var(--color-text-tertiary)',
        }}
      >
        {field.type}
        {field.pii ? ' · personal data' : ''}
      </span>
      <span
        style={{
          gridColumn: '1 / -1',
          fontSize: 'var(--type-xs)',
          color: 'var(--color-text-secondary)',
        }}
      >
        {field.meaning}
      </span>
      <span
        style={{
          gridColumn: '1 / -1',
          fontSize: 'var(--type-xs)',
          color:
            field.useInCrm === null ? 'var(--color-text-tertiary)' : 'var(--color-text-primary)',
        }}
      >
        {field.useInCrm === null ? 'We do nothing with it.' : `We use it: ${field.useInCrm}`}
      </span>
    </li>
  )
}

function SubHeading({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <h3
      style={{
        marginTop: 'var(--space-6)',
        fontSize: 'var(--type-sm)',
        fontWeight: 'var(--font-weight-semibold)',
      }}
    >
      {children}
    </h3>
  )
}

/** `70365` reads as `1m 10.4s`, which is the number the eye needs. */
function formatOffset(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const whole = Math.floor(seconds / 60)
  return `${whole}m ${(seconds - whole * 60).toFixed(1)}s`
}

const listStyle: React.CSSProperties = {
  margin: 'var(--space-3) 0 0',
  padding: 0,
  listStyle: 'none',
  display: 'grid',
  gap: 'var(--space-2)',
}

const rowStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr auto',
  gap: 'var(--space-1) var(--space-3)',
  padding: 'var(--space-3) var(--space-4)',
  background: 'var(--color-surface-1)',
  border: '1px solid var(--color-border-subtle)',
  borderRadius: 'var(--radius-md)',
}

const captionStyle: React.CSSProperties = {
  marginTop: 'var(--space-1)',
  fontSize: 'var(--type-xs)',
  color: 'var(--color-text-secondary)',
}
