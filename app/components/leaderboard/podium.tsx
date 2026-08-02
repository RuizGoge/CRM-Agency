import type { BoardRow } from '~/routes/api/leaderboard'
import { format, fromWireString } from '~/lib/money/money'

const ORDER = [1, 0, 2] as const // silver, gold, bronze — tallest in the middle
const HEIGHTS = ['5rem', '7rem', '4rem'] as const

/**
 * The 1-2-3 podium.
 *
 * Rank is stated in text on every step, not encoded in height alone: the
 * visual order is decoration and a screen reader must get the same answer as
 * an eye does.
 */
export function Podium({ top }: { top: readonly BoardRow[] }): React.JSX.Element {
  return (
    <ol
      aria-label="Top three"
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(3, 1fr)',
        gap: 'var(--space-3)',
        alignItems: 'end',
        margin: 0,
        padding: 0,
        listStyle: 'none',
      }}
    >
      {ORDER.map((index, slot) => {
        const row = top[index]
        if (!row) return <li key={index} aria-hidden="true" />

        return (
          <li
            key={row.userId}
            aria-current={row.isSelf ? 'true' : undefined}
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'flex-end',
              gap: 'var(--space-2)',
            }}
          >
            <span
              style={{
                fontSize: 'var(--type-sm)',
                fontWeight: 'var(--font-weight-semibold)',
                color: 'var(--color-text-primary)',
                textAlign: 'center',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                maxWidth: '100%',
              }}
            >
              {row.displayName}
              {/* The viewer must be able to find themselves on the podium too.
                  Reading the accessibility tree of the first render is what
                  surfaced this: the highlight existed only on the list rows. */}
              {row.isSelf ? (
                <span
                  style={{
                    marginLeft: 'var(--space-1)',
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
                fontSize: 'var(--type-lg)',
                fontWeight: 'var(--font-weight-bold)',
                color: 'var(--color-success-text)',
              }}
            >
              {format(fromWireString(row.totalCents))}
            </span>

            {/* A fixed-height well with the bar sitting at its bottom, so all
                three list items are the same overall height and the names and
                amounts land on ONE baseline. Sizing the bar itself was not
                enough: with different bar heights the labels above them step,
                and the top three stop reading as a group — which is the only
                thing a podium is for. */}
            <div
              style={{
                width: '100%',
                height: '7rem',
                display: 'flex',
                alignItems: 'flex-end',
              }}
            >
              <div
                style={{
                  width: '100%',
                  height: HEIGHTS[slot],
                  borderRadius: 'var(--radius-md) var(--radius-md) 0 0',
                  background:
                    row.rank === 1 ? 'var(--color-action-money-bg)' : 'var(--color-surface-3)',
                  border: '1px solid var(--color-border-subtle)',
                  borderBottom: 'none',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                {/* Labelled, because a bare "2" read aloud after a name and an
                  amount is ambiguous — and because the step's height carries
                  the same information visually and carries none at all here. */}
                <span
                  aria-label={`Rank ${row.rank}`}
                  style={{
                    fontSize: 'var(--type-2xl)',
                    fontWeight: 'var(--font-weight-bold)',
                    color:
                      row.rank === 1
                        ? 'var(--color-action-money-fg)'
                        : 'var(--color-text-secondary)',
                  }}
                >
                  {row.rank}
                </span>
              </div>
            </div>
          </li>
        )
      })}
    </ol>
  )
}
