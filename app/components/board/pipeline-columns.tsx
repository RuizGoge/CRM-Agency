import { useEffect, useState } from 'react'
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
                    onDragStart={(e) => {
                      // Firefox refuses to start a drag without payload.
                      e.dataTransfer.setData('text/plain', card.id)
                      e.dataTransfer.effectAllowed = 'move'
                      setDraggingId(card.id)
                    }}
                    onDragEnd={() => {
                      setDraggingId(null)
                      setOverStageId(null)
                    }}
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

function Card({
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
  onDragStart: (e: React.DragEvent<HTMLElement>) => void
  onDragEnd: () => void
}): React.JSX.Element {
  return (
    <article
      draggable={draggable}
      onDragStart={draggable ? onDragStart : undefined}
      onDragEnd={draggable ? onDragEnd : undefined}
      style={{
        padding: 'var(--space-3)',
        background: 'var(--color-surface-1)',
        border: '1px solid var(--color-border-subtle)',
        borderRadius: 'var(--radius-md)',
        display: 'grid',
        gap: 'var(--space-2)',
        cursor: draggable ? 'grab' : undefined,
        // Mid-flight, not done. The card is already in its new column here —
        // the server has not answered yet, and pretending otherwise is how a
        // seller stops believing the board.
        opacity: dragging || pending ? 0.55 : 1,
      }}
    >
      <span style={{ fontSize: 'var(--type-sm)', fontWeight: 'var(--font-weight-semibold)' }}>
        {card.contactName}
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
        <span>{card.daysUntouched}d untouched</span>
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
}
