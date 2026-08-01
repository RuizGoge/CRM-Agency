import { annualize, format, parseUserAmount } from '~/lib/money/money'
import { UNDO_WINDOW_MS } from '~/styles/tokens/timing'

import type { Route } from './+types/home'

export function meta(_: Route.MetaArgs) {
  return [
    { title: 'CRM Leads' },
    { name: 'description', content: 'Lead pipeline and Earnings board for sales teams.' },
  ]
}

/**
 * Foundation screen. It exists to prove the Phase-6 success criterion: the dev
 * command serves a page that already reads the Phase-4 token layer, with no hex
 * literal and no magic number outside the token files.
 *
 * It is replaced by the pipeline board in Sprint 1.
 */
export default function Home() {
  // A real monthly Final Expense premium, annualised through the money path.
  const monthly = parseUserAmount('249.99')
  const annual = annualize(monthly)

  return (
    <main
      style={{
        maxWidth: '52rem',
        margin: '0 auto',
        padding: 'var(--space-16) var(--space-8) var(--space-12)',
      }}
    >
      <p
        style={{
          fontSize: 'var(--type-micro)',
          fontWeight: 'var(--font-weight-semibold)',
          letterSpacing: '0.04em',
          textTransform: 'uppercase',
          color: 'var(--color-text-tertiary)',
        }}
      >
        Foundation
      </p>

      <h1
        style={{
          marginTop: 'var(--space-2)',
          fontSize: 'var(--type-3xl)',
          fontWeight: 'var(--font-weight-bold)',
          letterSpacing: '-0.015em',
        }}
      >
        CRM Leads
      </h1>

      <p
        style={{
          marginTop: 'var(--space-3)',
          fontSize: 'var(--type-md)',
          color: 'var(--color-text-secondary)',
          maxWidth: '40rem',
        }}
      >
        The repository is scaffolded on the architecture signed in Phase 5. This page renders from
        the canonical token layer — no hex literal, no magic number.
      </p>

      <section
        aria-labelledby="money-path"
        style={{
          marginTop: 'var(--space-10)',
          padding: 'var(--space-6)',
          background: 'var(--color-surface-1)',
          border: '1px solid var(--color-border-subtle)',
          borderRadius: 'var(--radius-lg)',
        }}
      >
        <h2
          id="money-path"
          style={{ fontSize: 'var(--type-lg)', fontWeight: 'var(--font-weight-semibold)' }}
        >
          The money path is exact
        </h2>
        <p
          style={{
            marginTop: 'var(--space-2)',
            fontSize: 'var(--type-sm)',
            color: 'var(--color-text-secondary)',
          }}
        >
          Final Expense sells monthly; Earnings are annual. In floating-point arithmetic this
          multiplication drifts and a public board shows the wrong number. Here it cannot: money is
          integer cents behind a branded type.
        </p>

        <dl
          style={{
            marginTop: 'var(--space-5)',
            display: 'grid',
            gridTemplateColumns: 'auto 1fr',
            gap: 'var(--space-2) var(--space-6)',
            alignItems: 'baseline',
          }}
        >
          <dt style={{ fontSize: 'var(--type-sm)', color: 'var(--color-text-tertiary)' }}>
            Monthly premium
          </dt>
          <dd className="money" style={{ fontSize: 'var(--type-lg)' }}>
            {format(monthly, { showCents: true })}
          </dd>

          <dt style={{ fontSize: 'var(--type-sm)', color: 'var(--color-text-tertiary)' }}>
            Counts as Earnings
          </dt>
          <dd
            className="money"
            style={{ fontSize: 'var(--type-2xl)', color: 'var(--color-success-text)' }}
          >
            {format(annual, { showCents: true })}
          </dd>
        </dl>
      </section>

      <ul
        style={{
          marginTop: 'var(--space-8)',
          padding: 0,
          listStyle: 'none',
          display: 'grid',
          gap: 'var(--space-2)',
          fontSize: 'var(--type-sm)',
          color: 'var(--color-text-secondary)',
        }}
      >
        <li>
          Undo window:{' '}
          <strong style={{ color: 'var(--color-text-primary)' }}>{UNDO_WINDOW_MS} ms</strong> — one
          number a seller learns, read from the single timing source.
        </li>
        <li>
          Next: Sprint 0 verifies the hosting region before any resource is created. If it fails,
          the stack decision reverses.
        </li>
      </ul>
    </main>
  )
}
