import { sql } from 'drizzle-orm'

import { withTenant, type SessionIdentity } from '~/db'
import { requireIdentity } from '~/lib/auth/identity'
import { defineEndpoint } from '~/lib/endpoint/define'

/**
 * `POST /api/notes` — a seller writes down what happened.
 *
 * 🔴 THE SECOND MISSING WRITER. `app.activity` has had a schema, three CHECKs,
 * a My Day surface that reads it and a `note` timeline kind waiting for it, and
 * nothing in `app/` ever wrote one. The seed did; the product did not. So the
 * only thing that could reach a seller's history was a stage move.
 *
 * It calls a definer for the same reason `/api/opportunities` does: `crm_app`
 * can INSERT the row but 0061 revoked `event_emit`, and the row and its event
 * belong in one transaction.
 */

/** 1000 characters. Long enough for what happened on a call, short enough to read. */
const MAX_BODY = 1000

export type LogNoteResult =
  | { readonly status: 'created'; readonly activityId: string }
  /** Empty after trimming, or past the limit. */
  | { readonly status: 'invalid'; readonly reason: 'empty' | 'too_long' }
  /** Not this seller's contact, or gone. ONE answer for both. */
  | { readonly status: 'not_found' }

export async function logNoteFor(
  identity: SessionIdentity,
  input: { contactId: string; body: string },
): Promise<LogNoteResult> {
  const body = input.body.trim()
  if (body === '') return { status: 'invalid', reason: 'empty' }
  if (body.length > MAX_BODY) return { status: 'invalid', reason: 'too_long' }

  // A malformed id is the same answer as a foreign one, checked before the cast.
  if (!/^[0-9a-f-]{36}$/i.test(input.contactId)) return { status: 'not_found' }

  const activityId = await withTenant(identity, async (tx) => {
    const rows = await tx.execute<{ id: string | null }>(
      sql`SELECT app.activity_log_note(${input.contactId}::uuid, ${body}) AS id`,
    )
    return rows[0]?.id ?? null
  })

  if (activityId === null) return { status: 'not_found' }
  return { status: 'created', activityId }
}

export async function action({ request }: { request: Request }): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response(null, { status: 405, headers: { allow: 'POST' } })
  }

  const identity = await requireIdentity(request)
  const form = await request.formData()
  const contactId = form.get('contactId')
  const body = form.get('body')

  if (typeof contactId !== 'string' || typeof body !== 'string') {
    return Response.json({ status: 'invalid', reason: 'empty' } satisfies LogNoteResult, {
      status: 422,
    })
  }

  const result = await logNoteFor(identity, { contactId, body })
  const status = result.status === 'created' ? 201 : result.status === 'invalid' ? 422 : 404

  // 404 and never 403 for a lead that is not this seller's — and the route
  // could not do otherwise, because the definer collapsed both cases into a
  // single NULL before the answer got here.
  return Response.json(result, { status, headers: { 'cache-control': 'private, no-store' } })
}

export const endpoint = defineEndpoint({
  method: 'POST',
  path: '/api/notes',
  role: 'web',
  audience: 'owner',
  scope: 'owner',
  surface: 'json',
  summary: 'Logs a note on a contact and puts it in that contact’s history.',
  /**
   * ⚠️ NOT IDEMPOTENT, and said so. Two identical notes a minute apart are two
   * real notes — a seller repeating herself is information, not a duplicate —
   * so there is no natural key here. The composer clears and disables on send;
   * that is UI, and therefore documentation.
   */
  idempotency: {
    kind: 'none',
    reason:
      'Two identical notes are two real notes. There is no key that separates a repeat from a double submit, and inventing one would silently swallow the second.',
  },
  siloProbe: { kind: 'foreign-id', param: 'contactId' },
})
