import type { BoardRow as Row } from '~/routes/api/leaderboard'
import { format, fromWireString } from '~/lib/money/money'

/**
 * One seller on the public board.
 *
 * The total arrives as a string of whole cents and is formatted here. No
 * arithmetic happens on the client, ever — this component turns an integer
 * into en-US display text and does nothing else with it.
 */
export function BoardRow({ row }: { row: Row }): React.JSX.Element {
  const self = row.isSelf

  return (
    <li
      aria-current={self ? 'true' : undefined}
      style={{
        display: 'grid',
        gridTemplateColumns: 'var(--space-10) 1fr auto',
        alignItems: 'center',
        gap: 'var(--space-4)',
        padding: 'var(--space-3) var(--space-4)',
        borderRadius: 'var(--radius-md)',
        background: self ? 'var(--color-selected-bg)' : 'transparent',
        // A left rail rather than colour alone: the self row must be findable
        // without relying on hue (WCAG 1.4.1).
        boxShadow: self ? 'inset 3px 0 0 0 var(--color-action-primary-bg)' : undefined,
      }}
    >
      <span
        aria-label={`Rank ${row.rank}`}
        style={{
          fontSize: 'var(--type-sm)',
          fontWeight: 'var(--font-weight-semibold)',
          color: 'var(--color-text-tertiary)',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {row.rank}
      </span>

      <span
        style={{
          fontSize: 'var(--type-base)',
          fontWeight: self ? 'var(--font-weight-semibold)' : 'var(--font-weight-regular)',
          color: 'var(--color-text-primary)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {row.displayName}
        {self ? (
          <span
            style={{
              marginLeft: 'var(--space-2)',
              fontSize: 'var(--type-micro)',
              textTransform: 'uppercase',
              letterSpacing: '0.04em',
              color: 'var(--color-text-tertiary)',
            }}
          >
            You
          </span>
        ) : null}
      </span>

      <span
        className="money"
        style={{
          fontSize: 'var(--type-md)',
          fontWeight: 'var(--font-weight-semibold)',
          color: 'var(--color-text-primary)',
        }}
      >
        {format(fromWireString(row.totalCents))}
      </span>
    </li>
  )
}
