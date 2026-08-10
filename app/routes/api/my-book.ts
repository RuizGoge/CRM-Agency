import { sql } from 'drizzle-orm'

import { withTenant, type SessionIdentity } from '~/db'
import { requireIdentity } from '~/lib/auth/identity'
import { bookChipOf, type BookChip } from '~/lib/card-health/book-chip'

/**
 * My Book — ONE list, ONE status chip (MVP item 24).
 *
 * It replaces the five seeded working lists the discovery phase found, and the
 * replacement is the point rather than a simplification: five lists is five
 * places a lead can be missing from, and a seller who has to check five is a
 * seller who checks two.
 *
 * THE CHIP IS COMPUTED HERE, ON THE SERVER, from the same rule the board uses —
 * `04b` §1253 requires the board, My Book and My Day to be byte-identical about
 * a lead's state, and the only way three screens agree is if none of them
 * decides. The derivation lives in `~/lib/card-health/book-chip`, beside the
 * card's own, precisely so that a future change to one is a change to both.
 *
 * OWNER SCOPING IS STRUCTURAL. `contact` is `owner_scoped`, so RLS returns the
 * caller's own book and nothing else — there is no predicate here that could be
 * forgotten, and no branch that could return somebody else's row.
 */

export interface BookRow {
  readonly contactId: string
  readonly fullName: string
  readonly phoneE164: string | null
  /** Null when the number has been flagged bad — the dial button must not offer it. */
  readonly badNumber: boolean
  readonly daysSinceHumanTouch: number | null
  readonly openDeals: number
  readonly chip: BookChip
}

export interface BookPayload {
  readonly rows: readonly BookRow[]
  /** The seller's own count, so the empty state can say "empty" and not "no matches". */
  readonly total: number
}

/** A `type`, not an `interface`: only a type alias satisfies tx.execute's Record<string, unknown>. */
type BookQueryRow = {
  contact_id: string
  full_name: string
  phone_e164: string | null
  bad_number: boolean
  days_since_human_touch: number | null
  open_deals: number
  won_deals: number
  total_deals: number
  cold_threshold_days: number
}

/** The read with the request seam removed, so tests exercise THIS SQL. */
export async function readBookFor(identity: SessionIdentity): Promise<BookPayload> {
  return withTenant(identity, async (tx) => {
    const rows = await tx.execute<BookQueryRow>(sql`
      SELECT c.id                                        AS contact_id,
             c.full_name,
             p.phone_e164,
             (p.bad_number_at IS NOT NULL)                AS bad_number,
             -- The HUMAN touch, not any touch. An automated SMS keeping a dead
             -- lead's chip green is automation masking abandonment, which is the
             -- opposite of what this column exists to surface.
             CASE WHEN max(o.last_human_touch_at) IS NULL THEN NULL
                  ELSE floor(extract(epoch FROM
                         clock_timestamp() - max(o.last_human_touch_at)) / 86400)::int
             END                                          AS days_since_human_touch,
             count(*) FILTER (WHERE o.current_stage_type = 'open')::int    AS open_deals,
             count(*) FILTER (WHERE o.current_stage_type = 'earning')::int AS won_deals,
             count(o.id)::int                             AS total_deals,
             t.cold_threshold_days
        FROM app.contact c
        JOIN app.tenant t ON t.id = c.tenant_id
        LEFT JOIN app.contact_phone p
               ON p.tenant_id = c.tenant_id AND p.contact_id = c.id AND p.is_primary
        LEFT JOIN app.opportunity o
               ON o.tenant_id = c.tenant_id AND o.contact_id = c.id AND o.deleted_at IS NULL
       WHERE c.deleted_at IS NULL
       GROUP BY c.id, c.full_name, p.phone_e164, p.bad_number_at, t.cold_threshold_days
       -- Never worked first, then the coldest. The book opens on the work
       -- nobody has started rather than on an alphabet.
       ORDER BY (max(o.last_human_touch_at) IS NOT NULL),
                max(o.last_human_touch_at) ASC NULLS FIRST,
                c.full_name ASC`)

    return {
      total: rows.length,
      rows: rows.map((r) => ({
        contactId: r.contact_id,
        fullName: r.full_name,
        // A bad number is not offered. The flag exists so a seller stops
        // burning attempts on a line that cannot connect.
        phoneE164: r.bad_number ? null : r.phone_e164,
        badNumber: r.bad_number,
        daysSinceHumanTouch: r.days_since_human_touch,
        openDeals: r.open_deals,
        chip: bookChipOf({
          daysSinceHumanTouch: r.days_since_human_touch,
          openDeals: r.open_deals,
          wonDeals: r.won_deals,
          totalDeals: r.total_deals,
          coldThresholdDays: r.cold_threshold_days,
        }),
      })),
    }
  })
}

export async function loader({ request }: { request: Request }): Promise<Response> {
  const payload = await readBookFor(await requireIdentity(request))
  return new Response(JSON.stringify(payload), {
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}
