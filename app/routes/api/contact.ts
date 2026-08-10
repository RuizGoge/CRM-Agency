import { sql } from 'drizzle-orm'

import { withTenant, type SessionIdentity } from '~/db'
import { requireIdentity } from '~/lib/auth/identity'
import { defineEndpoint } from '~/lib/endpoint/define'

/**
 * One contact record — the destination Ctrl+K opens.
 *
 * §7's recovery path ends here: the handset is ringing, the seller typed the
 * number, and this is the screen that has to be up before she answers. Two
 * interactions from anywhere in the app.
 *
 * 🔴 A FOREIGN ID IS NOT FOUND. NEVER FORBIDDEN. That is protected item
 * `DEMO-04` and it is the one rule on this endpoint that is not about
 * convenience: a 403 confirms the record exists, so a seller who pastes a
 * colleague's URL learns that a contact with that id is real and belongs to
 * somebody. Not-found tells them nothing, which is the whole point of a silo.
 *
 * The distinction is enforced by SHAPE rather than by discipline — there is no
 * branch here that could return 403, because the query simply returns no rows
 * for a contact the caller does not own and `null` becomes a 404 at the edge.
 */

export interface ContactDeal {
  readonly id: string
  readonly stageName: string
  readonly stageType: 'open' | 'earning' | 'lost'
  /** Whole cents, as a string, or null. The client formats and never computes. */
  readonly premiumCents: string | null
}

export interface ContactRecord {
  readonly id: string
  readonly fullName: string
  readonly email: string | null
  readonly stateCode: string | null
  readonly phones: readonly { readonly e164: string; readonly isPrimary: boolean }[]
  readonly deals: readonly ContactDeal[]
  /** Days since the last human touch, or null if never touched. */
  readonly daysSinceTouch: number | null
}

export async function readContactFor(
  identity: SessionIdentity,
  contactId: string,
): Promise<ContactRecord | null> {
  // A malformed id is not found either. Letting it reach Postgres as a uuid
  // cast would raise 22P02 and answer 500 — which tells a prober that their
  // input was interesting, and tells a seller their link is broken rather
  // than stale.
  if (!/^[0-9a-f-]{36}$/i.test(contactId)) return null

  return withTenant(identity, async (tx) => {
    const rows = await tx.execute<{
      id: string
      full_name: string
      email: string | null
      state_code: string | null
      days_since_touch: number | null
    }>(sql`
      SELECT c.id, c.full_name, c.email_norm::text AS email, c.state_code,
             CASE WHEN c.last_touch_at IS NULL THEN NULL
                  ELSE greatest(0, extract(day from clock_timestamp() - c.last_touch_at)::integer)
             END AS days_since_touch
        FROM app.contact c
       WHERE c.tenant_id = app.current_tenant()
         AND c.id = ${contactId}::uuid
         AND c.deleted_at IS NULL
         AND c.redacted_at IS NULL
         -- Owner-scoped explicitly, on top of the policy. A supervisor reads
         -- across books by design; a seller reading another's would be the
         -- breach, and this is the read a pasted URL lands on.
         AND (c.owner_user_id = app.current_user_id() OR app.scope_is_global())`)

    const contact = rows[0]
    if (contact === undefined) return null

    const phones = await tx.execute<{ phone_e164: string; is_primary: boolean }>(sql`
      SELECT p.phone_e164, p.is_primary FROM app.contact_phone p
       WHERE p.tenant_id = app.current_tenant() AND p.contact_id = ${contactId}::uuid
         AND p.redacted_at IS NULL
       ORDER BY p.is_primary DESC, p.created_at`)

    const deals = await tx.execute<{
      id: string
      stage_name: string
      stage_type: 'open' | 'earning' | 'lost'
      premium_cents: string | null
    }>(sql`
      SELECT o.id, s.name AS stage_name, s.stage_type::text AS stage_type,
             o.premium_annual_cents::text AS premium_cents
        FROM app.opportunity_live o
        JOIN app.stage s ON s.tenant_id = o.tenant_id AND s.id = o.stage_id
       WHERE o.tenant_id = app.current_tenant() AND o.contact_id = ${contactId}::uuid
       ORDER BY o.stage_entered_at DESC`)

    return {
      id: contact.id,
      fullName: contact.full_name,
      email: contact.email,
      stateCode: contact.state_code,
      daysSinceTouch: contact.days_since_touch,
      phones: [...phones].map((p) => ({ e164: p.phone_e164, isPrimary: p.is_primary })),
      deals: [...deals].map((d) => ({
        id: d.id,
        stageName: d.stage_name,
        stageType: d.stage_type,
        premiumCents: d.premium_cents,
      })),
    }
  })
}

export async function loader({
  request,
  params,
}: {
  request: Request
  params: { contactId?: string }
}): Promise<Response> {
  const identity = await requireIdentity(request)
  const record = await readContactFor(identity, params.contactId ?? '')

  if (record === null) {
    // 404, and the body says nothing about why. DEMO-04.
    return new Response(JSON.stringify({ error: 'not_found' }), {
      status: 404,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    })
  }

  return new Response(JSON.stringify(record), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'private, no-store',
    },
  })
}

/**
 * One contact, by id. The narrowest owner-scoped read, and the one whose denial
 * shape matters most: a 403 here would confirm the record exists.
 */
export const endpoint = defineEndpoint({
  method: 'GET',
  path: '/api/contacts/:contactId',
  role: 'web',
  audience: 'owner',
  scope: 'owner',
  surface: 'json',
  summary: 'A single contact with its phones, deals and compliance state.',
  etag: {
    kind: 'none',
    reason:
      'Opened once per navigation, not polled. The drawer refetches on open rather than revalidating.',
  },
  siloProbe: { kind: 'foreign-id', param: 'contactId' },
})
