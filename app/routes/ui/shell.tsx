import { Form, NavLink, Outlet, redirect } from 'react-router'

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
    const rows = await tx.execute<{ display_name: string; role: string }>(
      sql`SELECT display_name, role::text AS role FROM app.app_user
          WHERE tenant_id = app.current_tenant() AND id = app.current_user_id()`,
    )
    return {
      displayName: rows[0]?.display_name ?? 'You',
      role: rows[0]?.role ?? 'seller',
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
            maxWidth: '64rem',
            margin: '0 auto',
            padding: 'var(--space-3) var(--space-6)',
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-6)',
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
