import { sql } from 'drizzle-orm'

import { withTenant } from '~/db'
import { requireIdentity } from '~/lib/auth/identity'
import { defineEndpoint } from '~/lib/endpoint/define'

/**
 * Records that a celebration was shown. Nothing else.
 *
 * Called AFTER the render, so this endpoint being slow, refusing, or failing
 * outright can never turn into a missing animation — which is the property that
 * keeps D3-05's +/-100 ms achievable at all.
 *
 * Every refusal lives in `app.celebrate_once`, not here: too early, too late,
 * reversed, and already claimed. This handler translates the answer into a
 * status and adds no rule of its own, so a route written next year cannot
 * celebrate a cancelled sale by forgetting a check.
 */
export async function action({ request }: { request: Request }): Promise<Response> {
  const identity = await requireIdentity(request)
  const form = await request.formData()
  const raw = form.get('opportunityId')
  const opportunityId = typeof raw === 'string' ? raw : ''

  try {
    const result = await withTenant(identity, async (tx) => {
      const rows = await tx.execute<{ celebrated_at: string | null; refused: string | null }>(
        sql`SELECT celebrated_at, refused FROM app.celebrate_once(${opportunityId}::uuid)`,
      )
      return rows[0] ?? null
    })

    // A refusal is not an error for the seller. The animation already played;
    // what a refusal means is that the RECORD says no — the win was undone, or
    // the tab was reopened tomorrow, or another claim got there first. None of
    // those is something to interrupt anyone with.
    return Response.json(
      {
        recorded: result?.celebrated_at !== null && result !== null,
        refused: result?.refused ?? null,
      },
      { headers: { 'cache-control': 'private, no-store' } },
    )
  } catch (err: unknown) {
    const chain: string[] = []
    let cur: unknown = err
    while (cur instanceof Error) {
      chain.push(cur.message)
      cur = cur.cause
    }
    // Owner-scoped not-found, never a 403: a 403 confirms the record exists.
    if (chain.join(' | ').includes('CB404')) {
      return Response.json({ recorded: false, refused: 'not_found' }, { status: 404 })
    }
    throw err
  }
}

/**
 * Claims the closed-won celebration, once per opportunity, after the undo
 * window.
 */
export const endpoint = defineEndpoint({
  method: 'POST',
  path: '/api/celebrate',
  role: 'web',
  audience: 'owner',
  scope: 'owner',
  surface: 'json',
  summary: 'Claims the celebration for one opportunity; the second claimer is told already.',
  // app.celebrate_once is a conditional UPDATE - two claimants produce one
  // winner because the UPDATE is atomic, and the loser gets a success path.
  idempotency: {
    kind: 'natural',
    constraint: 'celebrate_once: UPDATE ... WHERE celebrated_at IS NULL',
  },
  siloProbe: { kind: 'foreign-id', param: 'opportunityId' },
})
