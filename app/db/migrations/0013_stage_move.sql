-- The close gate: one function, one transaction, or nothing.

-- ---------------------------------------------------------------------------
-- 1 · Protected columns, generated like everything else
-- ---------------------------------------------------------------------------
-- Found while writing stage_move: `opportunity` is owner_scoped, so crm_app
-- holds UPDATE on it — which means a card could be moved with a plain UPDATE,
-- skipping stage_move entirely. The CHECK gates would still refuse an
-- unqualified win, but a QUALIFIED one would move the card with no
-- stage_transition and no ledger row. The board and the money would diverge
-- silently, and the ledger has no recompute job to reconcile them with.
--
-- 05b §8.2 already uses column-level REVOKE for premium ("only app.set_premium()").
-- This makes that pattern part of the registry, so harden() re-applies it on
-- every deploy instead of it being one line someone re-grants by accident.
ALTER TABLE security.table_registry
  ADD COLUMN IF NOT EXISTS protected_columns text[];
--> statement-breakpoint

CREATE OR REPLACE FUNCTION security.harden()
RETURNS void
LANGUAGE plpgsql AS $fn$
DECLARE
  r           record;
  reg         security.table_registry%ROWTYPE;
  qual        text;
  with_check  text;
  ident       text;
  trg         text;
  cols        text;
  append_only boolean;
  tenant_pred constant text := 'tenant_id = app.current_tenant()';
BEGIN
  FOR r IN SELECT * FROM security.managed_relations() LOOP
    ident := format('%I.%I', r.schema_name, r.table_name);
    trg   := left('t_immutable_' || r.table_name, 63);

    SELECT * INTO reg FROM security.table_registry tr
     WHERE tr.schema_name = r.schema_name AND tr.table_name = r.table_name;

    IF NOT FOUND THEN
      RAISE EXCEPTION
        'HR001: relation % has no security.table_registry row. Classify it in the migration that creates it.',
        ident
        USING HINT = 'Every relation is classified or the deploy fails. This is the keystone, not a formality.';
    END IF;

    append_only := reg.policy_class IN
      ('append_only_owner', 'append_only_tenant', 'append_only_tenant_admin');

    CASE reg.policy_class
      WHEN 'owner_scoped' THEN
        qual := format('%s AND (%I = app.current_user_id() OR app.scope_is_global())',
                       tenant_pred, reg.owner_column);
        with_check := format('%s AND %I = app.current_user_id()',
                             tenant_pred, reg.owner_column);
      WHEN 'append_only_owner' THEN
        qual := format('%s AND (%I = app.current_user_id() OR app.scope_is_global())',
                       tenant_pred, reg.owner_column);
        with_check := 'false';
      WHEN 'tenant_scoped' THEN
        qual := tenant_pred;
        with_check := format('%s AND app.scope_is_admin()', tenant_pred);
      WHEN 'tenant_scoped_read' THEN
        qual := tenant_pred;
        with_check := 'false';
      WHEN 'append_only_tenant' THEN
        qual := tenant_pred;
        with_check := 'false';
      WHEN 'tenant_admin_only' THEN
        qual := format('%s AND app.scope_is_admin()', tenant_pred);
        with_check := format('%s AND app.scope_is_admin()', tenant_pred);
      WHEN 'append_only_tenant_admin' THEN
        qual := format('%s AND app.scope_is_admin()', tenant_pred);
        with_check := 'false';
      WHEN 'definer_only', 'system_cross_tenant' THEN
        qual := 'false';
        with_check := 'false';
      WHEN 'reference' THEN
        qual := 'true';
        with_check := 'false';
      ELSE
        RAISE EXCEPTION 'HR002: policy_class % has no generator', reg.policy_class;
    END CASE;

    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', ident);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', ident);

    EXECUTE format('DROP POLICY IF EXISTS p_app ON %s', ident);
    EXECUTE format('CREATE POLICY p_app ON %s FOR ALL TO crm_app USING (%s) WITH CHECK (%s)',
                   ident, qual, with_check);
    EXECUTE format('DROP POLICY IF EXISTS p_sys ON %s', ident);
    EXECUTE format('CREATE POLICY p_sys ON %s FOR ALL TO crm_migrator USING (true) WITH CHECK (true)',
                   ident);

    EXECUTE format('REVOKE ALL ON %s FROM crm_app', ident);
    EXECUTE format('GRANT SELECT ON %s TO crm_app', ident);

    IF NOT append_only THEN
      IF reg.app_can_insert
         AND reg.policy_class NOT IN ('definer_only', 'system_cross_tenant', 'reference',
                                      'tenant_scoped_read') THEN
        EXECUTE format('GRANT INSERT ON %s TO crm_app', ident);
      END IF;

      IF NOT reg.immutable
         AND reg.policy_class NOT IN ('definer_only', 'system_cross_tenant', 'reference',
                                      'tenant_scoped_read') THEN
        IF reg.protected_columns IS NOT NULL AND array_length(reg.protected_columns, 1) > 0 THEN
          -- Grant the ALLOWED columns, never the table.
          --
          -- PostgreSQL does not decompose a table-level grant, so
          -- `GRANT UPDATE ON t` followed by `REVOKE UPDATE (c) ON t` leaves c
          -- writable — the revoke silently removes a column privilege that was
          -- never separately granted. Enumerating the permitted columns is the
          -- only form that actually holds, and a column added later is
          -- protected by default until this list is regenerated.
          SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY a.attnum) INTO cols
          FROM pg_attribute a
          WHERE a.attrelid = ident::regclass
            AND a.attnum > 0
            AND NOT a.attisdropped
            AND a.attname <> ALL (reg.protected_columns);
          EXECUTE format('GRANT UPDATE (%s) ON %s TO crm_app', cols, ident);
        ELSE
          EXECUTE format('GRANT UPDATE ON %s TO crm_app', ident);
        END IF;
      END IF;
    END IF;

    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %s', trg, ident);
    IF reg.immutable OR append_only THEN
      EXECUTE format(
        'CREATE TRIGGER %I BEFORE UPDATE OR DELETE OR TRUNCATE ON %s '
        'FOR EACH STATEMENT EXECUTE FUNCTION security.refuse_mutation()',
        trg, ident);
    END IF;
  END LOOP;

  EXECUTE 'REVOKE ALL ON SCHEMA public FROM crm_app';
  EXECUTE 'REVOKE ALL ON SCHEMA security FROM crm_app';
  EXECUTE 'GRANT USAGE ON SCHEMA app TO crm_app';
  EXECUTE 'GRANT USAGE ON SCHEMA ref TO crm_app';
END
$fn$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2 · stage_type is immutable
-- ---------------------------------------------------------------------------
-- The single trigger that deletes a whole class of catastrophe. If a stage's
-- type can never flip, a per-seller board tweak can never move money on a
-- public leaderboard, and "recompute on stage-flag change" versus "no recompute
-- job exists" resolves in favour of the latter with nothing left ambiguous. A
-- seller who wants a different type creates a new stage and moves the cards —
-- a normal, gated move that credits or reverses exactly once.
CREATE OR REPLACE FUNCTION app.refuse_stage_type_change()
RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.stage_type IS DISTINCT FROM OLD.stage_type THEN
    RAISE EXCEPTION 'ST001: stage_type is immutable (% -> %)', OLD.stage_type, NEW.stage_type
      USING HINT = 'Create a new stage of the desired type and move the cards. That path credits or reverses exactly once.';
  END IF;
  RETURN NEW;
END
$fn$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS t_stage_type_immutable ON app.stage;
--> statement-breakpoint
CREATE TRIGGER t_stage_type_immutable
  BEFORE UPDATE ON app.stage
  FOR EACH ROW EXECUTE FUNCTION app.refuse_stage_type_change();
--> statement-breakpoint

-- celebrated_at goes NULL -> value exactly once. Confetti for a cancelled sale
-- is the failure this prevents; confetti twice is the one it also prevents.
CREATE OR REPLACE FUNCTION app.refuse_rewrite_of_write_once()
RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF OLD.celebrated_at IS NOT NULL AND NEW.celebrated_at IS DISTINCT FROM OLD.celebrated_at THEN
    RAISE EXCEPTION 'CE001: celebrated_at is write-once per opportunity';
  END IF;
  IF OLD.first_touch_latency_seconds IS NOT NULL
     AND NEW.first_touch_latency_seconds IS DISTINCT FROM OLD.first_touch_latency_seconds THEN
    RAISE EXCEPTION 'CE002: first_touch_latency_seconds is write-once';
  END IF;
  RETURN NEW;
END
$fn$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS t_opportunity_write_once ON app.opportunity;
--> statement-breakpoint
CREATE TRIGGER t_opportunity_write_once
  BEFORE UPDATE ON app.opportunity
  FOR EACH ROW EXECUTE FUNCTION app.refuse_rewrite_of_write_once();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3 · stage_move — the ONLY way a card changes column
-- ---------------------------------------------------------------------------
-- Everything the close gate does happens inside this one call, so it is one
-- transaction by construction: gate check, stage write, stage_transition, and
-- the ledger append. If the ledger append raises, the card never moved.
--
-- SECURITY DEFINER bypasses RLS, so ownership is checked EXPLICITLY below.
-- That is not belt-and-braces: without it this function would be the
-- cross-silo hole every policy above exists to prevent.
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
    PERFORM app.ledger_append(
      v_actor, v_tid, 'opportunity.reopened', 'reversal'::app.ledger_entry_type,
      -v_opp.premium_annual_cents,
      clock_timestamp(), p_opportunity_id, v_opp.contact_id, v_stage.id,
      v_stage.name, 1::bigint, v_opp.product_type, 'moved out of an earning stage',
      v_actor, NULL);
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
--> statement-breakpoint

CREATE OR REPLACE VIEW app.opportunity_live
  WITH (security_invoker = true) AS
  SELECT * FROM app.opportunity WHERE deleted_at IS NULL;
--> statement-breakpoint
GRANT SELECT ON app.opportunity_live TO crm_app;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4 · Classify, then harden
-- ---------------------------------------------------------------------------
INSERT INTO security.table_registry
  (schema_name, table_name, policy_class, owner_column, immutable, app_can_insert,
   protected_columns, exception_reason, registered_in_migration)
VALUES
  ('app', 'pipeline',         'owner_scoped',      'owner_user_id', false, true,  NULL, NULL, '0013_stage_move'),
  ('app', 'stage',            'owner_scoped',      'owner_user_id', false, true,  NULL, NULL, '0013_stage_move'),
  ('app', 'lost_reason',      'tenant_scoped',     NULL,            false, true,  NULL, NULL, '0013_stage_move'),
  ('app', 'stage_transition', 'append_only_owner', 'owner_user_id', true,  false, NULL, NULL, '0013_stage_move'),
  -- The card itself stays writable — carrier, policy number, notes. What a
  -- plain UPDATE may not touch is the set of columns that decide money.
  ('app', 'opportunity',      'owner_scoped',      'owner_user_id', false, true,
   ARRAY['stage_id','current_stage_type','premium_monthly_cents','premium_annual_cents',
         'premium_mode','celebrated_at','first_touch_latency_seconds'],
   NULL, '0013_stage_move')
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
