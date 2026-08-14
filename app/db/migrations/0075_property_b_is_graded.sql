-- ===========================================================================
-- PROPERTY (b) STOPS BEING A CLAIM AND BECOMES A MEASUREMENT.
--
-- CLAUDE.md names three properties that survive "Claude writes a migration and
-- nobody reads the diff": (a) a symptom on screen, (b) a gate anchored outside
-- the working tree, (c) re-assertion at deploy and at boot. This tree has (a)
-- and (c) in many places. It has never had (b), and `05c` says twenty-plus
-- closures lean on it.
--
-- 🔴 THE HONEST FINDING, MEASURED BEFORE ANYTHING WAS BUILT:
--
--   rolname       rolsuper  owns security
--   crm             TRUE       —            <- migrations run as this
--   crm_migrator    FALSE    security
--   crm_app         FALSE      —
--
-- Migrations run as `crm`, a SUPERUSER. Against a superuser nothing inside this
-- database is (b): it can insert any authorisation row, drop any trigger,
-- restore any revoked grant, in one statement. R4 says exactly this and grades
-- it "structural · unclosable in-document".
--
-- 🎯 SO THIS MIGRATION DOES NOT PRETEND TO DELIVER (b). Building a mechanism
-- that LOOKS like an out-of-tree anchor while a superuser can forge it would be
-- worse than not having one, because the next reader would stop looking. What
-- it does instead is the two things that are actually available:
--
--   1 · The STRUCTURE erratum E1b mandates and this tree never built —
--       `security.ddl_authorization`, a row created OUT OF BAND by the owner
--       before the deploy that consumes it. E1b is normative rank 1: "if this
--       placement is not adopted, the boldface claim is struck and §11.11 is
--       graded (a)+(c) only." It has been unadopted and ungraded since Gate 5.
--
--   2 · The GRADE, as a function anybody can call. Whether (b) holds is a fact
--       about role privileges, and a fact can be measured instead of assumed.
--
-- ⚠️ WHAT MAKES IT REAL IS ONE CONFIGURATION CHANGE, AND IT IS JORGE'S: run
-- migrations as `crm_migrator` rather than `crm`. The table below is owned by
-- `crm` with INSERT revoked from `crm_migrator`, so under that credential the
-- deploy can CONSUME an authorisation and cannot CREATE one — which is E1b's
-- ruling exactly. Until then the grade reads `degraded`, and it says so.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1 · A SCHEMA OF ITS OWN, AND THE REASON IS A COLLISION BETWEEN TWO OF THIS
--     PROJECT'S OWN MECHANISMS
-- ---------------------------------------------------------------------------
-- 🔴 THE FIRST VERSION PUT THIS TABLE IN `security` AND COULD NOT WORK. 0062's
-- `security.own_to_migrator()` takes every object in the managed schemas PLUS
-- `security` and makes `crm_migrator` its owner — and refuses to commit
-- (OWN003) if any is not. E1b needs the opposite for exactly one table: an
-- authorisation the DEPLOY ROLE CANNOT CREATE. An owner can always insert into
-- its own table, so the two requirements collide inside that schema.
--
-- Found by measurement rather than by reading: the suite graded `crm_migrator`
-- as (b) alone and as degraded in the full run, because `crm_test` is rebuilt
-- from every migration in order and `own_to_migrator()` had taken the table
-- back. Neither mechanism is wrong; they are simply not compatible in one
-- schema.
--
-- `authz` is outside `own_to_migrator()`'s list, which is
-- `schema_policy WHERE posture = 'managed' AND schema_name <> 'public'` UNION
-- `security`. It carries a `schema_policy` row because E1 made the hardening
-- pass default-DENY: a schema with no row raises rather than being skipped.
CREATE SCHEMA IF NOT EXISTS authz AUTHORIZATION crm;--> statement-breakpoint

INSERT INTO security.schema_policy (schema_name, posture, exception_reason)
VALUES ('authz', 'exempt',
        'Holds exactly one table: the out-of-band DDL authorisation erratum E1b mandates. Deliberately OUTSIDE security, because own_to_migrator() would make crm_migrator its owner and an owner can always insert — which is the one thing this table must refuse to the deploy role. No tenant dimension, no application access: crm_app has no grants here at all.')
ON CONFLICT (schema_name) DO UPDATE
  SET posture = EXCLUDED.posture, exception_reason = EXCLUDED.exception_reason;--> statement-breakpoint

REVOKE ALL ON SCHEMA authz FROM PUBLIC;--> statement-breakpoint
GRANT USAGE ON SCHEMA authz TO crm_migrator;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2 · THE AUTHORISATION E1b SPECIFIES
-- ---------------------------------------------------------------------------
-- One row = one permission to change protected objects, spent once.
--
-- 🔴 THE COLUMN THAT CARRIES THE PROPERTY IS `created_by`, AND IT IS DEFAULTED
-- RATHER THAN PASSED. A caller that could name who authorised it could name
-- somebody who did not — the same rule `audit_write` and `consent_append` state
-- and the reason neither takes an actor parameter.
CREATE TABLE IF NOT EXISTS authz.ddl_authorization (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  -- What it authorises. Free text on purpose: this is read by a person deciding
  -- whether the deploy in front of them is the one they authorised, and a closed
  -- vocabulary would be a second thing to keep in step with the migrations.
  purpose     text NOT NULL,
  created_by  text NOT NULL DEFAULT current_user,
  created_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- Consumed once. A second deploy cannot ride the first one's permission.
  consumed_at timestamptz,
  consumed_by text,
  CONSTRAINT ddl_authorization_purpose_present CHECK (length(btrim(purpose)) > 20),
  CONSTRAINT ddl_authorization_consumed_together
    CHECK ((consumed_at IS NULL) = (consumed_by IS NULL))
);--> statement-breakpoint

COMMENT ON TABLE authz.ddl_authorization IS
  'Erratum E1b. One row authorises one protected-object change and is spent once. Created OUT OF BAND by the owner; the deploy consumes what it cannot create.';--> statement-breakpoint

-- 🔴 THE REVOKE IS THE WHOLE MECHANISM, and it is inert today by design rather
-- than by oversight. `crm_migrator` may read an authorisation and mark it spent;
-- it may not create one. The day migrations stop running as a superuser, this
-- REVOKE is what makes the deploy unable to authorise itself — and until that
-- day it changes nothing, which is exactly what the grade below reports.
ALTER TABLE authz.ddl_authorization OWNER TO crm;--> statement-breakpoint
REVOKE ALL ON TABLE authz.ddl_authorization FROM PUBLIC;--> statement-breakpoint
REVOKE INSERT ON TABLE authz.ddl_authorization FROM crm_migrator;--> statement-breakpoint
GRANT SELECT, UPDATE ON TABLE authz.ddl_authorization TO crm_migrator;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3 · THE GRADE
-- ---------------------------------------------------------------------------
-- 🔴 IT ASKS THE ENGINE, NOT THE DOCUMENTATION. Whether (b) holds is a fact
-- about role privileges: can the role that runs deploys create its own
-- authorisation? `has_table_privilege` answers true for a superuser
-- automatically, which is the point — a superuser deploy grades `degraded` with
-- no special case for it.
--
-- Returns a row rather than a boolean so the reason travels with the verdict.
-- "It is degraded" is not actionable; "it is degraded because crm is a
-- superuser" is.
CREATE OR REPLACE FUNCTION security.property_b_grade(p_deploy_role text DEFAULT 'crm')
RETURNS TABLE (holds boolean, grade text, reason text)
LANGUAGE plpgsql
STABLE
AS $fn$
DECLARE
  v_super  boolean;
  v_insert boolean;
BEGIN
  SELECT r.rolsuper INTO v_super FROM pg_roles r WHERE r.rolname = p_deploy_role;

  IF v_super IS NULL THEN
    RETURN QUERY SELECT false, '(a)+(c)'::text,
      format('there is no role named %s, so nothing could be graded', p_deploy_role);
    RETURN;
  END IF;

  IF v_super THEN
    RETURN QUERY SELECT false, '(a)+(c)'::text,
      format('%s is a SUPERUSER: it can create its own authorisation, drop any '
             'trigger and restore any revoked grant in one statement. E1b: the '
             'boldface claim is struck and §11.11 is graded (a)+(c) only. The fix '
             'is configuration, not code — run migrations as crm_migrator.',
             p_deploy_role);
    RETURN;
  END IF;

  v_insert := has_table_privilege(p_deploy_role, 'authz.ddl_authorization', 'INSERT');

  IF v_insert THEN
    RETURN QUERY SELECT false, '(a)+(c)'::text,
      format('%s can INSERT into authz.ddl_authorization, so the deploy can '
             'authorise itself. E1b requires the row to be created out of band.',
             p_deploy_role);
    RETURN;
  END IF;

  -- 🔴 AND IT MUST BE ABLE TO CONSUME, or the green is for the wrong reason.
  -- The first version of this function graded `crm_app` as (b): it cannot insert
  -- an authorisation, so it passed — but it cannot read or spend one either,
  -- because it is not a deploy role at all. "Unable to forge" and "able to
  -- deploy under an authorisation it cannot forge" are different facts, and only
  -- the second is E1b's placement. Caught by asking the function about every
  -- role rather than only the one it defaults to.
  IF NOT (has_table_privilege(p_deploy_role, 'authz.ddl_authorization', 'SELECT')
      AND has_table_privilege(p_deploy_role, 'authz.ddl_authorization', 'UPDATE')) THEN
    RETURN QUERY SELECT false, 'n/a'::text,
      format('%s cannot read or spend an authorisation, so it is not a deploy '
             'role and there is nothing here to grade. Ask about the role that '
             'actually runs migrations.', p_deploy_role);
    RETURN;
  END IF;

  RETURN QUERY SELECT true, '(b)'::text,
    format('%s can consume an authorisation and cannot create one, which is '
           'E1b''s placement. The deciding fact lives outside the working tree.',
           p_deploy_role);
END;
$fn$;--> statement-breakpoint

REVOKE ALL ON FUNCTION security.property_b_grade(text) FROM PUBLIC;--> statement-breakpoint

-- No `security.harden()`: `security` is exempt from the hardening pass — it is
-- the schema that HOLDS `table_registry` and `harden()` itself — and no relation
-- in a managed schema was created here.
