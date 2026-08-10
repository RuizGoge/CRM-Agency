CREATE TYPE "app"."capability_status" AS ENUM('unknown', 'verified', 'absent');--> statement-breakpoint
CREATE TYPE "app"."capability_tier" AS ENUM('mvp_required', 'mvp_optional', 'probe_only');--> statement-breakpoint
CREATE TYPE "app"."provider" AS ENUM('aloware');--> statement-breakpoint
CREATE TABLE "ref"."capability_probe" (
	"probe_id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"provider" "app"."provider" NOT NULL,
	"capability" text NOT NULL,
	"http_status" smallint NOT NULL,
	"response_body" "bytea" NOT NULL,
	"response_digest" "bytea" NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"probe_run" text NOT NULL,
	"request_method" text NOT NULL,
	"request_url" text NOT NULL,
	CONSTRAINT "capability_probe_digest_matches" CHECK ("ref"."capability_probe"."response_digest" = sha256("ref"."capability_probe"."response_body")),
	CONSTRAINT "capability_probe_body_present" CHECK (length("ref"."capability_probe"."response_body") > 0 OR "ref"."capability_probe"."http_status" IN (204, 304)),
	CONSTRAINT "capability_probe_run_present" CHECK (length(btrim("ref"."capability_probe"."probe_run")) > 0),
	CONSTRAINT "capability_probe_http_status_range" CHECK ("ref"."capability_probe"."http_status" BETWEEN 100 AND 599)
);
--> statement-breakpoint
CREATE TABLE "ref"."provider_capability" (
	"provider" "app"."provider" NOT NULL,
	"capability" text NOT NULL,
	"status" "app"."capability_status" DEFAULT 'unknown' NOT NULL,
	"tier" "app"."capability_tier" NOT NULL,
	"verified_at" timestamp with time zone,
	"evidence_probe_id" uuid,
	CONSTRAINT "provider_capability_provider_capability_pk" PRIMARY KEY("provider","capability"),
	CONSTRAINT "capability_verified_needs_probe" CHECK ("ref"."provider_capability"."status" <> 'verified' OR ("ref"."provider_capability"."evidence_probe_id" IS NOT NULL AND "ref"."provider_capability"."verified_at" IS NOT NULL)),
	CONSTRAINT "capability_unverified_has_no_timestamp" CHECK ("ref"."provider_capability"."status" = 'verified' OR "ref"."provider_capability"."verified_at" IS NULL)
);
--> statement-breakpoint
ALTER TABLE "ref"."provider_capability" ADD CONSTRAINT "provider_capability_evidence_probe_id_capability_probe_probe_id_fk" FOREIGN KEY ("evidence_probe_id") REFERENCES "ref"."capability_probe"("probe_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- ===========================================================================
-- 2 · The three things a CHECK cannot say
-- ===========================================================================
-- `capability_verified_needs_probe` proves a probe is ATTACHED. It cannot prove
-- the probe is the RIGHT one. Without this trigger, `two_legged_call` can be
-- marked verified against the probe captured for `contact_lookup` — a 200 from
-- an endpoint that has nothing to do with dialling — and every constraint in
-- this file passes.
--
-- §7.7.6 specifies two of these arms (2xx, and verified_at = observed_at). The
-- provider/capability match is added here because the actor this whole design
-- distrusts is a migration nobody reads, and pointing at the wrong probe is
-- precisely the shape of a mistake that migration would make.
CREATE OR REPLACE FUNCTION ref.refuse_unproven_capability()
RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  p ref.capability_probe%ROWTYPE;
BEGIN
  IF NEW.status <> 'verified' THEN
    RETURN NEW;
  END IF;

  SELECT * INTO p FROM ref.capability_probe WHERE probe_id = NEW.evidence_probe_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'CAP001: % / % claims verified with no probe row', NEW.provider, NEW.capability
      USING HINT = 'A verification is a captured exchange or it is a word in a column.';
  END IF;

  IF p.provider <> NEW.provider OR p.capability <> NEW.capability THEN
    RAISE EXCEPTION
      'CAP002: % / % is verified by a probe for % / %',
      NEW.provider, NEW.capability, p.provider, p.capability
      USING HINT = 'The probe must be of the capability it certifies.';
  END IF;

  IF p.http_status < 200 OR p.http_status > 299 THEN
    RAISE EXCEPTION 'CAP003: % / % is verified by a probe that returned %',
      NEW.provider, NEW.capability, p.http_status
      USING HINT = 'A non-2xx exchange is evidence of ABSENT, not of verified.';
  END IF;

  IF NEW.verified_at IS DISTINCT FROM p.observed_at THEN
    RAISE EXCEPTION
      'CAP004: % / % has verified_at % but its probe was observed at %',
      NEW.provider, NEW.capability, NEW.verified_at, p.observed_at
      USING HINT = 'verified_at is the moment the provider answered, not the moment someone typed it.';
  END IF;

  RETURN NEW;
END
$fn$;--> statement-breakpoint

DROP TRIGGER IF EXISTS t_capability_needs_proof ON ref.provider_capability;--> statement-breakpoint

CREATE TRIGGER t_capability_needs_proof
  BEFORE INSERT OR UPDATE ON ref.provider_capability
  FOR EACH ROW EXECUTE FUNCTION ref.refuse_unproven_capability();--> statement-breakpoint

-- ===========================================================================
-- 3 · The eight capabilities of §7.3, as rows in state `unknown`
-- ===========================================================================
-- The tier column is the signed part. `mvp_required` is what the boot assertion
-- reads, and §7.3 gives exactly THREE of them a written consequence:
--
--   two_legged_call      absent -> the product has no dialer. NOT SHIPPABLE.
--   webhook_subscription absent -> same.
--   call_list            absent -> ARR-INT-08 has no implementation; a dropped
--                                  webhook silently deletes a call from history
--                                  and corrupts last_activity_at, the 7-day cold
--                                  rule and the decay rail.
--
-- `sms_send` reads like a fourth and is NOT one: §7.3 tiers it mvp_optional,
-- because absent it makes SMS-dark permanent rather than temporary and nothing
-- else moves. Promoting it would make a missing SMS endpoint stop production
-- from booting over a feature the launch posture already has switched off.
--
-- DO NOTHING, never DO UPDATE: a re-run must not quietly reset a verified
-- capability to `unknown` — nor, worse, the reverse.
INSERT INTO ref.provider_capability (provider, capability, status, tier)
VALUES
  ('aloware', 'two_legged_call',                     'unknown', 'mvp_required'),
  ('aloware', 'webhook_subscription',                'unknown', 'mvp_required'),
  ('aloware', 'call_list',                           'unknown', 'mvp_required'),
  ('aloware', 'sms_send',                            'unknown', 'mvp_optional'),
  ('aloware', 'contact_lookup',                      'unknown', 'mvp_optional'),
  ('aloware', 'sequence_enroll',                     'unknown', 'probe_only'),
  ('aloware', 'sequence_disenroll',                  'unknown', 'probe_only'),
  ('aloware', 'recording_announcement_on_two_legged','unknown', 'probe_only')
ON CONFLICT (provider, capability) DO NOTHING;--> statement-breakpoint

-- ===========================================================================
-- 4 · Classify, then harden
-- ===========================================================================
-- `reference` is the enumerated exception to "every table carries tenant_id",
-- and it requires a written reason. Both reasons are the same fact: a provider's
-- capability set is a property of the ACCOUNT we hold with that provider, not of
-- any tenant in this system. Giving these tables a tenant dimension would invite
-- the reading that tenant A's Aloware could be verified while tenant B's is not,
-- which is not the deployment this product has.
--
-- What the class buys mechanically, and it is the load-bearing half: harden()
-- grants `reference` tables SELECT to crm_app and NOTHING else — no INSERT, no
-- UPDATE, at any point in the function. So no request-serving code path can
-- mint a probe or promote a capability. That is a revoked privilege, not a
-- convention.
--
-- `immutable` on the probe adds the statement-level refusal, which binds the
-- OWNER and a superuser too, not just crm_app. Evidence that can be edited
-- afterwards is evidence that can be edited into agreement with whatever
-- somebody wishes were true. A wrong probe is superseded by a newer probe and
-- the capability repointed — the same compensating-append shape as the ledger.
INSERT INTO security.table_registry
  (schema_name, table_name, policy_class, immutable, app_can_insert, exception_reason, registered_in_migration)
VALUES
  ('ref', 'capability_probe',    'reference', true,  false,
   'Provider evidence, not tenant data. Append-only: a probe is a captured exchange and E9 puts it on a permanent clock, so it is never edited and never purged. Probes are captured against SYNTHETIC subjects only — a real consumer captured here would acquire that permanent clock, which is exactly the CCPA minimisation raw_payload_vault exists to provide.',
   '0029_provider_capability_probe'),
  ('ref', 'provider_capability', 'reference', false, false,
   'The capability set of the Aloware ACCOUNT, not of any tenant. Mutable because status legitimately moves unknown -> verified -> absent, but only through a migration or the owner console: the reference class grants crm_app no write at all.',
   '0029_provider_capability_probe')
ON CONFLICT (schema_name, table_name) DO UPDATE
  SET policy_class            = EXCLUDED.policy_class,
      immutable               = EXCLUDED.immutable,
      app_can_insert          = EXCLUDED.app_can_insert,
      exception_reason        = EXCLUDED.exception_reason,
      registered_in_migration = EXCLUDED.registered_in_migration;--> statement-breakpoint

SELECT security.harden();