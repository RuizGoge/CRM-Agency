-- ===========================================================================
-- THE DEPLOY CREDENTIAL CANNOT RECORD THAT IT DEPLOYED.
--
-- 🔴 FOUND BY TRYING TO SHIP A MIGRATION, WHICH IS THE ONLY WAY IT COULD HAVE
-- BEEN FOUND. Pointing MIGRATION_DATABASE_URL at `crm_migrator` on 2026-08-14
-- isolated the deploy — and silently made it unable to apply anything ever
-- again:
--
--     FAILED: CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" …
--     CAUSE:  permission denied for schema drizzle
--
-- Measured: the `drizzle` schema is owned by `crm`, and `crm_migrator` holds
-- neither USAGE nor CREATE on it, nor SELECT nor INSERT on the bookkeeping
-- table. Every migration was already applied, so there was nothing to run and
-- nothing failed visibly.
--
-- ⚠️ THREE THINGS HID IT AT ONCE, and each is worth naming because each will
-- hide the next one:
--   1 · `drizzle-kit migrate` exits 1 and prints NOTHING — no message, no
--        cause, just a spinner and a status code. The error above came from
--        drizzle-orm's migrator, called by hand.
--   2 · `npm run verify` does not run the deploy. It typechecks, lints, tests
--        and measures budgets; the one command that would have failed is the
--        one command it never calls.
--   3 · The grade said `(b)` the whole time. Credential isolation was real —
--        the deploy genuinely could not authorise itself. It also could not
--        deploy, and the grade has no opinion about that.
--
-- 🎯 A FRESH DATABASE WOULD NOT HAVE SHOWN IT EITHER. `crm_migrator` holds
-- CREATE on the database, so on a brand-new database it creates `drizzle`
-- itself and owns it. Only a database bootstrapped as `crm` — which is this
-- one, and would be production if it were ever bootstrapped that way — is
-- stuck. The failure is invisible until the first migration after the switch.
--
-- WHY IT IS OUT OF BAND: it cannot be a migration. Drizzle opens the
-- bookkeeping table BEFORE applying anything, so a migration that fixed this
-- could never be recorded — it would fail on the statement that makes it
-- possible to record it.
--
-- ⚠️ AND IT IS A DIFFERENT CONCERN FROM `ddl-guard.sql`, sharing only the actor
-- and the moment: both are statements only the owner can run, both are needed
-- before the isolated credential works at all. Kept in separate files so that
-- reading one does not suggest the other is part of it.
-- ===========================================================================

DO $$
BEGIN
  IF to_regnamespace('drizzle') IS NULL THEN
    RAISE NOTICE 'DEPLOY000: no drizzle schema yet. Nothing to hand over — the deploy role holds CREATE on the database and will create and own it on the first run.';
    RETURN;
  END IF;

  -- Ownership rather than grants. The deploy's own bookkeeping is the one thing
  -- it must be able to write without asking anybody, and an owner cannot have
  -- the privilege revoked out from under it by a later GRANT-shaped change.
  -- This is not a security boundary: drizzle's journal records what ran, and a
  -- role that can run migrations can already do everything the journal
  -- describes.
  EXECUTE 'ALTER SCHEMA drizzle OWNER TO crm_migrator';

  IF to_regclass('drizzle.__drizzle_migrations') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE drizzle.__drizzle_migrations OWNER TO crm_migrator';
  END IF;

  RAISE NOTICE 'DEPLOY001: drizzle schema and bookkeeping table handed to crm_migrator.';
END;
$$;
