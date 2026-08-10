import { useEffect, useRef, useState } from 'react'
import { Form, NavLink, Outlet, redirect, useLocation } from 'react-router'

import { SearchOverlay } from '~/components/search/search-overlay'

import { sql } from 'drizzle-orm'

import { withTenant } from '~/db'
import { resolveIdentity } from '~/lib/auth/identity'

import type { Route } from './+types/shell'

/**
 * The shell every signed-in screen sits inside.
 *
 * It exists because three screens with no way between them are three
 * prototypes, not a product — a seller who lands on Earnings had no route to
 * My Day at all. It also puts the identity on screen, which is the cheapest
 * possible answer to "am I looking at my own book or someone else's".
 */
export async function loader({ request }: Route.LoaderArgs) {
  const identity = await resolveIdentity(request)
  if (!identity) {
    // Everything below this layout is a seller's own work. There is no
    // anonymous rendering of any of it, so the redirect belongs here rather
    // than repeated in each child.
    throw redirect('/sign-in')
  }

  return withTenant(identity, async (tx) => {
    const rows = await tx.execute<{ display_name: string; role: string; is_demo: boolean }>(
      sql`SELECT u.display_name,
                 u.role::text AS role,
                 t.is_demo
            FROM app.app_user u
            JOIN app.tenant t ON t.id = u.tenant_id
           WHERE u.tenant_id = app.current_tenant() AND u.id = app.current_user_id()`,
    )
    return {
      displayName: rows[0]?.display_name ?? 'You',
      role: rows[0]?.role ?? 'seller',
      isDemo: rows[0]?.is_demo ?? false,
    }
  })
}

export default function Shell({ loaderData }: Route.ComponentProps): React.JSX.Element {
  const scroller = useRef<HTMLDivElement | null>(null)
  const [scrollable, setScrollable] = useState(false)
  // Re-measured on navigation, because the answer is a property of the SCREEN
  // and not of the shell: My Day overflows on a phone and the board never does.
  const location = useLocation()

  useEffect(() => {
    const measure = (): void => {
      const el = scroller.current
      if (el) setScrollable(el.scrollHeight > el.clientHeight)
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [location.pathname, location.search])

  return (
    <>
      {/* A FLEX COLUMN THE HEIGHT OF THE VIEWPORT, and it exists for exactly one
          screen. The board's columns each need their own bounded scroll
          container — 04b §2.1 does its window arithmetic against a "900px column
          viewport", which presumes one — and a child cannot claim the leftover
          height of a parent that has none.

          🔴 `height`, NOT `minHeight`, and the difference was a defect measured
          on the real page rather than reasoned about. With `min-height` the
          wrapper still grows to its content, so `flex: 1` on the board's main
          handed it the GROWN height: the column's scroll container measured
          16,008px tall, `scrollHeight - clientHeight` was zero, and nothing
          scrolled. Every card was positioned correctly, the window arithmetic
          was correct, and the board rendered ten cards and then simply stopped.
          A virtualizer that never receives a scroll event looks exactly like a
          column with ten cards in it. */}
      <div style={{ display: 'flex', flexDirection: 'column', height: '100dvh' }}>
        <header
          style={{
            // Or a 500-card board would squeeze the nav out of existence.
            flexShrink: 0,
            borderBottom: '1px solid var(--color-border-subtle)',
            background: 'var(--color-surface-1)',
          }}
        >
          <div
            style={{
              maxWidth: '64rem',
              margin: '0 auto',
              padding: 'var(--space-3) var(--space-6)',
              display: 'flex',
              alignItems: 'center',
              // WRAPS, and the reason is a defect the Demo chip exposed rather
              // than caused. This row was already one item away from overflowing a
              // phone; adding the chip pushed it over, the document gained
              // horizontal scroll, and the undo bar — `position: fixed`, centred
              // on the viewport — stopped being clickable at its own coordinates.
              // The mobile e2e caught it as a pointer-event interception, which
              // is a layout bug wearing a test failure's clothes.
              flexWrap: 'wrap',
              // Smaller than the 6 it was: at 482px the old gap alone accounted
              // for most of the overflow.
              gap: 'var(--space-3)',
            }}
          >
            <span
              style={{
                fontSize: 'var(--type-sm)',
                fontWeight: 'var(--font-weight-bold)',
                letterSpacing: '-0.01em',
              }}
            >
              CRM Leads
            </span>

            {/* Protected item 10. The failure it names is precise: without a
              persistent marker, a screenshot of the demo is indistinguishable
              from a real customer's standings — and this product's whole
              credibility rests on the public board being trustworthy.

              It sits next to the wordmark and never scrolls away, because a
              chip that only appears on one screen is a chip that is missing on
              the screenshot somebody actually takes. */}
            {loaderData.isDemo ? (
              <span
                title="Seeded data. This is not a live account."
                style={{
                  padding: 'var(--space-1) var(--space-2)',
                  borderRadius: 'var(--radius-sm)',
                  background: 'var(--color-caution-fill)',
                  border: '1px solid var(--color-caution-stroke)',
                  color: 'var(--color-caution-text)',
                  fontSize: 'var(--type-xs)',
                  fontWeight: 'var(--font-weight-semibold)',
                  letterSpacing: '0.02em',
                }}
              >
                Demo
              </span>
            ) : null}

            <nav aria-label="Main" style={{ display: 'flex', gap: 'var(--space-1)' }}>
              <Tab to="/my-day">My Day</Tab>
              <Tab to="/board">Pipeline</Tab>
              <Tab to="/earnings">Earnings</Tab>
            </nav>

            <div
              style={{
                marginLeft: 'auto',
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--space-3)',
              }}
            >
              <span style={{ fontSize: 'var(--type-sm)', color: 'var(--color-text-secondary)' }}>
                {loaderData.displayName}
                {/* Shown because a supervisor's screens differ from a seller's in
                  ways that are easy to misread as a bug. */}
                {loaderData.role !== 'seller' ? (
                  <span
                    style={{
                      marginLeft: 'var(--space-2)',
                      fontSize: 'var(--type-micro)',
                      textTransform: 'uppercase',
                      letterSpacing: '0.04em',
                      color: 'var(--color-text-tertiary)',
                    }}
                  >
                    {loaderData.role}
                  </span>
                ) : null}
              </span>

              {/* `action` is required, not decoration: a Form with none posts to
                the ACTIVE route, and this layout has no path — the request
                lands on `/` and answers 405. */}
              <Form method="post" action="/sign-out">
                <button
                  type="submit"
                  style={{
                    padding: 'var(--space-2) var(--space-3)',
                    borderRadius: 'var(--radius-md)',
                    border: '1px solid var(--color-action-secondary-border)',
                    background: 'var(--color-action-secondary-bg)',
                    color: 'var(--color-action-secondary-fg)',
                    fontSize: 'var(--type-sm)',
                    cursor: 'pointer',
                  }}
                >
                  Sign out
                </button>
              </Form>
            </div>
          </div>
        </header>

        {/* THE PAGE SCROLLER MOVES OFF THE DOCUMENT AND ONTO THIS DIV, which is
            the price of the line above and is worth naming rather than leaving
            to be discovered. Bounding the wrapper to the viewport means the
            document can no longer scroll, so every screen that is taller than a
            phone — My Day, Earnings, a contact — needs somewhere to scroll that
            is not the document. This is it, and for those screens it behaves
            exactly as document scroll did.

            The board is the one screen that does NOT scroll here: its `main` is
            `flex: 1` with `minHeight: 0`, so it fits this box exactly and the
            scrolling happens one level further in, per column. */}
        <div
          ref={scroller}
          // 🔴 FOCUSABLE ONLY WHEN IT ACTUALLY SCROLLS, and both halves of that
          // are a defect this had.
          //
          // axe caught the first half on My Day at phone width: moving the
          // scroll off the document and onto a div produced a `serious`
          // `scrollable-region-focusable` — a region a mouse can scroll and a
          // keyboard cannot reach at all. The document never had that problem
          // because browsers scroll documents from the keyboard for free, which
          // is exactly the kind of thing you lose by taking scrolling away from
          // it. WCAG 2.1.1, and the remedy is a tab stop.
          //
          // But an UNCONDITIONAL tab stop is the second half. It would land
          // before the undo bar on every screen, and `undo-keyboard.spec.ts`
          // caps how many presses the undo may sit behind precisely because the
          // bar lives five seconds. The board does not scroll here — its `main`
          // fits this box exactly — so on the one screen where a wasted press
          // costs the most, there is nothing to operate and no stop.
          tabIndex={scrollable ? 0 : undefined}
          style={{
            flex: 1,
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
            overflowY: 'auto',
          }}
        >
          <Outlet />
        </div>
      </div>

      {/* IN THE SHELL, because Ctrl+K has to work "from any surface" and a
          shortcut wired per screen is one that works on the screens somebody
          remembered. It renders nothing until it opens. */}
      <SearchOverlay />
    </>
  )
}

function Tab({ to, children }: { to: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <NavLink
      to={to}
      style={({ isActive }) => ({
        padding: 'var(--space-2) var(--space-3)',
        borderRadius: 'var(--radius-md)',
        fontSize: 'var(--type-sm)',
        fontWeight: isActive ? 'var(--font-weight-semibold)' : 'var(--font-weight-regular)',
        textDecoration: 'none',
        color: isActive ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
        background: isActive ? 'var(--color-selected-bg)' : 'transparent',
      })}
    >
      {children}
    </NavLink>
  )
}
