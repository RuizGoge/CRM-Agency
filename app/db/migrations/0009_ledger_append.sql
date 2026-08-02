-- The money path: the only writer, the two named intervals, and annualisation.

-- ---------------------------------------------------------------------------
-- 1 · The two intervals, which are NEVER given one name
-- ---------------------------------------------------------------------------
-- Errata E7 and NEW-1 record what happens when one name is asked to mean two
-- durations: one branch silently refuses every celebration claim, the other
-- reveals a still-undoable win on a public board — and a drift test that
-- compares names instead of values stays green in both. So there is no
-- `app.undo_window()`, deliberately, and IV004 asserts no function body ever
-- calls one.
CREATE TABLE IF NOT EXISTS ref.timing_constant (
  key      text PRIMARY KEY,
  value_ms integer NOT NULL CHECK (value_ms >= 0),
  purpose  text NOT NULL
);
--> statement-breakpoint

INSERT INTO ref.timing_constant (key, value_ms, purpose) VALUES
  ('undo_deadline_ms', 5000,
   'The celebration claim deadline and the undo toast lifetime. One number a seller learns.'),
  ('projection_reveal_delay_ms', 5500,
   'The PUBLIC projection predicate only. undo_deadline_ms + undo_projection_guard_ms, because recorded_at is stamped at INSERT while the seller''s undo timer starts after COMMIT plus network.')
ON CONFLICT (key) DO UPDATE
  SET value_ms = EXCLUDED.value_ms, purpose = EXCLUDED.purpose;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.undo_deadline_ms()
RETURNS integer LANGUAGE sql STABLE AS $fn$
  SELECT value_ms FROM ref.timing_constant WHERE key = 'undo_deadline_ms'
$fn$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.projection_reveal_delay_ms()
RETURNS integer LANGUAGE sql STABLE AS $fn$
  SELECT value_ms FROM ref.timing_constant WHERE key = 'projection_reveal_delay_ms'
$fn$;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION app.undo_deadline_ms() TO crm_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.projection_reveal_delay_ms() TO crm_app;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2 · Annualisation, server-side and exact
-- ---------------------------------------------------------------------------
-- Final Expense sells MONTHLY. Earnings are ANNUAL. Without the x12 the public
-- board is wrong by a factor of twelve, and it looks entirely plausible while
-- being wrong. Integer cents throughout: there is no floating point anywhere
-- on this path, in the database or in the client.
CREATE OR REPLACE FUNCTION app.annualize(p_monthly_cents bigint)
RETURNS bigint LANGUAGE sql IMMUTABLE STRICT AS $fn$
  SELECT p_monthly_cents * 12
$fn$;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION app.annualize(bigint) TO crm_app;
--> statement-breakpoint

CREATE SEQUENCE IF NOT EXISTS app.leaderboard_seq;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3 · ledger_append — the ONLY write path
-- ---------------------------------------------------------------------------
-- crm_app holds no INSERT on earnings_ledger and never will. This definer is
-- the whole surface, and it reaches the table through the crm_migrator policy.
--
-- The consequence Jorge can see: when a model writes `.onConflictDoUpdate()`
-- against the ledger — and it will, because that is the public idiom of upsert
-- — Postgres answers permission denied, the gate returns 500, and the seller
-- reads the specified copy on screen that minute. A silent wrong total is not
-- among the outcomes.
CREATE OR REPLACE FUNCTION app.ledger_append(
  p_owner_user_id        uuid,
  p_source_event_id      uuid,
  p_source_event_name    text,
  p_entry_type           app.ledger_entry_type,
  p_delta_cents          bigint,
  p_occurred_at          timestamptz,
  p_opportunity_id       uuid    DEFAULT NULL,
  p_contact_id           uuid    DEFAULT NULL,
  p_stage_id             uuid    DEFAULT NULL,
  p_stage_name_snapshot  text    DEFAULT NULL,
  p_stage_config_version bigint  DEFAULT NULL,
  p_product_type         app.product_type DEFAULT NULL,
  p_reason               text    DEFAULT NULL,
  p_actor_user_id        uuid    DEFAULT NULL,
  p_reverses_entry_id    uuid    DEFAULT NULL
)
RETURNS TABLE (entry_id uuid, was_duplicate boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = app, ref, pg_catalog
AS $fn$
DECLARE
  v_tenant      uuid;
  v_business_tz text;
  v_day         date;
  v_week        date;
  v_month       date;
  v_id          uuid;
  v_seq         bigint;
  v_recorded    timestamptz;
  v_period      record;
BEGIN
  -- Every SECURITY DEFINER body must contain app.current_tenant(); a CI query
  -- over pg_proc.prosrc asserts it. That grep catches the one way a definer
  -- becomes a cross-tenant hole.
  v_tenant := app.current_tenant();
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'LG001: ledger_append called with no tenant context';
  END IF;

  SELECT t.business_tz INTO v_business_tz FROM app.tenant t WHERE t.id = v_tenant;
  IF v_business_tz IS NULL THEN
    RAISE EXCEPTION 'LG002: tenant % has no business_tz', v_tenant;
  END IF;

  -- The TENANT BUSINESS timezone stamps period_key, and nothing else does.
  -- Not the seller's display timezone, not the lead's local one. Those are
  -- three distinct rules and conflating them silently moves a sale between
  -- months at the boundary.
  v_day   := (p_occurred_at AT TIME ZONE v_business_tz)::date;
  v_week  := date_trunc('week',  v_day)::date;
  v_month := date_trunc('month', v_day)::date;

  v_seq      := nextval('app.leaderboard_seq');
  v_recorded := clock_timestamp();

  INSERT INTO app.earnings_ledger (
    tenant_id, owner_user_id, source_event_id, source_event_name, entry_type,
    delta_cents, opportunity_id, contact_id, stage_id, stage_name_snapshot,
    stage_config_version, product_type, period_day, period_week, period_month,
    business_tz_snapshot, reason, actor_user_id, occurred_at, recorded_at,
    reverses_entry_id
  ) VALUES (
    v_tenant, p_owner_user_id, p_source_event_id, p_source_event_name, p_entry_type,
    p_delta_cents, p_opportunity_id, p_contact_id, p_stage_id, p_stage_name_snapshot,
    p_stage_config_version, p_product_type, v_day, v_week, v_month,
    v_business_tz, p_reason, p_actor_user_id, p_occurred_at, v_recorded,
    p_reverses_entry_id
  )
  ON CONFLICT (tenant_id, source_event_id) DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    -- A second delivery of the same source_event_id. This is a SUCCESS path,
    -- not an error: a double-tap, a provider retry and a replay all land here.
    -- The total is unchanged, nothing is surfaced to the seller, and the
    -- caller gets the id that already exists.
    SELECT e.id INTO v_id
    FROM app.earnings_ledger e
    WHERE e.tenant_id = v_tenant AND e.source_event_id = p_source_event_id;

    RETURN QUERY SELECT v_id, true;
    RETURN;
  END IF;

  -- Four period buckets, maintained rather than summed. The board reads this
  -- and never SUMs the ledger, never scans opportunities.
  FOR v_period IN
    SELECT * FROM (VALUES
      ('day'::app.period_type,      v_day),
      ('week'::app.period_type,     v_week),
      ('month'::app.period_type,    v_month),
      ('all_time'::app.period_type, DATE '1970-01-01')
    ) AS x(period_type, period_key)
  LOOP
    INSERT INTO app.leaderboard_projection (
      tenant_id, period_type, period_key, user_id,
      total_cents, entry_count, seq, last_entry_recorded_at, updated_at
    ) VALUES (
      v_tenant, v_period.period_type, v_period.period_key, p_owner_user_id,
      p_delta_cents, 1, v_seq, v_recorded, v_recorded
    )
    ON CONFLICT (tenant_id, period_type, period_key, user_id) DO UPDATE
      SET total_cents            = app.leaderboard_projection.total_cents + EXCLUDED.total_cents,
          entry_count            = app.leaderboard_projection.entry_count + 1,
          seq                    = EXCLUDED.seq,
          last_entry_recorded_at = EXCLUDED.last_entry_recorded_at,
          updated_at             = EXCLUDED.updated_at;
  END LOOP;

  RETURN QUERY SELECT v_id, false;
END
$fn$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION app.ledger_append(uuid, uuid, text, app.ledger_entry_type, bigint,
  timestamptz, uuid, uuid, uuid, text, bigint, app.product_type, text, uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.ledger_append(uuid, uuid, text, app.ledger_entry_type, bigint,
  timestamptz, uuid, uuid, uuid, text, bigint, app.product_type, text, uuid, uuid) TO crm_app;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4 · The public board read, with the undo window excluded
-- ---------------------------------------------------------------------------
-- R1.3: no viewer ever sees a number that later corrects itself. Entries
-- younger than projection_reveal_delay_ms are subtracted back out, computed
-- once per request rather than per seller.
--
-- clock_timestamp() EXPLICITLY, never now(): now() is the transaction start
-- time, so inside a long transaction the window would be measured from the
-- wrong instant and a just-written entry could be revealed early.
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
  WITH pending AS (
    SELECT e.owner_user_id, sum(e.delta_cents) AS pending_cents, count(*) AS pending_count
    FROM app.earnings_ledger e
    WHERE e.tenant_id = app.current_tenant()
      AND e.recorded_at > clock_timestamp()
                          - make_interval(secs => app.projection_reveal_delay_ms() / 1000.0)
      AND CASE p_period_type
            WHEN 'day'      THEN e.period_day   = p_period_key
            WHEN 'week'     THEN e.period_week  = p_period_key
            WHEN 'month'    THEN e.period_month = p_period_key
            ELSE true
          END
    GROUP BY e.owner_user_id
  )
  SELECT lp.user_id,
         lp.total_cents - coalesce(p.pending_cents, 0),
         lp.entry_count - coalesce(p.pending_count, 0)::integer
  FROM app.leaderboard_projection lp
  LEFT JOIN pending p ON p.owner_user_id = lp.user_id
  WHERE lp.tenant_id = app.current_tenant()
    AND lp.period_type = p_period_type
    AND lp.period_key = p_period_key
$fn$;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION app.leaderboard_read(app.period_type, date) TO crm_app;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 5 · Classify, then harden
-- ---------------------------------------------------------------------------
INSERT INTO security.table_registry
  (schema_name, table_name, policy_class, owner_column, immutable, app_can_insert, exception_reason, registered_in_migration)
VALUES
  ('app', 'earnings_ledger', 'append_only_owner', 'owner_user_id', true, false, NULL, '0009_ledger_append'),
  ('app', 'leaderboard_projection', 'tenant_scoped_read', NULL, false, false, NULL, '0009_ledger_append'),
  ('ref', 'timing_constant', 'reference', NULL, false, false,
   'Two durations generated from app/styles/tokens/timing.ts. No tenant dimension: the undo window is a product constant, not a tenant setting.',
   '0009_ledger_append')
ON CONFLICT (schema_name, table_name) DO UPDATE
  SET policy_class            = EXCLUDED.policy_class,
      owner_column            = EXCLUDED.owner_column,
      immutable               = EXCLUDED.immutable,
      app_can_insert          = EXCLUDED.app_can_insert,
      exception_reason        = EXCLUDED.exception_reason,
      registered_in_migration = EXCLUDED.registered_in_migration;
--> statement-breakpoint

SELECT security.harden();
