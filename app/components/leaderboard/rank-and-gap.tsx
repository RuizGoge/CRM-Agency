import type { BoardPayload, NextUp } from '~/routes/api/leaderboard'
import { format, fromWireString, isZero } from '~/lib/money/money'

/**
 * `RankGapBlock` (C-39) — the seller home's rank, total and gap sentence.
 *
 * Protected item 10's last big piece, and `04-ux-flows.md` §7 is explicit
 * about why it earns a component: it is the one number on the seller home that
 * "does the entire pitch before a word is spoken". Feature 4 of the
 * leaderboard module gives the product reason — rank alone is a verdict, a
 * dollar gap is a goal — and feature 28 gives the placement: sellers live in
 * My Day, so a board only they go looking for is a board most never open.
 *
 * 🔴 PRECEDENCE, and it cost a rewrite. The first version of this file was
 * built from §7's narrative, which reads `$6,900 behind Dana R.`, and from
 * `04b` §4.1's ASCII mock, which says the same. **Both are superseded inside
 * `04b` itself.** R5.4 rules that the seller home is specified in `04b`; §4.1's
 * own "Gap sentence variants" row, three lines under that mock, lists
 * `{amount} to pass {peer_short}` and adds *"never invent a gap sentence that
 * is not motivating"*; and §4.8 ratifies the same wording as `lb.self.gap`
 * under a table whose rule is **"keys not listed do not exist"**. Two sources
 * agree against one stale drawing.
 *
 * The distinction is not stylistic. `behind` is a loss frame and `to pass` is
 * a goal frame, and the leaderboard module's feature 30 bans the first
 * outright: rank messages are *"always phrased as a gap and an action, never
 * as a loss"*. `behind` survives in exactly one place — `earn.celebrate.*`,
 * the toast at the moment a seller has just passed somebody, where it is a
 * report of something that already happened rather than a verdict.
 *
 * NO ARITHMETIC HAPPENS HERE. Every amount arrives already computed, as a
 * string of whole cents, and this file turns integers into en-US text. Both
 * operands of the gap sit in the same response, which is what makes this the
 * most tempting place in the product to do money arithmetic on a client.
 */
export function RankAndGap({ board }: { board: BoardPayload }): React.JSX.Element {
  // `lb.supervisor_total`. Supervisors and admins get no self-row because they
  // cannot write into a seller's book, and a permanent $0 reads as last place
  // rather than as not competing. The slot is not left blank: an empty band on
  // the home screen reads as a surface that failed.
  if (!board.self) {
    return (
      <Frame>
        <span style={{ fontSize: 'var(--type-md)', color: 'var(--color-text-secondary)' }}>
          Floor total &mdash;{' '}
          <span className="money" style={{ color: 'var(--color-money-neutral)' }}>
            {format(fromWireString(board.floorTotalCents))}
          </span>
        </span>
      </Frame>
    )
  }

  // `lb.self.zero_alltime`. A rank and a gap are meaningless at $0, and
  // "$11,580 to pass Priya N." on a new hire's first morning is the sentence
  // that makes them stop opening the screen — §4.8 says so in as many words.
  //
  // The sibling key `lb.self.zero` (`{amount} to get on the board`) is NOT
  // implemented here and it is not an omission: C-39 makes this block all-time
  // only, and that key is scoped to "self-row at $0 in a BOUNDED period" — the
  // leaderboard's own pinned row, which does not exist yet. Its `{amount}` is
  // also ambiguous in the spec: the same gap it replaces would read the same
  // demotivating number in different words. Guessing it here would put a
  // number on a seller's screen that no document authorises.
  if (isZero(fromWireString(board.self.totalCents))) {
    return (
      <Frame>
        <span
          style={{
            fontSize: 'var(--type-lg)',
            fontWeight: 'var(--font-weight-semibold)',
            color: 'var(--color-text-primary)',
          }}
        >
          Your first sale puts you on the board.
        </span>
      </Frame>
    )
  }

  return (
    <Frame>
      <span
        style={{
          fontSize: 'var(--type-2xl)',
          fontWeight: 'var(--font-weight-bold)',
          color: 'var(--color-text-primary)',
          fontVariantNumeric: 'tabular-nums',
          whiteSpace: 'nowrap',
        }}
      >
        You&rsquo;re #{board.self.rank}
      </span>

      <Dot />

      <span
        className="money"
        style={{
          fontSize: 'var(--type-3xl)',
          color: 'var(--color-money-neutral)',
          whiteSpace: 'nowrap',
        }}
      >
        {format(fromWireString(board.self.totalCents))}
      </span>

      {/* The one that disappears on a phone, where the wrap does its job —
          see the rule in reset.css. */}
      <Dot className="standing-separator-last" />

      <Gap nextUp={board.nextUp} leadCents={board.leadCents} />
    </Frame>
  )
}

/**
 * The gap sentence, which has three shapes above $0 and not one.
 *
 * `#1` has nobody above them and reads `Leading by {amount}` — a leader shown
 * "$0 to pass" reads as a bug. A tie is possible on money even though it is
 * impossible on rank, because the board's window breaks ties by user id: two
 * sellers on the same total take adjacent ranks and the only visible trace is
 * a gap of zero. Left unhandled that renders `$0 to pass Priya N.`, which is
 * the sentence a seller screenshots and sends to their manager.
 */
function Gap({
  nextUp,
  leadCents,
}: {
  nextUp: NextUp | null
  leadCents: string | null
}): React.JSX.Element {
  const sentence = { fontSize: 'var(--type-base)', color: 'var(--color-text-secondary)' } as const

  if (!nextUp) {
    // `lb.self.leading`. A leader on a board of one has no margin to state, so
    // the sentence is dropped rather than rendered as "Leading by $0".
    if (leadCents === null) return <span style={sentence}>Leading the board</span>

    return (
      <span style={sentence}>
        Leading by{' '}
        <span className="money" style={{ color: 'var(--color-money-neutral)' }}>
          {format(fromWireString(leadCents))}
        </span>
      </span>
    )
  }

  const gap = fromWireString(nextUp.gapCents)
  const rival = shortName(nextUp.displayName)

  // `lb.self.tied`
  if (isZero(gap)) return <span style={sentence}>Tied with {rival}</span>

  // `lb.self.gap`
  return (
    <span style={sentence}>
      <span className="money" style={{ color: 'var(--color-money-neutral)' }}>
        {format(gap)}
      </span>{' '}
      to pass {rival}
    </span>
  )
}

/**
 * `{peer_short}` — `Dana Reyes` becomes `Dana R.`
 *
 * Not privacy: the board next door renders every name it is given. It is
 * length, and it is the form every example in the corpus uses. The seed writes
 * `display_name` in this shape already, and this is idempotent on it — the
 * defence is for a real tenant that configures a full name.
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
