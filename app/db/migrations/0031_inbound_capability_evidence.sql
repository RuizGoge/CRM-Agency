-- ===========================================================================
-- Sprint-0 Gate G2 · how an INBOUND capability is evidenced
--
-- THE HOLE THIS CLOSES, in the words migration 0030 used to record it:
--
--   "`webhook_subscription` is NOT promoted, AND IT CANNOT BE with the table as
--    designed. 20 real deliveries were captured, which is far stronger evidence
--    than any probe — but `ref.capability_probe` models an OUTBOUND request and
--    its response, and a webhook is INBOUND. There is no shape for it."
--
-- The shape is `ref.capability_delivery`. Same guarantees as the probe:
-- `reference` class so no request-serving code path can mint one, `immutable`
-- so the refusal binds the owner and a superuser too, and a digest CHECK so the
-- row is internally consistent at INSERT rather than at a boot check months
-- later.
--
-- ⚠️ ONE GUARANTEE IS DELIBERATELY NOT COPIED, and getting this wrong would have
-- refused the very evidence that answered G2's worst assertion. `CAP003` demands
-- a 2xx from an outbound probe, because there a 2xx is the provider saying the
-- endpoint exists. Inbound, OUR response status says nothing about THEIR ability
-- to deliver — G2 proved that directly by answering `HTTP 500` to six real
-- deliveries, every one of which had already been delivered. So there is no
-- status precondition here; the status is recorded as a fact.
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO:
--
--   * It does not wire the boot assertion. That needs `system_constant` to know
--     whether this is production, and that table does not exist yet. A gate that
--     cannot tell which environment it is in is not a gate.
--   * It does not promote `call_list`, which is also `mvp_required` and also
--     unverified. G2 found it neither documented nor discoverable, while §7.3's
--     own "if absent" cell for that row describes a compensating control and the
--     MVP shipping anyway. Those two texts cannot both be true and the
--     contradiction is the owner's to resolve, not a migration's.
-- ===========================================================================

CREATE TABLE "ref"."capability_delivery" (
	"delivery_id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"provider" "app"."provider" NOT NULL,
	"capability" text NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"request_method" text NOT NULL,
	"request_path" text NOT NULL,
	"request_headers" jsonb NOT NULL,
	"request_body" "bytea" NOT NULL,
	"request_digest" "bytea" NOT NULL,
	"response_status" smallint NOT NULL,
	"probe_run" text NOT NULL,
	"caused_by_probe_id" uuid,
	CONSTRAINT "capability_delivery_digest_matches" CHECK ("ref"."capability_delivery"."request_digest" = sha256("ref"."capability_delivery"."request_body")),
	CONSTRAINT "capability_delivery_body_present" CHECK (length("ref"."capability_delivery"."request_body") > 0),
	CONSTRAINT "capability_delivery_run_present" CHECK (length(btrim("ref"."capability_delivery"."probe_run")) > 0),
	CONSTRAINT "capability_delivery_response_status_range" CHECK ("ref"."capability_delivery"."response_status" BETWEEN 100 AND 599),
	CONSTRAINT "capability_delivery_headers_redacted" CHECK (lower("ref"."capability_delivery"."request_headers"::text) NOT LIKE '%"authorization"%'
          AND lower("ref"."capability_delivery"."request_headers"::text) NOT LIKE '%"cookie"%')
);
--> statement-breakpoint
ALTER TABLE "ref"."provider_capability" DROP CONSTRAINT "capability_verified_needs_probe";--> statement-breakpoint
ALTER TABLE "ref"."provider_capability" ADD COLUMN "evidence_delivery_id" uuid;--> statement-breakpoint
ALTER TABLE "ref"."capability_delivery" ADD CONSTRAINT "capability_delivery_caused_by_probe_id_capability_probe_probe_id_fk" FOREIGN KEY ("caused_by_probe_id") REFERENCES "ref"."capability_probe"("probe_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ref"."provider_capability" ADD CONSTRAINT "provider_capability_evidence_delivery_id_capability_delivery_delivery_id_fk" FOREIGN KEY ("evidence_delivery_id") REFERENCES "ref"."capability_delivery"("delivery_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ref"."provider_capability" ADD CONSTRAINT "capability_verified_needs_evidence" CHECK ("ref"."provider_capability"."status" <> 'verified'
          OR (num_nonnulls("ref"."provider_capability"."evidence_probe_id", "ref"."provider_capability"."evidence_delivery_id") = 1
              AND "ref"."provider_capability"."verified_at" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "ref"."provider_capability" ADD CONSTRAINT "capability_unverified_has_no_evidence" CHECK ("ref"."provider_capability"."status" = 'verified'
          OR num_nonnulls("ref"."provider_capability"."evidence_probe_id", "ref"."provider_capability"."evidence_delivery_id") = 0);--> statement-breakpoint

-- ===========================================================================
-- 2 · The trigger learns the second shape
-- ===========================================================================
-- `capability_verified_needs_evidence` proves an evidence row is ATTACHED and
-- that there is exactly one. It cannot prove it is the RIGHT one — the same
-- thing `CAP002` was added to 0029 for. This REPLACES that function rather than
-- adding a second trigger, so there stays exactly one place that decides what
-- "verified" costs.
CREATE OR REPLACE FUNCTION ref.refuse_unproven_capability()
RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  p ref.capability_probe%ROWTYPE;
  d ref.capability_delivery%ROWTYPE;
BEGIN
  IF NEW.status <> 'verified' THEN
    RETURN NEW;
  END IF;

  -- ---------------------------------------------------------------------
  -- Outbound: we asked, they answered. Unchanged from 0029.
  -- ---------------------------------------------------------------------
  IF NEW.evidence_probe_id IS NOT NULL THEN
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
  END IF;

  -- ---------------------------------------------------------------------
  -- Inbound: they sent, we received.
  -- ---------------------------------------------------------------------
  IF NEW.evidence_delivery_id IS NOT NULL THEN
    SELECT * INTO d FROM ref.capability_delivery WHERE delivery_id = NEW.evidence_delivery_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'CAP005: % / % claims verified with no delivery row', NEW.provider, NEW.capability
        USING HINT = 'A verification is a captured delivery or it is a word in a column.';
    END IF;

    IF d.provider <> NEW.provider OR d.capability <> NEW.capability THEN
      RAISE EXCEPTION
        'CAP006: % / % is verified by a delivery for % / %',
        NEW.provider, NEW.capability, d.provider, d.capability
        USING HINT = 'The delivery must be of the capability it certifies.';
    END IF;

    -- NOTE THE ABSENCE, because it is a decision and not an oversight: there is
    -- no arm here corresponding to CAP003. Our response status does not bear on
    -- whether the provider can deliver. G2 answered six real deliveries with
    -- HTTP 500 and every one of them had already been delivered; an arm
    -- demanding 2xx would have refused exactly that evidence.

    IF NEW.verified_at IS DISTINCT FROM d.received_at THEN
      RAISE EXCEPTION
        'CAP008: % / % has verified_at % but its delivery arrived at %',
        NEW.provider, NEW.capability, NEW.verified_at, d.received_at
        USING HINT = 'verified_at is the moment the provider delivered, not the moment someone typed it.';
    END IF;

    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'CAP001: % / % claims verified with no evidence at all', NEW.provider, NEW.capability
    USING HINT = 'Attach a probe (outbound) or a delivery (inbound).';
END
$fn$;--> statement-breakpoint

-- ===========================================================================
-- 3 · Classify, then harden
-- ===========================================================================
-- Same reasoning as 0029's two tables, and the same two words. `reference`
-- because a provider's capability set is a property of the ACCOUNT we hold with
-- that provider and not of any tenant — so harden() grants crm_app SELECT and
-- nothing else, and no code path that serves a request can write one.
-- `immutable` because a captured delivery that can be edited afterwards is a
-- delivery that can be edited into agreement with whatever somebody wishes were
-- true.
INSERT INTO security.table_registry
  (schema_name, table_name, policy_class, immutable, app_can_insert, exception_reason, registered_in_migration)
VALUES
  ('ref', 'capability_delivery', 'reference', true, false,
   'A captured INBOUND provider delivery — the counterpart of capability_probe, which models only an outbound request. Provider evidence, not tenant data. Append-only and never purged, so like the probe it is captured against synthetic subjects only: the delivery cited by this migration is Aloware''s own {"test_payload":true}, which carries no consumer data at all.',
   '0031_inbound_capability_evidence')
ON CONFLICT (schema_name, table_name) DO UPDATE
  SET policy_class            = EXCLUDED.policy_class,
      immutable               = EXCLUDED.immutable,
      app_can_insert          = EXCLUDED.app_can_insert,
      exception_reason        = EXCLUDED.exception_reason,
      registered_in_migration = EXCLUDED.registered_in_migration;--> statement-breakpoint

SELECT security.harden();--> statement-breakpoint

-- ===========================================================================
-- 4 · The captured delivery
-- ===========================================================================
-- Transcribed rather than referenced, for the reason 0030 established: the
-- capture lives on one developer laptop, and a migration that referenced its id
-- would apply there and fail on every other database. The bytes travel inside
-- the file so the evidence is reproducible on every database that runs the
-- chain, and `capability_delivery_digest_matches` re-verifies it on every apply.
--
-- WHY THIS DELIVERY, out of the 22 captured. It is the only one lawful to
-- transcribe. The others are real provider traffic — three production
-- appointments, an inbound call from the owner's own mobile, and an outbound
-- dial to a real lead from the client's production book — and every one of them
-- carries a phone number. This row is never purged, so committing any of those
-- would put a consumer's number on a permanent clock in git history, which is
-- precisely the CCPA minimisation raw_payload_vault's short window exists to
-- provide. `{"test_payload":true}` is 21 bytes and names nobody.
--
-- AND IT IS THE CORRECT EVIDENCE, not a consolation prize. What
-- `webhook_subscription` asserts is that Aloware can be configured to deliver to
-- a URL we control. This delivery is Aloware's own `Save and Test Webhook`
-- proving exactly that — emitted by the provider, in the provider's own shape.
--
-- ⚠️ WHAT IT DOES NOT PROVE, said rather than left to be assumed: it is not
-- evidence of the event vocabulary, the fan-out, or that call events arrive.
-- Those are established by the other 20 deliveries and they live in
-- docs/sprint-0/g2-aloware.md, because they cannot be committed here.
--
-- ⚠️ The headers are Aloware's SIX and no more. The ten `Cf-*`, `X-Forwarded-*`
-- and `Cdn-Loop` headers on the raw capture are the cloudflared tunnel's, and G2
-- records that reading one as a provider header would corrupt assertion (b) —
-- the finding that there is no signature, no timestamp and no nonce. That
-- exclusion happens here, once, in the durable row.
--
-- ⚠️ `Host` is retained even though `request_path` deliberately stores no
-- origin. Different concerns: the column avoids making this table a directory of
-- live endpoints, while the header is evidence of what actually arrived. The
-- hostname is a dead ephemeral tunnel we opened ourselves.
INSERT INTO ref.capability_delivery
  (delivery_id, provider, capability, received_at, request_method, request_path,
   request_headers, request_body, request_digest, response_status, probe_run,
   caused_by_probe_id)
VALUES (
  '019fd1a4-2b55-7c00-9e31-6d0f4a8b1c22',
  'aloware',
  'webhook_subscription',
  '2026-08-05 20:20:59.533+00'::timestamptz,
  'POST',
  '/hooks/aloware',
  '["Host","techrepublic-discharge-attitude-globe.trycloudflare.com","User-Agent","GuzzleHttp/7","Content-Length","21","Accept-Encoding","gzip","Connection","keep-alive","Content-Type","application/json"]'::jsonb,
  convert_to('{"test_payload":true}', 'UTF8'),
  '\x381e0c2144e26be2029ce3352e49d3d4b58667eb9c14846a302e5c2ff34fce7c'::bytea,
  204,
  'g2-webhook-save-and-test',
  -- No cause: this delivery was triggered from the provider's panel, not by an
  -- API call of ours. The column exists for the pairs that DO have one.
  NULL
)
ON CONFLICT (delivery_id) DO NOTHING;--> statement-breakpoint

-- ===========================================================================
-- 5 · The promotion
-- ===========================================================================
-- `verified_at` is the delivery's `received_at`, never now(). Trigger CAP008
-- enforces that equality and this statement is why it exists.
--
-- Guarded on `status <> 'verified'` so a re-run can never repoint an already
-- verified capability at older evidence.
UPDATE ref.provider_capability
   SET status               = 'verified',
       verified_at          = '2026-08-05 20:20:59.533+00'::timestamptz,
       evidence_delivery_id = '019fd1a4-2b55-7c00-9e31-6d0f4a8b1c22'
 WHERE provider = 'aloware'
   AND capability = 'webhook_subscription'
   AND status <> 'verified';--> statement-breakpoint

-- ===========================================================================
-- 6 · Refuse to have promoted nothing
-- ===========================================================================
-- 0030's CAP010, in its inbound form. Without it every arm above could silently
-- no-op — a missing registry row, a drifted capability name, an ON CONFLICT that
-- swallowed the insert — and the deploy would go green having verified nothing.
DO $verify$
DECLARE
  ok boolean;
BEGIN
  SELECT (pc.status = 'verified'
          AND pc.evidence_delivery_id = d.delivery_id
          AND pc.evidence_probe_id IS NULL
          AND pc.verified_at = d.received_at
          AND length(d.request_body) > 0)
    INTO ok
    FROM ref.provider_capability pc
    JOIN ref.capability_delivery d ON d.delivery_id = pc.evidence_delivery_id
   WHERE pc.provider = 'aloware' AND pc.capability = 'webhook_subscription';

  IF ok IS NOT TRUE THEN
    RAISE EXCEPTION
      'CAP011: webhook_subscription was not promoted — this migration verified nothing'
      USING HINT = 'The registry row, the delivery row, or the link between them is missing.';
  END IF;
END
$verify$;
