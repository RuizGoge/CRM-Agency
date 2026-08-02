-- Session context, the timezone guard, the registry rows, and the first
-- hardening run.
--
-- This is the migration where the silo becomes real: after it, every relation
-- in `app` carries FORCE RLS and two generated FOR ALL policies, and crm_app
-- holds DELETE on nothing.

-- ---------------------------------------------------------------------------
-- 1 · Session context
-- ---------------------------------------------------------------------------
-- Three GUCs, always set with set_config(key, value, true) — the third
-- argument is is_local, which scopes the setting to the current transaction
-- and resets it at COMMIT or ROLLBACK. That invariant is what makes PgBouncer
-- in TRANSACTION mode safe, and it is the entire reason session mode is
-- forbidden: a session-mode pooler reuses a server connection across clients,
-- so app.user_id set by seller A survives and is inherited by seller B. The
-- pages render perfectly, just with the wrong rows.
--
-- Every one of these returns NULL when the GUC is unset, never an error.
-- `tenant_id = NULL` is NULL, so the policy denies and a query that escapes
-- the wrapper returns ZERO ROWS rather than blowing up — in all five
-- execution contexts (request, job, webhook consumer, importer, export).

CREATE OR REPLACE FUNCTION app.current_tenant()
RETURNS uuid LANGUAGE sql STABLE AS $fn$
  SELECT nullif(current_setting('app.tenant_id', true), '')::uuid
$fn$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.current_user_id()
RETURNS uuid LANGUAGE sql STABLE AS $fn$
  SELECT nullif(current_setting('app.user_id', true), '')::uuid
$fn$;
--> statement-breakpoint

-- The EXISTS is the point: these re-verify the role AGAINST THE DATABASE
-- instead of trusting the GUC, so a seller session cannot produce
-- scope_mode = tenant_read even if something upstream sets it. Cost is one
-- index probe on a 50-row table that lives permanently in shared buffers.
--
-- CRITICAL: app_user is classified `tenant_scoped`, whose generated USING
-- clause is `tenant_id = app.current_tenant()` and does NOT call
-- app.scope_is_global(). If it did, this EXISTS would re-enter the policy and
-- Postgres would raise "infinite recursion detected in policy for relation
-- app_user". That is a real trap, and it is why app_user is the one
-- owner-bearing table that is deliberately tenant-readable.

CREATE OR REPLACE FUNCTION app.scope_is_global()
RETURNS boolean LANGUAGE sql STABLE AS $fn$
  SELECT current_setting('app.scope_mode', true) IN ('tenant_read', 'tenant_admin')
     AND EXISTS (
       SELECT 1 FROM app.app_user u
        WHERE u.tenant_id = app.current_tenant()
          AND u.id        = app.current_user_id()
          AND u.role IN ('supervisor', 'admin')
          AND u.deactivated_at IS NULL
     )
$fn$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.scope_is_admin()
RETURNS boolean LANGUAGE sql STABLE AS $fn$
  SELECT current_setting('app.scope_mode', true) = 'tenant_admin'
     AND EXISTS (
       SELECT 1 FROM app.app_user u
        WHERE u.tenant_id = app.current_tenant()
          AND u.id        = app.current_user_id()
          AND u.role      = 'admin'
          AND u.deactivated_at IS NULL
     )
$fn$;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION app.current_tenant()   TO crm_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.current_user_id()  TO crm_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.scope_is_global()  TO crm_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.scope_is_admin()   TO crm_app;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2 · business_tz is validated by trigger, not by CHECK
-- ---------------------------------------------------------------------------
-- CHECK (business_tz IN (SELECT name FROM pg_timezone_names)) is not possible:
-- a CHECK constraint must be immutable and that subquery is not. A bad zone
-- here silently mis-stamps every period_key in the tenant, which is a wrong
-- number on a public board with no error anywhere.
CREATE OR REPLACE FUNCTION app.validate_business_tz()
RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = NEW.business_tz) THEN
    RAISE EXCEPTION 'TZ001: business_tz "%" is not a recognised IANA time zone', NEW.business_tz
      USING HINT = 'This value stamps every period_key in the tenant and nothing else.';
  END IF;
  RETURN NEW;
END
$fn$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS t_validate_business_tz ON app.tenant;
--> statement-breakpoint
CREATE TRIGGER t_validate_business_tz
  BEFORE INSERT OR UPDATE OF business_tz ON app.tenant
  FOR EACH ROW EXECUTE FUNCTION app.validate_business_tz();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3 · Registry rows — without these, harden() refuses to run
-- ---------------------------------------------------------------------------
INSERT INTO security.table_registry
  (schema_name, table_name, policy_class, owner_column, immutable, app_can_insert, exception_reason, registered_in_migration)
VALUES
  -- Reading your own tenant row happens on every request (it carries the
  -- flags). Writing requires the admin scope. Tenants themselves are created
  -- out of band by the migrator, never by the application role.
  ('app', 'tenant',   'tenant_scoped', NULL, false, false, NULL, '0002_context_and_harden'),

  -- Deliberate, documented widening: read is tenant-wide because the
  -- leaderboard legitimately carries display names and avatars tenant-wide
  -- (ARR-EVT-23), supervisors need the seller list, and owner labels must
  -- render. See the recursion note in section 1.
  ('app', 'app_user', 'tenant_scoped', NULL, false, true,  NULL, '0002_context_and_harden')
ON CONFLICT (schema_name, table_name) DO UPDATE
  SET policy_class            = EXCLUDED.policy_class,
      owner_column            = EXCLUDED.owner_column,
      immutable               = EXCLUDED.immutable,
      app_can_insert          = EXCLUDED.app_can_insert,
      exception_reason        = EXCLUDED.exception_reason,
      registered_in_migration = EXCLUDED.registered_in_migration;
--> statement-breakpoint

-- The drizzle journal table lives in its own schema, already exempt.
-- Nothing else may exist unclassified: the next statement proves it.

-- ---------------------------------------------------------------------------
-- 4 · Harden. Always last.
-- ---------------------------------------------------------------------------
SELECT security.harden();
