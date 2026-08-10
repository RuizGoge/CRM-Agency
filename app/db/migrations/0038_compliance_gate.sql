CREATE TYPE "app"."gate_verdict" AS ENUM('allow', 'blocked_sms_disabled', 'blocked_suppressed', 'blocked_timezone_unknown', 'blocked_calling_window', 'blocked_recording_unverified');--> statement-breakpoint
CREATE TYPE "app"."override_end_reason" AS ENUM('manual', 'auto_expired');--> statement-breakpoint
CREATE TYPE "app"."override_scope" AS ENUM('timezone_and_window');--> statement-breakpoint
CREATE TABLE "app"."break_glass_override" (
	"tenant_id" uuid NOT NULL,
	"id" uuid DEFAULT uuidv7() NOT NULL,
	"started_by_user_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"scope" "app"."override_scope" DEFAULT 'timezone_and_window' NOT NULL,
	"started_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"ended_at" timestamp with time zone,
	"ended_by_user_id" uuid,
	"end_reason" "app"."override_end_reason",
	CONSTRAINT "break_glass_override_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "override_reason_is_real" CHECK (length(btrim("app"."break_glass_override"."reason")) >= 10),
	CONSTRAINT "override_scope_is_the_only_one" CHECK ("app"."break_glass_override"."scope" = 'timezone_and_window')
);
--> statement-breakpoint
CREATE TABLE "ref"."state_recording_regime" (
	"state_code" char(2) PRIMARY KEY NOT NULL,
	"regime" text NOT NULL,
	CONSTRAINT "recording_regime_known" CHECK ("ref"."state_recording_regime"."regime" IN ('all_party', 'one_party')),
	CONSTRAINT "recording_regime_state_is_alpha" CHECK ("ref"."state_recording_regime"."state_code" ~ '^[A-Z]{2}$')
);
--> statement-breakpoint
ALTER TABLE "app"."break_glass_override" ADD CONSTRAINT "break_glass_override_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."break_glass_override" ADD CONSTRAINT "override_started_by_fk" FOREIGN KEY ("tenant_id","started_by_user_id") REFERENCES "app"."app_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."break_glass_override" ADD CONSTRAINT "override_ended_by_fk" FOREIGN KEY ("tenant_id","ended_by_user_id") REFERENCES "app"."app_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "override_one_live_per_tenant" ON "app"."break_glass_override" USING btree ("tenant_id") WHERE "app"."break_glass_override"."ended_at" IS NULL;
--> statement-breakpoint

-- EXPIRY NEEDS NO JOB. Generated from started_at, so it is computed on every
-- read: it cannot drift, cannot be missed by a worker outage, and cannot be
-- extended by anyone. An override that outlives its window because a scheduler
-- was down is the failure this column removes.
--
-- 05b SPECIFIES `GENERATED ALWAYS AS (started_at + interval '60 minutes')
-- STORED` AND POSTGRES REFUSES IT: `timestamptz + interval` is marked STABLE,
-- not IMMUTABLE, so it cannot appear in a generation expression. The marking is
-- conservative rather than wrong -- an interval carrying months or days does
-- depend on the session timezone, because a "day" across a DST boundary is not
-- always 24 hours.
--
-- For a FIXED SUB-DAY interval it is genuinely immutable, so the claim below is
-- true rather than a convenient lie: sixty minutes is sixty minutes in every
-- zone, on every date. Declaring it lets the column stay GENERATED and STORED,
-- which is what the ruling actually wanted -- an expiry nobody can extend.
CREATE OR REPLACE FUNCTION app.override_expiry(p_started_at timestamptz)
RETURNS timestamptz
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $fn$ SELECT p_started_at + interval '60 minutes' $fn$;
--> statement-breakpoint

ALTER TABLE app.break_glass_override
  ADD COLUMN expires_at timestamptz
  GENERATED ALWAYS AS (app.override_expiry(started_at)) STORED;
--> statement-breakpoint

INSERT INTO security.table_registry
  (schema_name, table_name, policy_class, owner_column, immutable, app_can_insert,
   protected_columns, exception_reason, registered_in_migration)
VALUES
  ('app', 'break_glass_override', 'tenant_scoped', NULL, false, false, NULL, NULL,
   '0038_compliance_gate'),
  ('ref', 'state_recording_regime', 'reference', NULL, false, false, NULL,
   'Public reference data with no tenant dimension: which US states require all-party consent to record a call. SEC-10 requires this to live in a relation rather than an if-chain so that changing it is a seeded row and not a code change.',
   '0038_compliance_gate')
ON CONFLICT (schema_name, table_name) DO UPDATE
  SET policy_class = EXCLUDED.policy_class, exception_reason = EXCLUDED.exception_reason;
--> statement-breakpoint

-- TENANT-SCOPED READ ON PURPOSE: the amber banner has to reach every signed-in
-- user, sellers included, because a floor working under a paused calling-window
-- check must be able to see that it is. Writes are admin-only, which the
-- generated tenant_scoped policy already enforces via scope_is_admin().
INSERT INTO ref.state_recording_regime (state_code, regime) VALUES
  ('CA','all_party'), ('FL','all_party'), ('PA','all_party'),
  ('IL','all_party'), ('WA','all_party'), ('MA','all_party');
--> statement-breakpoint

INSERT INTO ref.system_constant (key, value, reason) VALUES
  ('recording_guard', 'tripped',
   'SEC-10. Aloware records at the ACCOUNT level and whether the announcement fires on the Two-Legged Call path is unverified, so the guard starts tripped and fails closed. While tripped, dials to all-party-consent states are refused and every other dial proceeds -- proportionate to the exposure rather than a floor-wide stop. Set to disabled_verified only against evidence.')
ON CONFLICT (key) DO NOTHING;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.break_glass_engage(p_reason text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = app, ref, pg_catalog
AS $fn$
DECLARE
  v_tenant uuid;
  v_id     uuid;
BEGIN
  v_tenant := app.current_tenant();
  IF v_tenant IS NULL OR NOT app.scope_is_admin() THEN
    RAISE EXCEPTION 'BG001: break-glass is admin-only';
  END IF;

  -- Close any override that has already expired, FIRST. clock_timestamp() is
  -- not immutable so it cannot live in the unique index predicate; "live" in
  -- the index means "not yet ended", and this deterministic fixup is what
  -- reconciles the two definitions before the insert.
  UPDATE app.break_glass_override
     SET ended_at = expires_at, end_reason = 'auto_expired'
   WHERE tenant_id = v_tenant
     AND ended_at IS NULL
     AND clock_timestamp() >= expires_at;

  INSERT INTO app.break_glass_override (tenant_id, started_by_user_id, reason)
  VALUES (v_tenant, app.current_user_id(), p_reason)
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$fn$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION app.break_glass_engage(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.break_glass_engage(text) TO crm_app;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.break_glass_end()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = app, ref, pg_catalog
AS $fn$
DECLARE
  v_tenant uuid;
  v_n      integer;
BEGIN
  v_tenant := app.current_tenant();
  IF v_tenant IS NULL OR NOT app.scope_is_admin() THEN
    RAISE EXCEPTION 'BG001: break-glass is admin-only';
  END IF;

  UPDATE app.break_glass_override
     SET ended_at = clock_timestamp(), ended_by_user_id = app.current_user_id(),
         end_reason = 'manual'
   WHERE tenant_id = v_tenant AND ended_at IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$fn$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION app.break_glass_end() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.break_glass_end() TO crm_app;
--> statement-breakpoint

-- ===========================================================================
-- THE ONE OUTBOUND COMPLIANCE GATE. D-SEC-4, in order.
--
-- Every dial, every message and every reminder passes through here: card,
-- detail, My Day, appointment row, wrap-up, scheduler, the degraded manual
-- path and the raw API. One choke point is the requirement -- a second place
-- that decides is a second place that can be wrong, and the wrong one is
-- always the one nobody tested.
--
-- ORDER IS PART OF THE MEANING. Suppression is evaluated before the clock, so
-- a STOP is refused at 2pm for exactly the reason it is refused at midnight.
-- The two clock verdicts come last among the blocks because they are the only
-- two that break-glass can release; putting them first would have let an
-- override answer a question it must never reach.
--
-- SECURITY DEFINER, because it reads suppression_list, which crm_app holds no
-- privilege on at all. That means RLS is switched off in here and ownership is
-- re-asserted by hand, on the contact, in the first statement.
-- ===========================================================================
CREATE OR REPLACE FUNCTION app.compliance_check(
  p_contact_id uuid,
  p_channel    app.channel,
  p_at         timestamptz DEFAULT now()
)
RETURNS TABLE (
  verdict       app.gate_verdict,
  event_verdict text,
  override_id   uuid,
  zones         text[]
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = app, ref, pg_catalog
AS $fn$
DECLARE
  v_tenant   uuid;
  v_state    char(2);
  v_zip      char(5);
  v_phone    text;
  v_npa      char(3);
  v_sms_ok   boolean;
  v_supp     app.suppression_kind;
  v_override uuid;
  v_zones    text[];
  v_allowed  boolean;
  v_visible  boolean;
  v_reason   text;
BEGIN
  v_tenant := app.current_tenant();
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'CG001: compliance_check called outside a tenant session';
  END IF;

  -- OWNERSHIP, re-asserted here because a definer has no RLS. A contact in
  -- another book resolves to nothing and falls through to the unknown-timezone
  -- verdict, which fails CLOSED -- the correct direction for an accident, and
  -- indistinguishable from a contact that never existed.
  SELECT c.state_code, c.zip5 INTO v_state, v_zip
    FROM app.contact c
   WHERE c.tenant_id = v_tenant
     AND c.id = p_contact_id
     AND (c.owner_user_id = app.current_user_id() OR app.scope_is_global());
  v_visible := FOUND;

  -- RETURN BEFORE DELEGATING, and this early exit is load-bearing rather than
  -- tidy. app.calling_window_check is SECURITY INVOKER and gets its silo from
  -- RLS -- but called from INSIDE this definer it inherits the definer's
  -- context, so RLS is off and it would happily resolve a contact in another
  -- seller's book. The ownership predicate above would have been decoration.
  --
  -- Found by a test asserting Ana gets the closed answer for Ben's lead; she
  -- got `allow`.
  IF NOT v_visible THEN
    RETURN QUERY SELECT 'blocked_timezone_unknown'::app.gate_verdict,
                        'unknown_timezone'::text, NULL::uuid, ARRAY[]::text[];
    RETURN;
  END IF;

  SELECT cp.phone_e164, substring(cp.phone_e164 from 3 for 3)
    INTO v_phone, v_npa
    FROM app.contact_phone cp
   WHERE cp.tenant_id = v_tenant
     AND cp.contact_id = p_contact_id
     AND (cp.owner_user_id = app.current_user_id() OR app.scope_is_global())
   ORDER BY cp.is_primary DESC, cp.created_at ASC
   LIMIT 1;

  -- 1 -- SMS DISABLED. Never overridable, at any tier, by anyone.
  SELECT t.sms_enabled INTO v_sms_ok FROM app.tenant t WHERE t.id = v_tenant;
  IF p_channel = 'sms' AND coalesce(v_sms_ok, false) = false THEN
    RETURN QUERY SELECT 'blocked_sms_disabled'::app.gate_verdict,
                        '10dlc_pending'::text, NULL::uuid, ARRAY[]::text[];
    RETURN;
  END IF;

  -- 2 -- SUPPRESSION. Never overridable, not even by an admin: break_glass has
  -- no label for it. A row with a NULL channel silences every channel, which is
  -- what a federal DNC listing actually means.
  IF v_phone IS NOT NULL THEN
    SELECT s.kind INTO v_supp
      FROM app.suppression_list s
     WHERE s.tenant_id = v_tenant
       AND s.phone_e164 = v_phone
       AND (s.channel IS NULL OR s.channel = p_channel)
     ORDER BY s.effective_at DESC, s.recorded_at DESC
     LIMIT 1;

    IF v_supp IS NOT NULL AND v_supp <> 'start' THEN
      RETURN QUERY SELECT 'blocked_suppressed'::app.gate_verdict,
                          (CASE WHEN v_supp = 'stop' THEN 'stop' ELSE 'dnc' END)::text,
                          NULL::uuid, ARRAY[]::text[];
      RETURN;
    END IF;
  END IF;

  -- The live override, if there is one. Expiry is read from the generated
  -- column, so an override that ran out one second ago is already not live.
  SELECT o.id INTO v_override
    FROM app.break_glass_override o
   WHERE o.tenant_id = v_tenant
     AND o.ended_at IS NULL
     AND p_at < o.expires_at
   LIMIT 1;

  -- 3 and 4 -- TIMEZONE and WINDOW. The only two verdicts break-glass releases.
  SELECT w.allowed, w.reason, w.zones
    INTO v_allowed, v_reason, v_zones
    FROM app.calling_window_check(p_contact_id, p_at) w;

  IF coalesce(v_allowed, false) = false THEN
    IF v_override IS NOT NULL THEN
      -- Released -- and the override id rides along so a permitted-under-
      -- break-glass send is never indistinguishable from a plain one.
      NULL;
    ELSE
      RETURN QUERY SELECT
        (CASE WHEN v_reason = 'blocked_timezone_unknown'
              THEN 'blocked_timezone_unknown' ELSE 'blocked_calling_window' END)::app.gate_verdict,
        (CASE WHEN v_reason = 'blocked_timezone_unknown'
              THEN 'unknown_timezone' ELSE 'outside_window' END)::text,
        NULL::uuid, coalesce(v_zones, ARRAY[]::text[]);
      RETURN;
    END IF;
  END IF;

  -- 5 -- RECORDING. Never overridable either, and proportionate: only dials to
  -- all-party-consent states are refused while the guard is tripped. Every
  -- other dial proceeds, because stopping the floor over an unverified provider
  -- setting is a bigger harm than the exposure it removes.
  IF p_channel = 'call'
     AND v_state IS NOT NULL
     AND EXISTS (SELECT 1 FROM ref.system_constant sc
                  WHERE sc.key = 'recording_guard' AND sc.value = 'tripped')
     AND EXISTS (SELECT 1 FROM ref.state_recording_regime r
                  WHERE r.state_code = v_state AND r.regime = 'all_party') THEN
    RETURN QUERY SELECT 'blocked_recording_unverified'::app.gate_verdict,
                        'unverified_mapping'::text, NULL::uuid,
                        coalesce(v_zones, ARRAY[]::text[]);
    RETURN;
  END IF;

  RETURN QUERY SELECT 'allow'::app.gate_verdict, NULL::text, v_override,
                      coalesce(v_zones, ARRAY[]::text[]);
END;
$fn$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION app.compliance_check(uuid, app.channel, timestamptz) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.compliance_check(uuid, app.channel, timestamptz) TO crm_app;
--> statement-breakpoint

SELECT security.harden();
