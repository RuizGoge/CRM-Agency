-- ===========================================================================
-- `folded_topology_saturated` BECOMES A LEGAL ALERT, AND GETS A WRITER.
--
-- Gate 6 ran on 2026-08-10 and could not close. Four of its assertions had no
-- subject; this migration builds the database half of three of them.
--
-- §2444's table is the specification, and it is exact:
--
--   | What degrades under a folded storm | Detection | Where Jorge sees it |
--   | SSR + API p95 (shared event loop)  | perf_hooks.monitorEventLoopDelay
--     histogram sampled per process; p99 > 200 ms sustained 60 s ->
--     admin_alert(kind='folded_topology_saturated') | /admin/integration-health,
--     with the literal remediation: "Split the processes." |
--
-- The kind was not a legal value: `admin_alert_kind` is a CHECK over five
-- literals and this is not one, so §2548's demand that the row "actually fire"
-- could not be met even by hand.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1 · THE VOCABULARY
-- ---------------------------------------------------------------------------
-- A CHECK and not an enum, so widening it is DROP then ADD rather than
-- ALTER TYPE. Both statements name the constraint that exists rather than
-- assuming one — read off `pg_constraint` before writing this.
--
-- ⚠️ `topology_split_required` IS DELIBERATELY NOT ADDED. §2453 names it, and
-- its trip condition depends on `system_constant['fold_split_webhooks_per_day_max']`,
-- which does not exist as a row because Gate 6 refused to write it: the
-- `cpu_ms_per_webhook` it would derive from was measured on a developer machine
-- and includes the poll floor's own CPU. Adding a kind with no writer is
-- exactly the condition the register already complains about for four of the
-- five existing kinds. One value, one writer, in the same migration.
ALTER TABLE "app"."admin_alert" DROP CONSTRAINT "admin_alert_kind";--> statement-breakpoint

ALTER TABLE "app"."admin_alert" ADD CONSTRAINT "admin_alert_kind"
  CHECK ("kind" IN ('unmapped_number', 'mapping_unverified', 'unmapped_disposition',
                    'ingest_throttled', 'reconciliation_unavailable',
                    'folded_topology_saturated'));--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2 · THE WRITER
-- ---------------------------------------------------------------------------
-- 🔴 A PROCESS HAS NO TENANT, AND THAT IS THE WHOLE DIFFICULTY.
--
-- `app.admin_alert_raise` reads `app.current_tenant()` and raises AL001 without
-- one. An event loop is a property of the PROCESS: when it saturates, every
-- agency served by that process is degraded at the same instant. There is no
-- single tenant to attribute it to, and picking one would be a lie that reads
-- like data.
--
-- FAN-OUT, one row per tenant, and the reason is that the statement is TRUE for
-- each of them: a seller in agency B whose board is slow because agency A's
-- provider is retrying is not having a different experience. The dedupe index
-- `(tenant_id, kind, subject_key)` collapses a sustained condition into one row
-- per agency rather than one per sample.
--
-- ⚠️ THIS IS A CROSS-TENANT WRITE, and it is the first in the tree — the four
-- sanctioned cross-tenant paths so far are all claims or reads. It is bounded
-- to a degree that makes it arguable: it writes ONE table, with a kind list
-- checked inside the function, carrying no business data of any kind, and it
-- reads nothing but `app.tenant.id`. It cannot express a contact, a dollar or a
-- name. A wider cross-tenant writer would not be acceptable and this one is not
-- a precedent for one.
--
-- WHY NOT GRANT `admin_alert_raise` TO crm_app INSTEAD: 0049:58-63 refuses that
-- by name — "granting EXECUTE to the application would let a request
-- manufacture an operational signal". That reasoning holds. This function is
-- narrower in the way that matters: the kinds it accepts are process-health
-- facts with no business meaning, so the worst a forged call can do is tell an
-- admin the process is slow.
CREATE OR REPLACE FUNCTION app.process_alert_raise(
  p_kind   text,
  p_detail text
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = app, pg_catalog
AS $fn$
DECLARE
  v_rows integer;
BEGIN
  -- DELIBERATELY DOES NOT CALL app.current_tenant(). The condition it reports
  -- belongs to the operating system process, not to an agency, and the caller
  -- is a monitor running in the worker loop with no session. Named in the
  -- exemption list of tests/integration/definer-tenancy.test.ts with that
  -- reason written there rather than assumed here.

  -- The kind list is checked HERE as well as by the table's CHECK, and the two
  -- are not redundant: the table permits six kinds and this function must
  -- permit only the process-health ones. Without this a caller reachable from a
  -- request could manufacture `unmapped_number` — which IS a business signal,
  -- and is the thing 0049 refused to allow.
  IF p_kind NOT IN ('folded_topology_saturated') THEN
    RAISE EXCEPTION 'PA001: % is not a process-health alert kind', p_kind
      USING HINT = 'This writer exists for facts about the process. Business alerts go through app.admin_alert_raise, which requires a tenant.';
  END IF;

  IF p_detail IS NULL OR btrim(p_detail) = '' THEN
    RAISE EXCEPTION 'PA002: a process alert with no detail says only that something happened';
  END IF;

  INSERT INTO app.admin_alert (tenant_id, kind, subject_key, detail)
  SELECT t.id, p_kind, '', p_detail
    FROM app.tenant t
  ON CONFLICT (tenant_id, kind, subject_key) DO UPDATE
    SET occurrence_count = app.admin_alert.occurrence_count + 1,
        last_seen_at     = clock_timestamp(),
        detail           = EXCLUDED.detail,
        -- 🔴 THE ACKNOWLEDGEMENT IS CLEARED ON RECURRENCE, and this differs from
        -- the business alerts on purpose. `admin_alert_subject_uidx` is NOT
        -- partial, so a row acknowledged once would be silenced forever — for a
        -- condition that comes and goes, that means the FIRST storm is the only
        -- one anybody is ever told about. An acknowledgement answers "I have
        -- seen this"; the process saturating again is a new thing to see.
        acknowledged_at  = NULL;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows;
END;
$fn$;--> statement-breakpoint

REVOKE ALL ON FUNCTION app.process_alert_raise(text, text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.process_alert_raise(text, text) TO crm_app;--> statement-breakpoint

SELECT security.harden();
