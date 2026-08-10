-- ===========================================================================
-- `app.dead_letter` and `app.admin_alert` — §4.6 made into product surfaces
--
-- *"The counter is a product surface, not a log."* Both tables exist so that
-- `/admin/integration-health` can render LIVE ROWS instead of reconstructing a
-- picture from log lines nobody reads until afterwards.
--
-- This migration also supersedes `app.call_merge()` from 0036. plpgsql has no
-- partial replacement, so a function that gains a call to a table created here
-- has to be restated in full — the same shape `security.harden()` has taken
-- four times across this chain. The body below is 0036's with one addition,
-- marked where it happens.
-- ===========================================================================

CREATE TABLE "app"."admin_alert" (
	"tenant_id" uuid NOT NULL,
	"id" uuid DEFAULT uuidv7() NOT NULL,
	"kind" text NOT NULL,
	"subject_key" text DEFAULT '' NOT NULL,
	"detail" text NOT NULL,
	"occurrence_count" integer DEFAULT 1 NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"acknowledged_at" timestamp with time zone,
	CONSTRAINT "admin_alert_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "admin_alert_kind" CHECK ("app"."admin_alert"."kind" IN ('unmapped_number', 'mapping_unverified', 'unmapped_disposition',
                        'ingest_throttled', 'reconciliation_unavailable')),
	CONSTRAINT "admin_alert_occurrences_positive" CHECK ("app"."admin_alert"."occurrence_count" >= 1),
	CONSTRAINT "admin_alert_detail_present" CHECK (length(btrim("app"."admin_alert"."detail")) > 0),
	CONSTRAINT "admin_alert_reconciliation_not_acknowledgeable" CHECK ("app"."admin_alert"."acknowledged_at" IS NULL OR "app"."admin_alert"."kind" <> 'reconciliation_unavailable')
);
--> statement-breakpoint
CREATE TABLE "app"."dead_letter" (
	"tenant_id" uuid NOT NULL,
	"id" uuid DEFAULT uuidv7() NOT NULL,
	"origin" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"raw_payload_id" uuid,
	"reason" text NOT NULL,
	"attempt_count" integer DEFAULT 1 NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "dead_letter_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "dead_letter_origin" CHECK ("app"."dead_letter"."origin" IN ('inbound_webhook', 'outbox_delivery', 'job')),
	CONSTRAINT "dead_letter_attempts_positive" CHECK ("app"."dead_letter"."attempt_count" >= 1),
	CONSTRAINT "dead_letter_reason_present" CHECK (length(btrim("app"."dead_letter"."reason")) > 0)
);
--> statement-breakpoint
ALTER TABLE "app"."dead_letter" ADD CONSTRAINT "dead_letter_payload_fk" FOREIGN KEY ("tenant_id","raw_payload_id") REFERENCES "app"."raw_payload_vault"("tenant_id","id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "admin_alert_subject_uidx" ON "app"."admin_alert" USING btree ("tenant_id","kind","subject_key");--> statement-breakpoint
CREATE UNIQUE INDEX "dead_letter_subject_uidx" ON "app"."dead_letter" USING btree ("tenant_id","origin","subject_type","subject_id");--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 1 · Raising an alert, and recording a dead letter
-- ---------------------------------------------------------------------------
-- NEITHER IS GRANTED TO `crm_app`, deliberately. These are called by other
-- definers inside the same transaction as the fact they describe, so an alert
-- cannot exist without its cause and a cause cannot exist without its alert.
-- Granting EXECUTE to the application would let a request manufacture an
-- operational signal, which is the same class of defect as letting one write to
-- the timeline.
CREATE OR REPLACE FUNCTION app.admin_alert_raise(
  p_kind        text,
  p_subject_key text,
  p_detail      text
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
    RAISE EXCEPTION 'AL001: admin_alert_raise called with no tenant context';
  END IF;

  -- The tenth occurrence updates a counter. §5's copy is "1 call from a number
  -- we do not recognize" — a sentence with a number in it, which only works if
  -- something maintains the number.
  INSERT INTO app.admin_alert (tenant_id, kind, subject_key, detail)
  VALUES (v_tenant, p_kind, COALESCE(p_subject_key, ''), p_detail)
  ON CONFLICT (tenant_id, kind, subject_key) DO UPDATE
    SET occurrence_count = app.admin_alert.occurrence_count + 1,
        last_seen_at     = clock_timestamp(),
        detail           = EXCLUDED.detail;
END
$fn$;--> statement-breakpoint

REVOKE ALL ON FUNCTION app.admin_alert_raise(text, text, text) FROM PUBLIC;--> statement-breakpoint

-- 🔴 TWO ENTRY POINTS BECAUSE THE INGEST EDGE HAS NO TENANT CONTEXT, and that
-- is the token decision from 0035 showing its consequences rather than a
-- workaround. `app.webhook_ingest()` resolves the tenant from a credential
-- INSIDE itself, so `app.current_tenant()` is NULL for the whole call — a
-- trigger firing there cannot ask the session who it is.
--
-- The write below takes the tenant explicitly and IS GRANTED TO NOBODY. Its
-- only callers are the definer beneath it and the trigger, and the trigger
-- passes `NEW.tenant_id` — the tenant of the row being written, which the
-- engine already established. So the property survives intact: nothing that
-- can be reached from the application ever names a tenant.
CREATE OR REPLACE FUNCTION app.dead_letter_write(
  p_tenant         uuid,
  p_origin         text,
  p_subject_type   text,
  p_subject_id     text,
  p_raw_payload_id uuid,
  p_reason         text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = app, pg_catalog
AS $fn$
BEGIN
  IF p_tenant IS NULL THEN
    RAISE EXCEPTION 'DL002: dead_letter_write called with no tenant';
  END IF;

  -- A subject dead-letters ONCE. A retry storm produces a count, not a thousand
  -- rows an admin has to page through to find the one that matters.
  INSERT INTO app.dead_letter
    (tenant_id, origin, subject_type, subject_id, raw_payload_id, reason)
  VALUES (p_tenant, p_origin, p_subject_type, p_subject_id, p_raw_payload_id, p_reason)
  ON CONFLICT (tenant_id, origin, subject_type, subject_id) DO UPDATE
    SET attempt_count = app.dead_letter.attempt_count + 1,
        last_seen_at  = clock_timestamp(),
        reason        = EXCLUDED.reason;
END
$fn$;--> statement-breakpoint

REVOKE ALL ON FUNCTION app.dead_letter_write(uuid, text, text, text, uuid, text) FROM PUBLIC;--> statement-breakpoint

/** For callers that DO have context — the job dispatcher and the outbox relay. */
CREATE OR REPLACE FUNCTION app.dead_letter_record(
  p_origin         text,
  p_subject_type   text,
  p_subject_id     text,
  p_raw_payload_id uuid,
  p_reason         text
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
    RAISE EXCEPTION 'DL001: dead_letter_record called with no tenant context';
  END IF;

  PERFORM app.dead_letter_write(
    v_tenant, p_origin, p_subject_type, p_subject_id, p_raw_payload_id, p_reason);
END
$fn$;--> statement-breakpoint

REVOKE ALL ON FUNCTION app.dead_letter_record(text, text, text, uuid, text) FROM PUBLIC;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2 · A signature-invalid delivery dead-letters BY TRIGGER
-- ---------------------------------------------------------------------------
-- 🔴 A TRIGGER RATHER THAN A LINE INSIDE `app.webhook_ingest()`, and the reason
-- is the difference between a rule and a mechanism. As a call, the guarantee is
-- "the one function that inserts these rows remembers to do it". As a trigger,
-- it is "a row with `signature_valid = false` CANNOT exist without its dead
-- letter" — true for the definer, true for a migration, true for the migrator
-- in a SQL console at 2 a.m.
--
-- ⚠️ IT IS UNREACHABLE TODAY AND THAT IS CORRECT, NOT DEAD CODE. Gate G2
-- established that Aloware sends no signature at all, so the edge writes NULL on
-- every real delivery — "we cannot verify", which §4.2 ruling 3 made nullable
-- precisely so we would not have to record a lie. The day a provider signs,
-- the decision is already made and already enforced.
CREATE OR REPLACE FUNCTION app.inbound_webhook_dead_letter()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = app, pg_catalog
AS $fn$
BEGIN
  IF NEW.signature_valid IS FALSE THEN
    -- `NEW.tenant_id`, never `app.current_tenant()`: the edge has no session and
    -- the row's own tenant is the one the engine already resolved from the token.
    PERFORM app.dead_letter_write(
      NEW.tenant_id,
      'inbound_webhook',
      'inbound_webhook_event',
      NEW.id::text,
      NEW.raw_payload_id,
      format('Signature presented by %s did not verify. The bytes are kept; no job was enqueued.',
             NEW.provider));
  END IF;
  RETURN NULL;
END
$fn$;--> statement-breakpoint

CREATE TRIGGER t_inbound_webhook_dead_letter
  AFTER INSERT ON app.inbound_webhook_event
  FOR EACH ROW EXECUTE FUNCTION app.inbound_webhook_dead_letter();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3 · Classify, then harden
-- ---------------------------------------------------------------------------
-- `tenant_admin_only`: sellers never see either table. An admin reads both and
-- may write exactly ONE column each — `acknowledged_at` and `resolved_at`.
--
-- 🔴 THE ONE-COLUMN GRANT IS BUILT BY LISTING THE PROTECTED COLUMNS, NEVER BY
-- GRANTING THE TABLE AND REVOKING THE REST. PostgreSQL does not decompose a
-- table-level grant, so `GRANT UPDATE ON t` followed by `REVOKE UPDATE (c) ON t`
-- leaves `c` writable — the revoke removes a column privilege that was never
-- separately granted. Enumerating is the only form that holds, and a column
-- added later is protected by default until this list is regenerated.
--
-- ⚠️ At least one column must stay OFF each list: `harden()` builds
-- `GRANT UPDATE (…)` from the complement, and an empty complement is a syntax
-- error that takes the whole hardening pass down.
INSERT INTO security.table_registry
  (schema_name, table_name, policy_class, owner_column, immutable, app_can_insert,
   protected_columns, exception_reason, registered_in_migration)
VALUES
  ('app', 'dead_letter', 'tenant_admin_only', NULL, false, false,
   ARRAY['tenant_id','id','origin','subject_type','subject_id','raw_payload_id',
         'reason','attempt_count','first_seen_at','last_seen_at'],
   NULL, '0049_dead_letter_and_alerts'),
  ('app', 'admin_alert', 'tenant_admin_only', NULL, false, false,
   ARRAY['tenant_id','id','kind','subject_key','detail','occurrence_count',
         'first_seen_at','last_seen_at'],
   NULL, '0049_dead_letter_and_alerts')
ON CONFLICT (schema_name, table_name) DO UPDATE
  SET policy_class            = EXCLUDED.policy_class,
      owner_column            = EXCLUDED.owner_column,
      immutable               = EXCLUDED.immutable,
      app_can_insert          = EXCLUDED.app_can_insert,
      protected_columns       = EXCLUDED.protected_columns,
      exception_reason        = EXCLUDED.exception_reason,
      registered_in_migration = EXCLUDED.registered_in_migration;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4 · call_merge, superseding 0036: an unmapped call now RAISES
-- ---------------------------------------------------------------------------
-- plpgsql has no partial replacement, so gaining one PERFORM means restating
-- the whole body. That is the same shape security.harden() has taken four
-- times across this chain, and the duplication is visible in one file rather
-- than hidden behind an edit to a migration that has already run.
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

  IF v_owner IS NULL THEN
    -- 🔴 THE QUARANTINE BECOMES VISIBLE HERE, IN THE SAME TRANSACTION AS THE
    -- ROW IT DESCRIBES. §5: "Vaulted, quarantined,
    -- admin_alert(kind='unmapped_number'), occurrence_count increments. Never
    -- dropped, never guessed."
    --
    -- A CALL rather than a trigger, unlike the dead-letter path in this same
    -- migration, and the difference is real rather than stylistic:
    -- app.call_merge() is the ONLY writer of app.call — crm_app holds SELECT
    -- and nothing else under owner_scoped_read — so "the one function does it"
    -- and "the engine does it" are the same guarantee here. On
    -- inbound_webhook_event they are not, which is why that one is a trigger.
    --
    -- The subject is the NUMBER, so fifty callbacks to one unrecognised line
    -- are one alert carrying a count of fifty rather than fifty rows. That is
    -- what makes §5’s sentence renderable at all.
    PERFORM app.admin_alert_raise(
      'unmapped_number',
      COALESCE(p_our_number_e164, ''),
      CASE WHEN p_our_number_e164 IS NULL
        THEN 'A call arrived with no number we could match. Nothing was written to a seller''s book.'
        ELSE format('A call arrived on %s, which is not in the number map. Nothing was written to a seller''s book.',
                    p_our_number_e164)
      END);
    RETURN 'unmapped';
  END IF;

  RETURN 'resolved';
END
$fn$;--> statement-breakpoint

SELECT security.harden();
