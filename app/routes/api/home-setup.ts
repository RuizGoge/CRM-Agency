import { sql } from 'drizzle-orm'

import { withTenant, type SessionIdentity } from '~/db'
import { requireIdentity } from '~/lib/auth/identity'

/**
 * The first-run checklist's state — US-9.14, `FirstRunChecklist` (C-41).
 *
 * THE RULE THAT SHAPES THIS FILE: every item checks off by itself. US-9.14 is
 * explicit — *"that checklist item checks off automatically without a manual
 * 'mark done' click"* — and C-41 says it again from the other side: *"there is
 * no 'mark done' control"*. So there is no `dismissed_at`, no completion
 * table, and nothing a seller can tick. Each item is a QUESTION ASKED OF THE
 * DATA, answered fresh on every read.
 *
 * That also gives the collapse rule for free. US-9.14 wants the checklist to
 * collapse when all four are done and never return; if the checklist is a
 * function of four conditions, and the conditions do not go backwards, "never
 * returns" is arithmetic rather than a flag somebody has to remember to set.
 *
 * Owner-scoped explicitly, for the reason `readMyDay` documents: the
 * `owner_scoped` policy grants a supervisor global read, which is right for
 * the board and exactly wrong for a personal setup checklist. The policy is
 * the floor, not the answer — though in this case the checklist is not shown
 * to a supervisor at all (`04b` §4.1, no-permission).
 */

export interface HomeSetup {
  /** Sellers only. A supervisor or admin has no book to set up. */
  readonly isSeller: boolean
  /**
   * Item 1. ALWAYS FALSE TODAY, and that is the true answer rather than a
   * placeholder: `aloware_number_mapping` (`05b` §782) does not exist in this
   * tree, so no seller in any tenant has a verified calling number. When the
   * Aloware module lands this becomes a read of that table and nothing else
   * about this file changes.
   */
  readonly numberVerified: boolean
  /** Item 2. Owns at least one stage, and at least one that counts as Earnings. */
  readonly stagesConfigured: boolean
  /** Item 3. Owns at least one contact. */
  readonly bookImported: boolean
}

export async function readHomeSetup(request: Request): Promise<HomeSetup> {
  return readHomeSetupFor(await requireIdentity(request))
}

/** The read with the request seam removed, so the suite exercises this SQL. */
export async function readHomeSetupFor(identity: SessionIdentity): Promise<HomeSetup> {
  return withTenant(identity, async (tx) => {
    const rows = await tx.execute<{
      is_seller: boolean
      stages_configured: boolean
      book_imported: boolean
    }>(sql`
      SELECT
        (SELECT u.role = 'seller'
           FROM app.app_user u
          WHERE u.tenant_id = app.current_tenant()
            AND u.id = app.current_user_id()) AS is_seller,

        -- Item 2 is TWO conditions and the second is the one that matters.
        -- A seller with six stages and none of them marked as Earnings has a
        -- board that can never pay them, which is the misconfiguration the
        -- hint under this item exists to name.
        EXISTS (SELECT 1 FROM app.stage s
                 WHERE s.tenant_id = app.current_tenant()
                   AND s.owner_user_id = app.current_user_id()
                   AND s.deleted_at IS NULL
                   AND s.stage_type = 'earning') AS stages_configured,

        EXISTS (SELECT 1 FROM app.contact c
                 WHERE c.tenant_id = app.current_tenant()
                   AND c.owner_user_id = app.current_user_id()
                   AND c.deleted_at IS NULL) AS book_imported`)

    const row = rows[0]

    return {
      isSeller: row?.is_seller ?? false,
      numberVerified: false,
      stagesConfigured: row?.stages_configured ?? false,
      bookImported: row?.book_imported ?? false,
    }
  })
}

export async function loader({ request }: { request: Request }): Promise<Response> {
  const body = JSON.stringify(await readHomeSetup(request))

  return new Response(body, {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // Never a shared cache: this is one seller's setup state, and two
      // sellers must never be served one another's response.
      'cache-control': 'private, no-store',
    },
  })
}
