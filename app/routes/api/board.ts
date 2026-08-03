import { sql } from 'drizzle-orm'

import { withTenant } from '~/db'
import { requireIdentity } from '~/lib/auth/identity'

/**
 * The pipeline board.
 *
 * Money leaves as a string of whole cents, like everywhere else. The card
 * carries the three things Phase 1 found sellers actually scan for — value,
 * days untouched, and what happens next — and nothing else.
 */

export interface BoardCard {
  readonly id: string
  readonly contactName: string
  readonly premiumCents: string | null
  readonly daysUntouched: number
  /**
   * Dial attempts on this deal — element ⑤ of the card anatomy, and half of
   * the fact `04b` §2.4 says is *"the only thing between this floor and a
   * harassment claim"*. Rendered as `3 attempts`; zero replaces the whole line
   * with `Not called yet`, which is a different sentence and not a `0`.
   */
  readonly attempts: number
  readonly nextActivity: string | null
}

export interface BoardColumn {
  readonly id: string
  readonly name: string
  readonly stageType: 'open' | 'earning' | 'lost'
  readonly cards: readonly BoardCard[]
  /** Whole cents. Summed by the database, never in the client. */
  readonly totalCents: string
}

export interface PipelinePayload {
  readonly columns: readonly BoardColumn[]
}

export async function readPipeline(request: Request): Promise<PipelinePayload> {
  const identity = await requireIdentity(request)

  return withTenant(identity, async (tx) => {
    const stages = await tx.execute<{
      id: string
      name: string
      stage_type: 'open' | 'earning' | 'lost'
    }>(sql`
      SELECT id, name, stage_type::text AS stage_type
      FROM app.stage
      WHERE tenant_id = app.current_tenant()
        AND owner_user_id = app.current_user_id()
        AND deleted_at IS NULL
      ORDER BY sort_order`)

    const cards = await tx.execute<{
      id: string
      stage_id: string
      contact_name: string
      premium_cents: string | null
      days_untouched: number
      attempts: number
      next_activity: string | null
    }>(sql`
      SELECT o.id,
             o.stage_id,
             coalesce(c.full_name, 'Unnamed lead') AS contact_name,
             o.premium_annual_cents::text AS premium_cents,
             greatest(0, extract(day from clock_timestamp()
               - coalesce(o.last_activity_at, o.stage_entered_at))::integer) AS days_untouched,
             o.attempt_count AS attempts,
             (SELECT a.title FROM app.activity a
               WHERE a.tenant_id = o.tenant_id AND a.opportunity_id = o.id
                 AND a.completed_at IS NULL AND a.canceled_at IS NULL
               ORDER BY a.due_at LIMIT 1) AS next_activity
      FROM app.opportunity_live o
      LEFT JOIN app.contact c ON c.tenant_id = o.tenant_id AND c.id = o.contact_id
      WHERE o.tenant_id = app.current_tenant()
        AND o.owner_user_id = app.current_user_id()
      ORDER BY o.stage_entered_at DESC`)

    const byStage = new Map<string, BoardCard[]>()
    const totals = new Map<string, bigint>()

    for (const row of cards) {
      const list = byStage.get(row.stage_id) ?? []
      list.push({
        id: row.id,
        contactName: row.contact_name,
        premiumCents: row.premium_cents,
        daysUntouched: row.days_untouched,
        attempts: row.attempts,
        nextActivity: row.next_activity,
      })
      byStage.set(row.stage_id, list)
      // Summed as BigInt, never as a float, and never on the client.
      totals.set(row.stage_id, (totals.get(row.stage_id) ?? 0n) + BigInt(row.premium_cents ?? '0'))
    }

    return {
      columns: [...stages].map((s) => ({
        id: s.id,
        name: s.name,
        stageType: s.stage_type,
        cards: byStage.get(s.id) ?? [],
        totalCents: (totals.get(s.id) ?? 0n).toString(),
      })),
    }
  })
}

export async function loader({ request }: { request: Request }): Promise<Response> {
  const payload = await readPipeline(request)
  return new Response(JSON.stringify(payload), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'private, no-store',
    },
  })
}
