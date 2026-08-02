import { isRouteErrorResponse, useRouteError } from 'react-router'

import { readMyDay, type MyDayItem, type MyDayPayload } from '~/routes/api/my-day'

import type { Route } from './+types/my-day'

export function meta(_: Route.MetaArgs) {
  return [{ title: 'My Day — CRM Leads' }]
}

export async function loader({ request }: Route.LoaderArgs): Promise<MyDayPayload> {
  return readMyDay(request)
}

export default function MyDay({ loaderData }: Route.ComponentProps): React.JSX.Element {
  const day = loaderData
  const clear =
    day.needsOutcome.length === 0 &&
    day.appointments.length === 0 &&
    day.dueNow.length === 0 &&
    day.laterToday.length === 0

  return (
    <main
      style={{ maxWidth: '44rem', margin: '0 auto', padding: 'var(--space-10) var(--space-6)' }}
    >
      <h1
        style={{
          fontSize: 'var(--type-3xl)',
          fontWeight: 'var(--font-weight-bold)',
          letterSpacing: '-0.015em',
        }}
      >
        My Day
      </h1>

      {clear ? (
        <p
          style={{
            marginTop: 'var(--space-8)',
            padding: 'var(--space-10) var(--space-6)',
            textAlign: 'center',
            fontSize: 'var(--type-lg)',
            color: 'var(--color-text-secondary)',
            background: 'var(--color-surface-1)',
            border: '1px dashed var(--color-border-default)',
            borderRadius: 'var(--radius-lg)',
          }}
        >
          You&rsquo;re clear. Nothing due right now.
        </p>
      ) : (
        <>
          {/* First, and undismissable. A meeting whose end time has passed with
              no outcome is money that may already have been made and not
              recorded — it is the one row a seller must not be able to
              postpone away. */}
          <Section
            title="Needs outcome"
            items={day.needsOutcome}
            tone="caution"
            empty="Nothing waiting on you."
            tz={day.displayTz}
          />
          <Section
            title="Today's appointments"
            items={day.appointments}
            tone="info"
            empty="No appointments today."
            tz={day.displayTz}
          />
          <Section
            title="Due now"
            items={day.dueNow}
            tone="danger"
            empty="Nothing overdue."
            tz={day.displayTz}
          />
          <Section
            title="Later today"
            items={day.laterToday}
            tone="neutral"
            empty="Nothing else scheduled."
            tz={day.displayTz}
          />
        </>
      )}
    </main>
  )
}

const TONES = {
  caution: [
    'var(--color-caution-fill)',
    'var(--color-caution-stroke)',
    'var(--color-caution-text)',
  ],
  info: ['var(--color-info-fill)', 'var(--color-info-stroke)', 'var(--color-info-text)'],
  danger: ['var(--color-danger-fill)', 'var(--color-danger-stroke)', 'var(--color-danger-text)'],
  neutral: [
    'var(--color-neutral-state-fill)',
    'var(--color-neutral-state-stroke)',
    'var(--color-neutral-state-text)',
  ],
} as const

function Section({
  title,
  items,
  tone,
  empty,
  tz,
}: {
  title: string
  items: readonly MyDayItem[]
  tone: keyof typeof TONES
  empty: string
  tz: string
}): React.JSX.Element {
  const [fill, stroke, text] = TONES[tone]

  return (
    <section style={{ marginTop: 'var(--space-8)' }}>
      {/* The count sits in the header and renders before the rows do — a
          seller reads "Needs outcome (2)" and knows the shape of their day
          before a single row arrives. */}
      <h2
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-2)',
          fontSize: 'var(--type-md)',
          fontWeight: 'var(--font-weight-semibold)',
        }}
      >
        {title}
        <span
          style={{
            padding: '0 var(--space-2)',
            borderRadius: 'var(--radius-full)',
            background: fill,
            border: `1px solid ${stroke}`,
            color: text,
            fontSize: 'var(--type-xs)',
            fontWeight: 'var(--font-weight-semibold)',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {items.length}
        </span>
      </h2>

      {items.length === 0 ? (
        <p
          style={{
            marginTop: 'var(--space-2)',
            fontSize: 'var(--type-sm)',
            color: 'var(--color-text-tertiary)',
          }}
        >
          {empty}
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
          {items.map((item) => (
            <li
              key={item.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 'var(--space-4)',
                padding: 'var(--space-3) var(--space-4)',
                background: 'var(--color-surface-1)',
                border: '1px solid var(--color-border-subtle)',
                borderLeft: `3px solid ${stroke}`,
                borderRadius: 'var(--radius-md)',
              }}
            >
              <span style={{ fontSize: 'var(--type-base)' }}>{item.title}</span>
              {item.at ? <Clock iso={item.at} tz={tz} /> : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/**
 * The seller's DISPLAY timezone, explicitly — never the browser's.
 *
 * Found by looking at the rendered screen: the first version omitted the
 * `timeZone` option, so `toLocaleTimeString` fell back to whatever the machine
 * was set to. The server had already decided which appointments count as
 * "today" using `app_user.display_tz`, so an appointment could be filtered in
 * as today and then printed with tomorrow's hour — and a seller travelling, or
 * with a laptop set to the wrong zone, would read times that disagree with
 * what the office tells them.
 *
 * Passing the zone in also makes server and client render identical strings,
 * so there is no hydration flicker to suppress.
 */
function Clock({ iso, tz }: { iso: string; tz: string }): React.JSX.Element {
  return (
    <time
      dateTime={iso}
      style={{
        fontSize: 'var(--type-sm)',
        color: 'var(--color-text-secondary)',
        fontVariantNumeric: 'tabular-nums',
        whiteSpace: 'nowrap',
      }}
    >
      {new Date(iso).toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        timeZone: tz,
      })}
    </time>
  )
}

export function ErrorBoundary(): React.JSX.Element {
  const error = useRouteError()
  const unauthorized = isRouteErrorResponse(error) && error.status === 401

  return (
    <main
      style={{ maxWidth: '32rem', margin: '0 auto', padding: 'var(--space-16) var(--space-6)' }}
    >
      <div
        role="alert"
        style={{
          padding: 'var(--space-6)',
          borderRadius: 'var(--radius-lg)',
          background: unauthorized ? 'var(--color-info-fill)' : 'var(--color-danger-fill)',
          border: `1px solid ${
            unauthorized ? 'var(--color-info-stroke)' : 'var(--color-danger-stroke)'
          }`,
        }}
      >
        <h1
          style={{
            fontSize: 'var(--type-lg)',
            fontWeight: 'var(--font-weight-semibold)',
            color: unauthorized ? 'var(--color-info-text)' : 'var(--color-danger-text)',
          }}
        >
          {unauthorized ? 'Sign in to see your day' : 'Your day could not load'}
        </h1>
        <p
          style={{
            marginTop: 'var(--space-2)',
            fontSize: 'var(--type-sm)',
            color: 'var(--color-text-secondary)',
          }}
        >
          {unauthorized
            ? 'My Day shows your own work, so it needs to know who you are.'
            : 'Nothing was lost. Your appointments and callbacks are still scheduled.'}
        </p>
      </div>
    </main>
  )
}
