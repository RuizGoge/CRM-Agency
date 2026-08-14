import { sql } from 'drizzle-orm'

import { withTenant } from '~/db'
import { requireIdentity } from '~/lib/auth/identity'
import { defineEndpoint } from '~/lib/endpoint/define'
import { refusalSentence } from '~/lib/endpoint/refusal'

/**
 * `POST /api/user-create` — reserve a seat for somebody who has not arrived.
 *
 * ⚠️ A THIRD MODULE FOR THE USER DOMAIN, and the route registry is why: a
 * descriptor declares ONE method and one path, so the roster read
 * (`GET /api/users`) and the two writes cannot share a file. Folding creation
 * into `/api/user-access` would have avoided the fragmentation and made that
 * path's name a lie — "access" is not what creating a person is.
 *
 * 🔴 WHAT THIS DOES NOT DO: grant access. `app.app_user_create` writes the row
 * with `auth_user_id` NULL, and `app.resolve_identity` matches on that column,
 * so the row answers no session. The admin RECORDS who may enter; Google proves
 * they are who they claim (ADR-085). Until Google login exists, a row created
 * here is a reservation that cannot yet be claimed — which the screen says
 * plainly rather than leaving to be discovered.
 */

export type CreateUserResult =
  | { readonly status: 'created'; readonly userId: string }
  | { readonly status: 'invalid'; readonly reason: string }
  | { readonly status: 'forbidden' }

const ROLES = new Set(['seller', 'supervisor', 'admin'])

/** The database raises these; the route turns them into a sentence. */
const REFUSALS: ReadonlyMap<string, string> = new Map([
  ['UC002', 'Only admins can add somebody to the team.'],
  ['UC003', 'That doesn’t look like an email address.'],
  ['UC004', 'Enter the person’s name.'],
  ['UC005', 'Somebody with that address is already on this team.'],
])

export interface CreateUserInput {
  readonly email: string
  readonly fullName: string
  readonly displayName: string
  readonly role: string
}

export async function createUser(
  request: Request,
  input: CreateUserInput,
): Promise<CreateUserResult> {
  const identity = await requireIdentity(request)

  if (!ROLES.has(input.role)) {
    // Before the cast, so an invented role reads as a bad request rather than a
    // Postgres enum error the screen cannot phrase.
    return { status: 'invalid', reason: 'That is not a role this product has.' }
  }

  // The catch wraps `withTenant` rather than sitting inside it: a raise from the
  // definer surfaces when the TRANSACTION closes, outside the callback. See
  // `~/lib/endpoint/refusal` — placing it inside answers 500 to every refusal.
  try {
    return await withTenant(identity, async (tx, scope) => {
      // The database checks this too, inside the definer, against the sealed
      // identity. This decides which SCREEN STATE renders; it is not the guard.
      if (scope !== 'tenant_admin') return { status: 'forbidden' }

      const rows = await tx.execute<{ id: string | null }>(sql`
        SELECT app.app_user_create(
          ${input.email}, ${input.fullName}, ${input.displayName},
          ${input.role}::app.user_role) AS id`)

      const userId = rows[0]?.id ?? null
      if (userId === null) return { status: 'invalid', reason: 'Nobody was added.' }
      return { status: 'created', userId }
    })
  } catch (error) {
    const sentence = refusalSentence(error, REFUSALS)
    // Anything unnamed is a fault, not the admin's mistake, and must not be
    // swallowed into a 422 that reads like one.
    if (sentence === null) throw error
    return { status: 'invalid', reason: sentence }
  }
}

export async function action({ request }: { request: Request }): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response(null, { status: 405, headers: { allow: 'POST' } })
  }

  const form = await request.formData()
  const email = form.get('email')
  const fullName = form.get('fullName')
  const displayName = form.get('displayName')
  const role = form.get('role')

  if (
    typeof email !== 'string' ||
    typeof fullName !== 'string' ||
    typeof role !== 'string' ||
    typeof displayName !== 'string'
  ) {
    return Response.json(
      { status: 'invalid', reason: 'Fill in every field.' } satisfies CreateUserResult,
      { status: 422, headers: { 'cache-control': 'private, no-store' } },
    )
  }

  const result = await createUser(request, { email, fullName, displayName, role })
  const status = result.status === 'created' ? 201 : result.status === 'forbidden' ? 403 : 422

  return Response.json(result, { status, headers: { 'cache-control': 'private, no-store' } })
}

export const endpoint = defineEndpoint({
  method: 'POST',
  path: '/api/user-create',
  role: 'web',
  audience: 'tenant',
  scope: 'tenant_admin',
  surface: 'json',
  summary: 'Reserves a seat: records who may enter, without granting them a way in yet.',
  mfa: false,
  mfaReason:
    'ADR-084 rules MFA is not required on admin endpoints in the MVP; the compensating control is that admin is a database role checked inside the definer against the sealed identity, not a UI flag.',
  /**
   * 🔴 IDEMPOTENT BY THE INDEX, not by a key the caller supplies. A double
   * submit hits `app_user_email_uidx` on (tenant_id, email) and is refused as a
   * duplicate — which is also the right answer for two admins adding the same
   * new hire at once, where a check-then-insert would let both through.
   */
  idempotency: {
    kind: 'natural',
    constraint: 'app_user_email_uidx unique on (tenant_id, email)',
  },
  siloProbe: {
    kind: 'none',
    reason:
      'Admin-only by scope, and app.app_user_create derives the tenant from the sealed session rather than taking it as an argument — so there is no id or field a probe could present that would place a person in another tenant.',
  },
})
