import { sql } from 'drizzle-orm'

import { withTenant } from '~/db'
import { requireIdentity } from '~/lib/auth/identity'
import { defineEndpoint } from '~/lib/endpoint/define'

/**
 * `GET /api/users` — the roster, for the one screen that changes it.
 *
 * ⚠️ A SECOND READ RATHER THAN REUSING `/api/leaderboard`, and the reason is that
 * the board genuinely does not carry this. It returns userId, displayName and a
 * total; it says nothing about ROLE or whether somebody is still on the floor,
 * which are the only two facts this screen acts on. The earnings-correction
 * screen could reuse the board precisely because the board already had what it
 * needed.
 */

export interface TeamMember {
  readonly userId: string
  readonly displayName: string
  readonly email: string
  readonly role: 'seller' | 'supervisor' | 'admin'
  /** False once deactivated. `scope_is_admin()` requires it to be true. */
  readonly active: boolean
  /** True for the caller, so the screen can grey out the self-guards. */
  readonly isSelf: boolean
}

export type RosterResult =
  | { readonly status: 'ok'; readonly members: readonly TeamMember[] }
  | { readonly status: 'forbidden' }

export async function readRoster(request: Request): Promise<RosterResult> {
  const identity = await requireIdentity(request)

  return withTenant(identity, async (tx, scope) => {
    // A screen state rather than a 403 body, the same call the other two admin
    // reads make.
    if (scope !== 'tenant_admin') return { status: 'forbidden' }

    const rows = await tx.execute<{
      id: string
      display_name: string
      email: string
      role: 'seller' | 'supervisor' | 'admin'
      active: boolean
    }>(sql`
      SELECT id, display_name, email::text AS email, role::text AS role,
             deactivated_at IS NULL AS active
        FROM app.app_user
       WHERE tenant_id = app.current_tenant()
       ORDER BY deactivated_at IS NOT NULL, display_name`)

    return {
      status: 'ok',
      members: [...rows].map((r) => ({
        userId: r.id,
        displayName: r.display_name,
        email: r.email,
        role: r.role,
        active: r.active,
        isSelf: r.id === identity.userId,
      })),
    }
  })
}

export async function loader({ request }: { request: Request }): Promise<Response> {
  const result = await readRoster(request)
  return Response.json(result, {
    status: result.status === 'forbidden' ? 403 : 200,
    headers: { 'cache-control': 'private, no-store' },
  })
}

export const endpoint = defineEndpoint({
  method: 'GET',
  path: '/api/users',
  role: 'web',
  audience: 'tenant',
  scope: 'tenant_admin',
  surface: 'json',
  summary: 'The tenant roster with each member’s role and whether they are still on the floor.',
  mfa: false,
  mfaReason:
    'ADR-084 rules MFA is not required on admin endpoints in the MVP; the compensating control is that admin is a database role checked inside the definer against the sealed identity, not a UI flag.',
  etag: {
    kind: 'none',
    reason: 'An operator surface read on demand, not polled. Its rows are counted in tens.',
  },
  siloProbe: {
    kind: 'none',
    reason:
      'Admin-only by scope and scoped by app.current_tenant() in the query itself: there is no per-record id to present, and a seller reaching this URL reads the screen’s no-permission state rather than another tenant’s roster.',
  },
})
