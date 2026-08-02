-- crm_app becomes a role that can actually connect.
--
-- Until now it existed only as a target for GRANTs, and every environment —
-- including this one — connected as the schema OWNER. That made the silo
-- depend on which user DATABASE_URL happened to name, because an owner (and a
-- superuser) bypasses row level security entirely, FORCE included. The canary
-- fixture in Sprint 1.4 found exactly that, and the SET LOCAL ROLE added then
-- is defence in depth, not the control.
--
-- This is the control: the application connects AS crm_app, so RLS applies
-- because of who it is rather than because of what it remembered to do.
--
-- NO PASSWORD IS SET HERE, deliberately. A credential written into a migration
-- is a credential in the repository, in the image, and in every clone. It is
-- set out of band: by the provider's console in production, and by the
-- dev-only setup path locally — the same shape errata E1b requires for the DDL
-- authorization token.
ALTER ROLE crm_app WITH LOGIN;
--> statement-breakpoint

-- Connecting is not reading. crm_app still holds only what harden() grants it,
-- and nothing at all in schema `security`.
--
-- `current_database()` rather than a literal: this same migration runs against
-- crm_dev, crm_test and whatever the provider names the production database.
DO $bootstrap$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO crm_app', current_database());
END
$bootstrap$;
