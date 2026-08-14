-- ===========================================================================
-- THE PRODUCT CAN FINALLY PUT SOMEBODY ON THE FLOOR.
--
-- 🔴 THE LAST OF THE FOUR MISSING WRITERS. 0065 gave the product a way to start
-- a deal, 0066 a way to write a note, 0072 a way to change a role — and none of
-- them mattered for a person who could not exist. `app.app_user` had no creator:
-- every user in this database was put there by the seed.
--
-- 🎯 AND IT BECAME BUILDABLE BECAUSE OF ADR-085, WHICH CHANGED WHAT A ROW MEANS.
-- Until Jorge's ruling of 2026-08-13 a user could not be created without a
-- password to hand over, because a row with no way to sign in was useless. With
-- Google sign-in coming, the row IS the thing: it records WHO MAY ENTER, and
-- Google later proves the person is who they claim. So this creates a row with
-- `auth_user_id` deliberately NULL — a seat reserved, waiting to be claimed.
--
-- ✅ `auth_user_id` IS ALREADY NULLABLE, checked against the engine rather than
-- assumed. ADR-085 listed making it nullable as work to do; it was wrong, and
-- the ADR is corrected in the same commit. One migration less.
--
-- ⚠️ WHAT A ROW WITH A NULL `auth_user_id` CAN AND CANNOT DO TODAY. It appears
-- on the team screen and can be given a role or deactivated. It CANNOT sign in:
-- `app.resolve_identity` matches on `auth_user_id`, so a NULL matches nothing
-- and no session ever resolves to it. That is the correct state between "the
-- admin recorded them" and "they arrived" — and until Google login exists, it is
-- also a dead end. Said plainly on the screen rather than left to be discovered.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1 · THE VOCABULARY
-- ---------------------------------------------------------------------------
-- Recording that somebody was given a seat is an audit act with a different
-- reader from the roster: the roster says who is here now, the audit says who
-- added them and when. `user.created` collides with no event name, live or
-- ghost — checked against `contracts/events/catalog.json` before being written,
-- and `audit-vocabulary.test.ts` asserts it in both directions from now on.
CREATE OR REPLACE FUNCTION app.audit_action_list()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
AS $fn$
  SELECT ARRAY[
    -- Ratified by name in the corpus.
    'user.credential_reset',
    'vault.body_viewed',
    'tenant.business_tz_changed',
    'book.viewed',
    'ownership.transferred',
    -- Derived from US-9.13's categories.
    'compliance.gate_checked',
    'compliance.break_glass_engaged',
    'compliance.break_glass_ended',
    'consent.ledger_appended',
    'suppression.ledger_appended',
    'data.exported',
    'ledger.adjusted',
    'stage.config_changed',
    'user.role_assigned',
    'user.access_revoked',
    'close.gate_refused',
    -- 0068. The ingest credential.
    'integration.credential_issued',
    'integration.credential_revoked',
    -- 0073. A seat reserved for somebody who has not arrived yet.
    'user.created'
  ]
$fn$;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2 · THE CREATE
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.app_user_create(
  p_email        text,
  p_full_name    text,
  p_display_name text,
  p_role         app.user_role
)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = app, ref, pg_catalog
AS $fn$
DECLARE
  v_tenant  uuid;
  v_actor   uuid;
  v_email   text;
  v_full    text;
  v_display text;
  v_id      uuid;
BEGIN
  v_tenant := app.current_tenant();
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'UC001: app_user_create called outside a tenant session';
  END IF;

  -- 🔴 ADMIN, CHECKED HERE. A definer switches RLS off inside its own body, so
  -- without this line any seller session reaching the function could put a new
  -- person — at any role, including admin — into her own agency. That is the
  -- same hole as `ledger_adjust` and `app_user_set_role`, through a third door.
  IF NOT app.scope_is_admin() THEN
    RAISE EXCEPTION 'UC002: adding somebody to the team is an admin act';
  END IF;

  v_email := lower(btrim(coalesce(p_email, '')));
  -- Deliberately a shape check and not a validity claim. An address that parses
  -- may still be nobody's; what this refuses is the empty box and the obvious
  -- typo, and the real proof of the address is Google asserting it at sign-in.
  IF v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' THEN
    RAISE EXCEPTION 'UC003: % does not look like an email address', v_email;
  END IF;

  v_full    := btrim(coalesce(p_full_name, ''));
  v_display := btrim(coalesce(p_display_name, ''));
  IF v_full = '' THEN
    RAISE EXCEPTION 'UC004: a person needs a name';
  END IF;
  -- The display name is what fifty people read on the public board. Defaulting
  -- it to the full name is friendlier than refusing, and an admin who wants
  -- "Renata O." can type it.
  IF v_display = '' THEN
    v_display := v_full;
  END IF;

  -- 🔴 THE COLLISION IS CAUGHT BY THE INDEX, NOT BY A LOOK-FIRST QUERY.
  -- `app_user_email_uidx` is UNIQUE on (tenant_id, email), and a
  -- check-then-insert loses that race under concurrency: two admins adding the
  -- same new hire at once both pass the check. Catching the violation is the
  -- only version that cannot double-add — the same argument `quick-add` makes
  -- for a duplicate contact.
  v_actor := app.current_user_id();

  BEGIN
    INSERT INTO app.app_user
      (tenant_id, email, full_name, display_name, role, auth_user_id)
    VALUES
      -- `auth_user_id` NULL ON PURPOSE: the seat is reserved and unclaimed.
      -- `app.resolve_identity` matches on this column, so a NULL matches no
      -- session and this row cannot sign in until Google links it (ADR-085).
      (v_tenant, v_email, v_full, v_display, p_role, NULL)
    RETURNING id INTO v_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'UC005: % is already on this team', v_email;
  END;

  PERFORM app.audit_write(
    'user.created',
    'app_user',
    v_id,
    NULL,
    jsonb_build_object('email', v_email, 'role', p_role::text, 'display_name', v_display),
    NULL);

  RETURN v_id;
END;
$fn$;--> statement-breakpoint

REVOKE ALL ON FUNCTION app.app_user_create(text, text, text, app.user_role) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.app_user_create(text, text, text, app.user_role) TO crm_app;--> statement-breakpoint

COMMENT ON FUNCTION app.app_user_create(text, text, text, app.user_role) IS
  'Admin-only. Reserves a seat: creates an app_user row with auth_user_id NULL, which cannot sign in until Google links it (ADR-085).';--> statement-breakpoint

SELECT security.own_to_migrator();
