import { sql } from 'drizzle-orm'

import { withTenant, type SessionIdentity } from '~/db'
import { requireIdentity } from '~/lib/auth/identity'
import { defineEndpoint } from '~/lib/endpoint/define'

/**
 * `POST /api/opportunities` — a seller starts a deal.
 *
 * 🔴 THE WRITER THE PRODUCT NEVER HAD. `app.opportunity` has had a schema, two
 * gates, an atomic `stage_move`, a board that drags it and a ledger that pays
 * it, and nothing in `app/` created one. So the product could move a deal it
 * could not start, and two screens told the seller "No open deal. Start one
 * from your board" — pointing at an affordance that did not exist.
 *
 * IT CALLS A DEFINER RATHER THAN INSERTING, and that is not indirection.
 * `crm_app` holds INSERT on `app.opportunity`, so this route could write the
 * row — but 0061 revoked EXECUTE on `app.event_emit`, and §2535(b) puts the row
 * and its event in ONE transaction. `app.opportunity_create` is where both
 * happen, which also means a deal cannot be created without `opportunity.created`
 * being emitted: there is one door and the emit is inside it.
 */

export type StartDealResult =
  | { readonly status: 'created'; readonly opportunityId: string }
  /**
   * The contact is not this seller's, or does not exist. ONE ANSWER FOR BOTH —
   * the definer returns NULL for either, so this route has no branch that could
   * tell them apart and no way to grow one by accident.
   */
  | { readonly status: 'not_found' }

export async function startDealFor(
  identity: SessionIdentity,
  input: { contactId: string },
): Promise<StartDealResult> {
  // A malformed id is the same answer as a foreign one. Checked here so the
  // definer is never handed something that would raise on the cast.
  if (!/^[0-9a-f-]{36}$/i.test(input.contactId)) return { status: 'not_found' }

  const opportunityId = await withTenant(identity, async (tx) => {
    const rows = await tx.execute<{ id: string | null }>(
      sql`SELECT app.opportunity_create(${input.contactId}::uuid) AS id`,
    )
    return rows[0]?.id ?? null
  })

  if (opportunityId === null) return { status: 'not_found' }
  return { status: 'created', opportunityId }
}

export async function action({ request }: { request: Request }): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response(null, { status: 405, headers: { allow: 'POST' } })
  }

  const identity = await requireIdentity(request)
  const form = await request.formData()
  const contactId = form.get('contactId')

  if (typeof contactId !== 'string') {
    return Response.json({ status: 'not_found' } satisfies StartDealResult, { status: 404 })
  }

  const result = await startDealFor(identity, { contactId })

  // 🔴 404 AND NEVER 403, for a lead that is not this seller's. A 403 confirms
  // the record exists, which is the one thing the silo rule forbids — and the
  // route cannot do otherwise, because the definer already collapsed both cases
  // into a single NULL before the answer got here.
  return Response.json(result, {
    status: result.status === 'created' ? 201 : 404,
    headers: { 'cache-control': 'private, no-store' },
  })
}

export const endpoint = defineEndpoint({
  method: 'POST',
  path: '/api/opportunities',
  role: 'web',
  audience: 'owner',
  scope: 'owner',
  surface: 'json',
  summary: 'Starts a deal on a contact, in the first open stage of its owner’s board.',
  /**
   * ⚠️ NOT IDEMPOTENT, AND SAID SO RATHER THAN IMPLIED. One contact
   * legitimately buys twice — the contact screen's own empty state says as much
   * — so a second call is a second deal by design, and there is no natural key
   * that could tell a double submit from a real cross-sell. The button disables
   * itself in flight; that is UI and therefore documentation, not a mechanism.
   */
  idempotency: {
    kind: 'none',
    reason:
      'A second deal on the same contact is a legitimate cross-sell, so there is no key that separates a duplicate submit from a real one. Stated rather than papered over.',
  },
  siloProbe: { kind: 'foreign-id', param: 'contactId' },
})
