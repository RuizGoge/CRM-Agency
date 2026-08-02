import { useEffect, useRef, useState } from 'react'
import { useFetcher } from 'react-router'

import { format, fromWireString } from '~/lib/money/money'
import type { CelebrationToken } from '~/modules/earnings/celebration'
import { CELEBRATION_VISIBLE_MS } from '~/styles/tokens/timing'

/**
 * The money moment.
 *
 * Rendered at T+5,000 ms by the undo window's OWN timer — there is no second
 * clock here, which is ruling P2.1 and the reason `04b`'s deleted
 * `--time-celebration-delay` token stays deleted. Everything on screen came in
 * the payload the page already held, so the +/-100 ms window of D3-05 has no
 * network on its render path (P2.4).
 *
 * The claim is recorded AFTER the render, never before. A refused claim
 * therefore costs a database row and never a missing animation, and the only
 * possible failure mode stays "no confetti" rather than "late confetti".
 *
 * Owner-scoped: this is the seller's own screen. There is no tenant-wide
 * broadcast (P2.2) — what the floor sees is the leaderboard re-ranking on its
 * own five-second channel, which is a different thing with a different budget.
 */
export function Celebration({ token }: { token: CelebrationToken }): React.JSX.Element | null {
  const claim = useFetcher()
  const claimed = useRef(false)
  const [visible, setVisible] = useState(true)

  useEffect(() => {
    // Its own lifetime, which is a different question from when it fires. P2.1
    // governs the DELAY and there is still exactly one timer for that — the undo
    // window's. This one only decides when the overlay stops sitting over the
    // middle of the board.
    const timer = setTimeout(() => setVisible(false), CELEBRATION_VISIBLE_MS)
    return () => clearTimeout(timer)
  }, [])

  useEffect(() => {
    // Once per mount, and the database refuses a second claim anyway. Both,
    // because a StrictMode double-effect in development would otherwise look
    // like the bug this guards against.
    if (claimed.current) return
    claimed.current = true
    void claim.submit(
      { opportunityId: token.opportunityId },
      { method: 'post', action: '/api/celebrate' },
    )
  }, [claim, token.opportunityId])

  if (!visible) return null

  return (
    <div
      // `alert`, not `status`: this interrupts on purpose. It is the one moment
      // in the product that is allowed to.
      role="alert"
      style={{
        position: 'fixed',
        inset: 0,
        display: 'grid',
        placeItems: 'center',
        pointerEvents: 'none',
        zIndex: 20,
      }}
    >
      <div
        className="celebration-card"
        style={{
          display: 'grid',
          gap: 'var(--space-2)',
          justifyItems: 'center',
          padding: 'var(--space-6) var(--space-8)',
          background: 'var(--color-surface-1)',
          border: '2px solid var(--color-action-money-bg)',
          borderRadius: 'var(--radius-xl)',
        }}
      >
        <span
          style={{
            fontSize: 'var(--type-xs)',
            fontWeight: 'var(--font-weight-semibold)',
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            color: 'var(--color-success-text)',
          }}
        >
          Sold
        </span>
        <strong
          className="money"
          style={{ fontSize: 'var(--type-3xl)', color: 'var(--color-success-text)' }}
        >
          {format(fromWireString(token.annualCents))}
        </strong>
        <span style={{ fontSize: 'var(--type-sm)', color: 'var(--color-text-secondary)' }}>
          {token.contactName} · added to your Earnings
        </span>
      </div>

      {/* The confetti. Twenty-four pieces, positioned deterministically rather
          than at random: a fixed pattern renders identically on the server and
          the client, and this component must never be the reason a hydration
          warning appears on the screen a room is watching. */}
      <div aria-hidden="true" style={{ position: 'fixed', inset: 0, overflow: 'hidden' }}>
        {Array.from({ length: 24 }, (_, i) => (
          <span
            key={i}
            className="confetti-piece"
            style={{
              position: 'absolute',
              left: `${(i * 37) % 100}%`,
              top: '-5%',
              width: 'var(--space-2)',
              height: 'var(--space-3)',
              borderRadius: 'var(--radius-xs)',
              background:
                i % 3 === 0
                  ? 'var(--color-action-money-bg)'
                  : i % 3 === 1
                    ? 'var(--color-action-primary-bg)'
                    : 'var(--color-caution-text)',
              animationDelay: `${(i % 8) * 60}ms`,
            }}
          />
        ))}
      </div>
    </div>
  )
}
