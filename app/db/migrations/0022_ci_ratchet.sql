-- Sprint-0 Gate 11, the half that anchors OUTSIDE the working tree.
--
-- `perf-budgets.json` already makes the build go red, which is a real mechanism.
-- What it is not is unwalkable: loosening a budget is a file edit, and the whole
-- point of `CLAUDE.md`'s founding rule is that the actor to design against is
-- "Claude writes it and nobody reads the diff". This moves the refusal into the
-- engine.
--
-- PRECEDENCE — this builds §11.3, NOT §10.0.1, and the difference is the point.
-- §10.0.1 puts `direction` on the value row and offers `frozen_set`. §11.3
-- STRIKES both: a direction chosen by whoever writes the newest row is chosen by
-- the attacker, and `frozen_set` is superset-only, which is the wrong arm for
-- every list it was guarding — "the model edits the literal" rebuilt as "the
-- model inserts a row". Building §10.0.1 first and correcting it later would
-- have shipped the inverted guard in between.

-- ---------------------------------------------------------------------------
-- 1 · The direction vocabulary
-- ---------------------------------------------------------------------------
DO $ratchet$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'ratchet_direction' AND n.nspname = 'app'
  ) THEN
    CREATE TYPE app.ratchet_direction AS ENUM (
      'monotonic_down',  -- numeric: a value above the running minimum is refused
      'monotonic_up',    -- numeric: the inverse
      'pinned',          -- numeric: anything other than the registered value is refused
      'shrink_only',     -- set:     a set that is not a SUBSET of the previous is refused
      'sealed_set'       -- set:     a set that is not EQUAL to the previous is refused
    );
    -- 'frozen_set' is deliberately absent. It permitted supersets, so every list
    -- it guarded could be loosened by adding one row.
  END IF;
END
$ratchet$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2 · The NAME registry — the direction is a property of the name, never of a row
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ref.ci_ratchet_name (
  name                    text PRIMARY KEY,
  direction               app.ratchet_direction NOT NULL,  -- no DEFAULT: unclassified is impossible
  registered_in_migration text NOT NULL,
  -- Long enough that it cannot be satisfied with "perf" or "TODO". A budget
  -- nobody could explain is a budget nobody will defend.
  rationale               text NOT NULL CHECK (length(btrim(rationale)) >= 20)
);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3 · The value ledger
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ref.ci_ratchet (
  name       text NOT NULL REFERENCES ref.ci_ratchet_name (name),
  value_num  bigint,
  value_set  text[],
  -- NOT NULL: a measurement with no run behind it is an assertion.
  set_by_run text NOT NULL CHECK (length(btrim(set_by_run)) > 0),
  set_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (name, set_at),
  -- Exactly one shape per row. A row carrying both is a row whose arm is
  -- ambiguous, and the trigger below would have to guess.
  CONSTRAINT ci_ratchet_one_shape
    CHECK ((value_num IS NULL) <> (value_set IS NULL))
);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4 · The arm, enforced at INSERT
-- ---------------------------------------------------------------------------
-- Every refusal carries its own SQLSTATE so a red build says which guarantee
-- was violated, not merely that one was.
CREATE OR REPLACE FUNCTION ref.ci_ratchet_enforce()
RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  dir        app.ratchet_direction;
  prev_num   bigint;
  first_num  bigint;
  prev_set   text[];
BEGIN
  SELECT n.direction INTO dir
    FROM ref.ci_ratchet_name n WHERE n.name = NEW.name;

  IF NOT FOUND THEN
    -- Unreachable through the foreign key, and kept anyway: it is the assertion
    -- that there is NO DEFAULT DIRECTION. A new name cannot inherit an arm.
    RAISE EXCEPTION
      'AP007: ratchet "%" has no ref.ci_ratchet_name row, so it has no direction.',
      NEW.name
      USING HINT = 'Register the name and its direction in a migration. There is no default arm.',
            ERRCODE = 'AP007';
  END IF;

  IF dir IN ('monotonic_down', 'monotonic_up', 'pinned') AND NEW.value_num IS NULL THEN
    RAISE EXCEPTION 'AP008: ratchet "%" is numeric (%); value_num is required.', NEW.name, dir
      USING ERRCODE = 'AP008';
  END IF;

  IF dir IN ('shrink_only', 'sealed_set') AND NEW.value_set IS NULL THEN
    RAISE EXCEPTION 'AP008: ratchet "%" is a set (%); value_set is required.', NEW.name, dir
      USING ERRCODE = 'AP008';
  END IF;

  CASE dir
    WHEN 'monotonic_down' THEN
      -- Against the running MINIMUM, not the latest row: otherwise a budget is
      -- loosened in two steps, each of which looks like a tightening of the one
      -- before it.
      SELECT min(r.value_num) INTO prev_num FROM ref.ci_ratchet r WHERE r.name = NEW.name;
      IF prev_num IS NOT NULL AND NEW.value_num > prev_num THEN
        RAISE EXCEPTION
          'AP002: % loosened from % to % — refused by ratchet (monotonic_down).',
          NEW.name, prev_num, NEW.value_num
          USING HINT = 'Tightening is free. Loosening is a decision, and it is not this one.',
                ERRCODE = 'AP002';
      END IF;

    WHEN 'monotonic_up' THEN
      SELECT max(r.value_num) INTO prev_num FROM ref.ci_ratchet r WHERE r.name = NEW.name;
      IF prev_num IS NOT NULL AND NEW.value_num < prev_num THEN
        RAISE EXCEPTION
          'AP003: % loosened from % to % — refused by ratchet (monotonic_up).',
          NEW.name, prev_num, NEW.value_num
          USING ERRCODE = 'AP003';
      END IF;

    WHEN 'pinned' THEN
      -- The FIRST value is the registered one. Later rows may only restate it,
      -- which is what makes a pinned number auditable rather than merely stable.
      SELECT r.value_num INTO first_num FROM ref.ci_ratchet r
       WHERE r.name = NEW.name ORDER BY r.set_at LIMIT 1;
      IF first_num IS NOT NULL AND NEW.value_num <> first_num THEN
        RAISE EXCEPTION
          'AP004: % is pinned at %; % is not that value.', NEW.name, first_num, NEW.value_num
          USING ERRCODE = 'AP004';
      END IF;

    WHEN 'shrink_only' THEN
      SELECT r.value_set INTO prev_set FROM ref.ci_ratchet r
       WHERE r.name = NEW.name ORDER BY r.set_at DESC LIMIT 1;
      IF prev_set IS NOT NULL AND NOT (NEW.value_set <@ prev_set) THEN
        RAISE EXCEPTION
          'AP005: % refused, % is not in the previous set (shrink_only).',
          NEW.name, (SELECT array_agg(e) FROM unnest(NEW.value_set) e WHERE NOT (e = ANY(prev_set)))
          USING HINT = 'Removing an entry is the tightening and stays free. Adding one is the danger.',
                ERRCODE = 'AP005';
      END IF;

    WHEN 'sealed_set' THEN
      SELECT r.value_set INTO prev_set FROM ref.ci_ratchet r
       WHERE r.name = NEW.name ORDER BY r.set_at DESC LIMIT 1;
      IF prev_set IS NOT NULL
         AND NOT (NEW.value_set <@ prev_set AND prev_set <@ NEW.value_set) THEN
        -- Both arms are fatal here: an addition and a removal are each a
        -- different way of corrupting what the set certifies.
        RAISE EXCEPTION
          'AP006: % is sealed; the set may not change.', NEW.name
          USING ERRCODE = 'AP006';
      END IF;
  END CASE;

  RETURN NEW;
END
$fn$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS t_ci_ratchet_arm ON ref.ci_ratchet;
--> statement-breakpoint

CREATE TRIGGER t_ci_ratchet_arm
  BEFORE INSERT ON ref.ci_ratchet
  FOR EACH ROW EXECUTE FUNCTION ref.ci_ratchet_enforce();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 5 · Classification, so harden() can generate the policies and immutability
-- ---------------------------------------------------------------------------
INSERT INTO security.table_registry
  (schema_name, table_name, policy_class, owner_column, immutable, app_can_insert,
   protected_columns, exception_reason, registered_in_migration)
VALUES
  ('ref', 'ci_ratchet', 'reference', NULL, true, false, NULL,
   'CI enforcement ledger, no tenant dimension, INSERT-only to crm_ci, immutable by trigger',
   '0022_ci_ratchet'),
  ('ref', 'ci_ratchet_name', 'reference', NULL, true, false, NULL,
   'Ratchet arms, no tenant dimension. Immutable so a direction cannot be flipped by a row edit: changing one requires dropping a protected trigger, which is counted rather than quiet.',
   '0022_ci_ratchet')
ON CONFLICT (schema_name, table_name) DO UPDATE
  SET policy_class            = EXCLUDED.policy_class,
      owner_column            = EXCLUDED.owner_column,
      immutable               = EXCLUDED.immutable,
      app_can_insert          = EXCLUDED.app_can_insert,
      protected_columns       = EXCLUDED.protected_columns,
      exception_reason        = EXCLUDED.exception_reason,
      registered_in_migration = EXCLUDED.registered_in_migration;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 6 · The CI role
-- ---------------------------------------------------------------------------
-- NOLOGIN and no password here, exactly as `crm_app` was created: a credential
-- in a migration is a credential in the repository, in the image and in every
-- clone. LOGIN and a password are granted out of band when the CI secret exists.
DO $ci_role$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crm_ci') THEN
    CREATE ROLE crm_ci NOINHERIT;
  END IF;
END
$ci_role$;
--> statement-breakpoint

GRANT USAGE ON SCHEMA ref TO crm_ci;
--> statement-breakpoint
GRANT USAGE ON SCHEMA app TO crm_ci;
--> statement-breakpoint

-- INSERT and SELECT on the values. SELECT ONLY on the arms: CI records what it
-- measured, and can never reclassify what a measurement means.
GRANT SELECT, INSERT ON ref.ci_ratchet TO crm_ci;
--> statement-breakpoint
GRANT SELECT ON ref.ci_ratchet_name TO crm_ci;
--> statement-breakpoint

-- harden() generates p_app and p_sys and drops only those two by name, so this
-- policy survives every re-hardening. FOR ALL with both clauses, like every
-- other policy in this database — the silo suite asserts that of all of them.
DROP POLICY IF EXISTS p_ci ON ref.ci_ratchet;
--> statement-breakpoint
CREATE POLICY p_ci ON ref.ci_ratchet FOR ALL TO crm_ci USING (true) WITH CHECK (true);
--> statement-breakpoint
DROP POLICY IF EXISTS p_ci ON ref.ci_ratchet_name;
--> statement-breakpoint
CREATE POLICY p_ci ON ref.ci_ratchet_name FOR ALL TO crm_ci USING (true) WITH CHECK (false);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 7 · The names this project has measured, with their arms
-- ---------------------------------------------------------------------------
INSERT INTO ref.ci_ratchet_name (name, direction, registered_in_migration, rationale)
VALUES
  ('perf.P12_initial_js_gzip', 'monotonic_down', '0022_ci_ratchet',
   'Initial JS for the pipeline route. Errata E6 struck the approved 250 KB as unsatisfiable against the TTI number; Gate 11 measured 108,086 bytes and the budget follows the measurement.'),
  ('perf.P13_initial_css_gzip', 'monotonic_down', '0022_ci_ratchet',
   'Initial CSS for the pipeline route. Measured at 2,368 bytes by Gate 11 against a struck 60 KB.'),
  ('perf.P6_drag_frames', 'monotonic_down', '0022_ci_ratchet',
   'p95 rAF frame time during a scripted three-column drag on the perf-500 fixture. Gate 12 measured 16.8 ms against the production build.'),
  ('perf.P20_mobile_tti_pipeline', 'monotonic_down', '0022_ci_ratchet',
   'Mobile time-to-interactive. Registered with NO VALUE ROW: errata E6 requires the name to exist and the number to come from measurement, and the nightly Lighthouse tier does not exist yet.')
ON CONFLICT (name) DO NOTHING;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 8 · The first value rows — this is E6 being satisfied, not anticipated
-- ---------------------------------------------------------------------------
-- E6: "register the ratchet NAME with direction monotonic_down and NO VALUE ROW
-- until the gate measures the first one." Gates 11 and 12 have now measured, so
-- these are the first rows. P20 gets none, because nothing has measured it —
-- the name exists and the hole is visible, which is exactly what E6 asked for.
INSERT INTO ref.ci_ratchet (name, value_num, set_by_run)
SELECT v.name, v.value_num, '0022_ci_ratchet'
FROM (VALUES
  ('perf.P12_initial_js_gzip'::text, 128000::bigint),
  ('perf.P13_initial_css_gzip', 16384),
  ('perf.P6_drag_frames', 20)
) AS v(name, value_num)
WHERE NOT EXISTS (SELECT 1 FROM ref.ci_ratchet r WHERE r.name = v.name);
--> statement-breakpoint

SELECT security.harden();
