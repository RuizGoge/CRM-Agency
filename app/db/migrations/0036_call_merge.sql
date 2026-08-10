-- ===========================================================================
-- `app.call` and `app.call_merge()` — the domain row every webhook lands on
--
-- §4.5, ARR-INT-06. One job, one queue, one key: `call-merge` serialized on
-- `aloware_call_id`. The merge is a DECLARED FIELD TABLE rather than a
-- hand-written UPDATE, because the two classes of field fail in opposite ways:
--
--   additive    COALESCE(new, old) — order-free. A late `Recording-Saved`
--               cannot erase a transcript that arrived first.
--   corrective  applied only when the PROVIDER's clock says this delivery is
--               not older than what we already merged. Arrival order is not
--               the provider's order: the queue serializes deliveries, it
--               cannot reorder what the provider sent late.
--
-- The symptom of getting this wrong is a timeline entry that looks perfectly
-- fine and is merely missing its transcript, which nobody ever reports.
-- ===========================================================================

CREATE TABLE "app"."call" (
	"tenant_id" uuid NOT NULL,
	"id" uuid DEFAULT uuidv7() NOT NULL,
	"aloware_call_id" text NOT NULL,
	"owner_user_id" uuid,
	"contact_id" uuid,
	"direction" text,
	"state" text NOT NULL,
	"state_ordinal" smallint NOT NULL,
	"disposition_raw" text,
	"talk_time_seconds" integer,
	"wait_time_seconds" integer,
	"recording_url" text,
	"transcript_url" text,
	"ai_summary_text" text,
	"provider_created_at" timestamp with time zone,
	"provider_last_event_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "call_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "call_direction" CHECK ("app"."call"."direction" IS NULL OR "app"."call"."direction" IN ('inbound', 'outbound')),
	CONSTRAINT "call_state_ordinal_agree" CHECK (("app"."call"."state" = 'initiated' AND "app"."call"."state_ordinal" = 10)
          OR ("app"."call"."state" = 'completed' AND "app"."call"."state_ordinal" = 90)),
	CONSTRAINT "call_durations_non_negative" CHECK (("app"."call"."talk_time_seconds" IS NULL OR "app"."call"."talk_time_seconds" >= 0)
          AND ("app"."call"."wait_time_seconds" IS NULL OR "app"."call"."wait_time_seconds" >= 0))
);
--> statement-breakpoint
ALTER TABLE "app"."call" ADD CONSTRAINT "call_owner_fk" FOREIGN KEY ("tenant_id","owner_user_id") REFERENCES "app"."app_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."call" ADD CONSTRAINT "call_contact_fk" FOREIGN KEY ("tenant_id","contact_id") REFERENCES "app"."contact"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "call_aloware_id_uidx" ON "app"."call" USING btree ("tenant_id","aloware_call_id");--> statement-breakpoint
CREATE INDEX "call_owner_recent_idx" ON "app"."call" USING btree ("tenant_id","owner_user_id","provider_created_at");--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 1 · A new policy class: `owner_scoped_read`
-- ---------------------------------------------------------------------------
-- 🔴 IT EXISTS BECAUSE THE THREE OBVIOUS CLASSIFICATIONS ARE EACH WRONG, and
-- this module has already paid for two of them (migrations 0033 and 0034).
--
--   `owner_scoped` + app_can_insert = false  →  SELECT **and UPDATE**.
--       `app_can_insert` governs INSERT and only INSERT. A seller would hold
--       UPDATE on their own call rows — which RLS scopes to their own, which
--       sounds safe and is not. The day strip counts calls, `last_activity_at`
--       is driven by them, and the 7-day cold rule and the decay rail read
--       that. A seller who can edit their own call row can manufacture
--       activity on a lead they never phoned.
--   `append_only_owner` / `immutable = true`  →  installs a statement-level
--       refusal that binds the DEFINER too, and the merge is an UPDATE by
--       definition. The table would be unwritable by the only thing meant to
--       write it.
--   `tenant_scoped_read`  →  correct grants, wrong scope. That class is right
--       for `aloware_number_mapping` because an outbound company number is
--       infrastructure; a call is lead data, and tenant-wide read would put
--       every seller's calls in every seller's reach.
--
-- Adding a class is deliberately cheap: since migration 0006 `policy_class` is
-- TEXT rather than an enum, precisely so that "one migration adds a class, the
-- next uses it" is not an unrunnable shape. As text it is one line in the CASE
-- and nothing else. There is intentionally no CHECK listing valid classes —
-- `harden()` raises HR002 on any class it has no generator for, at deploy time,
-- naming the class. One list, and it is the one that generates the policies.
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
      -- NEW in 0036. Owner-scoped read, and no write of any kind. Rows arrive
      -- through a SECURITY DEFINER and nowhere else.
      --
      -- A NULL owner is deliberately unreadable by everyone except a global
      -- scope: `NULL = app.current_user_id()` is NULL, never true. That is what
      -- makes "quarantined" a real state rather than a label — an unattributable
      -- call is written to NO book instead of being guessed into one.
      WHEN 'owner_scoped_read' THEN
        qual := format('%s AND (%I = app.current_user_id() OR app.scope_is_global())',
                       tenant_pred, reg.owner_column);
        with_check := 'false';
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
                                      'tenant_scoped_read', 'owner_scoped_read') THEN
        EXECUTE format('GRANT INSERT ON %s TO crm_app', ident);
      END IF;

      IF NOT reg.immutable
         AND reg.policy_class NOT IN ('definer_only', 'system_cross_tenant', 'reference',
                                      'tenant_scoped_read', 'owner_scoped_read') THEN
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
$fn$;--> statement-breakpoint

-- The new class names an owner column, so the constraint that says so has to
-- know about it. Without this a `owner_scoped_read` row with a NULL
-- `owner_column` would be accepted by the registry and then make `harden()`
-- build `NULL = app.current_user_id()` into a policy — which is not an error,
-- it is a policy that silently matches nothing.
ALTER TABLE security.table_registry DROP CONSTRAINT IF EXISTS owner_scoped_needs_owner_column;--> statement-breakpoint
ALTER TABLE security.table_registry
  ADD CONSTRAINT owner_scoped_needs_owner_column
  CHECK (policy_class NOT IN ('owner_scoped', 'owner_scoped_read', 'append_only_owner')
         OR owner_column IS NOT NULL);--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2 · The state cannot go backwards
-- ---------------------------------------------------------------------------
-- §4.5: "`state_ordinal` is monotonic by BEFORE UPDATE trigger: a late
-- `ringing` can never regress a `completed` call."
--
-- 🔴 IT CLAMPS RATHER THAN REFUSES, and that is the whole decision. Raising
-- would make a legitimately out-of-order delivery fail its job, and a failed
-- merge job is a call missing from a seller's history — which is the outcome
-- this trigger exists to prevent, arrived at by a different road. Out-of-order
-- is NORMAL here: G2 measured four deliveries about one call spread over
-- minutes, and the provider does not promise their order.
--
-- Both columns move together so `call_state_ordinal_agree` stays satisfiable;
-- clamping one alone would produce a row that sorts as `completed` and renders
-- as `initiated`.
CREATE OR REPLACE FUNCTION app.call_state_monotonic()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = app, pg_catalog
AS $fn$
BEGIN
  IF NEW.state_ordinal < OLD.state_ordinal THEN
    NEW.state         := OLD.state;
    NEW.state_ordinal := OLD.state_ordinal;
  END IF;
  RETURN NEW;
END
$fn$;--> statement-breakpoint

-- Named for what it does, NOT `t_immutable_call`: `harden()` drops and recreates
-- any trigger matching that name on every deploy, so borrowing the prefix would
-- have this quietly deleted the next time somebody hardens.
CREATE TRIGGER t_call_state_monotonic
  BEFORE UPDATE ON app.call
  FOR EACH ROW EXECUTE FUNCTION app.call_state_monotonic();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3 · The merge
-- ---------------------------------------------------------------------------
-- Returns how the owner resolved, because the caller has to act on it: §5 gives
-- four outcomes and only `resolved` writes to a book. `unmapped` is what raises
-- the admin alert — "1 call from a number we do not recognize. Nothing was
-- written to a seller's book."
--
-- ⚠️ THE TENANT COMES FROM `app.current_tenant()` AND THERE IS NO PARAMETER FOR
-- IT. The worker opens `withSystemWork(tenantId)` per job first, which is the
-- same shape `claimDueJobs` already establishes: the cross-tenant step returns
-- ids, and every caller sets per-row context before it touches a domain table.
CREATE OR REPLACE FUNCTION app.call_merge(
  p_aloware_call_id     text,
  p_state               text,
  p_direction           text        DEFAULT NULL,
  p_aloware_user_id     bigint      DEFAULT NULL,
  p_our_number_e164     text        DEFAULT NULL,
  p_lead_number_e164    text        DEFAULT NULL,
  p_disposition_raw     text        DEFAULT NULL,
  p_talk_time_seconds   integer     DEFAULT NULL,
  p_wait_time_seconds   integer     DEFAULT NULL,
  p_recording_url       text        DEFAULT NULL,
  p_transcript_url      text        DEFAULT NULL,
  p_ai_summary_text     text        DEFAULT NULL,
  p_provider_created_at timestamptz DEFAULT NULL,
  p_provider_event_at   timestamptz DEFAULT NULL
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = app, pg_catalog
AS $fn$
DECLARE
  v_tenant  uuid;
  v_owner   uuid;
  v_contact uuid;
  v_ordinal smallint;
BEGIN
  v_tenant := app.current_tenant();
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'CM001: call_merge called with no tenant context';
  END IF;

  IF p_aloware_call_id IS NULL OR length(btrim(p_aloware_call_id)) = 0 THEN
    RAISE EXCEPTION 'CM002: call_merge needs an aloware_call_id — it is the merge key';
  END IF;

  v_ordinal := CASE p_state
                 WHEN 'initiated' THEN 10
                 WHEN 'completed' THEN 90
                 ELSE NULL
               END;
  IF v_ordinal IS NULL THEN
    -- §6.1's `connected` was struck: G2 measured 70.4 s of total webhook silence
    -- over a 63-second call, so the live portion has no source at all.
    RAISE EXCEPTION 'CM003: % is not a call state; there are exactly two', p_state;
  END IF;

  -- Owner resolution, §5. Two routes and they are not equally good.
  --
  -- OUTBOUND is solid: the two-legged dial carries an explicit `user_id`, so
  -- attribution never has to come from the number. G2 confirmed that field
  -- carries per-seller attribution on both calls and SMS.
  --
  -- ⚠️ INBOUND IS THE OPEN PROBLEM, recorded rather than designed around. The
  -- account runs a 58-number Local Presence pool, and a rotating pool has NO
  -- stable number-to-seller binding — so a callback to a pool number resolves to
  -- nothing here and the call is quarantined. That is the honest outcome: the
  -- alternative is guessing an owner, and a lead's callback landing in a
  -- stranger's book is the failure §5.1 narrates at length.
  IF p_aloware_user_id IS NOT NULL THEN
    SELECT m.owner_user_id INTO v_owner
      FROM app.aloware_number_mapping m
     WHERE m.tenant_id = v_tenant
       AND m.aloware_user_id = p_aloware_user_id
       AND m.revoked_at IS NULL
       AND m.verified_at IS NOT NULL;
  END IF;

  IF v_owner IS NULL AND p_our_number_e164 IS NOT NULL THEN
    SELECT m.owner_user_id INTO v_owner
      FROM app.aloware_number_mapping m
     WHERE m.tenant_id = v_tenant
       AND m.from_number_e164 = p_our_number_e164
       AND m.revoked_at IS NULL
       AND m.verified_at IS NOT NULL;
  END IF;

  -- The contact is looked up INSIDE the resolved owner's book and nowhere else.
  -- Two sellers may legitimately hold the same lead — `contact_phone_owner_uidx`
  -- is unique on (tenant, owner, phone), not on (tenant, phone) — so a
  -- tenant-wide phone match would attach the call to whichever row the index
  -- happened to return.
  IF v_owner IS NOT NULL AND p_lead_number_e164 IS NOT NULL THEN
    SELECT cp.contact_id INTO v_contact
      FROM app.contact_phone cp
     WHERE cp.tenant_id = v_tenant
       AND cp.owner_user_id = v_owner
       AND cp.phone_e164 = p_lead_number_e164
     ORDER BY cp.is_primary DESC
     LIMIT 1;
  END IF;

  INSERT INTO app.call (
    tenant_id, aloware_call_id, owner_user_id, contact_id, direction,
    state, state_ordinal, disposition_raw, talk_time_seconds, wait_time_seconds,
    recording_url, transcript_url, ai_summary_text,
    provider_created_at, provider_last_event_at, updated_at
  ) VALUES (
    v_tenant, p_aloware_call_id, v_owner, v_contact, p_direction,
    p_state, v_ordinal, p_disposition_raw, p_talk_time_seconds, p_wait_time_seconds,
    p_recording_url, p_transcript_url, p_ai_summary_text,
    p_provider_created_at, p_provider_event_at, clock_timestamp()
  )
  ON CONFLICT (tenant_id, aloware_call_id) DO UPDATE SET
    -- ADDITIVE — COALESCE(new, old), order-free. A late `Recording-Saved`
    -- cannot erase a transcript that arrived first, and neither can a delivery
    -- that simply does not carry the field: G2 measured that
    -- `OutboundPhoneCall` has no `direct_recording_url` KEY AT ALL, so a
    -- mapper reading it gets `undefined` and calls it null.
    recording_url   = COALESCE(EXCLUDED.recording_url,   app.call.recording_url),
    transcript_url  = COALESCE(EXCLUDED.transcript_url,  app.call.transcript_url),
    ai_summary_text = COALESCE(EXCLUDED.ai_summary_text, app.call.ai_summary_text),
    direction       = COALESCE(EXCLUDED.direction,       app.call.direction),
    -- Attribution is additive too: once a call is in a seller's book, a later
    -- delivery that omits `user_id` must not orphan it.
    owner_user_id   = COALESCE(EXCLUDED.owner_user_id,   app.call.owner_user_id),
    contact_id      = COALESCE(EXCLUDED.contact_id,      app.call.contact_id),
    -- The provider's own creation clock: the EARLIEST wins.
    --
    -- 🔬 `LEAST` rather than `COALESCE(old, new)`, and the difference is exactly
    -- the property this whole design is judged on. "First non-null wins" makes
    -- the stored value depend on which delivery ARRIVED first, so two orderings
    -- of the same four webhooks could leave two different rows — which is what
    -- ARR-INT-06 forbids and what the permutation test asserts. `LEAST` ignores
    -- NULLs in PostgreSQL and is commutative, so the answer is the same however
    -- the deliveries land. Found by writing the permutation test, not by review.
    provider_created_at = LEAST(app.call.provider_created_at, EXCLUDED.provider_created_at),

    -- CORRECTIVE — guarded by the PROVIDER's clock, never by arrival order.
    --
    -- 🔴 THE FIRST TWO ARMS ARE NOT DEFENSIVE PADDING; WITHOUT THEM THIS RULE
    -- LOSES DATA, and the permutation test is what proved it rather than
    -- review. The guard alone reads "a newer delivery wins", and a provider
    -- delivery does not null a field it has nothing to say about — it OMITS it.
    -- G2 measured exactly that: `Recording-Saved` arrives 4 s AFTER the
    -- disposition and carries no `call_disposition` key at all. Merge them in
    -- the other order — which the provider never promises not to do — and the
    -- recording's newer timestamp makes the real disposition "older", so it is
    -- refused and the call keeps a NULL disposition for ever. Nothing errors.
    --
    -- So: an absent value never overwrites a present one, a present value
    -- always fills an empty one, and the clock only ever arbitrates between two
    -- values that both exist. All three arms are commutative, which is what
    -- ARR-INT-06 actually asks for.
    --
    -- ⚠️ `>=` rather than `>` so a restatement applies — `Call-Disposed` repeats
    -- the disposition 6.6 s later under a second name. The honest limit: two
    -- deliveries carrying the SAME provider timestamp and DIFFERENT values are
    -- order-dependent whichever comparison is used, and no rule here can fix
    -- that because the ambiguity is in the provider's data.
    disposition_raw = CASE
      WHEN EXCLUDED.disposition_raw IS NULL THEN app.call.disposition_raw
      WHEN app.call.disposition_raw IS NULL THEN EXCLUDED.disposition_raw
      WHEN EXCLUDED.provider_last_event_at IS NOT NULL
       AND (app.call.provider_last_event_at IS NULL
            OR EXCLUDED.provider_last_event_at >= app.call.provider_last_event_at)
      THEN EXCLUDED.disposition_raw
      ELSE app.call.disposition_raw END,
    talk_time_seconds = CASE
      WHEN EXCLUDED.talk_time_seconds IS NULL THEN app.call.talk_time_seconds
      WHEN app.call.talk_time_seconds IS NULL THEN EXCLUDED.talk_time_seconds
      WHEN EXCLUDED.provider_last_event_at IS NOT NULL
       AND (app.call.provider_last_event_at IS NULL
            OR EXCLUDED.provider_last_event_at >= app.call.provider_last_event_at)
      THEN EXCLUDED.talk_time_seconds
      ELSE app.call.talk_time_seconds END,
    wait_time_seconds = CASE
      WHEN EXCLUDED.wait_time_seconds IS NULL THEN app.call.wait_time_seconds
      WHEN app.call.wait_time_seconds IS NULL THEN EXCLUDED.wait_time_seconds
      WHEN EXCLUDED.provider_last_event_at IS NOT NULL
       AND (app.call.provider_last_event_at IS NULL
            OR EXCLUDED.provider_last_event_at >= app.call.provider_last_event_at)
      THEN EXCLUDED.wait_time_seconds
      ELSE app.call.wait_time_seconds END,

    -- The state is written unconditionally and CLAMPED BY THE TRIGGER. Doing it
    -- here with a CASE as well would be a second implementation of monotonicity
    -- that a future edit could put out of step with the first.
    state         = EXCLUDED.state,
    state_ordinal = EXCLUDED.state_ordinal,

    provider_last_event_at = GREATEST(
      app.call.provider_last_event_at,
      EXCLUDED.provider_last_event_at),
    updated_at = clock_timestamp()
  RETURNING owner_user_id INTO v_owner;

  RETURN CASE WHEN v_owner IS NULL THEN 'unmapped' ELSE 'resolved' END;
END
$fn$;--> statement-breakpoint

REVOKE ALL ON FUNCTION app.call_merge(text, text, text, bigint, text, text, text, integer,
  integer, text, text, text, timestamptz, timestamptz) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.call_merge(text, text, text, bigint, text, text, text, integer,
  integer, text, text, text, timestamptz, timestamptz) TO crm_app;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4 · Classify, then harden
-- ---------------------------------------------------------------------------
-- `owner_scoped_read`: a seller reads their own calls and writes none of them.
-- Every row arrives through `app.call_merge()`.
INSERT INTO security.table_registry
  (schema_name, table_name, policy_class, owner_column, immutable, app_can_insert,
   exception_reason, registered_in_migration)
VALUES
  ('app', 'call', 'owner_scoped_read', 'owner_user_id', false, false, NULL,
   '0036_call_merge')
ON CONFLICT (schema_name, table_name) DO UPDATE
  SET policy_class            = EXCLUDED.policy_class,
      owner_column            = EXCLUDED.owner_column,
      immutable               = EXCLUDED.immutable,
      app_can_insert          = EXCLUDED.app_can_insert,
      exception_reason        = EXCLUDED.exception_reason,
      registered_in_migration = EXCLUDED.registered_in_migration;--> statement-breakpoint

SELECT security.harden();
