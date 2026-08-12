import { sql } from 'drizzle-orm'

import { withTenant } from '~/db'
import { requireIdentity } from '~/lib/auth/identity'
import { defineEndpoint } from '~/lib/endpoint/define'

/**
 * `/api/webhook-endpoints` — the credential the ingest edge had no way to be
 * given.
 *
 * 🔴 WHY THIS ROUTE EXISTS AT ALL. `app.webhook_endpoint` is `definer_only` and
 * had no writer anywhere — not in `app/`, not in the seed, not in a migration.
 * Gate 6 found it by tripping over it: the storm harness had to insert its row
 * AS THE OWNER because `crm_app` holds no privilege on the table. In production
 * that means no endpoint row exists, `app.webhook_ingest` resolves no tenant for
 * any token, and the edge answers 401 to every real delivery — while G2 measured
 * that Aloware never retries. A permanent-loss path with nothing going red.
 *
 * The functions landed in 0068. Leaving them reachable only from SQL would
 * reproduce the exact defect the 2026-08-10 audit named — engine with no wiring
 * — so this is the wiring.
 *
 * ⚠️ THE PLAINTEXT TOKEN CROSSES THIS BOUNDARY EXACTLY ONCE. Only `sha256(token)`
 * is stored, so there is no second read and no recovery: an admin who loses it
 * issues another and revokes the first. Every response here is `no-store`, and
 * the issue response is the one that would be genuinely harmful in a cache.
 */

export interface WebhookEndpointRow {
  readonly endpointId: string
  readonly provider: string
  readonly label: string
  readonly createdAt: string
  /** Null while live. A revoked row stays for the provenance of its vault rows. */
  readonly revokedAt: string | null
}

export type IssueResult =
  /** The only time the token is ever readable. */
  | { readonly status: 'issued'; readonly endpointId: string; readonly token: string }
  | { readonly status: 'invalid'; readonly reason: string }
  | { readonly status: 'forbidden' }

export type RevokeResult =
  | { readonly status: 'revoked' }
  /** Unknown, another tenant's, or already revoked — ONE answer for all three. */
  | { readonly status: 'not_found' }
  | { readonly status: 'forbidden' }

/**
 * The database raises these, and the route turns them into a sentence. The
 * codes are the contract; the prose belongs to the surface, which is why it
 * lives here and not in the migration.
 */
const REFUSALS: ReadonlyMap<string, string> = new Map([
  ['WE003', 'We only ingest Aloware right now.'],
  ['WE004', 'Give this endpoint a name so you can tell it apart later.'],
  ['WE005', 'That name is too long — keep it under 80 characters.'],
])

const refusalOf = (error: unknown): string | null => {
  const message = error instanceof Error ? error.message : String(error)
  for (const [code, sentence] of REFUSALS) {
    if (message.includes(code)) return sentence
  }
  return null
}

/**
 * ⚠️ THE LIST IS NOT HERE, and the route registry is why. A descriptor declares
 * ONE method, and `route-registry.test.ts` asserts it matches where the module
 * is mounted — so a file exporting both a `loader` and an `action` would carry a
 * descriptor that honestly describes only half of itself. The read lives on
 * `/api/integration-health`, which is the same screen, the same admin scope and
 * one fetch instead of two.
 */

export async function issueWebhookEndpoint(
  request: Request,
  input: { provider: string; label: string },
): Promise<IssueResult> {
  const identity = await requireIdentity(request)

  return withTenant(identity, async (tx, scope) => {
    if (scope !== 'tenant_admin') return { status: 'forbidden' }

    try {
      const rows = await tx.execute<{ endpoint_id: string; token: string }>(sql`
        SELECT endpoint_id, token
          FROM app.webhook_endpoint_issue(${input.provider}, ${input.label})`)
      const row = rows[0]
      if (row === undefined) return { status: 'invalid', reason: 'Nothing was created.' }
      return { status: 'issued', endpointId: row.endpoint_id, token: row.token }
    } catch (error) {
      const sentence = refusalOf(error)
      // A refusal we named is a sentence for the admin; anything else is a
      // fault and must not be swallowed into a 422 that looks like their
      // mistake.
      if (sentence === null) throw error
      return { status: 'invalid', reason: sentence }
    }
  })
}

export async function revokeWebhookEndpoint(
  request: Request,
  endpointId: string,
): Promise<RevokeResult> {
  const identity = await requireIdentity(request)

  // A malformed id is the same answer as a foreign one, checked before the cast.
  if (!/^[0-9a-f-]{36}$/i.test(endpointId)) return { status: 'not_found' }

  return withTenant(identity, async (tx, scope) => {
    if (scope !== 'tenant_admin') return { status: 'forbidden' }

    const rows = await tx.execute<{ ok: boolean }>(
      sql`SELECT app.webhook_endpoint_revoke(${endpointId}::uuid) AS ok`,
    )
    return rows[0]?.ok === true ? { status: 'revoked' } : { status: 'not_found' }
  })
}

const NO_STORE = { 'cache-control': 'private, no-store' } as const

export async function action({ request }: { request: Request }): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response(null, { status: 405, headers: { allow: 'POST' } })
  }

  const form = await request.formData()
  const intent = form.get('intent')

  if (intent === 'revoke') {
    const endpointId = form.get('endpointId')
    if (typeof endpointId !== 'string') {
      return Response.json({ status: 'not_found' } satisfies RevokeResult, {
        status: 404,
        headers: NO_STORE,
      })
    }
    const result = await revokeWebhookEndpoint(request, endpointId)
    const status = result.status === 'revoked' ? 200 : result.status === 'forbidden' ? 403 : 404
    return Response.json(result, { status, headers: NO_STORE })
  }

  if (intent === 'issue') {
    const provider = form.get('provider')
    const label = form.get('label')
    if (typeof provider !== 'string' || typeof label !== 'string') {
      return Response.json(
        { status: 'invalid', reason: 'Give this endpoint a name.' } satisfies IssueResult,
        { status: 422, headers: NO_STORE },
      )
    }
    const result = await issueWebhookEndpoint(request, { provider, label })
    const status = result.status === 'issued' ? 201 : result.status === 'forbidden' ? 403 : 422
    return Response.json(result, { status, headers: NO_STORE })
  }

  return Response.json({ status: 'invalid', reason: 'Unknown action.' } satisfies IssueResult, {
    status: 422,
    headers: NO_STORE,
  })
}

export const endpoint = defineEndpoint({
  method: 'POST',
  path: '/api/webhook-endpoints',
  role: 'web',
  audience: 'tenant',
  scope: 'tenant_admin',
  surface: 'json',
  summary: 'Issues and revokes the ingest credential Aloware presents at the edge.',
  mfa: false,
  mfaReason:
    'ADR-084 rules MFA is not required on admin endpoints in the MVP; the compensating control is that admin is a database role checked inside the definer, not a UI flag.',
  /**
   * ⚠️ NOT IDEMPOTENT, and it must not be made so. Issuing twice is issuing two
   * real credentials — that IS rotation, and collapsing a repeat would break the
   * one procedure this surface exists to support. Revoking twice is naturally
   * idempotent: the second call changes nothing and says so.
   */
  idempotency: {
    kind: 'none',
    reason:
      'Two issues are two real credentials, which is what rotation needs. A natural key here would silently swallow the replacement token.',
  },
  siloProbe: {
    kind: 'none',
    reason:
      'Admin-only by scope and definer_only by classification: app.webhook_endpoint_issue derives the tenant from the session and app.webhook_endpoint_revoke returns the same false for an unknown id and another tenant id, so there is no foreign id that produces a distinguishable answer.',
  },
})
