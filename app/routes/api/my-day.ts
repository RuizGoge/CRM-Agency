import { sql } from 'drizzle-orm'

import { withTenant } from '~/db'
import { requireIdentity } from '~/lib/auth/identity'

/**
 * My Day — the seller's own work, and only ever their own.
 *
 * THE TRAP THIS MODULE HAS TO AVOID: the `owner_scoped` policy reads
 * `owner_user_id = current_user OR app.scope_is_global()`, which is correct for
 * a board a supervisor is meant to read across. It is exactly wrong here. A
 * supervisor opening My Day must see THEIR OWN day, not fifty sellers' tasks
 * merged into one list — global visibility lives on the read-scoped board and
 * nowhere else (Phase 4, flow table).
 *
 * So every query below filters `owner_user_id = app.current_user_id()`
 * EXPLICITLY. The policy is the floor, not the answer.
 */

export interface MyDayItem {
  readonly id: string
  readonly title: string
  readonly at: string | null
  readonly contactName: string | null
  readonly kind: 'meeting' | 'task'
}

export interface MyDayPayload {
  readonly displayTz: string
  /** Past their end time with no outcome recorded. Cannot be dismissed. */
  readonly needsOutcome: readonly MyDayItem[]
  readonly appointments: readonly MyDayItem[]
  readonly dueNow: readonly MyDayItem[]
  readonly laterToday: readonly MyDayItem[]
}

export async function readMyDay(request: Request): Promise<MyDayPayload> {
  const identity = await requireIdentity(request)

  return withTenant(identity, async (tx) => {
    // The seller's DISPLAY timezone decides what "today" means on this screen.
    // Not the tenant's business timezone (which stamps period_key and nothing
    // else) and not the lead's (which decides calling legality). Three rules,
    // deliberately never merged.
    const tzRows = await tx.execute<{ display_tz: string }>(
      sql`SELECT display_tz FROM app.app_user
          WHERE tenant_id = app.current_tenant() AND id = app.current_user_id()`,
    )
    const displayTz = tzRows[0]?.display_tz ?? 'America/New_York'

    const needsOutcome = await tx.execute<{
      id: string
      title: string
      at: string
      contact_name: string | null
    }>(sql`
      SELECT m.id,
             'Appointment with ' || coalesce(c.full_name, 'a lead') AS title,
             m.starts_at_utc::text AS at,
             c.full_name AS contact_name
      FROM app.meeting m
      LEFT JOIN app.contact c ON c.tenant_id = m.tenant_id AND c.id = m.contact_id
      WHERE m.tenant_id = app.current_tenant()
        AND m.owner_user_id = app.current_user_id()
        AND m.canceled_at IS NULL
        AND m.outcome IS NULL
        AND m.starts_at_utc + make_interval(mins => m.duration_minutes) < clock_timestamp()
      ORDER BY m.starts_at_utc`)

    const appointments = await tx.execute<{
      id: string
      title: string
      at: string
      contact_name: string | null
    }>(sql`
      SELECT m.id,
             'Appointment with ' || coalesce(c.full_name, 'a lead') AS title,
             m.starts_at_utc::text AS at,
             c.full_name AS contact_name
      FROM app.meeting m
      LEFT JOIN app.contact c ON c.tenant_id = m.tenant_id AND c.id = m.contact_id
      WHERE m.tenant_id = app.current_tenant()
        AND m.owner_user_id = app.current_user_id()
        AND m.canceled_at IS NULL
        AND m.outcome IS NULL
        AND (m.starts_at_utc AT TIME ZONE ${displayTz})::date
            = (clock_timestamp() AT TIME ZONE ${displayTz})::date
        AND m.starts_at_utc + make_interval(mins => m.duration_minutes) >= clock_timestamp()
      ORDER BY m.starts_at_utc`)

    const tasks = await tx.execute<{
      id: string
      title: string
      at: string
      contact_name: string | null
      overdue: boolean
    }>(sql`
      SELECT a.id, a.title, a.due_at::text AS at, c.full_name AS contact_name,
             (a.due_at <= clock_timestamp()) AS overdue
      FROM app.activity a
      LEFT JOIN app.contact c ON c.tenant_id = a.tenant_id AND c.id = a.contact_id
      WHERE a.tenant_id = app.current_tenant()
        AND a.owner_user_id = app.current_user_id()
        AND a.completed_at IS NULL
        AND a.canceled_at IS NULL
        AND a.due_at IS NOT NULL
        AND (a.due_at AT TIME ZONE ${displayTz})::date
            <= (clock_timestamp() AT TIME ZONE ${displayTz})::date
      ORDER BY a.due_at`)

    const asItem = (r: {
      id: string
      title: string
      at: string | null
      contact_name: string | null
    }): MyDayItem => ({
      id: r.id,
      title: r.title,
      at: r.at,
      contactName: r.contact_name,
      kind: 'task',
    })

    return {
      displayTz,
      needsOutcome: [...needsOutcome].map((r) => ({ ...asItem(r), kind: 'meeting' as const })),
      appointments: [...appointments].map((r) => ({ ...asItem(r), kind: 'meeting' as const })),
      dueNow: [...tasks].filter((r) => r.overdue).map(asItem),
      laterToday: [...tasks].filter((r) => !r.overdue).map(asItem),
    }
  })
}

export async function loader({ request }: { request: Request }): Promise<Response> {
  const payload = await readMyDay(request)
  return new Response(JSON.stringify(payload), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // Per-seller by construction. Never a shared cache.
      'cache-control': 'private, no-store',
    },
  })
}
