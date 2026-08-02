import { sql } from 'drizzle-orm'

import type { SessionIdentity } from '~/db'
import { authDb } from '~/db/auth-client'

import { auth } from './server'

/**
 * Turns an incoming request into the identity a unit of work runs as, or null.
 *
 * Two steps, and the split matters. better-auth answers "who signed in"; the
 * database answers "and what seat is that in this tenant". The second answer
 * is never taken from the cookie, so forging a session payload buys nothing —
 * `app.resolve_identity` reads `app_user`, and `app.begin_request` re-reads
 * the role after that to derive scope.
 *
 * Returns null for a deactivated seller with an otherwise valid cookie: that
 * reads as "not signed in" rather than confirming the account exists.
 */
export async function resolveIdentity(request: Request): Promise<SessionIdentity | null> {
  const session = await auth.api.getSession({ headers: request.headers })
  if (!session?.user?.id) {
    return null
  }

  const rows = await authDb.execute<{ tenant_id: string; user_id: string }>(
    sql`SELECT tenant_id, user_id FROM app.resolve_identity(${session.user.id})`,
  )

  const row = rows[0]
  if (!row) {
    // Authenticated, but holds no seat in any tenant. Treated as signed out
    // rather than as an error: it is a real state during onboarding, between
    // an account being created and an admin granting it a seat.
    return null
  }

  return { tenantId: row.tenant_id, userId: row.user_id }
}

/**
 * The identity or a 401. For routes that have no anonymous rendering — which
 * in this product is all of them except the public leaderboard.
 */
export async function requireIdentity(request: Request): Promise<SessionIdentity> {
  const identity = await resolveIdentity(request)
  if (!identity) {
    throw new Response('Unauthorized', { status: 401 })
  }
  return identity
}
