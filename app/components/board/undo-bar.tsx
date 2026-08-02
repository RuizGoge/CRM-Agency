import { useEffect, useState } from 'react'
import { Form, Link } from 'react-router'

import { UNDO_WINDOW_MS } from '~/styles/tokens/timing'

/**
 * The five-second undo, on the surface where the move happened.
 *
 * This is the counterpart the board was already paying for. The public
 * leaderboard has been withholding every sale for 5.5 seconds since the ledger
 * was built, to protect an undo that did not exist yet: the cost was charged
 * and the thing it bought was missing.
 *
 * The affordance is a plain POST to the same gated path as any other move. It
 * is not a privileged rollback and there is no delete: undoing appends a
 * reversal, and whether the public board ever publishes the pair is decided by
 * the gap between the two ledger rows, not by which button was pressed. A
 * seller who drags the card back by hand inside the window is protected
 * identically — which is the property that makes this a mechanism rather than a
 * feature of one button.
 *
 * Without JavaScript the bar does not self-dismiss; it stays until the next
 * navigation, and `Dismiss` is an ordinary link. A late press is not refused —
 * it is simply an ordinary move back, published on the ordinary delay.
 */
export function UndoBar({
  opportunityId,
  contactName,
  toStageName,
  backStageId,
  backStageName,
}: {
  opportunityId: string
  contactName: string
  toStageName: string
  backStageId: string
  backStageName: string
}): React.JSX.Element | null {
  const [visible, setVisible] = useState(true)

  useEffect(() => {
    // UNDO_WINDOW_MS, never a literal and never shortened by reduced motion:
    // the window is a product promise, not an animation.
    const timer = setTimeout(() => setVisible(false), UNDO_WINDOW_MS)
    return () => clearTimeout(timer)
  }, [])

  if (!visible) return null

  return (
    <div
      role="status"
      style={{
        position: 'fixed',
        left: '50%',
        bottom: 'var(--space-6)',
        transform: 'translateX(-50%)',
        zIndex: 10,
        width: 'min(30rem, calc(100% - var(--space-8)))',
        overflow: 'hidden',
        background: 'var(--color-surface-inverse)',
        color: 'var(--color-text-inverse)',
        borderRadius: 'var(--radius-lg)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-4)',
          padding: 'var(--space-3) var(--space-4)',
        }}
      >
        <p style={{ margin: 0, flex: 1, fontSize: 'var(--type-sm)' }}>
          Moved {contactName} to {toStageName}.
        </p>

        <Form method="post" style={{ display: 'contents' }}>
          <input type="hidden" name="intent" value="undo" />
          <input type="hidden" name="opportunityId" value={opportunityId} />
          <input type="hidden" name="toStageId" value={backStageId} />
          <button
            type="submit"
            style={{
              padding: 'var(--space-1) var(--space-2)',
              background: 'none',
              border: 'none',
              color: 'var(--color-text-link-inverse)',
              fontSize: 'var(--type-sm)',
              fontWeight: 'var(--font-weight-semibold)',
              cursor: 'pointer',
            }}
          >
            {/* Names the destination. `Undo` alone asks a seller to remember
                which column the card came from, five seconds after a drag. */}
            Undo — back to {backStageName}
          </button>
        </Form>

        <Link
          to="/board"
          style={{
            fontSize: 'var(--type-xs)',
            color: 'var(--color-text-inverse)',
            opacity: 0.72,
          }}
        >
          Dismiss
        </Link>
      </div>

      {/* The window, drawn. A countdown a seller can see is the difference
          between "there is still time" and pressing Undo into nothing. The
          class carries the reduced-motion exemption in motion.css — collapsed
          to 1ms this rail would report the deadline gone with four and a half
          seconds left. */}
      <div
        aria-hidden="true"
        className="undo-window-rail"
        style={{
          height: '2px',
          background: 'var(--color-text-link-inverse)',
          transformOrigin: 'left',
          animation: 'undo-window-drain var(--time-undo-window) linear forwards',
        }}
      />
    </div>
  )
}
