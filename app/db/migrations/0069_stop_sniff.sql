-- ===========================================================================
-- A STOP FROM A LEAD NOW SUPPRESSES. The compliance lane reaches the domain.
--
-- 🔴 THE HOLE, AND IT IS THE LEGAL ONE. `message.received` has been in the
-- canonical 49 since 0042 with NO EMITTER, so no inbound text could produce an
-- event, so `consent.stop_recorder` had nothing to consume and no STOP a lead
-- ever sent could reach `suppression_list`. §581 names the failure exactly —
-- *"a STOP honored on SMS but not on the dialer"* — and today it is worse than
-- that: a STOP is honored on neither, because nothing writes it down.
--
-- This is the last assertion without a subject in Gate 6 (G6/P24, marked
-- protected at `retries: 0`) and it is TCPA exposure rather than a checkbox.
--
-- ⚠️ WHAT THIS SLICE DOES AND DOES NOT DO, because the gate needs both halves
-- and this is only one. **Correctness: a STOP suppresses.** **Latency: it must
-- do so within 5 s behind a 20,000-message backlog** — that needs
-- `ref.job_registry.priority` with the `compliance | interactive | bulk` lanes
-- of `05c` §11.7, which DOES NOT EXIST IN THIS TREE. Until it does, a STOP that
-- lands behind a storm is late, and being late is a legal failure and not only
-- a red gate. Said here so the next reader does not mistake this for G6/P24
-- closed. (`05-architecture` §484 calls the lane axis "owed a ruling before
-- Sprint 0" — that text is superseded: `05c` §11.7 IS the ruling.)
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1 · THE SNIFF
-- ---------------------------------------------------------------------------
-- 🔴 WHOLE-MESSAGE MATCH, NEVER A SUBSTRING, AND THIS IS THE ENTIRE CORRECTNESS
-- ARGUMENT OF THE FUNCTION. `body ILIKE '%stop%'` would suppress on *"please
-- don't stop calling me"* and on *"stop by the office Tuesday"*. Suppression is
-- TENANT-WIDE, read live by the gate on every attempt, and this slice ships no
-- un-suppress path — so a false positive silently removes a lead from every
-- seller's reach for good. §1797 calls a forged STOP *"a denial-of-service
-- against a seller's book"*; a substring match is the same denial of service,
-- self-inflicted, and it needs no attacker at all.
--
-- Normalising to letters and comparing to an exact set is what the carriers
-- themselves do: `STOP.` `stop!` and ` Stop ` are all the keyword, while
-- `STOP CALLING` normalises to `STOPCALLING`, is in no set, and reads as an
-- ordinary reply — which it is.
--
-- ⚠️ `out_of_office` IS UNREACHABLE FROM THIS FUNCTION AND THAT IS DELIBERATE.
-- Nothing in an inbound SMS distinguishes it, and returning a value we cannot
-- actually determine would put a guess in a compliance payload. It stays in the
-- enum for the email lane that does not exist yet.
--
-- ⚠️ AND THERE IS NO OPT-BACK-IN INTENT. `START` / `UNSTOP` / `YES` are real
-- carrier keywords and `app.suppression_kind` even has a `start` value, but
-- `intent_hint` in the canonical catalog is `stop | help | reply |
-- out_of_office` and has no member for it. Inventing one would be a bug rather
-- than a feature, so a START reads as `reply` and re-subscription remains a
-- thing only a human can do. Named here because the asymmetry is a decision.
CREATE OR REPLACE FUNCTION app.sms_intent_of(p_body text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $fn$
  SELECT CASE
    WHEN p_body IS NULL THEN NULL
    -- Letters only. Digits and punctuation are stripped rather than matched so
    -- that `STOP2` and `STOP-ALL` do not become the keyword by accident.
    WHEN regexp_replace(upper(p_body), '[^A-Z]', '', 'g') IN
         ('STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT')
      THEN 'stop'
    WHEN regexp_replace(upper(p_body), '[^A-Z]', '', 'g') IN ('HELP', 'INFO')
      THEN 'help'
    WHEN btrim(coalesce(p_body, '')) = '' THEN NULL
    ELSE 'reply'
  END
$fn$;--> statement-breakpoint

REVOKE ALL ON FUNCTION app.sms_intent_of(text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.sms_intent_of(text) TO crm_app;--> statement-breakpoint

COMMENT ON FUNCTION app.sms_intent_of(text) IS
  'Classifies one inbound SMS body into the canonical intent_hint. Whole-message match against the carrier keyword sets, never a substring.';--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2 · THE CHAIN, INSIDE THE MERGE
-- ---------------------------------------------------------------------------
-- 🔴 THE CONSENT ROW AND THE SUPPRESSION ROW COMMIT WITH THE MESSAGE ROW, and
-- §581 states why in one sentence: *"an eventually-consistent suppression list
-- is an eventually-legal system."* So the chain lives INSIDE this function
-- rather than in a downstream consumer — there is no window in which the
-- message exists and the suppression does not.
--
-- 🔴 AND IT HANGS OFF THE RESOLVED OWNER, which is §1797(3) holding
-- structurally rather than by a check somebody remembered. The two mapping
-- lookups already require `verified_at IS NOT NULL AND revoked_at IS NULL`, so
-- a webhook aimed at an unverified number resolves no owner, returns
-- `unmapped`, and NEVER REACHES THE STOP CHAIN. That is the difference between
-- "a forged STOP is a nuisance" and "a forged STOP silently deletes a lead from
-- a seller's book".
CREATE OR REPLACE FUNCTION app.message_merge(
  p_provider_message_id text,
  p_state               text,
  p_direction           text        DEFAULT NULL,
  p_aloware_user_id     bigint      DEFAULT NULL,
  p_our_number_e164     text        DEFAULT NULL,
  p_lead_number_e164    text        DEFAULT NULL,
  p_body_text           text        DEFAULT NULL,
  p_failure_reason      text        DEFAULT NULL,
  p_provider_created_at timestamptz DEFAULT NULL,
  p_provider_event_at   timestamptz DEFAULT NULL
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = app, pg_catalog
AS $fn$
DECLARE
  v_tenant   uuid;
  v_owner    uuid;
  v_contact  uuid;
  v_message  uuid;
  v_fresh    boolean;
  v_intent   text;
  v_at       timestamptz;
BEGIN
  v_tenant := app.current_tenant();
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'MM001: message_merge called with no tenant context';
  END IF;

  IF p_provider_message_id IS NULL OR length(btrim(p_provider_message_id)) = 0 THEN
    RAISE EXCEPTION 'MM002: message_merge needs a provider_message_id — it is the merge key';
  END IF;

  IF p_state NOT IN ('received', 'failed') THEN
    -- `sent` and `delivered` are absent because nothing in the capture reports a
    -- successful send. A state nothing can write is how a screen ends up saying
    -- "Sending…" for ever.
    RAISE EXCEPTION 'MM003: % is not a message state; there are exactly two', p_state;
  END IF;

  -- Same two routes and the same order as the call merger, for the same reason:
  -- the seat is solid where it exists, the number is what saves the rest, and a
  -- Local Presence pool number resolves to nothing rather than to a guess.
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

  IF v_owner IS NOT NULL AND p_lead_number_e164 IS NOT NULL THEN
    SELECT cp.contact_id INTO v_contact
      FROM app.contact_phone cp
     WHERE cp.tenant_id = v_tenant
       AND cp.owner_user_id = v_owner
       AND cp.phone_e164 = p_lead_number_e164
     ORDER BY cp.is_primary DESC
     LIMIT 1;
  END IF;

  INSERT INTO app.message (
    tenant_id, provider_message_id, owner_user_id, contact_id, direction, state,
    body_text, failure_reason, provider_created_at, provider_last_event_at, updated_at
  ) VALUES (
    v_tenant, p_provider_message_id, v_owner, v_contact, p_direction, p_state,
    p_body_text, p_failure_reason, p_provider_created_at, p_provider_event_at,
    clock_timestamp()
  )
  ON CONFLICT (tenant_id, provider_message_id) DO UPDATE SET
    -- Every field additive, and the ordering property comes free from that: an
    -- absent value never erases a present one and the result does not depend on
    -- which delivery landed first.
    owner_user_id  = COALESCE(EXCLUDED.owner_user_id,  app.message.owner_user_id),
    contact_id     = COALESCE(EXCLUDED.contact_id,     app.message.contact_id),
    direction      = COALESCE(EXCLUDED.direction,      app.message.direction),
    body_text      = COALESCE(EXCLUDED.body_text,      app.message.body_text),
    failure_reason = COALESCE(EXCLUDED.failure_reason, app.message.failure_reason),
    -- `failed` is terminal and `received` cannot undo it: a delivery failure
    -- reported after the fact is the fact that matters for compliance.
    state = CASE WHEN app.message.state = 'failed' THEN 'failed' ELSE EXCLUDED.state END,
    provider_created_at    = LEAST(app.message.provider_created_at, EXCLUDED.provider_created_at),
    provider_last_event_at = GREATEST(app.message.provider_last_event_at,
                                      EXCLUDED.provider_last_event_at),
    updated_at = clock_timestamp()
  -- 🔴 `xmax = 0` IS "THIS STATEMENT INSERTED THE ROW", and the whole chain
  -- below hangs on it. G2 measured that Aloware RESTATES the same message with
  -- different bytes seconds later, so this function runs more than once per real
  -- message by design. Without this flag every restatement would append another
  -- consent row and another suppression row for one STOP, and emit
  -- `message.received` again — a ledger that counts deliveries instead of facts.
  RETURNING id, owner_user_id, (xmax = 0) INTO v_message, v_owner, v_fresh;

  IF v_owner IS NULL THEN
    PERFORM app.admin_alert_raise(
      'unmapped_number',
      COALESCE(p_our_number_e164, ''),
      CASE WHEN p_our_number_e164 IS NULL
        THEN 'A text arrived with no number we could match. Nothing was written to a seller''s book.'
        ELSE format('A text arrived on %s, which is not in the number map. Nothing was written to a seller''s book.',
                    p_our_number_e164)
      END);
    RETURN 'unmapped';
  END IF;

  -- Only an INBOUND message that was RECEIVED carries an intent. An outbound
  -- text of ours saying the word STOP is not a lead revoking anything, and a
  -- `failed` row is `message.delivery_failed` — a different event, still with no
  -- emitter, because its payload names `error_code`, `provider_error` and
  -- `is_hard_bounce` and this provider sends none of the three.
  IF v_fresh AND p_direction = 'inbound' AND p_state = 'received' THEN
    v_intent := app.sms_intent_of(p_body_text);
    v_at     := COALESCE(p_provider_created_at, clock_timestamp());

    PERFORM app.event_emit(
      uuidv7(), v_owner, 'message.received',
      'message', v_message,
      'message_received:' || v_message::text,
      jsonb_build_object(
        'message_id',          v_message,
        'channel',             'sms',
        'contact_id',          v_contact,
        'opportunity_id',      NULL,
        'body',                COALESCE(p_body_text, ''),
        'intent_hint',         v_intent,
        'provider_message_id', p_provider_message_id,
        'received_at',         to_char(v_at AT TIME ZONE 'UTC',
                                       'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        -- The owner resolved but the number is in nobody's book: the text is
        -- real, it belongs to a seller, and we do not know who sent it.
        'unknown_sender',      v_contact IS NULL),
      v_at);

    IF v_intent = 'stop' AND p_lead_number_e164 IS NOT NULL THEN
      -- Both ledgers, both append-only, both in THIS transaction. The consent
      -- row is the legal record of the revocation; the suppression row is what
      -- the gate actually reads on every attempt. Writing one without the other
      -- is the split §581 forbids — and they cannot drift, because there is no
      -- commit between them.
      PERFORM app.consent_append(
        'phone', p_lead_number_e164, 'sms', 'revoked', 'none', 'stop_keyword',
        v_at, v_contact, 'message:' || v_message::text);

      -- Tenant-wide and channel-wide ON PURPOSE: `p_channel => NULL`. §2721 —
      -- *"a STOP suppresses call and text for EVERY seller in the tenant
      -- immediately"*. Scoping it to SMS would leave the dialer free to call a
      -- number that just told us to stop, which is the exact failure §581 names.
      PERFORM app.suppression_append(
        p_lead_number_e164, 'stop', v_at, NULL, v_message,
        'message:' || v_message::text,
        'Lead replied with a STOP keyword by text.');
    END IF;
  END IF;

  RETURN 'resolved';
END
$fn$;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3 · THE HANDOVER
-- ---------------------------------------------------------------------------
-- 🔴 NOT OPTIONAL HERE, AND A TEST PROVED IT RATHER THAN A REVIEW. Migrations
-- run as `crm`, a superuser, so `app.sms_intent_of` is born owned by `crm`.
-- `app.message_merge` is SECURITY DEFINER and — since 0062 — runs as
-- `crm_migrator`, which the `REVOKE ALL … FROM PUBLIC` above leaves with no
-- EXECUTE. The first run of the suite failed with `permission denied for
-- function sms_intent_of` on every inbound message.
--
-- The failure mode is the interesting part: it is invisible until a definer
-- actually calls the new function. 0068's three functions are reached from
-- `crm_app` sessions directly, so they never noticed. `own_to_migrator()`
-- rather than `harden()` for the same reason 0067 gives — the same handover,
-- without taking the hardening pass with it.
SELECT security.own_to_migrator();--> statement-breakpoint

-- No `SELECT security.harden()`: no relation created, no registry row changed,
-- no privilege harden() manages. `message_merge` keeps the grant it already had.
