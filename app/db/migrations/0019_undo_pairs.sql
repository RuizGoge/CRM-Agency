-- An undo is not a correction, and the public board must not confuse them.
--
-- THE DEFECT THIS FIXES, found while building the 5-second undo:
--
-- `leaderboard_read` withholds entries younger than projection_reveal_delay_ms,
-- which makes the public board a 5.5-second-delayed replay of the ledger. That
-- is the right shape for a correction. It is exactly the wrong shape for an
-- undo, because the delay is measured per ENTRY and an undo produces TWO of
-- them:
--
--   t=0.0s  sale      +$2,220   projection $2,220   public $0      (withheld)
--   t=3.0s  reversal  -$2,220   projection $0       public $0      (both withheld)
--   t=5.5s  sale ages out of the window                 public $2,220  <-- WRONG
--   t=8.5s  reversal ages out                           public $0
--
-- For three seconds the public leaderboard shows a sale the seller already
-- cancelled, and then takes it back. Ruling R1.3 exists to make that
-- impossible: no viewer ever sees a number that later corrects itself. Today
-- the only producer of a reversal is a card dragged back out of an earning
-- stage, so the window is narrow. The moment `Undo` is a button on every win,
-- this is the normal case.
--
-- The rule, stated once: A REVERSAL RECORDED WITHIN undo_deadline_ms OF THE
-- ENTRY IT REVERSES IS AN UNDO, AND NEITHER HALF IS EVER PUBLISHED. Recorded
-- later, it is an ordinary correction and keeps the ordinary delay.
--
-- Note which constant governs which half, because they are 500ms apart and
-- this is the one place both appear: the REVEAL delay decides when an entry
-- becomes public; the UNDO deadline decides whether a pair is an undo at all.
-- Swapping them would make a 5.2-second undo publish itself.

-- ---------------------------------------------------------------------------
-- 1 · A reversal must say what it reverses
-- ---------------------------------------------------------------------------
-- Without the link, an undo is indistinguishable from a correction, so it takes
-- the correction path and lands on the public board. The column already
-- existed and `stage_move` was passing NULL into it — the shape of a rule that
-- was documentation rather than a mechanism.
--
-- Composite FK, like every reference in this schema: a reversal that points at
-- another tenant's entry is not rejected, it is unwritable.
ALTER TABLE app.earnings_ledger
  ADD CONSTRAINT earnings_reverses_fk
  FOREIGN KEY (tenant_id, reverses_entry_id)
  REFERENCES app.earnings_ledger (tenant_id, id);
--> statement-breakpoint

ALTER TABLE app.earnings_ledger
  ADD CONSTRAINT earnings_reversal_names_its_target
  CHECK (entry_type <> 'reversal' OR reverses_entry_id IS NOT NULL);
--> statement-breakpoint

-- One reversal per entry. Two would double-subtract, and the ledger has no
-- recompute job to notice.
CREATE UNIQUE INDEX earnings_reverses_uidx
  ON app.earnings_ledger (tenant_id, reverses_entry_id)
  WHERE reverses_entry_id IS NOT NULL;
--> statement-breakpoint

-- The public read scans the young tail on every poll — 50 sellers polling every
-- 5s against a board with a p95 budget of 300ms.
CREATE INDEX earnings_recorded_at_idx
  ON app.earnings_ledger (tenant_id, recorded_at DESC);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2 · The public read, with undo pairs withheld
-- ---------------------------------------------------------------------------
-- Both halves of an undo pair are dropped from the withholding sum rather than
-- added to it. That is not a shortcut: the projection already has both applied,
-- so a pair that nets to zero needs no subtraction at all, and skipping it is
-- what keeps the aged half from resurfacing alone.
--
-- The scan stays over the YOUNG tail only. An entry old enough to be public
-- whose partner is still young is reached through the second EXISTS, by primary
-- key, not by a self-join over the whole ledger.
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
  WITH withheld AS (
    SELECT e.owner_user_id, sum(e.delta_cents) AS cents, count(*) AS n
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
      -- e is the reversal half of an undo
      AND NOT EXISTS (
        SELECT 1 FROM app.earnings_ledger t
         WHERE t.tenant_id = e.tenant_id
           AND t.id = e.reverses_entry_id
           AND e.recorded_at <= t.recorded_at
                                + make_interval(secs => app.undo_deadline_ms() / 1000.0))
      -- e is the half that was undone
      AND NOT EXISTS (
        SELECT 1 FROM app.earnings_ledger r
         WHERE r.tenant_id = e.tenant_id
           AND r.reverses_entry_id = e.id
           AND r.recorded_at <= e.recorded_at
                                + make_interval(secs => app.undo_deadline_ms() / 1000.0))
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
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3 · stage_move links the reversal to the sale it cancels
-- ---------------------------------------------------------------------------
-- Identical to 0013 except for v_reverses. Repeated in full because a function
-- body cannot be patched, and a migration is never edited after merge.
CREATE OR REPLACE FUNCTION app.stage_move(
  p_opportunity_id   uuid,
  p_to_stage_id      uuid,
  p_moved_via        app.moved_via,
  p_actor_type       app.actor_type   DEFAULT 'human',
  p_client_move_key  uuid             DEFAULT NULL,
  p_premium_cents    bigint           DEFAULT NULL,
  p_premium_mode     app.premium_mode DEFAULT NULL,
  p_lost_reason_id   uuid             DEFAULT NULL,
  p_lost_reason_note text             DEFAULT NULL
)
RETURNS TABLE (transition_id uuid, credited boolean, was_duplicate boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = app, ref, pg_catalog
AS $fn$
DECLARE
  v_tenant   uuid;
  v_actor    uuid;
  v_opp      app.opportunity%ROWTYPE;
  v_stage    app.stage%ROWTYPE;
  v_existing uuid;
  v_tid      uuid;
  v_annual   bigint;
  v_monthly  bigint;
  v_reverses uuid;
  v_credited boolean := false;
BEGIN
  v_tenant := app.current_tenant();
  v_actor  := app.current_user_id();
  IF v_tenant IS NULL OR v_actor IS NULL THEN
    RAISE EXCEPTION 'SM001: stage_move called with no session context';
  END IF;

  -- The sendBeacon-on-tab-close double delivery is a SUCCESS path. Without
  -- this the second arrival either moves the card twice or credits twice.
  IF p_client_move_key IS NOT NULL THEN
    SELECT st.id INTO v_existing FROM app.stage_transition st
     WHERE st.tenant_id = v_tenant AND st.client_move_key = p_client_move_key;
    IF v_existing IS NOT NULL THEN
      RETURN QUERY SELECT v_existing, false, true;
      RETURN;
    END IF;
  END IF;

  SELECT * INTO v_opp FROM app.opportunity o
   WHERE o.tenant_id = v_tenant AND o.id = p_opportunity_id AND o.deleted_at IS NULL
   FOR UPDATE;

  -- Owner-scoped not-found, never a 403: a 403 confirms the record exists.
  IF NOT FOUND OR v_opp.owner_user_id <> v_actor THEN
    RAISE EXCEPTION 'SM404: no such opportunity';
  END IF;

  SELECT * INTO v_stage FROM app.stage s
   WHERE s.tenant_id = v_tenant AND s.id = p_to_stage_id AND s.deleted_at IS NULL;
  IF NOT FOUND OR v_stage.owner_user_id <> v_actor THEN
    RAISE EXCEPTION 'SM404: no such stage';
  END IF;

  v_annual  := v_opp.premium_annual_cents;
  v_monthly := v_opp.premium_monthly_cents;

  IF p_premium_cents IS NOT NULL THEN
    IF p_premium_mode IS NULL THEN
      RAISE EXCEPTION 'SM002: a premium needs an explicit monthly or annual mode';
    END IF;
    IF p_premium_mode = 'monthly' THEN
      -- Final Expense sells monthly; Earnings are annual. The x12 happens here
      -- and nowhere else, in integer cents.
      v_monthly := p_premium_cents;
      v_annual  := app.annualize(p_premium_cents);
    ELSE
      v_monthly := NULL;
      v_annual  := p_premium_cents;
    END IF;
  END IF;

  -- ---- THE WIN GATE, bound to stage_type and never to a stage name ----
  IF v_stage.stage_type = 'earning' AND v_annual IS NULL THEN
    RAISE EXCEPTION 'SM003: this stage counts toward Earnings and needs the deal value first';
  END IF;

  -- ---- THE LOSS GATE ----
  IF v_stage.stage_type = 'lost' AND coalesce(p_lost_reason_id, v_opp.lost_reason_id) IS NULL THEN
    RAISE EXCEPTION 'SM004: a lost card needs a reason';
  END IF;

  UPDATE app.opportunity o
     SET stage_id              = v_stage.id,
         current_stage_type    = v_stage.stage_type,
         premium_monthly_cents = v_monthly,
         premium_annual_cents  = v_annual,
         premium_mode          = CASE WHEN v_annual IS NULL THEN NULL
                                      ELSE coalesce(p_premium_mode, o.premium_mode) END,
         lost_reason_id        = coalesce(p_lost_reason_id, o.lost_reason_id),
         lost_reason_note      = coalesce(p_lost_reason_note, o.lost_reason_note),
         stage_entered_at      = clock_timestamp()
   WHERE o.tenant_id = v_tenant AND o.id = p_opportunity_id;

  INSERT INTO app.stage_transition (
    tenant_id, opportunity_id, owner_user_id,
    from_stage_id, from_stage_name_snapshot, from_stage_type,
    to_stage_id, to_stage_type, to_stage_name_snapshot,
    actor_user_id, actor_type, moved_via, client_move_key,
    stage_config_version, days_in_previous_stage
  )
  SELECT v_tenant, p_opportunity_id, v_actor,
         v_opp.stage_id, fs.name, v_opp.current_stage_type,
         v_stage.id, v_stage.stage_type, v_stage.name,
         v_actor, p_actor_type, p_moved_via, p_client_move_key,
         1, greatest(0, extract(day from clock_timestamp() - v_opp.stage_entered_at)::integer)
    FROM app.stage fs
   WHERE fs.tenant_id = v_tenant AND fs.id = v_opp.stage_id
  RETURNING id INTO v_tid;

  -- Entering an earning stage credits; leaving one reverses. Both go through
  -- ledger_append, so both are exactly-once and both maintain the projection.
  IF v_stage.stage_type = 'earning' AND v_opp.current_stage_type <> 'earning' THEN
    PERFORM app.ledger_append(
      v_actor, v_tid, 'opportunity.won', 'sale'::app.ledger_entry_type, v_annual,
      clock_timestamp(), p_opportunity_id, v_opp.contact_id, v_stage.id,
      v_stage.name, 1::bigint, v_opp.product_type, NULL, v_actor, NULL);
    v_credited := true;

  ELSIF v_opp.current_stage_type = 'earning' AND v_stage.stage_type <> 'earning' THEN
    -- The credit this cancels. Named, not inferred: whether the public board
    -- treats this as an undo or as a correction is decided by the gap between
    -- the two rows, and with no link there is no gap to measure.
    SELECT e.id INTO v_reverses
      FROM app.earnings_ledger e
     WHERE e.tenant_id = v_tenant
       AND e.opportunity_id = p_opportunity_id
       AND e.entry_type = 'sale'
       AND NOT EXISTS (SELECT 1 FROM app.earnings_ledger r
                        WHERE r.tenant_id = v_tenant AND r.reverses_entry_id = e.id)
     ORDER BY e.recorded_at DESC
     LIMIT 1;

    IF v_reverses IS NULL THEN
      -- The card sits in an earning stage with no unreversed credit behind it.
      -- Reversing what is not there would push the board negative, and there is
      -- no recompute job that would ever notice.
      RAISE EXCEPTION 'SM005: no unreversed credit found for this opportunity';
    END IF;

    PERFORM app.ledger_append(
      v_actor, v_tid, 'opportunity.reopened', 'reversal'::app.ledger_entry_type,
      -v_opp.premium_annual_cents,
      clock_timestamp(), p_opportunity_id, v_opp.contact_id, v_stage.id,
      v_stage.name, 1::bigint, v_opp.product_type, 'moved out of an earning stage',
      v_actor, v_reverses);
  END IF;

  RETURN QUERY SELECT v_tid, v_credited, false;
END
$fn$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION app.stage_move(uuid, uuid, app.moved_via, app.actor_type, uuid, bigint,
  app.premium_mode, uuid, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.stage_move(uuid, uuid, app.moved_via, app.actor_type, uuid, bigint,
  app.premium_mode, uuid, text) TO crm_app;
