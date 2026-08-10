import { sql } from 'drizzle-orm'

import { withTenant, type SessionIdentity } from '~/db'
import { requireIdentity } from '~/lib/auth/identity'
import { looksNumeric, toE164 } from '~/lib/phone/e164'
import { MIN_QUERY_LENGTH } from '~/lib/search/query'
import { defineEndpoint } from '~/lib/endpoint/define'

/**
 * Global search — MVP item 8, protected item `DEMO-08`, and §7's recovery path.
 *
 * The moment it exists for is precise: a seller's handset rings from a number
 * she does not recognise, the inbound call will log itself but only after it
 * ends, and she needs the file NOW. Ctrl+K, the digits as she reads them off
 * the screen, Enter — the record with forty-four days of history while the
 * phone is still ringing. Two interactions from anywhere in the app.
 *
 * THREE FIELDS AND NO MORE: name, phone, email. `search.idle` states them on
 * screen — *"By name, phone or email. Any phone format works."* — so nobody
 * tries a policy number and concludes the search is broken.
 *
 * 🔬 WHO ACTUALLY HOLDS THE SILO HERE, measured rather than assumed. The
 * predicate below filters on `app.current_user_id()` for a seller — and
 * MUTATING IT TO `true` LEAVES EVERY TEST GREEN, because `contact`'s
 * `owner_scoped` RLS policy has already scoped the seller's rows before this
 * query sees them. The database is the enforcer, exactly as the constitution
 * says, and this predicate is the second layer rather than the guarantee.
 *
 * It stays for two reasons that survive that finding. It makes the SUPERVISOR
 * case a decision instead of an accident — `global` is read from the seat's
 * own role here, never from anything the client sends — and it keeps the
 * application's intent legible next to the policy that enforces it. What it is
 * NOT is the thing standing between two sellers' books; a comment claiming
 * that would be documentation presented as a mechanism.
 */

export interface SearchHit {
  readonly contactId: string
  readonly fullName: string
  readonly phone: string | null
  readonly email: string | null
  /**
   * Which field matched, so the result row can show the seller why it is
   * there. A list of names that matched on an invisible email reads as wrong.
   */
  readonly matchedOn: 'name' | 'phone' | 'email'
  /**
   * The owner's display name — rendered as a chip on EVERY row, and only for a
   * supervisor or admin. §7: a global result set without an owner on each row
   * is a supervisor reading fifty books as if they were one.
   */
  readonly ownerName: string | null
}

export interface SearchPayload {
  readonly query: string
  /** `true` when the caller sees every book — supervisor or admin. */
  readonly global: boolean
  readonly hits: readonly SearchHit[]
  /**
   * The query as a phone number, when it could be one. The empty state uses it
   * to offer `Quick-add this number` prefilled, which is the whole point of
   * searching for a number that is not in the book yet.
   */
  readonly asPhone: string | null
}

/** One screen of results. A search that returns a report is not a search. */
const LIMIT = 20

export async function readSearch(request: Request): Promise<SearchPayload> {
  const url = new URL(request.url)
  return readSearchFor(await requireIdentity(request), url.searchParams.get('q') ?? '')
}

/** The read with the request seam removed, so the suite exercises this SQL. */
export async function readSearchFor(
  identity: SessionIdentity,
  rawQuery: string,
): Promise<SearchPayload> {
  const query = rawQuery.trim()
  const asPhone = toE164(query)

  if (query.length < MIN_QUERY_LENGTH) {
    return { query, global: false, hits: [], asPhone }
  }

  return withTenant(identity, async (tx) => {
    const roleRows = await tx.execute<{ is_seller: boolean }>(sql`
      SELECT u.role = 'seller' AS is_seller FROM app.app_user u
       WHERE u.tenant_id = app.current_tenant() AND u.id = app.current_user_id()`)

    // Default to the NARROW answer. A role lookup that returned nothing must
    // not be the reason somebody reads every book in the tenant.
    const global = roleRows[0]?.is_seller === false

    // The digits, for a suffix match on a partial number. A seller who
    // remembers the last four is the case §7 describes, and `%1234` cannot use
    // the unique index — which is why the exact E.164 match above it exists and
    // why this is bounded by LIMIT.
    const digits = looksNumeric(query) ? query.replace(/\D/g, '') : null

    const rows = await tx.execute<{
      contact_id: string
      full_name: string
      phone: string | null
      email: string | null
      matched_on: 'name' | 'phone' | 'email'
      owner_name: string | null
    }>(sql`
      -- THREE INDEXED BRANCHES, UNIONed — not one scoped set filtered
      -- afterwards, and the difference was measured at 1,053 ms.
      --
      -- The first version scoped the seller's book in a CTE and then tested
      -- each row in a LATERAL. That structure cannot use the index migration
      -- 0011 built for exactly this: a composite GIN over
      -- (tenant_id, owner_user_id, full_name gin_trgm_ops), which puts the
      -- OWNERSHIP PREDICATE INSIDE THE INDEX so the seller's own rows are the
      -- only ones the scan ever produces. Splitting the CTE from the match
      -- threw that away and made every keystroke a sequential scan of the
      -- tenant.
      --
      -- 0011's comment says why that index is shaped that way, and it is not
      -- about speed: "a tenant-wide trigram index filtered AFTER retrieval is
      -- the silo leak that rules out a separate search service — the rows are
      -- fetched first and discarded second." Writing the query the slow way
      -- was also writing it the shape that leak has.
      WITH matches AS (
        SELECT p.contact_id AS id, 'phone'::text AS matched_on, 1 AS rank
          FROM app.contact_phone p
         WHERE p.tenant_id = app.current_tenant()
           AND (${global}::boolean OR p.owner_user_id = app.current_user_id())
           AND (p.phone_e164 = ${asPhone}::text
                OR (${digits}::text IS NOT NULL
                    AND p.phone_e164 LIKE '%' || ${digits}::text))

        UNION ALL

        SELECT c.id, 'email', 2
          FROM app.contact c
         WHERE c.tenant_id = app.current_tenant()
           AND (${global}::boolean OR c.owner_user_id = app.current_user_id())
           AND c.email_norm IS NOT NULL
           AND c.email_norm::text LIKE ${`%${query.toLowerCase()}%`}::text

        UNION ALL

        -- The branch the composite GIN serves. All three conditions are in the
        -- scan, which is what keeps them in Index Cond rather than in a
        -- post-retrieval filter.
        SELECT c.id, 'name', 3
          FROM app.contact c
         WHERE c.tenant_id = app.current_tenant()
           AND (${global}::boolean OR c.owner_user_id = app.current_user_id())
           AND c.full_name ILIKE ${`%${query}%`}::text
      ),
      best AS (
        -- ONE row per contact. A phone match is an identification and a name
        -- match is a guess, so a contact found both ways is reported as found
        -- by phone.
        SELECT DISTINCT ON (id) id, matched_on FROM matches ORDER BY id, rank
      )
      SELECT c.id AS contact_id,
             c.full_name,
             (SELECT p.phone_e164 FROM app.contact_phone p
               WHERE p.tenant_id = c.tenant_id AND p.contact_id = c.id
               ORDER BY p.is_primary DESC LIMIT 1) AS phone,
             c.email_norm::text AS email,
             b.matched_on,
             CASE WHEN ${global}::boolean THEN o.display_name ELSE NULL END AS owner_name
        FROM best b
        JOIN app.contact c ON c.tenant_id = app.current_tenant() AND c.id = b.id
        LEFT JOIN app.app_user o
          ON o.tenant_id = app.current_tenant() AND o.id = c.owner_user_id
       WHERE c.deleted_at IS NULL AND c.redacted_at IS NULL
       ORDER BY b.matched_on, c.full_name
       LIMIT ${LIMIT}`)

    return {
      query,
      global,
      asPhone,
      hits: [...rows].map((r) => ({
        contactId: r.contact_id,
        fullName: r.full_name,
        phone: r.phone,
        email: r.email,
        matchedOn: r.matched_on,
        ownerName: r.owner_name,
      })),
    }
  })
}

export async function loader({ request }: { request: Request }): Promise<Response> {
  const body = JSON.stringify(await readSearch(request))

  return new Response(body, {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // One seller's book. Never a shared cache, ever.
      'cache-control': 'private, no-store',
    },
  })
}

/**
 * Global owner-scoped search. Name, phone in E.164, email.
 */
export const endpoint = defineEndpoint({
  method: 'GET',
  path: '/api/search',
  role: 'web',
  audience: 'owner',
  scope: 'owner',
  surface: 'json',
  summary: 'Owner-scoped search across name, phone and email.',
  etag: {
    kind: 'none',
    reason:
      'A query result keyed on a string the user is still typing. Revalidating it costs the same as answering it.',
  },
  // The silo-collision fixture lives here: two sellers, one consumer, one
  // phone number in three formats.
  siloProbe: { kind: 'listing', canary: true },
})
