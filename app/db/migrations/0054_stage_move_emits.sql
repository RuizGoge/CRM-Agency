-- ===========================================================================
-- THE FIRST REAL EMITTER. `app.stage_move` starts writing events.
--
-- Until now `app.event_emit` had ZERO production callers — the store, the
-- outbox, the enum and the 268 consumer rows all existed and nothing ever put
-- a fact into them. `05c` closed finding A7 on the claim that "§7.4.1 emits
-- opportunity.stage_changed unconditionally inside app.stage_move(), and the
-- column REVOKE makes that function the only writer". The first half was never
-- built. This builds it.
--
-- WHY THIS FUNCTION AND NOT ANOTHER. It is already the single writer of the
-- stage move AND of the ledger, enforced by column-level REVOKE, so an event
-- emitted here cannot be separated from the move that caused it. Anywhere else
-- would be a second write path that a future caller could skip.
--
-- Identical to 0019 except for three hoisted variables and the emissions.
-- Repeated in full because a function body cannot be patched.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 0 · THE INDEX THE DEDUPE HAS BEEN MISSING
-- ---------------------------------------------------------------------------
-- `app.event_emit` opens with a natural-key lookup —
--   SELECT 1 FROM event_log WHERE tenant_id = ? AND event_name = ? AND
--                                 idempotency_key = ?
-- — and no index covered it, because until this migration nothing ever called
-- the function. From here that lookup runs inside the CLOSE GATE's transaction,
-- three times per stage move, against a measured budget of API p95 < 300 ms and
-- a store that only grows. A sequential scan across every monthly partition is
-- not a problem today and is one the first month nobody is watching.
--
-- Declared on the parent, so PostgreSQL creates and attaches the matching index
-- on every partition, including ones `ensure_event_partitions` makes later.
CREATE INDEX "event_log_natural_key_idx" ON "app"."event_log"
  USING btree ("tenant_id","event_name","idempotency_key");--> statement-breakpoint

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
  -- Hoisted out of the INSERT ... SELECT below, because the events need them
  -- and a value computed inside a statement cannot be read after it.
  v_from_name text;
  v_days_in   integer;
  -- The story id. Every event this call emits carries the same one, so a
  -- consumer can tie "the card moved" to "the sale happened" without guessing
  -- from timestamps.
  v_story    uuid;
  v_sat      text[];
BEGIN
  v_tenant := app.current_tenant();
  v_actor  := app.current_user_id();
  IF v_tenant IS NULL OR v_actor IS NULL THEN
    RAISE EXCEPTION 'SM001: stage_move called with no session context';
  END IF;

  -- The sendBeacon-on-tab-close double delivery is a SUCCESS path. Without
  -- this the second arrival either moves the card twice or credits twice.
  --
  -- NOTHING IS EMITTED HERE, and that is deliberate: this branch returns before
  -- any write, so there is no new fact. The events belonging to the original
  -- move were emitted when it happened.
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

  -- Which gate requirements this move actually satisfied. Derived from the
  -- gates above rather than declared, so it cannot claim a field that was not
  -- required or miss one that was.
  -- The ::text casts are load-bearing. `text[] || 'literal'` is ambiguous in
  -- plpgsql and PostgreSQL resolves it as array-concat-array, then tries to
  -- parse the literal AS an array: `malformed array literal`. The failure is at
  -- runtime, not at CREATE, so the function compiles cleanly and every stage
  -- move raises 22P02 — which is what the first run of this migration did.
  v_sat := ARRAY[]::text[];
  IF v_stage.stage_type = 'earning' THEN
    v_sat := v_sat || 'deal_value_annual_premium'::text;
  ELSIF v_stage.stage_type = 'lost' THEN
    v_sat := v_sat || 'lost_reason_id'::text;
  END IF;

  SELECT fs.name INTO v_from_name FROM app.stage fs
   WHERE fs.tenant_id = v_tenant AND fs.id = v_opp.stage_id;
  v_days_in := greatest(0, extract(day from clock_timestamp() - v_opp.stage_entered_at)::integer);

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
  VALUES (
    v_tenant, p_opportunity_id, v_actor,
    v_opp.stage_id, v_from_name, v_opp.current_stage_type,
    v_stage.id, v_stage.stage_type, v_stage.name,
    v_actor, p_actor_type, p_moved_via, p_client_move_key,
    1, v_days_in
  )
  RETURNING id INTO v_tid;

  -- ==========================================================================
  -- THE EMISSION. Unconditional for the move itself, per §7.4.1 / A7.
  -- ==========================================================================
  -- IDEMPOTENCY IS KEYED ON THE TRANSITION, not on the opportunity and not on
  -- p_client_move_key. `client_move_key` is NULLABLE and the only production
  -- call site passes NULL, so as a key it does not exist. `v_tid` is generated
  -- inside this transaction, is unique per move, and gives the UNDO its own key
  -- — which is correct: an undo is a second move, and what makes the pair an
  -- undo is `reverses_entry_id` and the gap between them, never the key.
  --
  -- MONEY CROSSES AS A STRING OF WHOLE CENTS. `::text`, never a bare bigint,
  -- which would render as a JSON number and put a seller's premium into a
  -- float the first time anything read it in JavaScript.
  v_story := uuidv7();

  -- ⚠️ TWO FIELDS DIVERGE FROM THE DECLARED PAYLOAD, and both are the contract
  -- being stale rather than this emission being loose. Recorded here because a
  -- silent divergence is how a consumer written next month gets a surprise.
  --
  -- `moved_via`: the payload type lists four labels — kanban_drag,
  -- command_palette, mobile, automation — and `app.moved_via` has SEVEN.
  -- `move_sheet`, `keyboard`, `wrap_up` and `api` have no label at all, and
  -- `move_sheet` is the mobile path, which is most of the traffic. Emitting the
  -- ENGINE's value is true; mapping it onto four labels would silently merge
  -- three distinct paths and bake that loss into every stage move forever.
  --
  -- `product_type`: the payload declares it non-null; the column is NULLABLE,
  -- has no writer anywhere in the tree, and is NULL for every opportunity that
  -- exists. MVP item 39 calls these fields optional. So the contract asks for a
  -- guarantee the product deliberately does not make, and closing that is
  -- either a win-gate change or an erratum — a ruling, not a migration.
  PERFORM app.event_emit(
    v_story, v_opp.owner_user_id, 'opportunity.stage_changed',
    'opportunity', p_opportunity_id,
    'stage_transition:' || v_tid::text,
    jsonb_build_object(
      'opportunity_id',            p_opportunity_id,
      'contact_id',                v_opp.contact_id,
      'from_stage_id',             v_opp.stage_id,
      'from_stage_name',           v_from_name,
      'to_stage_id',               v_stage.id,
      'to_stage_name',             v_stage.name,
      'to_stage_is_closed',        v_stage.stage_type IN ('earning', 'lost'),
      'to_stage_closed_type',      CASE v_stage.stage_type
                                     WHEN 'earning' THEN 'won'
                                     WHEN 'lost'    THEN 'lost'
                                     ELSE NULL END,
      'deal_value_annual_premium', CASE WHEN v_annual IS NULL THEN NULL ELSE v_annual::text END,
      'product_type',              v_opp.product_type,
      'days_in_previous_stage',    v_days_in,
      'moved_via',                 p_moved_via,
      'required_fields_satisfied', to_jsonb(v_sat)
    ),
    clock_timestamp(), 'app', v_story);

  -- Entering an earning stage credits; leaving one reverses. Both go through
  -- ledger_append, so both are exactly-once and both maintain the projection.
  IF v_stage.stage_type = 'earning' AND v_opp.current_stage_type <> 'earning' THEN
    -- 🔴 EMITTED, AND `earnings` STILL DOES NOT RECEIVE IT. The consumer is
    -- classified `inline` in 0051 precisely because the ledger append below
    -- happens in THIS transaction; a fan-out row would ask a relay to credit
    -- the same sale again, permanently, on an append-only ledger with no
    -- recompute job. The event is for everyone else — audit first.
    PERFORM app.event_emit(
      uuidv7(), v_opp.owner_user_id, 'opportunity.won',
      'opportunity', p_opportunity_id,
      'stage_transition:won:' || v_tid::text,
      jsonb_build_object(
        'opportunity_id',            p_opportunity_id,
        'contact_id',                v_opp.contact_id,
        'deal_value_annual_premium', v_annual::text,
        'product_type',              v_opp.product_type,
        'carrier',                   v_opp.carrier,
        'policy_number',             v_opp.policy_number,
        'stage_id',                  v_stage.id,
        'closed_at',                 clock_timestamp(),
        -- Four fields the payload declares and the schema cannot produce:
        -- there is no source_channel or vendor column on opportunity or
        -- contact, `opportunity.created_at` is NOT lead creation (a cross-sell
        -- opportunity is born long after the lead), and `touches_to_close` has
        -- no source at all — `attempt_count` is a proxy, not the field. All
        -- four are nullable in the payload, so NULL is the honest value rather
        -- than a number invented to fill a slot.
        'source_channel',            NULL,
        'vendor_id',                 NULL,
        'days_from_lead_created',    NULL,
        'touches_to_close',          NULL
      ),
      clock_timestamp(), 'app', v_story);

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

    -- The ONLY one of the four opportunity payloads this function can fill
    -- completely and truthfully today. Every field exists as a column or is
    -- derived from one.
    PERFORM app.event_emit(
      uuidv7(), v_opp.owner_user_id, 'opportunity.reopened',
      'opportunity', p_opportunity_id,
      'stage_transition:reopened:' || v_tid::text,
      jsonb_build_object(
        'opportunity_id',      p_opportunity_id,
        'contact_id',          v_opp.contact_id,
        'from_stage_id',       v_opp.stage_id,
        'previous_closed_type', CASE v_opp.current_stage_type
                                  WHEN 'earning' THEN 'won' ELSE 'lost' END,
        'to_stage_id',         v_stage.id,
        'deal_value_reversed', v_opp.premium_annual_cents::text,
        'reason_note',         'moved out of an earning stage',
        'reopened_by_user_id', v_actor
      ),
      clock_timestamp(), 'app', v_story);

    PERFORM app.ledger_append(
      v_actor, v_tid, 'opportunity.reopened', 'reversal'::app.ledger_entry_type,
      -v_opp.premium_annual_cents,
      clock_timestamp(), p_opportunity_id, v_opp.contact_id, v_stage.id,
      v_stage.name, 1::bigint, v_opp.product_type, 'moved out of an earning stage',
      v_actor, v_reverses);
  END IF;

  -- ⚠️ `opportunity.lost` IS NOT EMITTED, and the reason is a vocabulary
  -- mismatch rather than an oversight.
  --
  -- Its payload declares `loss_reason_code` as a closed six-value list —
  -- price_affordability, not_contactable, already_insured, does_not_qualify,
  -- not_interested, no_funds. `app.lost_reason.code` is tenant-configurable
  -- text, and the seeded set is price, competitor, underwriting, unresponsive,
  -- not_interested, timing, bad_contact. The two lists share exactly ONE value.
  -- Mapping seven onto six would be inventing a correspondence nobody ratified,
  -- and Reporting keys on this code by name.
  --
  -- It also declares `recyclable` non-null and `recycle_eligible_at`, and
  -- neither exists as a column anywhere.
  --
  -- The move is still recorded: `opportunity.stage_changed` above carries
  -- to_stage_closed_type = 'lost', so nothing about the loss is invisible —
  -- only the typed loss event is withheld until its vocabulary is settled.

  RETURN QUERY SELECT v_tid, v_credited, false;
END
$fn$;--> statement-breakpoint

REVOKE ALL ON FUNCTION app.stage_move(uuid, uuid, app.moved_via, app.actor_type, uuid, bigint,
  app.premium_mode, uuid, text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.stage_move(uuid, uuid, app.moved_via, app.actor_type, uuid, bigint,
  app.premium_mode, uuid, text) TO crm_app;--> statement-breakpoint

SELECT security.harden();
