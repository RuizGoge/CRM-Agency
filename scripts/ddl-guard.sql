-- ===========================================================================
-- E1b, THE PROTECTION HALF. A PROTECTED CHANGE MUST NOW CONSUME AN
-- AUTHORISATION THE DEPLOY ROLE CANNOT CREATE.
--
-- 🔴 WHY THIS IS NOT A MIGRATION, AND CANNOT BE ONE.
--
-- `CREATE EVENT TRIGGER` requires SUPERUSER. Since 2026-08-14 the deploy runs
-- as `crm_migrator`, which is not one — measured, not assumed. So this file is
-- applied OUT OF BAND by the owner, exactly like the three role-altering
-- statements `docs/sprint-0/deploy-credential-isolation.md` already lists. The
-- authorisation infrastructure cannot bootstrap itself under the credential it
-- exists to limit; that is the property showing up honestly rather than a bug.
--
-- 🎯 WHAT IT CLOSES, MEASURED BEFORE IT WAS WRITTEN (2026-08-14):
--
--     SET ROLE crm_migrator; DROP POLICY p_app ON app.contact;   -- succeeded
--     SET ROLE crm_migrator; ALTER TABLE app.contact NO FORCE ROW LEVEL SECURITY;
--                                                                -- succeeded
--     SET ROLE crm_migrator; DROP TABLE app.contact CASCADE;     -- succeeded
--
-- Seller isolation was removable by the role that runs deploys, in one
-- statement, with nothing to notice it. That is what this refuses.
--
-- ⚠️ WHAT IT DOES NOT CLOSE, SAID HERE RATHER THAN DISCOVERED LATER:
--
--   1 · A SUPERUSER still defeats it — `ALTER EVENT TRIGGER … DISABLE`, or
--       `SET event_triggers = off`. That is R4, graded "structural · unclosable
--       in-document", and this changes nothing about it. What changed is that
--       the DEPLOY is no longer a superuser, so R4's actor is now a human at a
--       console rather than every migration.
--   2 · Whether a managed provider grants superuser at all is R2 and is STILL
--       UNMEASURED. If Render withholds it, this cannot be installed in
--       production and the grade must say so rather than inherit development's.
--   3 · The `harden()` exemption below is the widest seam, and §4 gates it.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1 · WAS THIS TRANSACTION AUTHORISED?
-- ---------------------------------------------------------------------------
-- One authorisation covers one TRANSACTION, not one statement. Per statement
-- would mean a migration that touches four policies needs four rows typed by
-- hand, which is a rule that gets automated away within a week — and an
-- automated authorisation is the defect E1b exists to remove.
--
-- 🔴 `age(xmin) = 0` IS THE WHOLE TEST, and it is deliberately not a GUC. The
-- obvious shape is `SET LOCAL authz.authorised = on` from inside this function
-- and read it back on the next statement. Any role can set a custom GUC, so a
-- migration would set it itself and walk straight through. A row's `xmin` is
-- written by Postgres, and `age() = 0` means THIS transaction wrote it.
CREATE OR REPLACE FUNCTION authz.authorised_in_this_transaction()
RETURNS boolean
LANGUAGE sql
STABLE
AS $fn$
  SELECT EXISTS (
    SELECT 1 FROM authz.ddl_authorization
     WHERE consumed_at IS NOT NULL
       AND age(xmin) = 0
  );
$fn$;

-- ---------------------------------------------------------------------------
-- 2 · SPEND ONE, OR REFUSE
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION authz.consume_authorization(p_reason text)
RETURNS void
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_id      uuid;
  v_purpose text;
BEGIN
  IF authz.authorised_in_this_transaction() THEN
    RETURN;
  END IF;

  UPDATE authz.ddl_authorization
     SET consumed_at = clock_timestamp(),
         consumed_by = current_user
   WHERE id = (SELECT a.id
                 FROM authz.ddl_authorization a
                WHERE a.consumed_at IS NULL
                ORDER BY a.created_at
                LIMIT 1
                  FOR UPDATE SKIP LOCKED)
  RETURNING id, purpose INTO v_id, v_purpose;

  IF v_id IS NULL THEN
    RAISE EXCEPTION
      'AUTHZ001: refusing % — no unconsumed authorisation exists.', p_reason
      USING HINT =
        'This changes seller isolation or destroys a registered table, so E1b '
        'requires an authorisation created OUT OF BAND by the owner before the '
        'deploy that spends it. The deploy role cannot create one: that is the '
        'property. Locally: npm run db:authorize -- "why". In production: one '
        'INSERT into authz.ddl_authorization from the provider''s SQL console.';
  END IF;

  RAISE NOTICE 'AUTHZ: spent authorisation % (%) for %', v_id, v_purpose, p_reason;
END;
$fn$;

-- ---------------------------------------------------------------------------
-- 3 · IS THIS STATEMENT RUNNING INSIDE security.harden()?
-- ---------------------------------------------------------------------------
-- 🔴 THE EXEMPTION IS NOT A CONVENIENCE — WITHOUT IT THE PRODUCT STOPS.
--
-- Measured: `harden()` issues DROP POLICY and CREATE POLICY on EVERY managed
-- relation, and 0057 wired it to partition CREATION — so the worker calls it
-- the night a new `event_outbox` day or `event_log` month first appears. Gate
-- the policy tags without this and that midnight tick demands an authorisation
-- from a background job, the partition is never created, and the event
-- transport stops. The failure would arrive as silence.
--
-- 🎯 AND THE EXEMPTION IS SAFE FOR A REASON THAT IS NOT "WE TRUST IT":
-- `harden()` GENERATES policies from `security.table_registry`. You cannot use
-- this exemption to install a policy of your choosing — you can only use it to
-- install the policy the registry already implies. §4 gates the two ways of
-- changing what it implies: replacing the function, and editing the registry.
CREATE OR REPLACE FUNCTION authz.inside_harden()
RETURNS boolean
LANGUAGE plpgsql
STABLE
AS $fn$
DECLARE
  v_ctx text;
BEGIN
  GET DIAGNOSTICS v_ctx = PG_CONTEXT;
  RETURN v_ctx ~ 'function security\.harden\(\)';
END;
$fn$;

-- ---------------------------------------------------------------------------
-- 4 · THE GUARDS
-- ---------------------------------------------------------------------------

-- 4a · Policies. Any create, alter or drop, on any table.
--
-- Deliberately NOT narrowed to managed relations: at `ddl_command_start` there
-- is no object to inspect, and a guard that had to wait for `ddl_command_end`
-- would be a guard that fires after the policy is already gone.
CREATE OR REPLACE FUNCTION authz.guard_policy()
RETURNS event_trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF authz.inside_harden() THEN
    RETURN;
  END IF;
  PERFORM authz.consume_authorization(format('%s', TG_TAG));
END;
$fn$;

-- 4b · Row level security switched off, and the function that generates the
--      policies replaced.
--
-- ⚠️ THE RLS CHECK IS A STATE CHECK, NOT A COMMAND PARSE, and that is why it
-- catches `NO FORCE ROW LEVEL SECURITY` — whose tag is a bare `ALTER TABLE`,
-- indistinguishable from adding a column until you look at the result. It reads
-- the END state, so `harden()`'s own two-statement ENABLE-then-FORCE would trip
-- it; the exemption above is what keeps that legal.
CREATE OR REPLACE FUNCTION authz.guard_alter()
RETURNS event_trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_weak text;
BEGIN
  IF authz.inside_harden() THEN
    RETURN;
  END IF;

  -- The generator itself. Replacing `harden()` is how you would turn the
  -- exemption above into a way in, so it costs an authorisation.
  IF EXISTS (
    SELECT 1 FROM pg_event_trigger_ddl_commands() c
     WHERE c.classid = 'pg_proc'::regclass
       AND c.object_identity LIKE 'security.harden(%'
  ) THEN
    PERFORM authz.consume_authorization('replacing security.harden()');
    RETURN;
  END IF;

  -- 🔴 `classid` IS LOAD-BEARING AND WAS MISSING IN THE FIRST DRAFT. OIDs are
  -- unique within a catalog, not across them, so `pg_class.oid = c.objid` on a
  -- CREATE FUNCTION event can match an unrelated relation that happens to share
  -- the number — and the guard would then demand an authorisation for creating
  -- a function, naming a table nobody touched.
  SELECT string_agg(format('%s.%s', n.nspname, cl.relname), ', ')
    INTO v_weak
    FROM pg_event_trigger_ddl_commands() c
    JOIN pg_class cl ON cl.oid = c.objid
    JOIN pg_namespace n ON n.oid = cl.relnamespace
    JOIN security.table_registry tr
      ON tr.schema_name = n.nspname AND tr.table_name = cl.relname
   WHERE c.classid = 'pg_class'::regclass
     AND cl.relkind IN ('r', 'p')
     AND NOT (cl.relrowsecurity AND cl.relforcerowsecurity);

  IF v_weak IS NOT NULL THEN
    PERFORM authz.consume_authorization(
      format('leaving row level security off or unforced on %s', v_weak));
  END IF;
END;
$fn$;

-- 4c · Dropping a registered table, and editing the registry that decides what
--      `harden()` generates.
--
-- 🎯 `table_registry` IS THE PARTITION TEST, AND IT IS NOT A NAMING RULE.
-- Measured: 44 registry rows, 58 partitions, and ZERO partitions carry a row of
-- their own — `harden()` resolves a partition to its parent's classification on
-- purpose. So "has a registry row" separates a real table from a partition
-- exactly, and the retention drops (`event_outbox` at 14 days, `event_log`
-- monthly, the vault's purge) keep working with no authorisation at all. A
-- pattern match on the table NAME would have been the obvious shape and would
-- have broken the first time somebody named a table with a date in it.
CREATE OR REPLACE FUNCTION authz.guard_drop()
RETURNS event_trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_dropped text;
BEGIN
  IF authz.inside_harden() THEN
    RETURN;
  END IF;

  SELECT string_agg(format('%s.%s', d.schema_name, d.object_name), ', ')
    INTO v_dropped
    FROM pg_event_trigger_dropped_objects() d
    JOIN security.table_registry tr
      ON tr.schema_name = d.schema_name AND tr.table_name = d.object_name
   WHERE d.object_type = 'table';

  IF v_dropped IS NOT NULL THEN
    PERFORM authz.consume_authorization(format('dropping registered table %s', v_dropped));
  END IF;
END;
$fn$;

DROP EVENT TRIGGER IF EXISTS authz_guard_policy;
CREATE EVENT TRIGGER authz_guard_policy ON ddl_command_start
  WHEN TAG IN ('CREATE POLICY', 'ALTER POLICY', 'DROP POLICY')
  EXECUTE FUNCTION authz.guard_policy();

DROP EVENT TRIGGER IF EXISTS authz_guard_alter;
CREATE EVENT TRIGGER authz_guard_alter ON ddl_command_end
  WHEN TAG IN ('ALTER TABLE', 'CREATE FUNCTION')
  EXECUTE FUNCTION authz.guard_alter();

DROP EVENT TRIGGER IF EXISTS authz_guard_drop;
CREATE EVENT TRIGGER authz_guard_drop ON sql_drop
  EXECUTE FUNCTION authz.guard_drop();

-- ---------------------------------------------------------------------------
-- 5 · THE REGISTRY IS DML, SO IT NEEDS AN ORDINARY TRIGGER
-- ---------------------------------------------------------------------------
-- An event trigger sees DDL and nothing else. `security.table_registry` is a
-- TABLE, and changing a row in it changes the policy `harden()` will generate —
-- reclassify `contact` from `owner_scoped` to `tenant_scoped_read` and every
-- seller reads every seller's leads, with no DDL written anywhere.
--
-- 🔴 UPDATE AND DELETE ONLY — INSERT IS DELIBERATELY FREE, AND THE FIRST DRAFT
-- HAD THIS WRONG. Gating INSERT means every migration that adds a table needs a
-- hand-typed authorisation, because a new table's registry row is how it gets
-- policies at all. That is friction on the safe direction: a new row describes a
-- table that did not exist a moment ago, so it cannot weaken isolation that was
-- never there, and a wrong class on it is a design error the silo suite catches.
-- Reclassifying a LIVE table is the dangerous one, and that is an UPDATE. The
-- delete-then-reinsert route around it is closed because DELETE is gated too.
--
-- ⚠️ `crm_migrator` OWNS THIS TABLE AND CAN THEREFORE DROP THIS TRIGGER. That
-- is a `DROP TRIGGER`, which 4b does not gate. Stated rather than hidden: this
-- raises the cost of a registry edit from one statement to two, and the second
-- one is visible in a diff. It is not (b) on its own.
CREATE OR REPLACE FUNCTION authz.guard_registry()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  PERFORM authz.consume_authorization(
    format('%s on security.table_registry', TG_OP));
  RETURN COALESCE(NEW, OLD);
END;
$fn$;

DROP TRIGGER IF EXISTS t_authz_guard_registry ON security.table_registry;
CREATE TRIGGER t_authz_guard_registry
  BEFORE UPDATE OR DELETE ON security.table_registry
  FOR EACH ROW EXECUTE FUNCTION authz.guard_registry();

-- ---------------------------------------------------------------------------
-- 6 · AN AUTHORISATION IS SPENT ONCE, AND WITHOUT THIS THE WHOLE FILE IS THEATRE
-- ---------------------------------------------------------------------------
-- 🔴 THE HOLE THIS CLOSES WAS MINE, AND IT IS THE SAME SPECIES 0075
-- REINTRODUCED — the object built to remove a defect quietly containing it.
--
-- §1 decides "was this transaction authorised?" with `age(xmin) = 0`, and the
-- deploy role must hold UPDATE on this table or it could not consume anything.
-- Put those two together and the row does not have to be a NEW authorisation:
--
--     SET ROLE crm_migrator;
--     UPDATE authz.ddl_authorization SET consumed_at = clock_timestamp();
--     DROP POLICY p_app ON app.contact;      -- 🔴 succeeded
--
-- Measured, not reasoned about. A spent authorisation is never deleted — it is
-- a log — so from the first authorisation onward there is always a row to
-- re-touch, and the deploy role authorises itself for ever. Every refusal above
-- would still have passed its test.
--
-- The fix is that a spent row is IMMUTABLE. Then the only way to hold a row with
-- `consumed_at IS NOT NULL AND age(xmin) = 0` is to have moved it from NULL in
-- this transaction — which is a genuine spend of a genuine authorisation that
-- somebody the deploy is not put there.
--
-- ⚠️ AND CONSUMING BY HAND STAYS LEGAL, deliberately. An unconsumed row was
-- created out of band by the owner; spending it directly rather than through the
-- guard is the same spend. What must never be legal is spending one twice.
CREATE OR REPLACE FUNCTION authz.authorization_is_spent_once()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'AUTHZ003: an authorisation is a record of who allowed what. It is never deleted.';
  END IF;

  IF OLD.consumed_at IS NOT NULL THEN
    RAISE EXCEPTION
      'AUTHZ002: authorisation % was already spent at % by %.',
      OLD.id, OLD.consumed_at, OLD.consumed_by
      USING HINT =
        'One row authorises one change. Re-touching a spent row would make this '
        'transaction look authorised to the guard, which is the whole property. '
        'Create a new authorisation out of band.';
  END IF;

  -- Nothing but the spend may move. `purpose` is what a person reads to decide
  -- whether the deploy in front of them is the one that was authorised; a
  -- deploy that could rewrite it could authorise one thing and do another.
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.purpose IS DISTINCT FROM OLD.purpose
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'AUTHZ004: only consumed_at and consumed_by may change on an authorisation.';
  END IF;

  -- Recorded, never accepted. Same rule as `created_by` in 0075 and the reason
  -- `audit_write` takes no actor: a caller that could name who spent it could
  -- name somebody who did not.
  NEW.consumed_by := current_user;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS t_authz_spent_once ON authz.ddl_authorization;
CREATE TRIGGER t_authz_spent_once
  BEFORE UPDATE OR DELETE ON authz.ddl_authorization
  FOR EACH ROW EXECUTE FUNCTION authz.authorization_is_spent_once();

-- ---------------------------------------------------------------------------
-- 7 · THE DEPLOY ROLE MAY RUN THESE AND MAY NOT REPLACE THEM
-- ---------------------------------------------------------------------------
-- Every function above is owned by `crm` and lives in `authz`, where
-- `crm_migrator` holds USAGE and not CREATE — so it cannot CREATE OR REPLACE
-- any of them. Measured in the probe: "permission denied for schema".
REVOKE ALL ON FUNCTION authz.consume_authorization(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.authorised_in_this_transaction() FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.inside_harden() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.consume_authorization(text) TO crm_migrator;
GRANT EXECUTE ON FUNCTION authz.authorised_in_this_transaction() TO crm_migrator;
GRANT EXECUTE ON FUNCTION authz.inside_harden() TO crm_migrator;
