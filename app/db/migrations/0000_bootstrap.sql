-- Bootstrap: roles, extensions, and the keystone of the isolation design.
--
-- Nothing here is application schema. This migration creates the machinery
-- that GENERATES isolation, so that no policy is ever authored by hand. The
-- public RLS corpus is full of USING-only examples, which is what a model
-- writes by inertia — this design removes the place to write one.
--
-- Deliberate deviation from 05b §938: `policy_class` lives in schema
-- `security`, not `app`. It is registry metadata crm_app can never read, and
-- putting it here removes a bootstrap ordering hazard (the `app` schema is
-- created by Drizzle in 0001). No behavioural consequence.

-- ---------------------------------------------------------------------------
-- 1 · Extensions
-- ---------------------------------------------------------------------------
-- Verified available on PostgreSQL 18 by Sprint-0 gate G1e, together with the
-- fact that btree_gin ships a GIN opclass for uuid — which is what lets the
-- ownership predicate live INSIDE the search index instead of after retrieval.
CREATE EXTENSION IF NOT EXISTS citext;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS btree_gin;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2 · Roles
-- ---------------------------------------------------------------------------
-- The separation between these two is what makes FORCE meaningful.
--   crm_migrator — OWNS the schema. Used by exactly one thing: the one-shot
--                  pre-deploy migration job. Never by a long-running process.
--   crm_app      — the connection identity of web, worker and ingest. NOT the
--                  owner of anything. NOINHERIT. Subject to RLS twice over:
--                  once because it is not the owner, once because FORCE.
DO $bootstrap$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crm_migrator') THEN
    CREATE ROLE crm_migrator NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crm_app') THEN
    CREATE ROLE crm_app NOLOGIN NOINHERIT;
  END IF;
END
$bootstrap$;
--> statement-breakpoint

-- A transaction orphaned mid-close-gate holds locks on the opportunity row AND
-- on the leaderboard watermark, blocking every subsequent close in the tenant.
ALTER ROLE crm_app SET idle_in_transaction_session_timeout = '15s';
--> statement-breakpoint
ALTER ROLE crm_migrator SET idle_in_transaction_session_timeout = '5min';
--> statement-breakpoint

CREATE SCHEMA IF NOT EXISTS security;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3 · The registry: every relation is classified, or the deploy fails
-- ---------------------------------------------------------------------------
DO $bootstrap$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'policy_class' AND n.nspname = 'security'
  ) THEN
    CREATE TYPE security.policy_class AS ENUM (
      'owner_scoped',        -- a seller's own rows; supervisors may read
      'tenant_scoped',       -- readable tenant-wide, writable by admin only
      'tenant_admin_only',   -- admin reads and writes; invisible to sellers
      'append_only_owner',   -- owner_scoped, plus immutable by engine
      'append_only_tenant',  -- tenant_scoped, plus immutable by engine
      'definer_only',        -- unreachable by crm_app except through definers
      'system_cross_tenant', -- one of the four enumerated cross-tenant paths
      'reference'            -- no tenant dimension; requires a written reason
    );
  END IF;
END
$bootstrap$;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS security.table_registry (
  schema_name             text NOT NULL,
  table_name              text NOT NULL,
  policy_class            security.policy_class NOT NULL,
  owner_column            text,
  immutable               boolean NOT NULL DEFAULT false,
  app_can_insert          boolean NOT NULL DEFAULT true,
  exception_reason        text,
  registered_in_migration text NOT NULL,
  PRIMARY KEY (schema_name, table_name),
  -- A table can only be exempted from tenancy with a written reason.
  CONSTRAINT reference_needs_reason
    CHECK (policy_class <> 'reference' OR exception_reason IS NOT NULL),
  CONSTRAINT owner_scoped_needs_owner_column
    CHECK (policy_class NOT IN ('owner_scoped', 'append_only_owner')
           OR owner_column IS NOT NULL)
);
--> statement-breakpoint

-- The versioned schema exception list. harden() raises on any relation in any
-- schema that is neither managed nor listed here — which closes the "someone
-- creates a table in public" hole rather than assuming nobody will.
CREATE TABLE IF NOT EXISTS security.schema_policy (
  schema_name      text PRIMARY KEY,
  posture          text NOT NULL CHECK (posture IN ('managed', 'exempt')),
  exception_reason text,
  CONSTRAINT exempt_needs_reason
    CHECK (posture <> 'exempt' OR exception_reason IS NOT NULL)
);
--> statement-breakpoint

INSERT INTO security.schema_policy (schema_name, posture, exception_reason) VALUES
  ('app',      'managed', NULL),
  ('ref',      'managed', NULL),
  ('security', 'exempt',  'Defines RLS. Readable only by crm_migrator; crm_app has no grants on this schema at all.'),
  ('drizzle',  'exempt',  'Migration journal owned by the migrator. Never reachable from the application role.'),
  ('public',   'managed', NULL)
ON CONFLICT (schema_name) DO NOTHING;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4 · The single catalog scan
-- ---------------------------------------------------------------------------
-- Schema gate S21 asserts harden() contains no pg_class scan other than
-- through this function. A future loop that re-hardcodes a schema list fails
-- the pre-merge tier. `public` is 'managed', not exempt, so a table created
-- there has no registry row and breaks the deploy — which is the point.
CREATE OR REPLACE FUNCTION security.managed_relations()
RETURNS TABLE (schema_name text, table_name text, relkind "char")
LANGUAGE sql STABLE AS $fn$
  SELECT n.nspname::text, c.relname::text, c.relkind
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN security.schema_policy sp ON sp.schema_name = n.nspname
  WHERE c.relkind IN ('r', 'p')          -- ordinary and partitioned tables
    AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
    AND n.nspname NOT LIKE 'pg_temp%'
    AND n.nspname NOT LIKE 'pg_toast_temp%'
    AND coalesce(sp.posture, 'managed') = 'managed'
$fn$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION security.refuse_mutation()
RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION
    'IM001: % is append-only. Corrections are compensating appends, never edits.',
    TG_TABLE_NAME
    USING HINT = 'There is no recompute job by design. Use the admin void/adjust surface.';
END
$fn$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 5 · harden() — policies are GENERATED, never authored
-- ---------------------------------------------------------------------------
-- The LAST statement of the one-shot pre-deploy migration job, not a line in
-- each migration file. Idempotent. Raises on any unclassified relation, so a
-- migration that creates a table without classifying it FAILS THE DEPLOY. That
-- is stronger than a CI check, because CI can be amended and a deploy that
-- will not proceed cannot.
--
-- FOR ALL is the only permitted policy form. Postgres makes a WITH CHECK on
-- FOR SELECT a syntax error, so a gate demanding both clauses is unsatisfiable
-- for per-command policies — and an unsatisfiable gate gets "fixed" by being
-- weakened. Every table therefore gets exactly two FOR ALL policies, both with
-- a non-null qual AND a non-null with_check.
CREATE OR REPLACE FUNCTION security.harden()
RETURNS void
LANGUAGE plpgsql AS $fn$
DECLARE
  r           record;
  reg         security.table_registry%ROWTYPE;
  qual        text;
  with_check  text;
  ident       text;
  trg         text;
  tenant_pred constant text := 'tenant_id = app.current_tenant()';
BEGIN
  FOR r IN SELECT * FROM security.managed_relations() LOOP
    ident := format('%I.%I', r.schema_name, r.table_name);
    trg   := left('t_immutable_' || r.table_name, 63);

    SELECT * INTO reg FROM security.table_registry tr
     WHERE tr.schema_name = r.schema_name AND tr.table_name = r.table_name;

    IF NOT FOUND THEN
      RAISE EXCEPTION
        'HR001: relation % has no security.table_registry row. Classify it in the migration that creates it.',
        ident
        USING HINT = 'Every relation is classified or the deploy fails. This is the keystone, not a formality.';
    END IF;

    -- Build both clauses from the classification. There is no branch that
    -- leaves with_check permissive.
    CASE reg.policy_class
      WHEN 'owner_scoped', 'append_only_owner' THEN
        qual := format('%s AND (%I = app.current_user_id() OR app.scope_is_global())',
                       tenant_pred, reg.owner_column);
        with_check := format('%s AND %I = app.current_user_id()',
                             tenant_pred, reg.owner_column);

      WHEN 'tenant_scoped', 'append_only_tenant' THEN
        -- Read is tenant-wide on purpose: the leaderboard legitimately carries
        -- display names tenant-wide and owner labels must render. Writing
        -- requires the admin scope, re-verified against app_user rather than
        -- trusted from the GUC.
        qual := tenant_pred;
        with_check := format('%s AND app.scope_is_admin()', tenant_pred);

      WHEN 'tenant_admin_only' THEN
        qual := format('%s AND app.scope_is_admin()', tenant_pred);
        with_check := format('%s AND app.scope_is_admin()', tenant_pred);

      WHEN 'definer_only', 'system_cross_tenant' THEN
        -- Reachable only through SECURITY DEFINER functions that return
        -- booleans and reason codes, never rows.
        qual := 'false';
        with_check := 'false';

      WHEN 'reference' THEN
        qual := 'true';
        with_check := 'false';

      ELSE
        RAISE EXCEPTION 'HR002: policy_class % has no generator', reg.policy_class;
    END CASE;

    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', ident);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', ident);

    EXECUTE format('DROP POLICY IF EXISTS p_app ON %s', ident);
    EXECUTE format('CREATE POLICY p_app ON %s FOR ALL TO crm_app USING (%s) WITH CHECK (%s)',
                   ident, qual, with_check);

    EXECUTE format('DROP POLICY IF EXISTS p_sys ON %s', ident);
    EXECUTE format('CREATE POLICY p_sys ON %s FOR ALL TO crm_migrator USING (true) WITH CHECK (true)',
                   ident);

    -- Grants. crm_app never holds DELETE on anything, anywhere: soft delete is
    -- the only delete this product has.
    EXECUTE format('REVOKE ALL ON %s FROM crm_app', ident);
    EXECUTE format('GRANT SELECT ON %s TO crm_app', ident);

    IF reg.app_can_insert
       AND reg.policy_class NOT IN ('definer_only', 'system_cross_tenant', 'reference') THEN
      EXECUTE format('GRANT INSERT ON %s TO crm_app', ident);
    END IF;

    IF NOT reg.immutable
       AND reg.policy_class NOT IN ('definer_only', 'system_cross_tenant', 'reference') THEN
      EXECUTE format('GRANT UPDATE ON %s TO crm_app', ident);
    END IF;

    -- Immutability is a trigger AND a revoked privilege, because the trigger
    -- also binds the provider's SQL console, where a REVOKE on crm_app does
    -- nothing at all.
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %s', trg, ident);
    IF reg.immutable THEN
      EXECUTE format(
        'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %s FOR EACH ROW EXECUTE FUNCTION security.refuse_mutation()',
        trg, ident);
    END IF;
  END LOOP;

  -- Nothing of ours lives in public, and crm_app cannot create anything there.
  EXECUTE 'REVOKE ALL ON SCHEMA public FROM crm_app';
  EXECUTE 'REVOKE ALL ON SCHEMA security FROM crm_app';
  EXECUTE 'GRANT USAGE ON SCHEMA app TO crm_app';
  EXECUTE 'GRANT USAGE ON SCHEMA ref TO crm_app';
END
$fn$;
