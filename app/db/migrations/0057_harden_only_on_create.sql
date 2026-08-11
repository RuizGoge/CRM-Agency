-- ===========================================================================
-- THE PARTITION MAINTENANCE WAS TAKING ACCESS EXCLUSIVE ON EVERY TABLE, ONCE A
-- MINUTE, FOREVER.
--
-- 🔴 FOUND BY GATE 5, WHICH IS THE POINT OF GATE 5. Running the same e2e suite
-- against the split topology produced this, and the folded run did not:
--
--   [WebServer] DrizzleQueryError: SELECT * FROM app.leaderboard_board(...)
--   [WebServer]   cause: PostgresError: deadlock detected
--   [relay] pass failed
--
-- §2543's failure clause is "if any behaviour differs between topologies, the
-- split is not configuration and the cheap tier is a trap." The behaviour
-- differed. The cause is not the topology, though — it is a defect 0051 and
-- 0053 introduced, which the fold happened to hide.
--
-- WHAT WAS ACTUALLY HAPPENING. `ensure_event_partitions` and
-- `ensure_audit_partitions` end in `PERFORM security.harden()`, and the worker
-- calls both on EVERY dispatch tick — once a minute (`worker.ts`, and again at
-- boot). `harden()` iterates every managed relation issuing ALTER TABLE ...
-- FORCE ROW LEVEL SECURITY, DROP POLICY, CREATE POLICY, REVOKE, GRANT, DROP
-- TRIGGER and CREATE TRIGGER. Every one of those takes ACCESS EXCLUSIVE.
--
-- So once a minute the worker briefly locked every table in `app` and `ref`
-- against all readers. Folded, that contends with the same process and mostly
-- interleaves; split, it is a separate backend and Postgres reported the
-- deadlock. Neither is acceptable: a lock storm on a fixed schedule is a
-- product that stutters for reasons no seller could ever describe.
--
-- THE FIX IS THAT HARDENING BELONGS TO CREATION, NOT TO THE TICK. A partition
-- created in flight genuinely must be hardened — that reasoning from 0051
-- stands, and `silo.test.ts` proved it once by catching a managed relation with
-- FORCE RLS off. What does not follow is hardening when nothing was created,
-- which is what happens on 1,439 of every 1,440 daily ticks.
--
-- ⚠️ AND `made` WAS ALREADY LYING. Both functions incremented it once per loop
-- ITERATION rather than once per creation, so they returned 18 on every call
-- and there was no way to tell a tick that did work from one that did not —
-- which is also why nobody noticed the harden was unconditional.
-- ===========================================================================

CREATE OR REPLACE FUNCTION app.ensure_event_partitions(
  p_months integer DEFAULT 3,
  p_days   integer DEFAULT 14
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = app, ref, pg_catalog
AS $fn$
DECLARE
  i     integer;
  m     date;
  d     date;
  part  text;
  made  integer := 0;
BEGIN
  -- Cluster storage, not tenant data: exempt from the definer-tenancy gate with
  -- that reason recorded there. Unchanged from 0051.
  FOR i IN 0..p_months LOOP
    m := (date_trunc('month', clock_timestamp()) + make_interval(months => i))::date;
    part := 'event_log_' || to_char(m, 'YYYY_MM');

    -- ASKED BEFORE CREATING, so `made` counts creations rather than loop trips.
    -- `CREATE TABLE IF NOT EXISTS` cannot report whether it did anything, and
    -- that missing signal is precisely why the harden below ran unconditionally.
    IF to_regclass('app.' || quote_ident(part)) IS NULL THEN
      EXECUTE format(
        'CREATE TABLE IF NOT EXISTS app.%I PARTITION OF app.event_log FOR VALUES FROM (%L) TO (%L)',
        part, m, (m + interval '1 month')::date);
      made := made + 1;
    END IF;
  END LOOP;

  FOR i IN 0..p_days LOOP
    d := (clock_timestamp() + make_interval(days => i))::date;
    part := 'event_outbox_' || to_char(d, 'YYYY_MM_DD');

    IF to_regclass('app.' || quote_ident(part)) IS NULL THEN
      EXECUTE format(
        'CREATE TABLE IF NOT EXISTS app.%I PARTITION OF app.event_outbox FOR VALUES FROM (%L) TO (%L)',
        part, d, d + 1);
      made := made + 1;
    END IF;
  END LOOP;

  -- 🔴 ONLY WHEN SOMETHING WAS CREATED. A new partition is a managed relation
  -- with no policy until this runs, so skipping it then would leave a table
  -- holding events with FORCE RLS off. Running it when nothing was created buys
  -- nothing and costs ACCESS EXCLUSIVE on every table in the schema.
  IF made > 0 THEN
    PERFORM security.harden();
  END IF;

  RETURN made;
END;
$fn$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.ensure_audit_partitions(p_months integer DEFAULT 3)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = app, ref, pg_catalog
AS $fn$
DECLARE
  i    integer;
  m    date;
  part text;
  made integer := 0;
BEGIN
  FOR i IN 0..p_months LOOP
    m := (date_trunc('month', clock_timestamp()) + make_interval(months => i))::date;
    part := 'audit_log_' || to_char(m, 'YYYY_MM');

    IF to_regclass('app.' || quote_ident(part)) IS NULL THEN
      EXECUTE format(
        'CREATE TABLE IF NOT EXISTS app.%I PARTITION OF app.audit_log FOR VALUES FROM (%L) TO (%L)',
        part, m, (m + interval '1 month')::date);

      -- The per-partition dedupe index, created with its partition rather than
      -- on the parent: a unique index on a partitioned parent must contain every
      -- partitioning column, and adding `occurred_at` would destroy the point.
      EXECUTE format(
        'CREATE UNIQUE INDEX IF NOT EXISTS %I ON app.%I '
        '(tenant_id, action, actor_user_id, subject_id, dedupe_bucket) '
        'WHERE dedupe_bucket IS NOT NULL',
        left(part || '_dedupe_uidx', 63), part);

      made := made + 1;
    END IF;
  END LOOP;

  IF made > 0 THEN
    PERFORM security.harden();
  END IF;

  RETURN made;
END;
$fn$;--> statement-breakpoint

-- Run once here so this deploy's own partitions are correct, and so that the
-- first tick after it has nothing to do — which is the steady state this
-- migration exists to produce.
SELECT app.ensure_event_partitions();--> statement-breakpoint
SELECT app.ensure_audit_partitions();--> statement-breakpoint

SELECT security.harden();
