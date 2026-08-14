-- ===========================================================================
-- THE TENANT STOPS BEING A BARE CLAIM. R1, and the half 0067 left open.
--
-- 🔴 REPRODUCED BEFORE BEING CLOSED, as `crm_app`, inside one real transaction:
--
--   SELECT app.begin_request(<demo tenant>, <a real seller>);
--   SELECT count(*) FROM app.app_user;                       -->  6
--   SELECT set_config('app.tenant_id', <other tenant>, true);
--   SELECT count(*) FROM app.app_user;                       -->  1
--   SELECT email, full_name FROM app.app_user;
--     --> perf500@perf.test / Perf Fivehundred
--
-- Another agency's roster, read by the application role, by setting ONE GUC.
--
-- 🎯 AND 0067 IS WHY IT WAS ONLY HALF OPEN — the same run reported
-- `current_user_id is NULL`. The identity seal did its job: every OWNER-scoped
-- policy closed, because a forged tenant breaks the (tenant, user) seal and a
-- NULL owner matches no row. What stayed open is every class that scopes by
-- `app.current_tenant()` ALONE, and there are ten such tables:
--
--   tenant_scoped       app_user, tenant, lost_reason, break_glass_override
--   tenant_scoped_read  aloware_number_mapping, inbound_webhook_event,
--                       leaderboard_projection, raw_payload_vault
--   tenant_admin_only   admin_alert, dead_letter
--
-- So the reachable damage was: another agency's ROSTER, their EARNINGS TOTALS,
-- their sellers' PHONE NUMBERS, and `raw_payload_vault` — the raw provider
-- bodies, which E9 describes as carrying recording URLs that 302 to pre-signed
-- audio. The two `tenant_admin_only` tables also need `scope_is_admin()`, which
-- rests on the sealed `current_user_id()`, so those were already closed.
--
-- ⚠️ THE COST IS THE WHOLE RISK OF THIS MIGRATION, and 0067 already paid it
-- once. `app.current_tenant()` is called by EVERY RLS policy in the schema.
-- Making it a SECURITY DEFINER makes it un-inlinable, and 0067 measured that
-- nesting definers took N13 from 84 ms to 121.7 ms against a 120 ms budget.
-- This adds a SECOND un-inlinable call with a heap read to every statement.
-- N13 is measured before and after in the same session and the number is in
-- CONTEXT.md; a budget is not something this project weakens to land a change.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1 · THE TENANT SEAL
-- ---------------------------------------------------------------------------
-- Granted to nobody, like `app.identity_seal`. Only the two doors below reach
-- it, running as the owner, so `crm_app` cannot produce a value that satisfies
-- the verification for any tenant — including its own.
--
-- 🔴 THE `:T:` SEPARATOR IS A DOMAIN TAG, NOT DECORATION. The identity seal is
-- `secret : tenant : user`; this one is `secret :T: tenant`. Without a distinct
-- domain the two hashes live in the same space, and a value minted for one
-- purpose becomes usable for the other the day somebody adds a third seal with
-- a shape that happens to collide. Separating them costs two characters.
CREATE OR REPLACE FUNCTION app.tenant_seal(p_tenant_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = app, security, pg_catalog
AS $fn$
  SELECT md5(s.secret || ':T:' || p_tenant_id::text)
    FROM security.identity_secret s
$fn$;--> statement-breakpoint

REVOKE ALL ON FUNCTION app.tenant_seal(uuid) FROM PUBLIC;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2 · THE VERIFICATION
-- ---------------------------------------------------------------------------
-- 🔴 NOW THE SECOND-HIGHEST-BLAST-RADIUS FUNCTION IN THE TREE, and after this
-- migration it is arguably the first: every tenant-scoped policy calls it, and
-- so does every definer that establishes its own tenant. It stays STABLE and
-- zero-argument so the planner folds it once per statement rather than per row.
--
-- AN UNSEALED CLAIM IS AN ABSENCE, NOT AN ERROR — the same direction 0067 chose
-- and for the same reason. NULL makes `tenant_id = app.current_tenant()` false
-- for every row, so a forged tenant sees NOTHING. A raise would be louder and
-- would turn a forged GUC into a denial of service on the whole request.
--
-- ⚠️ THE SEAL IS RECOMPUTED HERE RATHER THAN BY CALLING `app.tenant_seal`, and
-- that is 0067's measurement applied rather than repeated: a definer inside a
-- definer can never be inlined, so every statement would pay two un-inlinable
-- calls plus a heap read. `app.tenant_seal` stays because the two minting sites
-- need it; this is the read path and it is hotter than both combined.
CREATE OR REPLACE FUNCTION app.current_tenant()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = app, security, pg_catalog
AS $fn$
  SELECT c.tenant
    FROM (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid AS tenant,
                 nullif(current_setting('app.tenant_seal', true), '')     AS seal) c
   WHERE c.tenant IS NOT NULL
     AND c.seal IS NOT NULL
     AND c.seal = (SELECT md5(s.secret || ':T:' || c.tenant::text)
                     FROM security.identity_secret s)
$fn$;--> statement-breakpoint

REVOKE ALL ON FUNCTION app.current_tenant() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.current_tenant() TO crm_app;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3 · THE TWO DOORS, WHICH ARE THE ONLY PLACES A TENANT ENTERS
-- ---------------------------------------------------------------------------
-- Verified by grep before this was written: `set_config('app.tenant_id', …)`
-- appears in exactly these two function bodies and nowhere else in `app/`,
-- `scripts/` or the migrations. Every other occurrence in the tree is a test
-- performing the forgery on purpose.
CREATE OR REPLACE FUNCTION app.begin_request(p_tenant_id uuid, p_user_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = app, pg_catalog
AS $fn$
DECLARE
  v_role  app.user_role;
  v_scope text;
  v_stale text;
BEGIN
  -- 1 · The pooled-context leak detector. Unchanged from 0003.
  v_stale := nullif(current_setting('app.tenant_id', true), '');
  IF v_stale IS NOT NULL THEN
    RAISE EXCEPTION
      'CTX001: session context was already set (tenant %) when this unit of work began', v_stale
      USING HINT = 'A bare SET leaked across a transaction, or the pooler is in session mode. '
                   'Transaction mode plus set_config(..., true) is the only supported configuration.';
  END IF;

  -- 2 · Identity is verified, never asserted. Unchanged from 0003.
  SELECT u.role INTO v_role
  FROM app.app_user u
  WHERE u.tenant_id = p_tenant_id
    AND u.id = p_user_id
    AND u.deactivated_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'CTX002: no active user for the supplied session'
      USING HINT = 'A deactivated seller must not be able to open a unit of work.';
  END IF;

  -- 3 · Scope is DERIVED from the role. It is never an input. Unchanged.
  v_scope := CASE v_role
               WHEN 'seller'     THEN 'owner'
               WHEN 'supervisor' THEN 'tenant_read'
               WHEN 'admin'      THEN 'tenant_admin'
             END;

  PERFORM set_config('app.tenant_id',  p_tenant_id::text, true);
  PERFORM set_config('app.user_id',    p_user_id::text,   true);
  PERFORM set_config('app.scope_mode', v_scope,           true);

  -- 0067's line: the ANSWER to "who is this" is unforgeable.
  PERFORM set_config('app.identity_seal',
                     app.identity_seal(p_tenant_id, p_user_id), true);

  -- 🔴 0074's line: so is the answer to "which agency". Without it, the three
  -- set_config calls above remain three statements `crm_app` can issue for
  -- itself, and the ten tenant-scoped tables follow whichever id it names.
  PERFORM set_config('app.tenant_seal', app.tenant_seal(p_tenant_id), true);

  RETURN v_scope;
END;
$fn$;--> statement-breakpoint

-- `app.begin_system_work` — the worker's door. It sets no user and mints no
-- IDENTITY seal, but it very much has a tenant, so it must mint a TENANT one:
-- without it every job would read `current_tenant()` as NULL and the entire
-- worker would go silently blind. That failure would be fail-closed and
-- catastrophic in a quiet way, which is why it is called out rather than left
-- to be discovered.
CREATE OR REPLACE FUNCTION app.begin_system_work(p_tenant_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = app, pg_catalog
AS $fn$
DECLARE
  v_stale text;
BEGIN
  v_stale := nullif(current_setting('app.tenant_id', true), '');
  IF v_stale IS NOT NULL THEN
    RAISE EXCEPTION
      'CTX001: session context was already set (tenant %) when this unit of work began', v_stale
      USING HINT = 'A bare SET leaked across a transaction, or the pooler is in session mode.';
  END IF;

  PERFORM set_config('app.tenant_id',      p_tenant_id::text, true);
  PERFORM set_config('app.user_id',        '',                true);
  PERFORM set_config('app.scope_mode',     'system',          true);
  PERFORM set_config('app.identity_seal',  '',                true);
  PERFORM set_config('app.tenant_seal',    app.tenant_seal(p_tenant_id), true);

  RETURN 'system';
END;
$fn$;--> statement-breakpoint

SELECT security.own_to_migrator();
