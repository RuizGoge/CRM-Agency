import { Form, NavLink, Outlet, redirect } from 'react-router'

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
  return (
    <>
      <header
        style={{
          borderBottom: '1px solid var(--color-border-subtle)',
          background: 'var(--color-surface-1)',
        }}
      >
        <div
          style={{
            // FULL WIDTH, and the previous 64rem cap is what made the board look
            // unfinished. Every other screen is a centred reading column, so the
            // capped bar lined up with them and the wordmark sat 200px in from
            // the edge — while the Pipeline's title and its first column started
            // at the page margin. Two left edges on one screen. A top bar that
            // spans the window is also just what an application shell is; a
            // centred one reads as a marketing page.
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

      <Outlet />

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
