import type { BookRow } from '~/routes/api/my-book'

import { BookChipBadge } from './book-chip-badge'

/**
 * C-17 — My Book below 1024. 72px two-line rows.
 *
 * Two lines rather than four columns because below the density boundary the
 * targets are 44px and a four-column table becomes a horizontal scroll, which
 * is the one interaction a seller cannot do while holding a phone to their ear.
 */
export function BookList({ rows }: { readonly rows: readonly BookRow[] }): React.JSX.Element {
  return (
    <ul style={{ listStyle: 'none', margin: 0, padding: 0 }} aria-label="My Book">
      {rows.map((r) => (
        <li
          key={r.contactId}
          style={{
            minHeight: '72px',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
            gap: 'var(--space-1)',
            padding: 'var(--space-2) var(--space-4)',
            borderBottom: '1px solid var(--color-border)',
          }}
        >
          <a
            href={`/contacts/${r.contactId}`}
            style={{ color: 'var(--color-text)', fontSize: 'var(--type-md)' }}
          >
            {r.fullName}
          </a>
          <span
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--space-2)',
              color: 'var(--color-text-muted)',
              fontSize: 'var(--type-sm)',
            }}
          >
            <BookChipBadge chip={r.chip} />
            {r.badNumber ? 'Bad number' : (r.phoneE164 ?? 'No number')}
          </span>
        </li>
      ))}
    </ul>
  )
}
