import { sql } from 'drizzle-orm'

import { withTenant } from '~/db'
import { requireIdentity } from '~/lib/auth/identity'
import { defineEndpoint } from '~/lib/endpoint/define'
import { MoneyError, negate, parseUserAmount, toWireString, type Money } from '~/lib/money/money'

/**
 * `POST /api/ledger-corrections` — the admin fixes a wrong number on the board.
 *
 * 🔴 THE SURFACE THE CONSTITUTION NAMED AND NOBODY BUILT. CLAUDE.md has always
 * said corrections are "compensating appends through the admin void/adjust
 * surface"; 0071 built the writer, and until this route existed it was reachable
 * only from SQL — the same engine-with-no-wiring shape that migration's own
 * comment complains about.
 *
 * The ledger stays append-only. A correction is a NEW ROW, so the board reads
 * right while the history of how it got there survives.
 */

export type CorrectionResult =
  | { readonly status: 'applied'; readonly entryId: string; readonly deltaCents: string }
  | { readonly status: 'invalid'; readonly reason: string }
  /** Not a seller in this tenant. Same answer as an id that never existed. */
  | { readonly status: 'not_found' }
  | { readonly status: 'forbidden' }

/**
 * The database raises these; the route turns them into a sentence. The codes are
 * the contract, the prose belongs to the surface.
 */
const REFUSALS: ReadonlyMap<string, string> = new Map([
  ['LA002', 'Only admins can correct the board.'],
  ['LA003', 'A correction of zero would change nothing.'],
  ['LA004', 'Say why the number is being corrected — this note is the only record of it.'],
])

export interface CorrectionInput {
  readonly ownerUserId: string
  /** As the admin typed it: `1200`, `1,200.50`, `$310`. Never a number. */
  readonly amount: string
  readonly direction: 'add' | 'remove'
  readonly reason: string
  /** One per open form, so a double submit lands on the ledger's own index. */
  readonly idempotencyKey: string
}

export async function correctLedger(
  request: Request,
  input: CorrectionInput,
): Promise<CorrectionResult> {
  const identity = await requireIdentity(request)

  // 🔴 THE AMOUNT IS PARSED HERE, ON THE SERVER, AND NEVER ARRIVES AS A NUMBER.
  // `parseUserAmount` refuses sub-cent precision rather than rounding it —
  // rounding money is a domain decision and that function is not authorised to
  // make one. The client sends the string the admin typed and performs no money
  // arithmetic, ever.
  let deltaCents: Money
  try {
    const magnitude = parseUserAmount(input.amount)
    // POSITIVE AMOUNT PLUS A DIRECTION, rather than asking an admin to type a
    // minus sign. "Remove $310.00 from Renata's total" is what the person is
    // actually doing, and a typo that drops a `-` would silently double the
    // number instead of halving it.
    if (magnitude < 0n) {
      return { status: 'invalid', reason: 'Enter a positive amount and choose add or remove.' }
    }
    deltaCents = input.direction === 'remove' ? negate(magnitude) : magnitude
  } catch (error) {
    if (error instanceof MoneyError) return { status: 'invalid', reason: error.message }
    throw error
  }

  if (!/^[0-9a-f-]{36}$/i.test(input.ownerUserId)) return { status: 'not_found' }
  if (!/^[0-9a-f-]{36}$/i.test(input.idempotencyKey)) {
    return { status: 'invalid', reason: 'Reload the form and try again.' }
  }

  return withTenant(identity, async (tx, scope) => {
    // The database checks this too, inside the definer, against the sealed
    // identity. This decides which SCREEN STATE renders; it is not what protects
    // the board.
    if (scope !== 'tenant_admin') return { status: 'forbidden' }

    try {
      const rows = await tx.execute<{ id: string | null }>(sql`
        SELECT app.ledger_adjust(
          ${input.ownerUserId}::uuid,
          ${deltaCents.toString()}::bigint,
          ${input.reason},
          ${input.idempotencyKey}::uuid
        ) AS id`)

      const entryId = rows[0]?.id ?? null
      if (entryId === null) return { status: 'not_found' }
      return { status: 'applied', entryId, deltaCents: toWireString(deltaCents) }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      for (const [code, sentence] of REFUSALS) {
        if (message.includes(code)) return { status: 'invalid', reason: sentence }
      }
      // Anything we did not name is a fault, not the admin's mistake, and must
      // not be swallowed into a 422 that reads like one.
      throw error
    }
  })
}

export async function action({ request }: { request: Request }): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response(null, { status: 405, headers: { allow: 'POST' } })
  }

  const form = await request.formData()
  const ownerUserId = form.get('ownerUserId')
  const amount = form.get('amount')
  const direction = form.get('direction')
  const reason = form.get('reason')
  const idempotencyKey = form.get('idempotencyKey')

  if (
    typeof ownerUserId !== 'string' ||
    typeof amount !== 'string' ||
    typeof reason !== 'string' ||
    typeof idempotencyKey !== 'string' ||
    (direction !== 'add' && direction !== 'remove')
  ) {
    return Response.json(
      { status: 'invalid', reason: 'Fill in every field.' } satisfies CorrectionResult,
      { status: 422, headers: { 'cache-control': 'private, no-store' } },
    )
  }

  const result = await correctLedger(request, {
    ownerUserId,
    amount,
    direction,
    reason,
    idempotencyKey,
  })

  const status =
    result.status === 'applied'
      ? 201
      : result.status === 'forbidden'
        ? 403
        : result.status === 'not_found'
          ? 404
          : 422

  return Response.json(result, { status, headers: { 'cache-control': 'private, no-store' } })
}

export const endpoint = defineEndpoint({
  method: 'POST',
  path: '/api/ledger-corrections',
  role: 'web',
  audience: 'tenant',
  scope: 'tenant_admin',
  surface: 'json',
  summary: 'Appends a compensating entry so a wrong number on the public board can be corrected.',
  mfa: false,
  mfaReason:
    'ADR-084 rules MFA is not required on admin endpoints in the MVP; the compensating control is that admin is a database role checked inside the definer against the sealed identity, not a UI flag.',
  /**
   * 🔴 IDEMPOTENT, AND THIS IS THE ONE PLACE THAT MATTERS MOST. The key rides
   * into `app.ledger_adjust` as `source_event_id`, so a double submit lands on
   * `earnings_source_event_uidx` — the index the ledger table calls "THE
   * correctness mechanism, not a performance index" — instead of crediting
   * twice. `notes.ts` argues the opposite for notes and is right there: two
   * identical notes are two real notes. Two identical corrections are one
   * correction submitted twice.
   */
  idempotency: {
    kind: 'client_key',
    field: 'idempotencyKey',
    constraint: 'earnings_ledger dedupe on (tenant, source_event_id)',
  },
  siloProbe: {
    kind: 'none',
    reason:
      'Admin-only by scope, and app.ledger_adjust derives the tenant from the sealed session: a foreign owner_user_id returns the same NULL as an id that never existed, so there is no id that produces a distinguishable answer from outside the tenant.',
  },
})
