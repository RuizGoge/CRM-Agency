import { sql } from 'drizzle-orm'

import { withTenant } from '~/db'
import { requireIdentity } from '~/lib/auth/identity'
import { defineEndpoint } from '~/lib/endpoint/define'
import { refusalSentence } from '~/lib/endpoint/refusal'

/**
 * `POST /api/user-access` — change a role, or take somebody off the floor.
 *
 * 🔴 THE ROLE IS NOT A MENU SETTING ANY MORE. `app.scope_is_admin()` gates
 * issuing the ingest credential (0068), correcting the public earnings board
 * (0071) and reading dead letters, and 0067 sealed the (tenant, user) pair — so
 * promoting somebody here hands them the surfaces that move money. 0072 built
 * the writers; until this route existed they were reachable only from SQL.
 */

export type AccessResult =
  | { readonly status: 'changed' }
  /** Already in that state, so nothing was written — including no audit row. */
  | { readonly status: 'unchanged' }
  | { readonly status: 'invalid'; readonly reason: string }
  /** Not in this tenant. Same answer as an id that never existed. */
  | { readonly status: 'not_found' }
  | { readonly status: 'forbidden' }

const ROLES = new Set(['seller', 'supervisor', 'admin'])

/**
 * The database raises these; the route turns them into a sentence a person can
 * act on. The codes are the contract, the prose belongs to the surface.
 */
const REFUSALS: ReadonlyMap<string, string> = new Map([
  ['UR002', 'Only admins can change a role.'],
  ['UR007', 'Only admins can change who has access.'],
  ['UR003', 'Say why the role is changing — this note is the record of it.'],
  ['UR008', 'Say why — a seller losing access will ask, and so will an auditor.'],
  ['UR004', 'You can’t take your own admin away. Ask another admin to do it.'],
  ['UR009', 'You can’t lock yourself out. Ask another admin to do it.'],
  ['UR005', 'This is the only admin left — promote somebody else first.'],
  ['UR010', 'This is the only admin left — promote somebody else first.'],
])

export interface AccessInput {
  readonly userId: string
  readonly reason: string
  readonly change:
    | { readonly kind: 'role'; readonly role: string }
    | { readonly kind: 'active'; readonly active: boolean }
}

export async function changeAccess(request: Request, input: AccessInput): Promise<AccessResult> {
  const identity = await requireIdentity(request)

  if (!/^[0-9a-f-]{36}$/i.test(input.userId)) return { status: 'not_found' }
  if (input.change.kind === 'role' && !ROLES.has(input.change.role)) {
    // Checked before the cast so an invented role reads as a bad request rather
    // than a Postgres enum error the screen cannot phrase.
    return { status: 'invalid', reason: 'That is not a role this product has.' }
  }

  const change = input.change

  // 🔴 THE CATCH IS AROUND `withTenant`, NOT INSIDE IT, AND THAT PLACEMENT IS THE
  // WHOLE FIX. A raise from the definer does not reject at the `tx.execute`
  // await — postgres.js surfaces it when the TRANSACTION closes, outside the
  // callback. A catch inside the callback therefore never runs, every refusal
  // escapes to the route boundary, and the admin gets `500 Unexpected Server
  // Error` instead of "say why the role is changing". Found by driving the real
  // HTTP route; the definer tests never see it, because a direct call raises
  // where the caller is looking.
  try {
    return await withTenant(identity, async (tx, scope) => {
      // The database checks this too, inside the definer, against the sealed
      // identity. This decides which SCREEN STATE renders; it is not the guard.
      if (scope !== 'tenant_admin') return { status: 'forbidden' }

      const rows =
        change.kind === 'role'
          ? await tx.execute<{ ok: boolean }>(sql`
              SELECT app.app_user_set_role(
                ${input.userId}::uuid, ${change.role}::app.user_role, ${input.reason}) AS ok`)
          : await tx.execute<{ ok: boolean }>(sql`
              SELECT app.app_user_set_active(
                ${input.userId}::uuid, ${change.active}, ${input.reason}) AS ok`)

      // 🔴 `false` MEANS TWO THINGS AND THE ROUTE MUST NOT COLLAPSE THEM. The
      // definer returns false for "no such user in this tenant" AND for "already
      // in that state". Reporting the second as not-found would tell an admin
      // their colleague had vanished; reporting the first as unchanged would
      // hide a typo. The screen has just listed the roster, so a member it can
      // see resolving to false is the no-op case.
      return rows[0]?.ok === true ? { status: 'changed' } : { status: 'unchanged' }
    })
  } catch (error) {
    // Matched over the whole `cause` chain rather than `error.message`: drizzle
    // wraps the Postgres error when it does reach us that way. See
    // `~/lib/endpoint/refusal`.
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
  const userId = form.get('userId')
  const reason = form.get('reason')
  const role = form.get('role')
  const active = form.get('active')

  const bad = Response.json(
    { status: 'invalid', reason: 'Fill in every field.' } satisfies AccessResult,
    { status: 422, headers: { 'cache-control': 'private, no-store' } },
  )
  if (typeof userId !== 'string' || typeof reason !== 'string') return bad

  const change: AccessInput['change'] | null =
    typeof role === 'string'
      ? { kind: 'role', role }
      : active === 'true' || active === 'false'
        ? { kind: 'active', active: active === 'true' }
        : null
  if (change === null) return bad

  const result = await changeAccess(request, { userId, reason, change })
  const status =
    result.status === 'changed' || result.status === 'unchanged'
      ? 200
      : result.status === 'forbidden'
        ? 403
        : result.status === 'not_found'
          ? 404
          : 422

  return Response.json(result, { status, headers: { 'cache-control': 'private, no-store' } })
}

export const endpoint = defineEndpoint({
  method: 'POST',
  path: '/api/user-access',
  role: 'web',
  audience: 'tenant',
  scope: 'tenant_admin',
  surface: 'json',
  summary: 'Changes a member’s role, or takes them off the floor and back on.',
  mfa: false,
  mfaReason:
    'ADR-084 rules MFA is not required on admin endpoints in the MVP; the compensating control is that admin is a database role checked inside the definer against the sealed identity, not a UI flag.',
  /**
   * Naturally idempotent, and it needs no key to be. Setting the role somebody
   * already has, or deactivating somebody already deactivated, returns
   * `unchanged` and writes NOTHING — not even an audit row, because a row for a
   * change that did not happen is one somebody has to explain later.
   */
  idempotency: {
    kind: 'natural',
    constraint: 'app_user_set_role / app_user_set_active return false and write nothing on a no-op',
  },
  siloProbe: {
    kind: 'none',
    reason:
      'Admin-only by scope, and both definers derive the tenant from the sealed session: a foreign user id returns the same false as an id that never existed, so no id produces a distinguishable answer from outside the tenant.',
  },
})
