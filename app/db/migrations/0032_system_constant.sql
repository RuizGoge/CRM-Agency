-- ===========================================================================
-- `ref.system_constant` — and with it, §3's boot assertion becomes buildable
--
-- The table has been named since Phase 5 and missing ever since. CONTEXT.md has
-- carried it as the blocker on TWO gates: the `is_demo`-in-production trigger
-- from Sprint 1 item 1, and §3's refusal to boot production while an
-- `mvp_required` capability is unverified. The second is what this unblocks.
--
-- 🔴 THE ONLY INTERESTING DECISION IN THIS FILE IS WHICH WAY IT FAILS.
--
-- An unclassified database could default to `development` or to `production`.
-- Defaulting to development is the comfortable choice and it is wrong: a real
-- production database is unclassified on the day it is created, so every gate
-- keyed on this constant would be silent on precisely the machine it exists to
-- protect, and nothing about that machine would look broken. Defaulting to
-- production inverts it — an unclassified database refuses to serve, loudly,
-- and a developer's database has to say so about itself.
--
-- ⚠️ AND THE CLASSIFICATION IS DERIVED, NOT ASKED FOR. A step somebody has to
-- remember is not a mechanism, and this one would be remembered on every
-- machine except the new one. `app.tenant.is_demo` is already the fact:
-- **a database holding a demo tenant is not a production database.** Jorge's
-- dev database and `crm_test` both hold one, so both classify themselves
-- correctly on this migration without anybody touching anything; an empty
-- production database holds none and classifies as production.
--
-- The derivation runs ONCE, here, and `ON CONFLICT DO NOTHING` means a later
-- demo seed cannot flip an already-classified database. Seeding demo data into
-- production remains a problem — it is the one the `is_demo` trigger is for —
-- but it is not a way to disarm this.
-- ===========================================================================

CREATE TABLE "ref"."system_constant" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"reason" text NOT NULL,
	CONSTRAINT "system_constant_value_present" CHECK (length(btrim("ref"."system_constant"."value")) > 0),
	CONSTRAINT "system_constant_reason_present" CHECK (length(btrim("ref"."system_constant"."reason")) > 0),
	CONSTRAINT "system_constant_environment_known" CHECK ("ref"."system_constant"."key" <> 'environment' OR "ref"."system_constant"."value" IN ('production', 'development', 'test'))
);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 1 · Classify, then harden
-- ---------------------------------------------------------------------------
-- `reference`, so `crm_app` gets SELECT and nothing else: no request-serving
-- code path can talk the process into believing it is somewhere else.
--
-- NOT `immutable`, and that is the difference from the capability tables. A
-- captured exchange is a historical fact and may never change; an environment
-- is a property of the database that can legitimately move — a production
-- restore into a staging box is exactly that, and it must be correctable
-- without a schema change. What keeps it honest is the revoked privilege, not
-- immutability.
INSERT INTO security.table_registry
  (schema_name, table_name, policy_class, immutable, app_can_insert, exception_reason, registered_in_migration)
VALUES
  ('ref', 'system_constant', 'reference', false, false,
   'Facts a PROCESS needs before it has a tenant — chiefly which environment this database is. Not tenant data by construction: a tenant dimension would invite the reading that one tenant could be in production while another is not, which is not a deployment this product has. Mutable because an environment legitimately changes when a database is restored elsewhere; crm_app still holds SELECT and nothing else.',
   '0032_system_constant')
ON CONFLICT (schema_name, table_name) DO UPDATE
  SET policy_class            = EXCLUDED.policy_class,
      immutable               = EXCLUDED.immutable,
      app_can_insert          = EXCLUDED.app_can_insert,
      exception_reason        = EXCLUDED.exception_reason,
      registered_in_migration = EXCLUDED.registered_in_migration;--> statement-breakpoint

SELECT security.harden();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2 · Classify THIS database, from a fact rather than from a question
-- ---------------------------------------------------------------------------
INSERT INTO ref.system_constant (key, value, reason)
SELECT
  'environment',
  CASE
    WHEN EXISTS (SELECT 1 FROM app.tenant WHERE is_demo) THEN 'development'
    ELSE 'production'
  END,
  CASE
    WHEN EXISTS (SELECT 1 FROM app.tenant WHERE is_demo)
      THEN 'Derived by 0032: this database holds a demo tenant, so it is not production.'
    ELSE 'Derived by 0032: no demo tenant, so this database is treated as production. An unclassified database defaults to production ON PURPOSE — the alternative leaves every gate silent on the one machine it protects.'
  END
ON CONFLICT (key) DO NOTHING;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3 · Refuse to have classified nothing
-- ---------------------------------------------------------------------------
-- The same shape as CAP010 and CAP011. Without it the INSERT above could
-- silently write no row — and a boot assertion reading a missing constant is a
-- boot assertion that never fires, which is the exact failure this whole file
-- exists to prevent, reintroduced by an empty statement.
DO $verify$
DECLARE
  env text;
BEGIN
  SELECT value INTO env FROM ref.system_constant WHERE key = 'environment';

  IF env IS NULL THEN
    RAISE EXCEPTION 'SYS001: ref.system_constant has no environment row after 0032'
      USING HINT = 'A boot gate reading a missing constant is a gate that never fires.';
  END IF;

  RAISE NOTICE 'environment classified as %', env;
END
$verify$;
