-- The bridge from an authenticated login to a tenant membership.

-- ---------------------------------------------------------------------------
-- 1 · `auth` joins the versioned exception list, with its reason
-- ---------------------------------------------------------------------------
-- These tables have no tenant dimension and cannot carry the policies harden()
-- generates: a login identity exists before any tenant context does. RLS
-- cannot secure them either, because at the moment a session is validated
-- there IS no session context to scope by. That chicken-and-egg is named here
-- rather than papered over, and the residual — crm_app can read password
-- hashes and session tokens — is declared in app/db/auth-client.ts.
INSERT INTO security.schema_policy (schema_name, posture, exception_reason)
VALUES ('auth', 'exempt',
        'better-auth owns these tables. They have no tenant dimension: a login identity precedes tenant context, '
        'and at session-validation time there is no context to scope by. Closing the residual properly means a '
        'fourth Postgres role used only by the auth layer.')
ON CONFLICT (schema_name) DO UPDATE
  SET posture = EXCLUDED.posture, exception_reason = EXCLUDED.exception_reason;
--> statement-breakpoint

GRANT USAGE ON SCHEMA auth TO crm_app;
--> statement-breakpoint
-- Enumerated per table rather than granted across the schema, because DELETE
-- is the privilege this product refuses everywhere else: soft delete is the
-- only delete the domain has. Two tables genuinely need it — sign-out removes
-- a session row, and a consumed verification token is deleted, not archived.
-- `user` and `account` do not: there is no account-deletion flow, and an
-- app_user with ledger history must never lose its login by cascade.
GRANT SELECT, INSERT, UPDATE ON auth."user" TO crm_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON auth.account TO crm_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON auth.session TO crm_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON auth.verification TO crm_app;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2 · Resolving a login to a membership
-- ---------------------------------------------------------------------------
-- This has to be a definer. The lookup happens BEFORE begin_request, so there
-- is no session context, so `app_user`'s policy denies and a plain SELECT
-- returns zero rows — a login that silently never resolves. Making it a
-- definer also makes it enumerable: this is the complete list of ways the
-- application reads app_user without context, and it is one.
--
-- A deactivated seller resolves to nothing, so a valid cookie for a departed
-- user reads as "not signed in" rather than disclosing that the account exists.
CREATE OR REPLACE FUNCTION app.resolve_identity(p_auth_user_id text)
RETURNS TABLE (tenant_id uuid, user_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = app, pg_catalog
AS $fn$
  SELECT u.tenant_id, u.id
  FROM app.app_user u
  WHERE u.auth_user_id = p_auth_user_id
    AND u.deactivated_at IS NULL
  LIMIT 1
$fn$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION app.resolve_identity(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.resolve_identity(text) TO crm_app;
--> statement-breakpoint

SELECT security.harden();
