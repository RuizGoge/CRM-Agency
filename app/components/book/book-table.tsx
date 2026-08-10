import type { BookRow } from '~/routes/api/my-book'

import { BookChipBadge } from './book-chip-badge'

/**
 * C-16 — My Book on desktop (≥1024). 48px rows, sticky header, no zebra.
 *
 * `04b` lists a zebra token for this table AND specifies C-16 as "no zebra".
 * The component spec wins: zebra earns its keep on a ledger of numbers where
 * the eye tracks along a row, and this table is four short columns where it is
 * decoration that fights the chip for attention.
 */
export function BookTable({ rows }: { readonly rows: readonly BookRow[] }): React.JSX.Element {
  return (
    <table
      style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--type-sm)' }}
      aria-label="My Book"
    >
      <thead>
        <tr>
          {['Name', 'Phone', 'Status', 'Open deals'].map((h) => (
            <th
              key={h}
              scope="col"
              style={{
                position: 'sticky',
                top: 0,
                textAlign: h === 'Open deals' ? 'right' : 'left',
                background: 'var(--color-surface-1)',
                borderBottom: '1px solid var(--color-border)',
                padding: 'var(--space-2) var(--space-3)',
                color: 'var(--color-text-muted)',
                fontWeight: 'var(--font-weight-medium)',
              }}
            >
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.contactId} style={{ height: '48px' }}>
            <td
              style={{ padding: '0 var(--space-3)', borderBottom: '1px solid var(--color-border)' }}
            >
              <a href={`/contacts/${r.contactId}`} style={{ color: 'var(--color-text)' }}>
                {r.fullName}
              </a>
            </td>
            <td
              style={{
                padding: '0 var(--space-3)',
                borderBottom: '1px solid var(--color-border)',
                color: r.badNumber ? 'var(--color-text-muted)' : 'var(--color-text)',
              }}
            >
              {/* A bad number is NOT offered. The seller sees why instead of
                  dialling a line that cannot connect. */}
              {r.badNumber ? 'Bad number' : (r.phoneE164 ?? '—')}
            </td>
            <td
              style={{ padding: '0 var(--space-3)', borderBottom: '1px solid var(--color-border)' }}
            >
              <BookChipBadge chip={r.chip} />
            </td>
            <td
              style={{
                padding: '0 var(--space-3)',
                borderBottom: '1px solid var(--color-border)',
                textAlign: 'right',
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {r.openDeals}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
