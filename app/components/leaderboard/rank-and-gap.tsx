import type { BoardRow, NextUp } from '~/routes/api/leaderboard'
import { format, fromWireString, isZero } from '~/lib/money/money'

/**
 * `You're #2 · $9,029.88 · $2,550.12 behind Priya N.`
 *
 * Protected item 10's last missing piece, and `04-ux-flows.md` §7 is explicit
 * about why it is worth a component of its own: it is the one number on the
 * seller home that "does the entire pitch before a word is spoken". The
 * leaderboard module's feature 4 gives the product reason — rank alone is a
 * verdict, a dollar gap is a goal — and its feature 28 gives the placement:
 * sellers live in My Day, so a board only they go looking for is a board most
 * of them never open.
 *
 * NO ARITHMETIC HAPPENS HERE. The gap arrives already subtracted, as a string
 * of whole cents, and this file turns integers into en-US text and does
 * nothing else with them. Both operands of that subtraction are in the same
 * response, which is exactly what makes this the most tempting place in the
 * product to compute money on a client.
 */
export function RankAndGap({
  self,
  nextUp,
}: {
  self: BoardRow | null
  nextUp: NextUp | null
}): React.JSX.Element {
  // Supervisors and admins cannot write into a seller's book, so the board
  // does not rank them. Saying so is better than an empty space that reads as
  // a surface that failed to load.
  if (!self) {
    return (
      <Frame>
        <span style={{ fontSize: 'var(--type-sm)', color: 'var(--color-text-secondary)' }}>
          You&rsquo;re not ranked on the Earnings board.
        </span>
      </Frame>
    )
  }

  return (
    <Frame>
      <span
        style={{
          fontSize: 'var(--type-xl)',
          fontWeight: 'var(--font-weight-bold)',
          color: 'var(--color-text-primary)',
          fontVariantNumeric: 'tabular-nums',
          whiteSpace: 'nowrap',
        }}
      >
        You&rsquo;re #{self.rank}
      </span>

      <Dot />

      <span
        className="money"
        style={{
          fontSize: 'var(--type-xl)',
          color: 'var(--color-text-primary)',
          whiteSpace: 'nowrap',
        }}
      >
        {format(fromWireString(self.totalCents))}
      </span>

      {/* The one that disappears on a phone, where the wrap does its job —
          see the rule in reset.css. */}
      <Dot className="standing-separator-last" />

      <Gap nextUp={nextUp} />
    </Frame>
  )
}

/**
 * The third clause, which has three shapes and not one.
 *
 * `#1` has nobody above them, and a leader shown "$0 behind" reads as a bug.
 * A tie is possible on totals even though it is not possible on rank — the
 * board's window breaks ties by user id, so two sellers on the same money get
 * adjacent ranks and a gap of zero — and "$0 behind Priya N." is the sentence
 * a seller screenshots and sends to their manager.
 */
function Gap({ nextUp }: { nextUp: NextUp | null }): React.JSX.Element {
  if (!nextUp) {
    return (
      <span
        style={{
          fontSize: 'var(--type-md)',
          fontWeight: 'var(--font-weight-semibold)',
          color: 'var(--color-success-text)',
        }}
      >
        Leading the board
      </span>
    )
  }

  const gap = fromWireString(nextUp.gapCents)
  const rival = shortName(nextUp.displayName)

  if (isZero(gap)) {
    return (
      <span style={{ fontSize: 'var(--type-md)', color: 'var(--color-text-secondary)' }}>
        Tied with {rival}
      </span>
    )
  }

  return (
    <span style={{ fontSize: 'var(--type-md)', color: 'var(--color-text-secondary)' }}>
      <span className="money" style={{ color: 'var(--color-text-primary)' }}>
        {format(gap)}
      </span>{' '}
      behind {rival}
    </span>
  )
}

/**
 * `Priya Nair` becomes `Priya N.` — the form §7 writes the line in.
 *
 * Not privacy: the board next door renders every full name. It is length. This
 * line has to survive a 480px phone on one row, and a surname is the part a
 * seller does not need to know which colleague is above them.
 */
function shortName(displayName: string): string {
  const parts = displayName.trim().split(/\s+/)
  const first = parts[0] ?? displayName
  const last = parts.length > 1 ? parts[parts.length - 1] : undefined
  const initial = last?.[0]

  return initial ? `${first} ${initial}.` : first
}

/** Hidden from assistive technology: a separator is punctuation, not content. */
function Dot({ className }: { className?: string }): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      {...(className ? { className } : {})}
      style={{ color: 'var(--color-text-tertiary)' }}
    >
      &middot;
    </span>
  )
}

function Frame({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <span
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'baseline',
        gap: 'var(--space-2)',
      }}
    >
      {children}
    </span>
  )
}
