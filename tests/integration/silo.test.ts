import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { TEST_URL } from './setup/urls'

/**
 * The silo, asserted against a real PostgreSQL.
 *
 * Every assertion here exists because its failure has NO SYMPTOM. A seller
 * seeing another seller's book renders a perfect page with the wrong rows: no
 * error, no warning, no log line, and nobody finds out. That is why these are
 * engine assertions rather than unit tests over application code — the
 * guarantee lives in the database or it does not exist.
 */

const TENANT = '00000000-0000-7000-8000-0000000000f1'
const ANA = '00000000-0000-7000-8000-00000000000a'
const BEN = '00000000-0000-7000-8000-00000000000b'
const SUPER = '00000000-0000-7000-8000-00000000000c'

let sql: postgres.Sql

beforeAll(async () => {
  sql = postgres(TEST_URL, { max: 1, onnotice: () => {} })

  // A probe table in the owner_scoped class. tenant and app_user are both
  // tenant_scoped by design, so neither can demonstrate owner-level denial —
  // the class that carries every lead, note, card and call in the product.
  await sql.unsafe(`
    CREATE TABLE app.probe_note (
      tenant_id     uuid NOT NULL,
      id            uuid NOT NULL DEFAULT uuidv7(),
      owner_user_id uuid NOT NULL,
      body          text NOT NULL,
      PRIMARY KEY (tenant_id, id)
    )`)

  await sql`
    INSERT INTO security.table_registry
      (schema_name, table_name, policy_class, owner_column, immutable, app_can_insert, registered_in_migration)
    VALUES ('app', 'probe_note', 'owner_scoped', 'owner_user_id', false, true, 'silo.test.ts')`

  await sql`SELECT security.harden()`

  await sql`
    INSERT INTO app.tenant (id, name, business_tz)
    VALUES (${TENANT}, 'Probe Agency', 'America/New_York')`

  await sql`
    INSERT INTO app.app_user (tenant_id, id, email, full_name, display_name, role) VALUES
      (${TENANT}, ${ANA},   'ana@probe.test',   'Ana Seller',  'Ana',  'seller'),
      (${TENANT}, ${BEN},   'ben@probe.test',   'Ben Seller',  'Ben',  'seller'),
      (${TENANT}, ${SUPER}, 'sam@probe.test',   'Sam Super',   'Sam',  'supervisor')`

  await sql`
    INSERT INTO app.probe_note (tenant_id, owner_user_id, body) VALUES
      (${TENANT}, ${ANA}, 'ANA PRIVATE NOTE'),
      (${TENANT}, ${BEN}, 'BEN PRIVATE NOTE')`
})

afterAll(async () => {
  await sql?.end()
})

/**
 * One unit of work, exactly as the application performs it: an explicit
 * transaction whose first statement sets the three GUCs with `is_local = true`,
 * then drops to the unprivileged role.
 */
async function asUser<T>(
  userId: string,
  scopeMode: 'owner' | 'tenant_read' | 'tenant_admin',
  fn: (tx: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  return sql.begin(async (tx) => {
    await tx`SELECT set_config('app.tenant_id', ${TENANT}, true)`
    await tx`SELECT set_config('app.user_id', ${userId}, true)`
    await tx`SELECT set_config('app.scope_mode', ${scopeMode}, true)`
    await tx`SET LOCAL ROLE crm_app`
    return fn(tx)
  }) as Promise<T>
}

describe('the generated hardening', () => {
  it('puts ENABLE and FORCE row level security on every managed relation', async () => {
    const rows = await sql<{ relation: string; forced: boolean; enabled: boolean }[]>`
      SELECT n.nspname || '.' || c.relname AS relation,
             c.relrowsecurity      AS enabled,
             c.relforcerowsecurity AS forced
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname IN ('app', 'ref') AND c.relkind IN ('r', 'p')`

    expect(rows.length).toBeGreaterThan(0)
    for (const r of rows) {
      expect(r.enabled, `${r.relation} has RLS disabled`).toBe(true)
      // Without FORCE, the table owner bypasses every policy. A restore that
      // comes back without it boots looking perfectly healthy.
      expect(r.forced, `${r.relation} is missing FORCE`).toBe(true)
    }
  })

  it('declares USING and WITH CHECK on every policy, and uses FOR ALL only', async () => {
    // A USING-only policy scopes reads and leaves writes unscoped. The public
    // RLS corpus is full of them, which is exactly why this is an assertion
    // and not a convention.
    const violations = await sql<{ relation: string; policyname: string; cmd: string }[]>`
      SELECT schemaname || '.' || tablename AS relation, policyname, cmd
      FROM pg_policies
      WHERE schemaname IN ('app', 'ref')
        AND (qual IS NULL OR with_check IS NULL OR cmd <> 'ALL')`

    expect(violations).toEqual([])
  })

  it('grants crm_app no DELETE on anything, anywhere', async () => {
    // Soft delete is the only delete this product has.
    const grants = await sql<{ relation: string }[]>`
      SELECT table_schema || '.' || table_name AS relation
      FROM information_schema.table_privileges
      WHERE grantee = 'crm_app' AND privilege_type = 'DELETE'`

    expect(grants).toEqual([])
  })
})

describe('harden() refuses to run on an unclassified relation', () => {
  it('raises HR001 and names the table, which fails the deploy', async () => {
    await sql.unsafe('CREATE TABLE app.forgotten_table (tenant_id uuid, id uuid)')
    try {
      await expect(sql`SELECT security.harden()`).rejects.toThrow(/HR001.*app\.forgotten_table/s)
    } finally {
      await sql.unsafe('DROP TABLE app.forgotten_table')
    }
    // And passes again once the offending relation is gone.
    await expect(sql`SELECT security.harden()`).resolves.toBeDefined()
  })

  it('looks in public too, so a table created there also fails the deploy', async () => {
    await sql.unsafe('CREATE TABLE public.saved_view (id uuid)')
    try {
      await expect(sql`SELECT security.harden()`).rejects.toThrow(/HR001.*public\.saved_view/s)
    } finally {
      await sql.unsafe('DROP TABLE public.saved_view')
    }
  })
})

describe('the owner-scoped policy actually denies', () => {
  it('returns zero rows — not an error — when no session context is set', async () => {
    // current_tenant() is NULL when the GUC is unset, `tenant_id = NULL` is
    // NULL, and the policy denies. A query that escapes the wrapper leaks
    // nothing in any of the five execution contexts.
    const rows = await sql.begin(async (tx) => {
      await tx`SET LOCAL ROLE crm_app`
      return tx<{ body: string }[]>`SELECT body FROM app.probe_note`
    })

    expect(rows).toEqual([])
  })

  it('shows a seller only their own rows', async () => {
    const rows = await asUser(
      ANA,
      'owner',
      (tx) => tx<{ body: string }[]>`
      SELECT body FROM app.probe_note`,
    )

    expect(rows.map((r) => r.body)).toEqual(['ANA PRIVATE NOTE'])
  })

  it('REFUSES a seller writing a row owned by another seller', async () => {
    // The scenario a USING-only policy lets through: the write succeeds, the
    // row vanishes from the writer's own view, and nobody ever finds out.
    await expect(
      asUser(
        ANA,
        'owner',
        (tx) => tx`
        INSERT INTO app.probe_note (tenant_id, owner_user_id, body)
        VALUES (${TENANT}, ${BEN}, 'FORGED BY ANA')`,
      ),
    ).rejects.toThrow(/row-level security/i)

    // And nothing landed.
    const forged = await sql<{ body: string }[]>`
      SELECT body FROM app.probe_note WHERE body = 'FORGED BY ANA'`
    expect(forged).toEqual([])
  })

  it('refuses DELETE by privilege, not by policy', async () => {
    await expect(asUser(ANA, 'owner', (tx) => tx`DELETE FROM app.probe_note`)).rejects.toThrow(
      /permission denied/i,
    )
  })
})

describe('scope is re-verified against the database, never trusted from the GUC', () => {
  it('gives a seller no global scope even when the session claims tenant_read', async () => {
    const result = await asUser(ANA, 'tenant_read', async (tx) => {
      const [scope] = await tx<{ global: boolean }[]>`SELECT app.scope_is_global() AS global`
      const rows = await tx<{ body: string }[]>`SELECT body FROM app.probe_note`
      return { global: scope?.global, bodies: rows.map((r) => r.body) }
    })

    expect(result.global).toBe(false)
    expect(result.bodies).toEqual(['ANA PRIVATE NOTE'])
  })

  it('gives a supervisor a global read but still refuses the write', async () => {
    // USING passes (they may legitimately read); WITH CHECK fails. That
    // asymmetry is the whole authorization model, and it is what makes the
    // supervisor case a 403 rather than an owner-scoped not-found.
    const bodies = await asUser(SUPER, 'tenant_read', async (tx) => {
      const rows = await tx<{ body: string }[]>`SELECT body FROM app.probe_note ORDER BY body`
      return rows.map((r) => r.body)
    })
    expect(bodies).toEqual(['ANA PRIVATE NOTE', 'BEN PRIVATE NOTE'])

    await expect(
      asUser(
        SUPER,
        'tenant_read',
        (tx) => tx`
        INSERT INTO app.probe_note (tenant_id, owner_user_id, body)
        VALUES (${TENANT}, ${ANA}, 'WRITTEN BY SUPERVISOR')`,
      ),
    ).rejects.toThrow(/row-level security/i)
  })
})

describe('the role enum is closed', () => {
  it('has exactly three labels, so a fourth role needs a migration', async () => {
    // The mechanical form of "no role builder, no permission matrix". There is
    // deliberately no role table and no user_permission table.
    const [row] = await sql<{ labels: string[] }[]>`
      SELECT array_agg(e.enumlabel ORDER BY e.enumsortorder)::text[] AS labels
      FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
      JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE t.typname = 'user_role' AND n.nspname = 'app'`

    expect(row?.labels).toEqual(['seller', 'supervisor', 'admin'])
  })
})
