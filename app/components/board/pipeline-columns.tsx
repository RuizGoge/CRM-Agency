import { memo, useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router'

import { format, fromWireString } from '~/lib/money/money'
import type { BoardCard, BoardColumn } from '~/routes/api/board'
import { BREAKPOINTS } from '~/styles/tokens/timing'

/**
 * The board's columns, with drag bound on top of them.
 *
 * Drag is ADDITIVE and that ordering is the design (ruling G12). The move
 * sheet was built first and is the universal path — mobile, keyboard, and
 * assistive technology all go through it — so if drag ever breaks, the product
 * still works and the failure is confined to one surface on one class of
 * device. Nothing here is the only way to do anything.
 *
 * Bound only at >=BREAKPOINTS.lg AND `pointer: fine`, together. Width alone
 * would arm it on a large tablet, where a drag competes with the scroll
 * gesture and a seller loses a card trying to scroll the board. The number
 * comes from the tokens module: two hard-coded breakpoints anywhere in the
 * tree is a build failure.
 *
 * The check runs in an effect, so the server renders cards that are not
 * draggable. That is the honest default — without JavaScript there is no drag,
 * and the markup should not claim otherwise.
 */
export function PipelineColumns({
  columns,
  onDropCard,
  onNeedsGate,
  pendingCardId,
}: {
  columns: readonly BoardColumn[]
  /** A drop onto an open stage: submitted straight away. */
  onDropCard: (cardId: string, fromStageId: string, toStageId: string) => void
  /** A drop onto a stage whose gate needs input a drop cannot carry. */
  onNeedsGate: (cardId: string) => void
  /** Rendered mid-flight, so the card reads as in-progress rather than done. */
  pendingCardId: string | null
}): React.JSX.Element {
  // THREE states, not two. `null` means "not decided yet", and the difference
  // is load-bearing for the tests: `data-drag` is absent until the effect has
  // run, so waiting for the ATTRIBUTE proves hydration finished and its VALUE
  // is the answer. With a plain boolean, "drag is off" and "the page has not
  // rendered yet" produce the same DOM, and an assertion that drag is off
  // passes before the page exists — which is a test that would go on passing
  // if drag started appearing on phones.
  const [dragEnabled, setDragEnabled] = useState<boolean | null>(null)
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [overStageId, setOverStageId] = useState<string | null>(null)

  useEffect(() => {
    const query = window.matchMedia(`(min-width: ${BREAKPOINTS.lg}px) and (pointer: fine)`)
    const apply = (): void => setDragEnabled(query.matches)
    apply()
    query.addEventListener('change', apply)
    return () => query.removeEventListener('change', apply)
  }, [])

  // STABLE IDENTITY, which is what makes the memo on Card do anything at all.
  // As inline arrows these were new objects on every render, so all 500 cards
  // failed their prop comparison every time the pointer crossed a column.
  const handleCardDragStart = useCallback((e: React.DragEvent<HTMLElement>, id: string): void => {
    // Firefox refuses to start a drag without payload.
    e.dataTransfer.setData('text/plain', id)
    e.dataTransfer.effectAllowed = 'move'
    setDraggingId(id)
  }, [])

  const handleCardDragEnd = useCallback((): void => {
    setDraggingId(null)
    setOverStageId(null)
  }, [])

  function handleDrop(target: BoardColumn): void {
    const cardId = draggingId
    setDraggingId(null)
    setOverStageId(null)
    if (cardId === null) return

    const from = columns.find((c) => c.cards.some((k) => k.id === cardId))
    // Dropped back where it started, or onto a board that moved underneath the
    // drag. Either way there is nothing to move.
    if (!from || from.id === target.id) return

    // A drop cannot carry a deal value or a loss reason, and the database will
    // refuse the move without them. Opening the sheet is not a fallback for a
    // failure — it is the gate appearing where it applies, before the seller is
    // told no.
    if (target.stageType !== 'open') {
      onNeedsGate(cardId)
      return
    }

    onDropCard(cardId, from.id, target.id)
  }

  return (
    <div
      data-drag={dragEnabled === null ? undefined : dragEnabled ? 'on' : 'off'}
      style={{
        display: 'flex',
        gap: 'var(--space-4)',
        overflowX: 'auto',
        paddingBottom: 'var(--space-4)',
      }}
    >
      {columns.map((column) => {
        const earning = column.stageType === 'earning'
        const over = overStageId === column.id && draggingId !== null

        return (
          <section
            key={column.id}
            aria-label={column.name}
            style={{
              flex: '0 0 17rem',
              display: 'flex',
              flexDirection: 'column',
              gap: 'var(--space-3)',
            }}
          >
            {/* The total sits BELOW the name rather than flush right. Pushed
                right it lands against the next column's heading, and two
                adjacent columns read as one run-on line. */}
            <header
              style={{ display: 'grid', gap: 'var(--space-1)', minHeight: 'var(--space-10)' }}
            >
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--space-2)' }}>
                <h2
                  style={{ fontSize: 'var(--type-sm)', fontWeight: 'var(--font-weight-semibold)' }}
                >
                  {column.name}
                </h2>
                <span style={{ fontSize: 'var(--type-xs)', color: 'var(--color-text-tertiary)' }}>
                  {column.cards.length}
                </span>
              </div>

              {/* Summed by the database. The client never adds money. */}
              {column.totalCents !== '0' ? (
                <span
                  className="money"
                  style={{
                    fontSize: 'var(--type-xs)',
                    fontWeight: 'var(--font-weight-semibold)',
                    color: earning ? 'var(--color-success-text)' : 'var(--color-text-secondary)',
                  }}
                >
                  {format(fromWireString(column.totalCents))}
                </span>
              ) : null}
            </header>

            <div
              // dragover fires continuously; the state only changes on enter
              // and leave. Re-rendering the board on every dragover event is
              // how a drag stops holding 60fps.
              onDragOver={dragEnabled === true ? (e) => e.preventDefault() : undefined}
              onDragEnter={dragEnabled === true ? () => setOverStageId(column.id) : undefined}
              onDragLeave={
                dragEnabled === true
                  ? (e) => {
                      // Only when the pointer leaves the column itself, not
                      // when it crosses a card inside it.
                      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                        setOverStageId((current) => (current === column.id ? null : current))
                      }
                    }
                  : undefined
              }
              onDrop={
                dragEnabled === true
                  ? (e) => {
                      e.preventDefault()
                      handleDrop(column)
                    }
                  : undefined
              }
              style={{
                display: 'grid',
                gap: 'var(--space-2)',
                alignContent: 'start',
                minHeight: 'var(--space-16)',
                padding: 'var(--space-2)',
                background: over ? 'var(--color-selected-bg)' : 'var(--color-surface-2)',
                borderRadius: 'var(--radius-lg)',
                // An inset ring rather than a border: a border changes the box
                // and every card below it shifts by a pixel as the pointer
                // crosses columns.
                boxShadow: over ? 'inset 0 0 0 2px var(--color-action-primary-bg)' : undefined,
                // NO TRANSITION HERE, and the reason is a defect this had.
                //
                // With `transition: background …` the tint never arrived at
                // all: measured on the real element, the inline style read
                // `var(--color-selected-bg)` for a full 500ms while the
                // computed background-color stayed on the old value the whole
                // time. Chromium would not interpolate between two custom
                // properties and the result was not "no animation", it was the
                // new colour never applying. The drop target looked inert
                // while the code said it was highlighted.
                //
                // Found by reading computed style over time, not by looking:
                // the ring rendered correctly, so the column did light up and
                // the missing tint was invisible next to it.
              }}
            >
              {column.cards.length === 0 ? (
                <p
                  style={{
                    margin: 0,
                    padding: 'var(--space-4) var(--space-2)',
                    textAlign: 'center',
                    fontSize: 'var(--type-xs)',
                    color: 'var(--color-text-tertiary)',
                  }}
                >
                  Nothing here yet.
                </p>
              ) : (
                column.cards.map((card) => (
                  <Card
                    key={card.id}
                    card={card}
                    draggable={dragEnabled === true}
                    dragging={draggingId === card.id}
                    pending={pendingCardId === card.id}
                    onDragStart={handleCardDragStart}
                    onDragEnd={handleCardDragEnd}
                  />
                ))
              )}
            </div>
          </section>
        )
      })}
    </div>
  )
}

/**
 * MEMOISED, and that is a performance budget rather than a preference.
 *
 * `overStageId` changes on every column the pointer crosses, and without this
 * every one of those re-rendered ALL 500 cards on the `perf-500` fixture.
 * Sprint-0 Gate 12 measured it: a frame was dropped on every single column
 * crossing — a max frame of 33.3 ms against a 34 ms budget, which is not
 * headroom, it is luck, and it reached 50 ms often enough to fail one run in six.
 *
 * Memo alone would not have been enough. The handlers were inline arrows created
 * fresh on each render, so every card's props changed identity every time and a
 * memo comparison would have returned false for all 500 of them. The callbacks
 * being stable is half of this fix, not a tidy-up alongside it.
 */
const Card = memo(function Card({
  card,
  draggable,
  dragging,
  pending,
  onDragStart,
  onDragEnd,
}: {
  card: BoardCard
  draggable: boolean
  dragging: boolean
  pending: boolean
  onDragStart: (e: React.DragEvent<HTMLElement>, id: string) => void
  onDragEnd: () => void
}): React.JSX.Element {
  // Created per Card render, which costs nothing: it is not a prop, so it can
  // never be the reason a memo comparison fails.
  const handleDragStart = (e: React.DragEvent<HTMLElement>): void => {
    onDragStart(e, card.id)
  }

  return (
    <article
      draggable={draggable}
      onDragStart={draggable ? handleDragStart : undefined}
      onDragEnd={draggable ? onDragEnd : undefined}
      style={{
        padding: 'var(--space-3)',
        background: 'var(--color-surface-1)',
        border: '1px solid var(--color-border-subtle)',
        // THE HEALTH RAIL — leading edge, full height, and a GRADIENT rather
        // than a colour (§2.8). Below the threshold it fills from the top at
        // days-since-touch ÷ cold_threshold_days, so a card at day 5 of 7
        // already shows most of a rail: a seller watches decay coming instead
        // of finding it arrived. R6 deleted the two boundaries and kept the
        // gradient, which is what the old two-tier design was actually buying.
        //
        // Painted as a background rather than a border because a border cannot
        // be partially filled, and the fill IS the second signal.
        backgroundImage: railFill(card),
        backgroundRepeat: 'no-repeat',
        backgroundSize: '3px 100%',
        backgroundPosition: 'left top',
        borderRadius: 'var(--radius-md)',
        display: 'grid',
        // FIXED, and it is a foundation decision rather than a component one
        // (`04b` R1 scope note): every card is the same height so a column has
        // a uniform pitch, which is what makes a 500-card board virtualisable
        // and P6's 60 fps reachable. Ruling N17 fixes the numbers at 120px
        // desktop / 156px mobile — §2's own mock still draws 112, which is the
        // THIRD height this document has carried and the one N17 struck.
        //
        // `--card-h` switches at the density breakpoint in reset.css, next to
        // the only other hard-coded breakpoint number in the tree.
        height: 'var(--card-h)',
        gridAutoRows: 'min-content',
        alignContent: 'start',
        overflow: 'hidden',
        gap: 'var(--space-2)',
        cursor: draggable ? 'grab' : undefined,
        // Mid-flight, not done. The card is already in its new column here —
        // the server has not answered yet, and pretending otherwise is how a
        // seller stops believing the board.
        opacity: dragging || pending ? 0.55 : 1,
      }}
    >
      <span
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 'var(--space-2)',
        }}
      >
        <span
          style={{
            fontSize: 'var(--type-sm)',
            fontWeight: 'var(--font-weight-semibold)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {card.contactName}
        </span>

        {/* THE SIGNAL SLOT — exactly one, or nothing. The server decides which;
            a component that picked would be a second precedence order, and §2.4
            has one. The slot collapses rather than reserving space, because a
            card this size cannot afford a permanent empty box. */}
        {card.signal ? <SignalChip signal={card.signal} /> : null}
      </span>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-2)',
          fontSize: 'var(--type-xs)',
          color: 'var(--color-text-tertiary)',
        }}
      >
        {card.premiumCents ? (
          <span className="money" style={{ color: 'var(--color-text-secondary)' }}>
            {format(fromWireString(card.premiumCents))}
          </span>
        ) : (
          <span>No value yet</span>
        )}
        <span aria-hidden="true">·</span>
        {/* Element ⑤, both halves. §2.4 gives zero attempts its own sentence
            rather than the number 0 — `Not called yet` is a state a seller
            acts on, and `0 attempts` is a field they read past. */}
        <span>
          {card.attempts === 0
            ? 'Not called yet'
            : `${card.daysUntouched}d untouched · ${card.attempts} attempt${card.attempts === 1 ? '' : 's'}`}
        </span>
      </div>

      {card.nextActivity ? (
        <span style={{ fontSize: 'var(--type-xs)', color: 'var(--color-text-secondary)' }}>
          Next: {card.nextActivity}
        </span>
      ) : (
        <span style={{ fontSize: 'var(--type-xs)', color: 'var(--color-caution-text)' }}>
          No next step
        </span>
      )}

      {/* The universal path, and it does not go away when drag is available.
          `draggable={false}` because a link drags itself by default, which
          would start a link drag instead of a card drag from that corner. */}
      <Link
        to={`?move=${card.id}`}
        draggable={false}
        style={{
          justifySelf: 'start',
          fontSize: 'var(--type-xs)',
          color: 'var(--color-text-link)',
        }}
      >
        Move
      </Link>
    </article>
  )
})

/**
 * The health rail, drawn as a partial fill from the top.
 *
 * `04b` §2.8 calls it *"a two-signal gradient, not a colour"*, and both halves
 * of that matter for WCAG 1.4.1: the hue says WHICH state and the fill height
 * says HOW FAR, so a seller who cannot separate amber from grey still reads
 * the card. A solid 3px border could carry the first signal and never the
 * second, which is why this is a background image and not a border.
 *
 * The healthy rail is deliberately a visible hairline rather than nothing:
 * §5's contrast matrix grades it 1.29 and marks it *"carries no information by
 * design"*. A card with no rail at all would make the rail's ABSENCE a third
 * state, and there are five.
 */
function railFill(card: BoardCard): string {
  const color =
    card.health === 'blocked' || card.health === 'overdue'
      ? 'var(--color-rail-blocked)'
      : card.health === 'fresh'
        ? 'var(--color-rail-fresh)'
        : card.health === 'going_cold'
          ? 'var(--color-rail-cold)'
          : null

  // A named health state fills the whole edge: it is a verdict, not a slope.
  if (color !== null) return `linear-gradient(to bottom, ${color} 0 100%)`

  // `ok`, but decaying. This is the gradient R6 kept when it deleted the two
  // boundaries — the card is on its way to the threshold and says so before it
  // gets there. `decay` is computed on the server against the tenant's own
  // cold_threshold_days; the client never sees either number.
  const filled = Math.round(card.decay * 100)
  if (filled <= 0) return `linear-gradient(to bottom, var(--color-rail-none) 0 100%)`

  return (
    `linear-gradient(to bottom, var(--color-rail-cold) 0 ${filled}%, ` +
    `var(--color-rail-none) ${filled}% 100%)`
  )
}

/**
 * One signal, in two renderings that §2.7 ratifies as one concept.
 *
 * The card face carries the ≤16-character chip because the card is 264px wide;
 * the ACCESSIBLE NAME carries R11's full sentence. A screen-reader user hears
 * `Going cold — 9 days since last touch` where a sighted seller reads
 * `Going cold · 9d`, and neither of them ever meets the banned word.
 */
function SignalChip({ signal }: { signal: NonNullable<BoardCard['signal']> }): React.JSX.Element {
  const [fill, text] =
    signal.kind === 'overdue'
      ? ['var(--color-danger-fill)', 'var(--color-danger-text)']
      : signal.kind === 'fresh'
        ? ['var(--color-info-fill)', 'var(--color-info-text)']
        : ['var(--color-caution-fill)', 'var(--color-caution-text)']

  return (
    <span
      // The full sentence, not the chip: the visible text is an abbreviation
      // and an abbreviation is not an accessible name.
      aria-label={signal.full}
      title={signal.full}
      style={{
        flexShrink: 0,
        padding: '0 var(--space-15)',
        borderRadius: 'var(--radius-xs)',
        background: fill,
        color: text,
        fontSize: 'var(--type-micro)',
        fontWeight: 'var(--font-weight-semibold)',
        whiteSpace: 'nowrap',
      }}
    >
      {signal.chip}
    </span>
  )
}
