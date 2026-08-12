-- ===========================================================================
-- THE LATENCY AXIS. `05c` §11.7, and the half of G6/P24 that 0069 could not do.
--
-- 🔴 THE DEFECT, IN ONE SENTENCE FROM §2367: `weight ∈ {light, heavy}` is a CPU
-- axis with no latency axis, so during the 20,000-message replay this
-- architecture itself sizes, **a TCPA STOP is job 14,000 in a FIFO drain**.
-- `ARR-EVT-13` is explicit that delay here is a LEGAL failure and not a UX
-- degradation. 0069 made a STOP suppress; this is what makes it suppress in
-- time.
--
-- 🔴 AND THE CONTENTION IS REAL IN THIS TREE, MEASURED FROM THE CODE RATHER
-- THAN ASSUMED. `app/jobs/boss.ts` constructs ONE `PgBoss`, and all four
-- `work()` loops share its single internal connection pool. §11.7.2 describes
-- exactly this — *"one worker slot still blocks behind a long bulk job"* — and
-- names the fix: three fetch loops with their own connections and their own
-- concurrency. That is the app-side half; this migration is the registry the
-- lanes are DERIVED from, so the classification is never a constant in a worker
-- file that somebody edits.
--
-- ⚠️ WHAT THIS DOES NOT DO. §11.7.3 routes an individual delivery by sniffing
-- the first 320 raw bytes and enqueuing a STOP into `lane_compliance` while
-- ordinary replies go to `lane_interactive`. **That is not built here, and there
-- is a conflict in it worth naming rather than quietly implementing:** the lane
-- is a property of the QUEUE in this design (`ref.job_registry` is keyed on
-- queue name), so per-delivery routing means two queues for one merger — and
-- `message-merge` is `key_strict_fifo` on `provider_message_id`, whose whole
-- purpose is that a message and its restatement serialize. Split across two
-- queues they no longer do, and G2 measured Aloware restating the same message
-- seconds later. Classifying the WHOLE `message-merge` queue as `compliance` is
-- what ships: strictly safer, and it costs only that an SMS flood shares the
-- compliance lane. Named as an open decision in CONTEXT.md.
-- ===========================================================================

DO $$
BEGIN
  CREATE TYPE app.job_priority AS ENUM ('compliance', 'interactive', 'bulk');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 1 · THE REGISTRY
-- ---------------------------------------------------------------------------
-- `priority` is NOT NULL WITH NO DEFAULT, and that is the mechanic §2382 asks
-- for in the same words `weight` already uses: unclassified must be impossible
-- to express, rather than possible and discouraged. A default — any default —
-- would make "somebody forgot" a silent `bulk`, and the one job where that is
-- fatal is the STOP.
CREATE TABLE IF NOT EXISTS ref.job_registry (
  queue_name text PRIMARY KEY,
  priority   app.job_priority NOT NULL,
  -- Generated rather than written: the lane name and the priority cannot drift
  -- apart, because there is only one of them.
  --
  -- ⚠️ SPELLED AS A `CASE`, NOT AS `'lane_' || priority::text`, WHICH IS WHAT
  -- §11.7.1 PRINTS AND WHAT POSTGRES REFUSES. The enum-to-text cast is STABLE
  -- rather than IMMUTABLE — enum labels can be renamed, so the same input could
  -- produce a different string later — and a generation expression must be
  -- immutable. `CREATE TABLE` fails outright with *"generation expression is not
  -- immutable"*. Enum EQUALITY is immutable, so the CASE is accepted and yields
  -- exactly the same four strings. Copying the spec verbatim here does not
  -- compile.
  lane       text GENERATED ALWAYS AS (
    CASE priority
      WHEN 'compliance'  THEN 'lane_compliance'
      WHEN 'interactive' THEN 'lane_interactive'
      WHEN 'bulk'        THEN 'lane_bulk'
    END) STORED,
  -- Why this queue sits in this lane. Prose, because the day somebody
  -- reclassifies the STOP chain the question asked will be "who decided that,
  -- and what did they think it cost".
  rationale  text NOT NULL,
  registered_in_migration text NOT NULL,
  CONSTRAINT job_registry_queue_present  CHECK (length(btrim(queue_name)) > 0),
  CONSTRAINT job_registry_rationale_present CHECK (length(btrim(rationale)) > 20)
);--> statement-breakpoint

COMMENT ON TABLE ref.job_registry IS
  'The latency axis. One row per queue, seeded here, read by the worker to derive its lanes. 05c §11.7.';--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2 · THE CLASSIFICATION
-- ---------------------------------------------------------------------------
-- Read off §11.7.1's own table rather than chosen. The four queues this tree
-- actually has, and where each one lands:
INSERT INTO ref.job_registry (queue_name, priority, rationale, registered_in_migration)
VALUES
  ('message-merge', 'compliance',
   'The STOP chain. Since 0069 app.message_merge appends the consent row and the '
   'suppression row inside its own transaction, so this queue IS the TCPA lane: '
   'delay is a legal failure, not a slow screen. G6/P24 measures it at 5 s.',
   '0070_job_latency_lanes'),

  ('scheduled-job-dispatch', 'compliance',
   'The T-1h reminder tick. §11.7.1 puts the reminder in compliance and NOT in '
   'interactive, and gives the reason: a late reminder can fire OUTSIDE the legal '
   'calling window. The 15-minute drop rule bounds the damage; the lane is what '
   'keeps it from being reached behind a storm.',
   '0070_job_latency_lanes'),

  ('call-merge', 'interactive',
   'A live call landing in a seller''s book. §11.7.1: delay is measured in seconds '
   'on the number the entire lead spend is judged by. It is also the queue the '
   'Gate 6 storm actually fills, which is precisely why it must not share a lane '
   'with the STOP chain.',
   '0070_job_latency_lanes'),

  ('dead-letter', 'bulk',
   'Recording a failure that already happened. Nothing downstream is waiting on '
   'it and an operator reads the row weeks later, so §11.7.1''s test applies '
   'literally: delay is invisible.',
   '0070_job_latency_lanes')
ON CONFLICT (queue_name) DO NOTHING;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3 · THE LANE LOOKUP
-- ---------------------------------------------------------------------------
-- 🔴 THE ENQUEUER CANNOT CHOOSE THE LANE (§2396). The lane is looked up from
-- the registry, never passed in — a caller that could name its own lane could
-- name `bulk` for a STOP, which is the one reclassification this whole object
-- exists to make visible.
--
-- Raises rather than returning NULL for an unregistered queue: §2382's half (b)
-- is that a queue with no registry row must fail rather than default, and a
-- NULL here would flow into a worker that silently drains nothing.
CREATE OR REPLACE FUNCTION ref.job_lane_of(p_queue_name text)
RETURNS text
LANGUAGE plpgsql
STABLE
AS $fn$
DECLARE
  v_lane text;
BEGIN
  SELECT r.lane INTO v_lane
    FROM ref.job_registry r
   WHERE r.queue_name = p_queue_name;

  IF v_lane IS NULL THEN
    RAISE EXCEPTION 'JL001: queue % has no ref.job_registry row, so it has no lane and nothing would drain it', p_queue_name;
  END IF;

  RETURN v_lane;
END;
$fn$;--> statement-breakpoint

REVOKE ALL ON FUNCTION ref.job_lane_of(text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION ref.job_lane_of(text) TO crm_app;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4 · REGISTRATION
-- ---------------------------------------------------------------------------
-- `reference`, no tenant dimension, and IMMUTABLE — the same treatment
-- `ref.ci_ratchet_name` gets and for the same reason §2407 gives about this
-- object: reclassifying a job from `compliance` to `bulk` must not be a row
-- edit. With the immutability trigger installed, changing one requires dropping
-- a protected trigger, which is counted rather than quiet.
INSERT INTO security.table_registry
  (schema_name, table_name, policy_class, owner_column, immutable, app_can_insert,
   protected_columns, exception_reason, registered_in_migration)
VALUES
  ('ref', 'job_registry', 'reference', NULL, true, false, NULL,
   'The job latency axis. No tenant dimension. Immutable so a queue cannot be moved between lanes by a row edit: 05c §2407 requires a reclassification to be visible rather than free.',
   '0070_job_latency_lanes')
ON CONFLICT (schema_name, table_name) DO UPDATE
  SET policy_class            = EXCLUDED.policy_class,
      immutable               = EXCLUDED.immutable,
      app_can_insert          = EXCLUDED.app_can_insert,
      exception_reason        = EXCLUDED.exception_reason,
      registered_in_migration = EXCLUDED.registered_in_migration;--> statement-breakpoint

SELECT security.harden();
