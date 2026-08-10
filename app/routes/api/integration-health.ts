import { sql } from 'drizzle-orm'

import { withTenant } from '~/db'
import { requireIdentity } from '~/lib/auth/identity'
import { defineEndpoint } from '~/lib/endpoint/define'

/**
 * `GET /api/integration-health` — §4.6's counter, as data.
 *
 * *"The counter is a product surface, not a log. `/admin/integration-health`
 * renders live rows."* Everything below is a row somebody wrote at the moment
 * something went wrong, not a number reconstructed afterwards from log lines.
 *
 * 🔴 THE PERMISSION IS THE DATABASE'S, NOT THIS FILE'S. `dead_letter` and
 * `admin_alert` are `tenant_admin_only`, so their policies read
 * `app.scope_is_admin()` — which `app.begin_request` derived from `app_user.role`
 * rather than from anything the request said. A seller issuing these exact
 * queries gets zero rows. The `scope` check here decides which SCREEN STATE to
 * render; it is not what protects the data.
 */

export interface HealthAlert {
  readonly kind: string
  readonly subjectKey: string
  readonly detail: string
  readonly occurrenceCount: number
  readonly lastSeenAt: string
  /** Fixed false for the reconciliation gap — a CHECK refuses to acknowledge it. */
  readonly acknowledgeable: boolean
}

export interface HealthPayload {
  /** Unacknowledged alerts, worst-repeated first. */
  readonly alerts: readonly HealthAlert[]
  /** Dead letters that nobody has resolved. */
  readonly deadLetters: readonly {
    readonly origin: string
    readonly subjectType: string
    readonly reason: string
    readonly attemptCount: number
    readonly lastSeenAt: string
    /** False once the vault has purged the body — the DLQ inherits its clock. */
    readonly bodyRetained: boolean
  }[]
  /**
   * 🔴 A PERMANENT LINE, NOT AN OMISSION. §4.2 ruling 3: when we cannot verify
   * a provider's deliveries, the fact that we cannot is rendered rather than
   * left blank. Gate G2 established Aloware sends no signature at all.
   */
  readonly signatureVerification: 'unavailable'
  /** Deliveries the extractor could not read. Stored anyway; visible here. */
  readonly unparsedDeliveries: number
  /** Calls attributed to nobody. Written to no book, never guessed. */
  readonly quarantinedCalls: number
}

/** Kinds the engine refuses to let an admin tick away. Mirrors the CHECK. */
const UNACKNOWLEDGEABLE = new Set(['reconciliation_unavailable'])

export type HealthResult =
  { readonly status: 'ok'; readonly payload: HealthPayload } | { readonly status: 'forbidden' }

export async function readIntegrationHealth(request: Request): Promise<HealthResult> {
  const identity = await requireIdentity(request)

  return withTenant(identity, async (tx, scope) => {
    // Not a 403 body for a seller — a screen state. The rows are already
    // unreachable to them; this is what decides whether they read
    // "You don't have access to this page" or a table of zeros that would be
    // indistinguishable from a healthy tenant.
    if (scope !== 'tenant_admin') {
      return { status: 'forbidden' }
    }

    const alerts = await tx.execute<{
      kind: string
      subject_key: string
      detail: string
      occurrence_count: number
      last_seen_at: string
    }>(sql`
      SELECT kind, subject_key, detail, occurrence_count,
             to_char(last_seen_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS last_seen_at
        FROM app.admin_alert
       WHERE tenant_id = app.current_tenant() AND acknowledged_at IS NULL
       ORDER BY occurrence_count DESC, last_seen_at DESC`)

    const deadLetters = await tx.execute<{
      origin: string
      subject_type: string
      reason: string
      attempt_count: number
      last_seen_at: string
      body_retained: boolean
    }>(sql`
      SELECT origin, subject_type, reason, attempt_count,
             to_char(last_seen_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS last_seen_at,
             raw_payload_id IS NOT NULL AS body_retained
        FROM app.dead_letter
       WHERE tenant_id = app.current_tenant() AND resolved_at IS NULL
       ORDER BY last_seen_at DESC`)

    const [counts] = await tx.execute<{ unparsed: string; quarantined: string }>(sql`
      SELECT
        (SELECT count(*) FROM app.inbound_webhook_event
          WHERE tenant_id = app.current_tenant() AND parse_status = 'unparsed')::text AS unparsed,
        (SELECT count(*) FROM app.call
          WHERE tenant_id = app.current_tenant() AND owner_user_id IS NULL)::text AS quarantined`)

    return {
      status: 'ok',
      payload: {
        alerts: [...alerts].map((a) => ({
          kind: a.kind,
          subjectKey: a.subject_key,
          detail: a.detail,
          occurrenceCount: a.occurrence_count,
          lastSeenAt: a.last_seen_at,
          acknowledgeable: !UNACKNOWLEDGEABLE.has(a.kind),
        })),
        deadLetters: [...deadLetters].map((d) => ({
          origin: d.origin,
          subjectType: d.subject_type,
          reason: d.reason,
          attemptCount: d.attempt_count,
          lastSeenAt: d.last_seen_at,
          bodyRetained: d.body_retained,
        })),
        signatureVerification: 'unavailable',
        // `Number.parseInt`, never `Number(` — the money guard bans the latter
        // outside app/lib/money and a count is not money.
        unparsedDeliveries: Number.parseInt(counts?.unparsed ?? '0', 10),
        quarantinedCalls: Number.parseInt(counts?.quarantined ?? '0', 10),
      },
    }
  })
}

export async function loader({ request }: { request: Request }): Promise<Response> {
  const result = await readIntegrationHealth(request)

  if (result.status === 'forbidden') {
    return Response.json(
      { error: 'forbidden' },
      {
        status: 403,
        headers: { 'cache-control': 'private, no-store' },
      },
    )
  }

  // ⚠️ A 403 HERE IS CORRECT AND IS NOT THE SILO RULE BEING BROKEN. "Never 403,
  // return owner-scoped not-found" is about a RECORD a seller does not own —
  // where a 403 confirms the record exists. This is a whole admin screen whose
  // existence is not a secret, and the same asymmetry the silo suite already
  // asserts for a supervisor's rejected write.
  return Response.json(result.payload, {
    headers: { 'cache-control': 'private, no-store' },
  })
}

/**
 * The admin's view of the ingest edge: dead letters and alerts.
 */
export const endpoint = defineEndpoint({
  method: 'GET',
  path: '/api/integration-health',
  role: 'web',
  audience: 'tenant',
  scope: 'tenant_admin',
  surface: 'health',
  summary: 'Dead letters and admin alerts for the tenant, admin only.',
  // ADR-084: MFA is NOT required on admin endpoints in the MVP. Declared
  // rather than omitted so the day that ruling changes, the compiler finds
  // every site instead of somebody grepping for them.
  mfa: false,
  mfaReason:
    'ADR-084 rules MFA is not required on admin endpoints in the MVP; the compensating control is that admin is a database role, not a UI flag.',
  etag: {
    kind: 'none',
    reason: 'An operator surface read on demand, not polled. Its rows are counted in tens.',
  },
  // The one route in the tree that answers 403 rather than 404, argued in
  // place: this is a SCREEN whose existence is not secret, not a RECORD whose
  // existence a 403 would confirm.
  siloProbe: {
    kind: 'none',
    reason:
      'Admin-only by scope and tenant_admin_only by policy: a seller reading it gets zero rows rather than another tenant data. There is no per-record id to present, and the cross-tenant case is covered by the table classification rather than by the route.',
  },
})
