-- The claim has to actually claim, and pg-boss gets a schema it may not extend.
--
-- THE DEFECT, found while wiring the process that consumes this:
--
-- `app.scheduled_job_claim` was a plain SELECT. It took no lock and it left no
-- mark, so two dispatchers running the same second received THE SAME ROWS and
-- both fired them. `scheduled_job_resolve` updates `WHERE status = 'pending'`,
-- so the second resolve is a harmless no-op — but the SIDE EFFECT has already
-- happened twice by then, and the side effect here is a message to a consumer's
-- phone. A reminder is a legal artifact: it must fire once, at the right
-- instant, inside the legal calling window. Twice is not a smaller version of
-- that promise.
--
-- Invisible until now for a good reason: nothing called it. The domain layer
-- landed in Sprint 1.6 and the process that consumes it is this change, which
-- is exactly when a single-caller assumption becomes a concurrency bug.
--
-- Two mechanisms, and BOTH are needed:
--   FOR UPDATE SKIP LOCKED  stops two claims in flight from picking one row.
--   claimed_at              survives the transaction. Without it, the lock ends
--                           the moment the claim returns and the next tick —
--                           milliseconds later, before the work is resolved —
--                           picks the same job up again.

-- ---------------------------------------------------------------------------
-- 1 · The lease
-- ---------------------------------------------------------------------------
ALTER TABLE app.scheduled_job
  ADD COLUMN IF NOT EXISTS claimed_at timestamptz;
--> statement-breakpoint

-- A dispatcher that dies mid-job leaves the row claimed and still pending. The
-- lease is what makes that recoverable rather than a job lost in silence, and
-- it is deliberately SHORTER than the fifteen minutes after which a reminder is
-- dropped as too late: one retry fits inside the window, and a job that keeps
-- failing reaches its terminal `dropped_late` row instead of being retried
-- forever into the night.
COMMENT ON COLUMN app.scheduled_job.claimed_at IS
  'Lease taken by the dispatcher. NULL means claimable. Older than the lease means the claimer died.';
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS scheduled_job_claimable_idx
  ON app.scheduled_job (fire_at)
  WHERE status = 'pending' AND canceled_at IS NULL;
--> statement-breakpoint

DROP FUNCTION IF EXISTS app.scheduled_job_claim(integer);
--> statement-breakpoint

-- Same fairness as before, now with the claim it was named for.
--
-- DISTINCT ON gives each tenant its oldest due job before any tenant gets a
-- second, so ONE tenant's twenty-thousand-webhook recovery storm cannot starve
-- every other tenant's T-1h reminders — and a reminder that fires late can fire
-- OUTSIDE the legal calling window. Noisy-neighbour with a plaintiff attached
-- (§9.6 residual #2).
--
-- FOR UPDATE cannot be combined with DISTINCT, so the fair pick and the lock
-- are separate CTEs rather than one clever query.
--
-- This is one of exactly four enumerated cross-tenant paths. It returns ids and
-- tenants only; every caller must then set per-row context before it touches a
-- domain table.
CREATE OR REPLACE FUNCTION app.scheduled_job_claim(
  p_limit integer  DEFAULT 50,
  p_lease interval DEFAULT interval '5 minutes'
)
RETURNS TABLE (tenant_id uuid, job_id uuid, kind app.scheduled_kind,
               subject_id uuid, fire_at timestamptz)
LANGUAGE sql
SECURITY DEFINER
SET search_path = app, pg_catalog
AS $fn$
  WITH fair AS (
    SELECT DISTINCT ON (j.tenant_id) j.tenant_id, j.id, j.fire_at
    FROM app.scheduled_job j
    WHERE j.status = 'pending'
      AND j.canceled_at IS NULL
      AND j.fire_at <= clock_timestamp()
      AND (j.claimed_at IS NULL OR j.claimed_at < clock_timestamp() - p_lease)
    ORDER BY j.tenant_id, j.fire_at
  ),
  due AS (
    SELECT f.tenant_id, f.id FROM fair f ORDER BY f.fire_at LIMIT p_limit
  ),
  locked AS (
    SELECT j.tenant_id, j.id
    FROM app.scheduled_job j
    JOIN due d ON d.tenant_id = j.tenant_id AND d.id = j.id
    FOR UPDATE OF j SKIP LOCKED
  )
  UPDATE app.scheduled_job s
     SET claimed_at = clock_timestamp()
    FROM locked l
   WHERE s.tenant_id = l.tenant_id AND s.id = l.id
  RETURNING s.tenant_id, s.id, s.kind, s.subject_id, s.fire_at
$fn$;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION app.scheduled_job_claim(integer, interval) TO crm_app;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2 · pg-boss owns a schema it is not allowed to change
-- ---------------------------------------------------------------------------
-- Without this row the next deploy dies with HR001 the moment pg-boss exists:
-- `security.managed_relations()` scans EVERY schema and `harden()` refuses any
-- unclassified table. That is the gate working, not a problem to route around —
-- so the exemption is written here, with its reason, rather than discovered in
-- a red deploy.
--
-- Its tables are installed by the MIGRATOR at deploy time (`npm run db:jobs`)
-- and the worker connects as `crm_app` with `migrate: false` and no CREATE on
-- the schema. That ordering matters: pg-boss will happily migrate its own
-- schema at boot, and a library issuing DDL against production under the
-- application's credential is the shape of change this project does not accept.
-- Measured before relying on it — a queue in pg-boss 12 is unpartitioned by
-- default, so nothing it does at runtime needs to create an object.
INSERT INTO security.schema_policy (schema_name, posture, exception_reason)
VALUES ('pgboss', 'exempt',
  'Job queue owned by the migrator. Installed at deploy, never at boot; crm_app holds DML and EXECUTE and no CREATE, so it cannot alter what it runs on. Its rows carry no tenant dimension — a queue entry is a pointer to app.scheduled_job, which is where the tenant scoping and the audit live.')
ON CONFLICT (schema_name) DO UPDATE
  SET posture = EXCLUDED.posture, exception_reason = EXCLUDED.exception_reason;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3 · Reclassify, then harden
-- ---------------------------------------------------------------------------
-- claimed_at joins the protected list. The lease is the dispatcher's, and an
-- application role that can clear it can make one reminder fire twice — the
-- exact failure this migration exists to close, reintroduced through a plain
-- UPDATE.
UPDATE security.table_registry
   SET protected_columns = protected_columns || ARRAY['claimed_at'],
       registered_in_migration = '0020_job_dispatch'
 WHERE schema_name = 'app' AND table_name = 'scheduled_job'
   AND NOT ('claimed_at' = ANY (protected_columns));
--> statement-breakpoint

SELECT security.harden();
