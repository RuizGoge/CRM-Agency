-- ===========================================================================
-- Sprint-0 Gate G2 · promote `two_legged_call` to `verified`
--
-- This migration carries no schema change. It carries EVIDENCE.
--
-- WHY THE EXCHANGE IS TRANSCRIBED HERE INSTEAD OF REFERENCED BY ID.
-- Probes are written by `npm run spike:probe` against the real Aloware
-- account, so the row captured on 2026-08-05 exists on exactly one developer
-- laptop. A migration that merely referenced its uuid would apply there and
-- fail on every other database — CI, a fresh clone, production — because the
-- row it points at was never created. The chain must apply clean to an empty
-- database; 0029 was proven that way and this must not break it.
--
-- So the captured bytes travel INSIDE the migration. Two consequences, both
-- wanted: the evidence is reproducible on every database that runs the chain,
-- and `capability_probe_digest_matches` re-verifies it on every single apply.
-- A mistranscribed body or a mistyped digest is a failed deploy, not a quiet
-- lie — which is the only reason to hardcode both instead of deriving one
-- from the other.
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO, said plainly:
--
--   * `sms_send` is NOT promoted. No probe exists. Verifying it means sending
--     a real, billable message to a real handset, and the 10DLC brand being
--     approved is not evidence that the endpoint answers.
--   * `contact_lookup` is NOT promoted. Its four probes are all 404, and
--     CAP003 requires 2xx. A 2xx here would mean a real consumer's record
--     inside a row E9 never purges — so verifying it lawfully needs a
--     synthetic contact that does not exist yet.
--   * `webhook_subscription` is NOT promoted, AND IT CANNOT BE with the table
--     as designed. 20 real deliveries were captured, which is far stronger
--     evidence than any probe — but `ref.capability_probe` models an OUTBOUND
--     request and its response, and a webhook is INBOUND. There is no shape
--     for it. Since the capability is `mvp_required`, the boot assertion still
--     refuses production. That is an open design decision (how an inbound
--     capability is evidenced), recorded here rather than papered over by
--     inventing a probe that never happened.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1 · The captured exchange
-- ---------------------------------------------------------------------------
-- Run `g2-dial-02`, 2026-08-05. Chosen over `g2-dial-01` — which also answered
-- 202 — because this is the dial that went the whole way: the agent leg was
-- answered, the lead leg bridged, and the call carried 63 seconds of talk time
-- with a recording produced. Both are valid probes of the endpoint; only one
-- is evidence that the capability does what the product needs it to do.
INSERT INTO ref.capability_probe
  (probe_id, provider, capability, http_status, response_body, response_digest,
   observed_at, probe_run, request_method, request_url)
VALUES (
  '019fd3b8-a866-796d-955a-af7e4b7cf429',
  'aloware',
  'two_legged_call',
  202,
  convert_to('{"message":"Two legged call established."}', 'UTF8'),
  '\xb455db115076ba7ae805edfaa2c107717a22599dc5cc52e0a40bce46db22f533'::bytea,
  '2026-08-05 20:58:42.109+00'::timestamptz,
  'g2-dial-02',
  'POST',
  -- The token travels in the JSON body on this endpoint, so no redaction is
  -- needed here — unlike contact_lookup, where it rides in the query string.
  'https://app.aloware.io/api/v1/webhook/two-legged-call'
)
ON CONFLICT (probe_id) DO NOTHING;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2 · The promotion
-- ---------------------------------------------------------------------------
-- `verified_at` is the probe's `observed_at`, not `now()`. Trigger CAP004
-- enforces that equality, and this statement is exactly why it exists:
-- verified_at is the moment the provider answered, never the moment somebody
-- wrote the migration.
--
-- Guarded on `status <> 'verified'` so a re-run can never repoint an already
-- verified capability at older evidence.
UPDATE ref.provider_capability
   SET status            = 'verified',
       verified_at       = '2026-08-05 20:58:42.109+00'::timestamptz,
       evidence_probe_id = '019fd3b8-a866-796d-955a-af7e4b7cf429'
 WHERE provider = 'aloware'
   AND capability = 'two_legged_call'
   AND status <> 'verified';
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3 · Refuse to have promoted nothing
-- ---------------------------------------------------------------------------
-- Without this, every arm above could silently no-op — a missing registry row,
-- a capability name that drifted, an ON CONFLICT that swallowed the insert —
-- and the deploy would go green having verified nothing at all. The entire
-- point of this file is that "verified" stops being a word, so a migration
-- that fails to write it must fail loudly rather than quietly.
DO $verify$
DECLARE
  ok boolean;
BEGIN
  SELECT (pc.status = 'verified'
          AND pc.evidence_probe_id = p.probe_id
          AND pc.verified_at = p.observed_at
          AND p.http_status BETWEEN 200 AND 299)
    INTO ok
    FROM ref.provider_capability pc
    JOIN ref.capability_probe p ON p.probe_id = pc.evidence_probe_id
   WHERE pc.provider = 'aloware' AND pc.capability = 'two_legged_call';

  IF ok IS NOT TRUE THEN
    RAISE EXCEPTION
      'CAP010: two_legged_call was not promoted — this migration verified nothing'
      USING HINT = 'The registry row, the probe row, or the link between them is missing.';
  END IF;
END
$verify$;
