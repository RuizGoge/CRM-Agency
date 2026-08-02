-- Scheduling: the reminder, the reschedule, and a claim that cannot starve.

-- ---------------------------------------------------------------------------
-- 1 · A meeting's timezone is validated, because it decides legality
-- ---------------------------------------------------------------------------
-- Not a CHECK: pg_timezone_names is not immutable. A bad zone here does not
-- merely display a wrong local time — it decides whether the T-1h reminder was
-- legal to send, and that answer has to survive years of hindsight.
CREATE OR REPLACE FUNCTION app.validate_contact_timezone()
RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = NEW.contact_timezone) THEN
    RAISE EXCEPTION 'TZ002: contact_timezone "%" is not a recognised IANA zone', NEW.contact_timezone;
  END IF;
  RETURN NEW;
END
$fn$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS t_meeting_timezone ON app.meeting;
--> statement-breakpoint
CREATE TRIGGER t_meeting_timezone
  BEFORE INSERT OR UPDATE OF contact_timezone ON app.meeting
  FOR EACH ROW EXECUTE FUNCTION app.validate_contact_timezone();
--> statement-breakpoint

-- `needs_outcome` is a DERIVED predicate, never a stored column, so it cannot
-- go stale between the moment a meeting ends and the moment a job notices.
CREATE OR REPLACE VIEW app.meeting_needs_outcome
  WITH (security_invoker = true) AS
  SELECT * FROM app.meeting
  WHERE canceled_at IS NULL AND outcome IS NULL AND starts_at_utc < clock_timestamp();
--> statement-breakpoint

GRANT SELECT ON app.meeting_needs_outcome TO crm_app;
--> statement-breakpoint

CREATE OR REPLACE VIEW app.task
  WITH (security_invoker = true) AS
  SELECT * FROM app.activity WHERE type = 'task' AND canceled_at IS NULL;
--> statement-breakpoint

GRANT SELECT ON app.task TO crm_app;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2 · Scheduling, where a reschedule cannot double-book a reminder
-- ---------------------------------------------------------------------------
-- Cancel-then-insert inside ONE statement path, so there is never a window in
-- which two live jobs exist for the same episode. The partial unique index is
-- what makes a second enqueue impossible rather than merely unlikely.
CREATE OR REPLACE FUNCTION app.schedule_job(
  p_kind            app.scheduled_kind,
  p_idempotency_key text,
  p_subject_type    text,
  p_subject_id      uuid,
  p_fire_at         timestamptz,
  p_owner_user_id   uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = app, pg_catalog
AS $fn$
DECLARE
  v_tenant uuid;
  v_id     uuid;
BEGIN
  v_tenant := app.current_tenant();
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'SJ001: schedule_job called with no tenant context';
  END IF;

  UPDATE app.scheduled_job
     SET canceled_at = clock_timestamp(),
         status      = 'canceled',
         resolved_at = clock_timestamp()
   WHERE tenant_id = v_tenant
     AND kind = p_kind
     AND idempotency_key = p_idempotency_key
     AND canceled_at IS NULL;

  INSERT INTO app.scheduled_job
    (tenant_id, kind, idempotency_key, subject_type, subject_id, owner_user_id, fire_at)
  VALUES
    (v_tenant, p_kind, p_idempotency_key, p_subject_type, p_subject_id, p_owner_user_id, p_fire_at)
  RETURNING id INTO v_id;

  RETURN v_id;
END
$fn$;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION app.schedule_job(app.scheduled_kind, text, text, uuid, timestamptz, uuid)
  TO crm_app;
--> statement-breakpoint

-- The T-1h reminder, keyed exactly as the brief demands: one live reminder per
-- meeting, and rescheduling the meeting moves it rather than adding a second.
CREATE OR REPLACE FUNCTION app.schedule_meeting_reminder(p_meeting_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = app, pg_catalog
AS $fn$
DECLARE
  v_tenant  uuid;
  v_meeting app.meeting%ROWTYPE;
BEGIN
  v_tenant := app.current_tenant();
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'SJ001: schedule_meeting_reminder called with no tenant context';
  END IF;

  SELECT * INTO v_meeting FROM app.meeting m
   WHERE m.tenant_id = v_tenant AND m.id = p_meeting_id AND m.canceled_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SJ404: no such meeting';
  END IF;

  RETURN app.schedule_job(
    'meeting_reminder',
    p_meeting_id::text || ':t_minus_60m',
    'meeting',
    p_meeting_id,
    v_meeting.starts_at_utc - interval '1 hour',
    v_meeting.owner_user_id);
END
$fn$;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION app.schedule_meeting_reminder(uuid) TO crm_app;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3 · The claim, round-robin by tenant
-- ---------------------------------------------------------------------------
-- Residual risk #2 in §9.6, and it has a compliance edge rather than a merely
-- operational one. Ordering purely by fire_at across all tenants lets ONE
-- tenant's twenty-thousand-webhook recovery storm starve every other tenant's
-- T-1h reminders — and a reminder that fires late can fire OUTSIDE the legal
-- calling window. Noisy-neighbour with a plaintiff attached.
--
-- DISTINCT ON gives each tenant its oldest due job before any tenant gets a
-- second, so a backlog in one book cannot delay another's.
--
-- This is one of exactly four enumerated cross-tenant paths. It returns ids
-- and tenants only; every caller must then set per-row context before it
-- touches any domain table.
CREATE OR REPLACE FUNCTION app.scheduled_job_claim(p_limit integer DEFAULT 50)
RETURNS TABLE (tenant_id uuid, job_id uuid, kind app.scheduled_kind, subject_id uuid)
LANGUAGE sql
SECURITY DEFINER
SET search_path = app, pg_catalog
AS $fn$
  WITH fair AS (
    SELECT DISTINCT ON (j.tenant_id) j.tenant_id, j.id
    FROM app.scheduled_job j
    WHERE j.status = 'pending'
      AND j.canceled_at IS NULL
      AND j.fire_at <= clock_timestamp()
    ORDER BY j.tenant_id, j.fire_at
  )
  SELECT j.tenant_id, j.id, j.kind, j.subject_id
  FROM app.scheduled_job j
  JOIN fair ON fair.id = j.id
  ORDER BY j.fire_at
  LIMIT p_limit
$fn$;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION app.scheduled_job_claim(integer) TO crm_app;
--> statement-breakpoint

-- A job resolves to a terminal state. `skipped` is FIRST-CLASS, not an error:
-- it is what makes the SMS-dark rehearsal pass with no path erroring, and it
-- is the evidence that a reminder was skipped rather than lost.
CREATE OR REPLACE FUNCTION app.scheduled_job_resolve(
  p_job_id uuid,
  p_status app.job_status,
  p_reason text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = app, pg_catalog
AS $fn$
DECLARE
  v_tenant uuid;
BEGIN
  v_tenant := app.current_tenant();
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'SJ001: scheduled_job_resolve called with no tenant context';
  END IF;

  IF p_status = 'pending' THEN
    RAISE EXCEPTION 'SJ002: pending is not a terminal state';
  END IF;

  UPDATE app.scheduled_job
     SET status = p_status, terminal_reason = p_reason, resolved_at = clock_timestamp()
   WHERE tenant_id = v_tenant AND id = p_job_id AND status = 'pending';
END
$fn$;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION app.scheduled_job_resolve(uuid, app.job_status, text) TO crm_app;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4 · Classify, then harden
-- ---------------------------------------------------------------------------
INSERT INTO security.table_registry
  (schema_name, table_name, policy_class, owner_column, immutable, app_can_insert,
   protected_columns, exception_reason, registered_in_migration)
VALUES
  ('app', 'activity', 'owner_scoped', 'owner_user_id', false, true, NULL, NULL, '0015_scheduling'),
  ('app', 'meeting',  'owner_scoped', 'owner_user_id', false, true, NULL, NULL, '0015_scheduling'),
  -- Scheduling intent is written by definers only. A seller cannot enqueue,
  -- cancel or resolve a job by hand, so the episode-idempotency guarantee is a
  -- privilege fact rather than a convention. Read stays owner-scoped so My Day
  -- can explain why a reminder was skipped.
  ('app', 'scheduled_job', 'owner_scoped', 'owner_user_id', false, false,
   ARRAY['status','terminal_reason','fire_at','canceled_at','resolved_at','boss_job_id',
         'kind','idempotency_key','subject_type','subject_id'],
   NULL, '0015_scheduling')
ON CONFLICT (schema_name, table_name) DO UPDATE
  SET policy_class            = EXCLUDED.policy_class,
      owner_column            = EXCLUDED.owner_column,
      immutable               = EXCLUDED.immutable,
      app_can_insert          = EXCLUDED.app_can_insert,
      protected_columns       = EXCLUDED.protected_columns,
      exception_reason        = EXCLUDED.exception_reason,
      registered_in_migration = EXCLUDED.registered_in_migration;
--> statement-breakpoint

SELECT security.harden();
