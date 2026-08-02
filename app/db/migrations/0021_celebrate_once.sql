-- The celebration claim: four refusals in one conditional UPDATE.
--
-- Ruling P2 (Phase 5, Part I) settles the shape and this migration only builds
-- the database half of it. The client owns the ONE timer — the undo window's
-- own — and nothing is fetched at T+5,000 ms. There is no pg-boss job here on
-- purpose: a queued job in a folded process cannot hold D3-05's +/-100 ms, and
-- confetti that arrives late fires after the seller has moved on, which is
-- worse than no confetti.
--
-- PRECEDENCE NOTE, and it matters: P2.1's own mechanism text calls
-- `app.undo_window()`. That function does not exist and must not — errata E7 /
-- NEW-1 struck it, because one name meaning two durations silently refuses
-- every celebration in one branch and reveals an undoable win on a public board
-- in the other. Erratas outrank Part I. The claim below uses
-- `app.undo_deadline_ms()`, which is the celebration's interval; the 500 ms
-- guard belongs to the PUBLIC PROJECTION and never to this.
--
-- The other adaptation, recorded rather than silent: P2.1 anchors the window on
-- `opportunity.won_at`. There is no such column — the win instant lives on the
-- ledger's `sale` entry, which is the same row and the same clock the public
-- board withholds. Anchoring here means the confetti and the public reveal can
-- never disagree about when the sale happened.

-- ---------------------------------------------------------------------------
-- 1 · The grace window, named for the one job it does
-- ---------------------------------------------------------------------------
-- "Not replayed tomorrow" becomes a WHERE clause. A tab left open overnight, a
-- restored session, a bfcache resume: each of them can run the client timer
-- again, and each is refused here rather than by asking the client to remember.
INSERT INTO ref.timing_constant (key, value_ms, purpose) VALUES
  ('celebration_claim_grace_ms', 30000,
   'How long after the undo window a celebration may still be claimed. Past it the claim is refused, which is how "not replayed tomorrow" is a predicate rather than client discipline.')
ON CONFLICT (key) DO UPDATE
  SET value_ms = EXCLUDED.value_ms, purpose = EXCLUDED.purpose;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.celebration_claim_grace_ms()
RETURNS integer LANGUAGE sql STABLE AS $fn$
  SELECT value_ms FROM ref.timing_constant WHERE key = 'celebration_claim_grace_ms'
$fn$;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION app.celebration_claim_grace_ms() TO crm_app;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2 · celebrate_once
-- ---------------------------------------------------------------------------
-- Fired AFTER the render, so a failed claim costs a record and never a missing
-- animation. Four properties fall out of the one statement:
--
--   TOO EARLY   A claim before the undo window closes is refused (R1.4). The
--               seller can still take the undo back; confetti now would be
--               celebrating something that has not finished happening.
--   TOO LATE    Past the grace window it is refused — the tab reopened tomorrow.
--   REVERSED    A win whose credit was reversed is refused. This is Gate 10's
--               named nightmare: the whole office watching confetti for a
--               cancelled sale. Migration 0019 made the reversal NAME the entry
--               it cancels, so this is an exact check rather than a guess.
--   CONCURRENT  Two claimants produce one winner, because a conditional UPDATE
--               is atomic. No lock, no advisory key, no retry.
--
-- SECURITY DEFINER, so ownership is checked EXPLICITLY. Owner-scoped not-found,
-- never a 403: a 403 confirms the record exists.
CREATE OR REPLACE FUNCTION app.celebrate_once(p_opportunity_id uuid)
RETURNS TABLE (celebrated_at timestamptz, refused text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = app, ref, pg_catalog
AS $fn$
DECLARE
  v_tenant uuid;
  v_actor  uuid;
  v_owner  uuid;
  v_sale   record;
  v_when   timestamptz;
BEGIN
  v_tenant := app.current_tenant();
  v_actor  := app.current_user_id();
  IF v_tenant IS NULL OR v_actor IS NULL THEN
    RAISE EXCEPTION 'CB001: celebrate_once called with no session context';
  END IF;

  SELECT o.owner_user_id INTO v_owner
    FROM app.opportunity o
   WHERE o.tenant_id = v_tenant AND o.id = p_opportunity_id AND o.deleted_at IS NULL;

  IF NOT FOUND OR v_owner <> v_actor THEN
    RAISE EXCEPTION 'CB404: no such opportunity';
  END IF;

  -- The win instant, and whether it still stands. One lookup answers both.
  SELECT e.id, e.recorded_at,
         EXISTS (SELECT 1 FROM app.earnings_ledger r
                  WHERE r.tenant_id = v_tenant AND r.reverses_entry_id = e.id) AS reversed
    INTO v_sale
    FROM app.earnings_ledger e
   WHERE e.tenant_id = v_tenant
     AND e.opportunity_id = p_opportunity_id
     AND e.entry_type = 'sale'
   ORDER BY e.recorded_at DESC
   LIMIT 1;

  IF NOT FOUND THEN
    RETURN QUERY SELECT NULL::timestamptz, 'no_win';
    RETURN;
  END IF;

  IF v_sale.reversed THEN
    RETURN QUERY SELECT NULL::timestamptz, 'reversed';
    RETURN;
  END IF;

  -- clock_timestamp() EXPLICITLY, never now(): now() is the transaction start
  -- time, so a claim arriving inside a longer transaction would be measured
  -- from the wrong instant.
  IF clock_timestamp() < v_sale.recorded_at
                         + make_interval(secs => app.undo_deadline_ms() / 1000.0) THEN
    RETURN QUERY SELECT NULL::timestamptz, 'too_early';
    RETURN;
  END IF;

  IF clock_timestamp() >= v_sale.recorded_at
                          + make_interval(secs => (app.undo_deadline_ms()
                                                   + app.celebration_claim_grace_ms()) / 1000.0) THEN
    RETURN QUERY SELECT NULL::timestamptz, 'too_late';
    RETURN;
  END IF;

  UPDATE app.opportunity o
     SET celebrated_at = clock_timestamp()
   WHERE o.tenant_id = v_tenant
     AND o.id = p_opportunity_id
     AND o.celebrated_at IS NULL
  RETURNING o.celebrated_at INTO v_when;

  IF v_when IS NULL THEN
    -- Already claimed. A SUCCESS path for the caller in the same sense the
    -- ledger's duplicate delivery is: nothing moved, nobody is told anything.
    RETURN QUERY SELECT NULL::timestamptz, 'already';
    RETURN;
  END IF;

  RETURN QUERY SELECT v_when, NULL::text;
END
$fn$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION app.celebrate_once(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.celebrate_once(uuid) TO crm_app;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3 · Nothing to reclassify; harden anyway
-- ---------------------------------------------------------------------------
-- No new relation, so this adds no registry row. `harden()` still runs, because
-- the deploy re-asserting the whole posture on every migration is the mechanism
-- — not a step that only matters when something changed.
SELECT security.harden();
