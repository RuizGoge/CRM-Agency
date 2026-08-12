import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { TEST_URL } from './setup/urls'

/**
 * THE APPLICATION ROLE CANNOT CLAIM TO BE SOMEBODY ELSE.
 *
 * 🔴 THE FINDING, MEASURED BEFORE IT WAS CLOSED. Inside a real seller's
 * session, as `crm_app`:
 *
 *     SELECT count(*) FROM app.contact;                       -->  42
 *     SELECT set_config('app.user_id', <a colleague>, true);
 *     SELECT count(*) FROM app.contact;                       -->   3
 *
 * Every RLS policy in the schema, `timeline_read`'s ownership predicate and
 * `stage_move`'s SM404 rest on `app.current_user_id()`, which read a GUC the
 * application role could overwrite. The silo was a convention the application
 * observed, not a rule the database enforced.
 *
 * After 0067 the same forgery yields ZERO rows rather than a colleague's book —
 * the fail-closed direction, because an unsealed claim resolves to NULL and
 * `owner_user_id = NULL` is false for every row.
 */

const TENANT = '00000000-0000-7000-8000-0000000f2100'
const OTHER_TENANT = '00000000-0000-7000-8000-0000000f21ff'
const ANA = '00000000-0000-7000-8000-0000000f21a1'
const BEN = '00000000-0000-7000-8000-0000000f21b1'

let sql: postgres.Sql

beforeAll(async () => {
  sql = postgres(TEST_URL, { max: 1, onnotice: () => {} })

  await sql`
    INSERT INTO app.tenant (id, name, business_tz) VALUES
      (${TENANT}, 'Seal Agency', 'America/New_York'),
      (${OTHER_TENANT}, 'Other Seal Agency', 'America/Chicago')`
  await sql`
    INSERT INTO app.app_user (tenant_id, id, email, full_name, display_name, role) VALUES
      (${TENANT}, ${ANA}, 'ana@seal.test', 'Ana Seal', 'Ana S.', 'seller'),
      (${TENANT}, ${BEN}, 'ben@seal.test', 'Ben Seal', 'Ben S.', 'seller')`
  await sql`
    INSERT INTO app.contact (tenant_id, owner_user_id, full_name, created_via) VALUES
      (${TENANT}, ${ANA}, 'Ana Lead One', 'manual'),
      (${TENANT}, ${ANA}, 'Ana Lead Two', 'manual'),
      (${TENANT}, ${BEN}, 'Ben Lead', 'manual')`
})

afterAll(async () => {
  await sql?.end()
})

/** A real unit of work: the production door, then the unprivileged role. */
async function asSeller<T>(
  userId: string,
  fn: (tx: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  return sql.begin(async (tx) => {
    await tx`SELECT app.begin_request(${TENANT}::uuid, ${userId}::uuid)`
    await tx`SET LOCAL ROLE crm_app`
    return fn(tx)
  }) as Promise<T>
}

describe('an identity claim has to carry a seal', () => {
  it('gives a seller her own book through the door', async () => {
    // The positive control. Without it every assertion below passes over a
    // database where nothing is visible to anyone — which is the exact shape a
    // broken seal would take, and it would look like a pass.
    const names = await asSeller(ANA, async (tx) => {
      const rows = await tx<{ full_name: string }[]>`
        SELECT full_name FROM app.contact ORDER BY full_name`
      return rows.map((r) => r.full_name)
    })
    expect(names).toEqual(['Ana Lead One', 'Ana Lead Two'])
  })

  it('shows NOTHING when the application role rewrites the user id', async () => {
    // 🎯 THE TEST OF MIGRATION 0067, and the number that matters is ZERO rather
    // than Ben's one row. Before the seal this returned Ben's book.
    //
    // MUTATION: drop the `AND c.seal = …` predicate from `app.current_user_id`.
    // Every other test in this tree stays green — the product behaves
    // identically for every honest caller — and this returns 'Ben Lead'.
    const result = await asSeller(ANA, async (tx) => {
      await tx`SELECT set_config('app.user_id', ${BEN}, true)`
      const rows = await tx<{ full_name: string }[]>`SELECT full_name FROM app.contact`
      const [who] = await tx<{ id: string | null }[]>`SELECT app.current_user_id() AS id`
      return { names: rows.map((r) => r.full_name), identity: who?.id ?? null }
    })

    expect(result.names).toEqual([])
    // AND THE IDENTITY IS ABSENT RATHER THAN WRONG. NULL is what makes every
    // owner-scoped policy close instead of opening onto somebody else.
    expect(result.identity).toBeNull()
  })

  it('shows nothing when the whole context is forged, tenant and all', async () => {
    // The seal binds the user TO the tenant, so moving both together does not
    // produce a matching pair either.
    const rows = await asSeller(ANA, async (tx) => {
      await tx`SELECT set_config('app.tenant_id', ${OTHER_TENANT}, true)`
      await tx`SELECT set_config('app.user_id', ${BEN}, true)`
      return tx<{ full_name: string }[]>`SELECT full_name FROM app.contact`
    })
    expect(rows).toEqual([])
  })

  it('refuses a seal copied from one identity onto another', async () => {
    // A caller that captures its OWN seal cannot spend it as somebody else:
    // the digest covers (tenant, user), so Ana's seal beside Ben's id fails.
    const result = await asSeller(ANA, async (tx) => {
      const [mine] = await tx<{ seal: string | null }[]>`
        SELECT current_setting('app.identity_seal', true) AS seal`
      await tx`SELECT set_config('app.user_id', ${BEN}, true)`
      await tx`SELECT set_config('app.identity_seal', ${mine?.seal ?? ''}, true)`
      const [who] = await tx<{ id: string | null }[]>`SELECT app.current_user_id() AS id`
      return { seal: mine?.seal ?? null, identity: who?.id ?? null }
    })

    // The seal was real — this is not passing because there was nothing to copy.
    expect(result.seal).toMatch(/^[0-9a-f]{32}$/)
    expect(result.identity).toBeNull()
  })

  it('keeps the secret unreachable and the minting function unexecutable', async () => {
    // 🔴 THE TWO ABSENCES THE WHOLE MIGRATION RESTS ON. `crm_app` has no USAGE
    // on `security`, so it cannot even NAME the table, and no EXECUTE on the
    // one function that would compute a seal for it.
    const [schema] = await sql<{ usage: boolean }[]>`
      SELECT has_schema_privilege('crm_app', 'security', 'USAGE') AS usage`
    expect(schema?.usage).toBe(false)

    const [fn] = await sql<{ granted: boolean }[]>`
      SELECT has_function_privilege('crm_app', p.oid, 'EXECUTE') AS granted
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'app' AND p.proname = 'identity_seal'`
    expect(fn?.granted).toBe(false)

    // And the secret is not a literal anybody can read out of the catalog:
    // `pg_proc.prosrc` is world-readable, which is why it lives in a table.
    const [leak] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname IN ('app', 'security')
         AND p.prosrc LIKE '%' || (SELECT secret FROM security.identity_secret) || '%'`
    expect(leak?.n).toBe(0)
  })

  it('still lets system work run with no user at all', async () => {
    // `begin_system_work` sets an empty user and mints no seal, and the relay
    // depends on that. MUTATION: require a seal unconditionally in
    // `current_user_id` and every projection, reminder and audit write stops.
    const scope = await sql.begin(async (tx) => {
      const [row] = await tx<{ scope: string }[]>`
        SELECT app.begin_system_work(${TENANT}::uuid) AS scope`
      await tx`SET LOCAL ROLE crm_app`
      const [who] = await tx<{ id: string | null }[]>`SELECT app.current_user_id() AS id`
      expect(who?.id ?? null).toBeNull()
      return row?.scope
    })
    expect(scope).toBe('system')
  })
})
