-- THE PUBLIC BOARD READ COSTS 192 ms AND IT SHOULD COST ONE. MEASURED, THEN
-- DIAGNOSED, THEN THIS.
--
-- P11 (`04b` §3.2) budgets the leaderboard poll at a p95 of 80 ms for a `304`,
-- warning at 40. On the fifty-seller `perf-floor` fixture it measured **238 ms
-- p95, 192 ms median** — and the split says where: the read is 192 ms and the
-- ETag serialize-and-compare is 0.2 ms. The caching layer was never the
-- problem.
--
-- §1183 assumed 2 ms per `304` and built the cost model on it: *"17 req/s x
-- 2 ms = 34 ms of CPU per wall second ~ 7 % of a 0.5-CPU Starter instance. That
-- is the number that makes a 5-second poll compatible with USD 7/month of
-- compute."* It also said the 2 ms *"is an assumption until Puerta 2 measures
-- it"*. Measured, it was out by about a hundred times.
--
-- ---------------------------------------------------------------------------
-- WHAT IT ACTUALLY WAS
-- ---------------------------------------------------------------------------
-- `EXPLAIN (ANALYZE, BUFFERS)` on the withheld CTE:
--
--   Seq Scan on earnings_ledger  (actual time=177.597..177.597 rows=0)
--     Rows Removed by Filter: 6400
--     Buffers: shared hit=13000
--
-- Thirteen thousand buffers to reject six thousand four hundred rows — two
-- pages per row, on a table whose every row fits in a fraction of one. The
-- filter is the cause:
--
--   e.recorded_at > clock_timestamp()
--                     - make_interval(secs => app.projection_reveal_delay_ms() / 1000.0)
--
-- `projection_reveal_delay_ms()` is STABLE and would be evaluated once — but
-- `clock_timestamp()` is VOLATILE BY DEFINITION, so the expression CONTAINING
-- it is re-evaluated for every row, and it drags the STABLE function along with
-- it. That function reads `ref.timing_constant`. Six thousand four hundred rows
-- therefore performed six thousand four hundred lookups of a one-row table, and
-- those lookups are the thirteen thousand buffers.
--
-- This is N13's lesson in the money path: the schema was already right and the
-- SQL could not use it. Nothing about the index, the table or the volatility
-- markings needed to change.
--
-- MEASURED AFTER, same fixture, same session: **177 ms -> 0.87 ms, 13 000
-- buffers -> 43.**
--
-- ---------------------------------------------------------------------------
-- AND IT IS ALSO MORE CORRECT, which is why this is not a tuning change
-- ---------------------------------------------------------------------------
-- A per-row `clock_timestamp()` judges different rows against different
-- instants. This predicate decides which wins are still inside the reveal delay
-- and must be WITHHELD from a public board; evaluating it once per read is the
-- semantics ruling R1.3 describes, and evaluating it per row was never
-- deliberate. Two sellers' entries a microsecond apart could land on opposite
-- sides of a boundary that is supposed to be one instant.
--
-- The two `undo_deadline_ms()` calls inside the NOT EXISTS clauses are hoisted
-- for the same reason. They cost less today only because they run on the rows
-- the first filter already passed, which is normally none — a smaller version
-- of the same defect, fixed at the same time rather than left to be rediscovered.
--
-- NO BEHAVIOUR CHANGES OTHERWISE. The body is repeated in full because a
-- function body cannot be patched and a migration is never edited after merge.
-- `undo-window.spec.ts`, `celebration.test.ts` and `honest-board.spec.ts` all
-- assert the withholding this function performs, and they are what proves the
-- rewrite kept it.

CREATE OR REPLACE FUNCTION app.leaderboard_read(
  p_period_type app.period_type,
  p_period_key  date
)
RETURNS TABLE (user_id uuid, total_cents bigint, entry_count integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = app, ref, pg_catalog
AS $fn$
  -- MATERIALIZED, so the planner may not inline it back into the row filter and
  -- undo the whole point of this migration.
  WITH bounds AS MATERIALIZED (
    SELECT clock_timestamp()
             - make_interval(secs => app.projection_reveal_delay_ms() / 1000.0) AS reveal_cutoff,
           make_interval(secs => app.undo_deadline_ms() / 1000.0)               AS undo_window
  ),
  withheld AS (
    SELECT e.owner_user_id, sum(e.delta_cents) AS cents, count(*) AS n
    FROM app.earnings_ledger e
    WHERE e.tenant_id = app.current_tenant()
      AND e.recorded_at > (SELECT reveal_cutoff FROM bounds)
      AND CASE p_period_type
            WHEN 'day'      THEN e.period_day   = p_period_key
            WHEN 'week'     THEN e.period_week  = p_period_key
            WHEN 'month'    THEN e.period_month = p_period_key
            ELSE true
          END
      -- e is the reversal half of an undo
      AND NOT EXISTS (
        SELECT 1 FROM app.earnings_ledger t
         WHERE t.tenant_id = e.tenant_id
           AND t.id = e.reverses_entry_id
           AND e.recorded_at <= t.recorded_at + (SELECT undo_window FROM bounds))
      -- e is the half that was undone
      AND NOT EXISTS (
        SELECT 1 FROM app.earnings_ledger r
         WHERE r.tenant_id = e.tenant_id
           AND r.reverses_entry_id = e.id
           AND r.recorded_at <= e.recorded_at + (SELECT undo_window FROM bounds))
    GROUP BY e.owner_user_id
  )
  SELECT lp.user_id,
         lp.total_cents - coalesce(w.cents, 0),
         lp.entry_count - coalesce(w.n, 0)::integer
  FROM app.leaderboard_projection lp
  LEFT JOIN withheld w ON w.owner_user_id = lp.user_id
  WHERE lp.tenant_id = app.current_tenant()
    AND lp.period_type = p_period_type
    AND lp.period_key = p_period_key
$fn$;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION app.leaderboard_read(app.period_type, date) TO crm_app;
