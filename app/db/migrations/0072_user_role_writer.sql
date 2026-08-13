-- ===========================================================================
-- A ROLE CAN BE CHANGED, AND SOMEBODY CAN BE TAKEN OFF THE FLOOR.
--
-- 🔴 WHY THIS IS URGENT NOW RATHER THAN TIDY. `app_user.role` had no writer
-- anywhere: a user's role was whatever the seed gave it, for ever. That was a
-- gap when the role only chose a menu. It is not any more — as of this week
-- `app.scope_is_admin()` gates THREE surfaces that did not exist before:
--
--   · issuing and revoking the ingest credential      (0068)
--   · correcting the public earnings board            (0071)
--   · reading dead letters and admin alerts           (existing)
--
-- So the column that decides who can move money is the one column nothing in
-- the product can write. And 0067 sealed the (tenant, user) pair, which makes
-- the role authoritative rather than advisory — `scope_is_admin()` re-reads it
-- from this table on every check.
--
-- ⚠️ WHAT THIS DELIBERATELY DOES NOT DO: create a user. A signable-in account
-- needs `auth.api.signUpEmail` — a better-auth JavaScript call, not SQL — and
-- with no transactional email in the MVP there is no invitation to send, so an
-- admin would have to set an initial password and pass it on out of band. That
-- is a product decision and it is Jorge's, not one to settle inside a
-- migration. Named here so the absence is visible rather than assumed.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1 · THE ROLE CHANGE
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.app_user_set_role(
  p_user_id uuid,
  p_role    app.user_role,
  p_reason  text
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = app, ref, pg_catalog
AS $fn$
DECLARE
  v_tenant uuid;
  v_actor  uuid;
  v_before app.user_role;
  v_reason text;
  v_admins integer;
BEGIN
  v_tenant := app.current_tenant();
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'UR001: app_user_set_role called outside a tenant session';
  END IF;

  IF NOT app.scope_is_admin() THEN
    RAISE EXCEPTION 'UR002: changing a role is an admin act';
  END IF;

  v_reason := btrim(coalesce(p_reason, ''));
  IF length(v_reason) < 10 THEN
    RAISE EXCEPTION 'UR003: say why the role is changing — this row is the record of it';
  END IF;

  v_actor := app.current_user_id();

  -- 🔴 AN ADMIN CANNOT DEMOTE THEMSELVES, and this is not paternalism. The
  -- check below counts the OTHER admins, so a self-demotion by the only admin
  -- is already refused — but a self-demotion while a second admin exists is
  -- still a foot-gun with no upside: the person clicking is the person who
  -- loses the surface, immediately, with no way back except the other admin
  -- happening to be reachable.
  IF p_user_id = v_actor AND p_role <> 'admin' THEN
    RAISE EXCEPTION 'UR004: an admin cannot take their own admin away — ask another admin';
  END IF;

  SELECT u.role INTO v_before
    FROM app.app_user u
   WHERE u.tenant_id = v_tenant AND u.id = p_user_id;

  -- Not in this tenant, or never existed: one answer for both. A message that
  -- distinguished them would confirm the user exists in another agency.
  IF v_before IS NULL THEN
    RETURN false;
  END IF;

  IF v_before = p_role THEN
    -- Idempotent and honest: nothing changed, so nothing is recorded. An audit
    -- row for a no-op is a row somebody has to explain later.
    RETURN false;
  END IF;

  -- ⚠️ THIS COUNTER IS CURRENTLY UNREACHABLE, AND THE TEST FOUND IT RATHER THAN
  -- THE AUTHOR. Getting here requires the caller to be an admin; an admin who
  -- is not the target IS another live admin, so the count below is at least
  -- one, and an admin who IS the target was already stopped by UR004. So the
  -- protection that actually holds today is the self-guard above, not this.
  --
  -- Kept rather than deleted, because the invariant it states — a tenant always
  -- has one reachable admin — is the real one, and it becomes load-bearing the
  -- moment somebody relaxes UR004. Without that invariant a tenant can reach a
  -- state where NOBODY can issue an ingest credential, correct a wrong number
  -- on the public board, or read a dead letter, and the only remedy is the
  -- provider's SQL console: an outage with a database ticket attached.
  -- `user-role.test.ts` asserts the reachable shape and says this is not it.
  IF v_before = 'admin' AND p_role <> 'admin' THEN
    SELECT count(*) INTO v_admins
      FROM app.app_user u
     WHERE u.tenant_id = v_tenant AND u.role = 'admin'
       AND u.deactivated_at IS NULL AND u.id <> p_user_id;

    IF v_admins = 0 THEN
      RAISE EXCEPTION 'UR005: this is the only admin left — promote somebody else first';
    END IF;
  END IF;

  UPDATE app.app_user
     SET role = p_role
   WHERE tenant_id = v_tenant AND id = p_user_id;

  -- `user.role_assigned` has been in `app.audit_action_list()` since 0053 with
  -- nothing writing it. The BEFORE value is the half that matters: "she is an
  -- admin" is a fact anybody can read today, "she was made one on Tuesday by
  -- him" is the one nobody can reconstruct afterwards.
  PERFORM app.audit_write(
    'user.role_assigned',
    'app_user',
    p_user_id,
    jsonb_build_object('role', v_before::text),
    jsonb_build_object('role', p_role::text),
    v_reason);

  RETURN true;
END;
$fn$;--> statement-breakpoint

REVOKE ALL ON FUNCTION app.app_user_set_role(uuid, app.user_role, text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.app_user_set_role(uuid, app.user_role, text) TO crm_app;--> statement-breakpoint

COMMENT ON FUNCTION app.app_user_set_role(uuid, app.user_role, text) IS
  'Admin-only role change with a mandatory reason. An admin cannot demote themselves (UR004); the last-admin counter UR005 is unreachable today and kept as the stated invariant.';--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2 · TAKING SOMEBODY OFF THE FLOOR
-- ---------------------------------------------------------------------------
-- Deactivation rather than deletion, and the earnings board is the reason: a
-- departed seller's ledger rows stay, `earnings_disposition` already decides
-- whether they stay on the all-time board, and a DELETE would take a public
-- number's provenance with it. Same shape as revoking an ingest credential.
CREATE OR REPLACE FUNCTION app.app_user_set_active(
  p_user_id uuid,
  p_active  boolean,
  p_reason  text
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = app, ref, pg_catalog
AS $fn$
DECLARE
  v_tenant uuid;
  v_actor  uuid;
  v_was    timestamptz;
  v_role   app.user_role;
  v_reason text;
  v_admins integer;
  v_found  boolean := false;
BEGIN
  v_tenant := app.current_tenant();
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'UR006: app_user_set_active called outside a tenant session';
  END IF;

  IF NOT app.scope_is_admin() THEN
    RAISE EXCEPTION 'UR007: deactivating a user is an admin act';
  END IF;

  v_reason := btrim(coalesce(p_reason, ''));
  IF length(v_reason) < 10 THEN
    RAISE EXCEPTION 'UR008: say why — a seller losing access will ask, and so will an auditor';
  END IF;

  v_actor := app.current_user_id();
  IF p_user_id = v_actor AND NOT p_active THEN
    RAISE EXCEPTION 'UR009: an admin cannot lock themselves out — ask another admin';
  END IF;

  SELECT u.deactivated_at, u.role INTO v_was, v_role
    FROM app.app_user u
   WHERE u.tenant_id = v_tenant AND u.id = p_user_id;

  IF v_role IS NULL THEN
    RETURN false;
  END IF;

  IF (v_was IS NULL) = p_active THEN
    RETURN false;                     -- already in the requested state
  END IF;

  -- The same guard as UR005 and unreachable for the same reason, kept for the
  -- same one. `scope_is_admin()` requires `deactivated_at IS NULL`, so
  -- deactivating the last admin locks the tenant out exactly as demoting them
  -- does: one hole, two doors, and UR009 is what actually closes both today.
  IF NOT p_active AND v_role = 'admin' THEN
    SELECT count(*) INTO v_admins
      FROM app.app_user u
     WHERE u.tenant_id = v_tenant AND u.role = 'admin'
       AND u.deactivated_at IS NULL AND u.id <> p_user_id;

    IF v_admins = 0 THEN
      RAISE EXCEPTION 'UR010: this is the only admin left — promote somebody else first';
    END IF;
  END IF;

  UPDATE app.app_user
     SET deactivated_at = CASE WHEN p_active THEN NULL ELSE clock_timestamp() END
   WHERE tenant_id = v_tenant AND id = p_user_id;
  v_found := true;

  PERFORM app.audit_write(
    CASE WHEN p_active THEN 'user.role_assigned' ELSE 'user.access_revoked' END,
    'app_user',
    p_user_id,
    jsonb_build_object('active', v_was IS NULL),
    jsonb_build_object('active', p_active),
    v_reason);

  RETURN v_found;
END;
$fn$;--> statement-breakpoint

REVOKE ALL ON FUNCTION app.app_user_set_active(uuid, boolean, text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.app_user_set_active(uuid, boolean, text) TO crm_app;--> statement-breakpoint

COMMENT ON FUNCTION app.app_user_set_active(uuid, boolean, text) IS
  'Admin-only deactivate/reactivate with a mandatory reason. An admin cannot lock themselves out (UR009); the last-admin counter UR010 is unreachable today and kept as the stated invariant.';--> statement-breakpoint

-- No `security.harden()`: no relation created, no registry row changed. Both
-- functions reach `app.app_user` as the OWNER, the same shape every other
-- definer in this tree uses.
SELECT security.own_to_migrator();
