-- app.begin_request() — the first statement of every unit of work.
--
-- Why this is a database function and not TypeScript: the application must not
-- be able to choose its own scope. If `scope_mode` were an argument, then every
-- route, job and webhook consumer would be one wrong literal away from granting
-- itself tenant-wide read, and nothing would go red. Here the caller supplies
-- only WHO it is; the engine reads app_user.role and decides WHAT that means.
--
-- The caller cannot pass a scope. There is no parameter for it.

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
  -- ---------------------------------------------------------------------
  -- 1 · The pooled-context leak detector
  -- ---------------------------------------------------------------------
  -- Every unit of work sets its GUCs with set_config(..., is_local => true),
  -- which resets them at COMMIT and at ROLLBACK. So finding context already
  -- set at the start of a unit of work means exactly one of two things: a bare
  -- SET was used somewhere (session-scoped, survives the transaction), or a
  -- session-mode pooler handed us a connection still carrying another
  -- seller's identity.
  --
  -- Both are the same catastrophe: pages render perfectly, with the wrong
  -- rows, for a person who is not entitled to them. This raises on the FIRST
  -- leaked request instead.
  v_stale := nullif(current_setting('app.tenant_id', true), '');
  IF v_stale IS NOT NULL THEN
    RAISE EXCEPTION
      'CTX001: session context was already set (tenant %) when this unit of work began', v_stale
      USING HINT = 'A bare SET leaked across a transaction, or the pooler is in session mode. '
                   'Transaction mode plus set_config(..., true) is the only supported configuration.';
  END IF;

  -- ---------------------------------------------------------------------
  -- 2 · Identity is verified, never asserted
  -- ---------------------------------------------------------------------
  SELECT u.role INTO v_role
  FROM app.app_user u
  WHERE u.tenant_id = p_tenant_id
    AND u.id = p_user_id
    AND u.deactivated_at IS NULL;

  IF NOT FOUND THEN
    -- Deliberately says nothing about which half was wrong, and nothing about
    -- whether the tenant or the user exists.
    RAISE EXCEPTION 'CTX002: no active user for the supplied session'
      USING HINT = 'A deactivated seller must not be able to open a unit of work.';
  END IF;

  -- ---------------------------------------------------------------------
  -- 3 · Scope is DERIVED from the role. It is never an input.
  -- ---------------------------------------------------------------------
  v_scope := CASE v_role
               WHEN 'seller'     THEN 'owner'
               WHEN 'supervisor' THEN 'tenant_read'
               WHEN 'admin'      THEN 'tenant_admin'
             END;

  IF v_scope IS NULL THEN
    -- Unreachable while user_role has three labels; here so that adding a
    -- fourth without deciding its scope fails loudly instead of defaulting.
    RAISE EXCEPTION 'CTX003: role % has no scope mapping', v_role;
  END IF;

  PERFORM set_config('app.tenant_id',  p_tenant_id::text, true);
  PERFORM set_config('app.user_id',    p_user_id::text,   true);
  PERFORM set_config('app.scope_mode', v_scope,           true);

  RETURN v_scope;
END
$fn$;
--> statement-breakpoint

-- SECURITY DEFINER runs as the owner, so it sees app_user through p_sys. The
-- application role may call it and may not read it.
REVOKE ALL ON FUNCTION app.begin_request(uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.begin_request(uuid, uuid) TO crm_app;
--> statement-breakpoint

-- The system scope, for the four enumerated cross-tenant paths (outbox relay,
-- scheduled-job dispatch, intake token resolution, purge). It carries no user
-- and cannot be reached from a request: `withTenant` has no way to ask for it.
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
      'CTX001: session context was already set (tenant %) when this unit of work began', v_stale;
  END IF;

  PERFORM set_config('app.tenant_id',  p_tenant_id::text, true);
  PERFORM set_config('app.user_id',    '',                true);
  PERFORM set_config('app.scope_mode', 'system',          true);

  RETURN 'system';
END
$fn$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION app.begin_system_work(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.begin_system_work(uuid) TO crm_app;
--> statement-breakpoint

SELECT security.harden();
