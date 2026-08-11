-- ===========================================================================
-- THE GATE RECORDS ITSELF. MVP item 11, the compliance half, closed.
--
-- `compliance.send_blocked` has been in the canonical catalog since 0042 and
-- has had NO EMITTER. §580 calls it "the number that proves the gate works";
-- G13 §7 says the same in different words. Until this migration the product
-- could count sends and count failures and could not count REFUSALS, and the
-- seller was told why on a panel that vanishes when she navigates away.
--
-- 🔴 THE MECHANISM IS A REVOKED PRIVILEGE, NOT A CONVENTION. `crm_app` loses
-- EXECUTE on `app.compliance_check` and never gets it back. After this, the
-- application role can obtain a verdict for an ATTEMPT through exactly one
-- function — `app.compliance_attempt` — and that function has already written
-- the audit row and emitted the event before it returns. "Remember to record
-- the refusal" is documentation; "there is no way to get the answer without
-- the record" is a rule.
--
-- ⚠️ THE ORDER OF THE CHAIN IS UNTOUCHED. `compliance_check` is recreated
-- rather than rewritten: the body below is transcribed from 0038:192-322 with
-- exactly three deltas, all of them the new `contact_phone_id` output. The
-- ordering comment at 0038:158-176 is the specification, not decoration --
-- suppression before the clock, the two clock verdicts last among the blocks
-- because they are the only two break-glass can release.
--
-- WHY A DROP AND NOT A REPLACE: adding an OUT column is a return-type change
-- and `CREATE OR REPLACE FUNCTION` refuses it. 0058:36-39 forbids a second
-- INPUT ("a second way to ask the question"); an output column adds no way to
-- ask.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1 · WHERE THE ATTEMPT CAME FROM
-- ---------------------------------------------------------------------------
-- Three labels, one per producer that exists: the dial surface, the scheduler,
-- and a direct call (a script, or the gate suite driving the door). A fourth
-- surface is a migration rather than a string literal.
--
-- ⚠️ THIS DELIBERATELY DIVERGES FROM `opportunity.gate_blocked.attempted_via`,
-- which is `kanban_drag|command_palette|mobile|automation|api`. That is the
-- PIPELINE CLOSE gate -- a different act -- and it has no label for a
-- scheduler, which is one of exactly two producers here. The contract types
-- `compliance.send_blocked.attempted_via` as plain text, so an enum label cast
-- to text satisfies it with no amendment. `api` is spelled identically because
-- it means the same thing.
CREATE TYPE "app"."attempt_origin" AS ENUM ('dial_button', 'reminder_dispatch', 'api');--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2 · THE INVERSE MAP
-- ---------------------------------------------------------------------------
-- TWO VOCABULARIES, TWO DOMAINS, AND CONFUSING THEM IS THE MOST LIKELY DEFECT
-- IN THIS WHOLE CHANGE. `app.gate_verdict` is a GATE OUTCOME and includes
-- `allow`. The catalog's `verdict` is a REFUSAL REASON and has no `allow`.
--
-- The FORWARD direction is already built and must never be rewritten:
-- `compliance_check` returns both columns and `event_verdict` IS the ratified
-- vocabulary. Any CASE reproducing it in SQL or TypeScript is a second table of
-- truth. This function is the INVERSE, needed once, by the projector, to put
-- the right `app.gate_verdict` in the timeline row.
--
-- 🔴 IT RAISES RATHER THAN RETURNING NULL. A NULL would reach
-- `app.timeline_upsert`, trip TL002 three layers away, and dead-letter the
-- delivery with a message about a missing verdict instead of an unmapped one.
--
-- `no_consent` and `bad_number` are ratified in the catalog and NO BRANCH OF
-- THE GATE PRODUCES THEM: suppression covers STOP and DNC, not "consent was
-- never captured", and a bad number lives on `contact_phone.bad_number_at`
-- with its own event. Widening `app.gate_verdict` to make the map total was
-- considered and REFUSED: `GateVerdict` in `app/routes/api/calls.ts` is a
-- hand-written TypeScript union, so new SQL labels would not turn the build
-- red and would not force anybody to write the microcopy. Two dead enum labels
-- plus a gate that does not gate is worse than an explicit raise.
CREATE OR REPLACE FUNCTION app.gate_verdict_of(p_event_verdict text)
RETURNS app.gate_verdict
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $fn$
DECLARE
  v app.gate_verdict;
BEGIN
  -- Assign then check. `RETURN CASE ... ELSE NULL END` returns before any
  -- check can run, which is how this kind of guard is usually written and why
  -- it usually does nothing.
  v := (CASE p_event_verdict
          WHEN 'stop'               THEN 'blocked_suppressed'
          WHEN 'dnc'                THEN 'blocked_suppressed'
          WHEN '10dlc_pending'      THEN 'blocked_sms_disabled'
          WHEN 'unknown_timezone'   THEN 'blocked_timezone_unknown'
          WHEN 'outside_window'     THEN 'blocked_calling_window'
          WHEN 'unverified_mapping' THEN 'blocked_recording_unverified'
          ELSE NULL
        END)::app.gate_verdict;

  IF v IS NULL THEN
    RAISE EXCEPTION 'CG011: % has no app.gate_verdict counterpart', p_event_verdict
      USING HINT = 'no_consent and bad_number are ratified in the catalog and no branch of app.compliance_check produces them. If one now does, this function and app.gate_verdict grow together or the seller silently loses the entry.';
  END IF;

  RETURN v;
END;
$fn$;--> statement-breakpoint

REVOKE ALL ON FUNCTION app.gate_verdict_of(text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.gate_verdict_of(text) TO crm_app;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3 · THE GATE, RECREATED WITH A FIFTH COLUMN AND NO GRANT
-- ---------------------------------------------------------------------------
-- The new column is `contact_phone_id`: the row the gate ACTUALLY judged. A
-- `blocked_suppressed` verdict is about one specific number, and re-resolving
-- that number at the emit point would be a second table of truth about which
-- one -- worse on the reminder path, where the identity has already been
-- restored and the same predicate resolves nothing at all.
DROP FUNCTION app.compliance_check(uuid, app.channel, timestamptz);--> statement-breakpoint

CREATE FUNCTION app.compliance_check(
  p_contact_id uuid,
  p_channel    app.channel,
  p_at         timestamptz DEFAULT now()
)
RETURNS TABLE (
  verdict          app.gate_verdict,
  event_verdict    text,
  override_id      uuid,
  zones            text[],
  contact_phone_id uuid
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
  v_phone_id uuid;
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
                        'unknown_timezone'::text, NULL::uuid, ARRAY[]::text[],
                        NULL::uuid;
    RETURN;
  END IF;

  SELECT cp.id, cp.phone_e164, substring(cp.phone_e164 from 3 for 3)
    INTO v_phone_id, v_phone, v_npa
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
                        '10dlc_pending'::text, NULL::uuid, ARRAY[]::text[],
                        v_phone_id;
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
                          NULL::uuid, ARRAY[]::text[], v_phone_id;
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
        NULL::uuid, coalesce(v_zones, ARRAY[]::text[]), v_phone_id;
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
                        coalesce(v_zones, ARRAY[]::text[]), v_phone_id;
    RETURN;
  END IF;

  RETURN QUERY SELECT 'allow'::app.gate_verdict, NULL::text, v_override,
                      coalesce(v_zones, ARRAY[]::text[]), v_phone_id;
END;
$fn$;--> statement-breakpoint

REVOKE ALL ON FUNCTION app.compliance_check(uuid, app.channel, timestamptz) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION app.compliance_check(uuid, app.channel, timestamptz) FROM crm_app;--> statement-breakpoint
-- 🔴 AND NO GRANT. THIS ABSENCE IS THE DESIGN.
--
-- PostgreSQL grants EXECUTE to PUBLIC by default on a freshly created
-- function, so the REVOKE above is not boilerplate: omitting it would leave
-- the gate MORE reachable than it was before this migration while every
-- behavioural test in the suite stayed green.
--
-- From here the only ways to a verdict are `app.compliance_attempt` and
-- `app.reminder_gate`, both of which record first. `tests/integration/
-- compliance-emit.test.ts` asserts the privilege in both directions and scans
-- `pg_proc` for a third caller.

-- ---------------------------------------------------------------------------
-- 4 · THE WRITER, REACHABLE BY NOTHING
-- ---------------------------------------------------------------------------
-- One attempt, one story: the audit row and the event share a correlation id,
-- and the event's idempotency key IS the audit row's id. That makes "one audit
-- row per attempt" and "one event per refusal" the same counting rule by
-- construction rather than by two rules that agree today.
--
-- NO GRANT TO ANY ROLE. Only the two definers below can reach it, running as
-- the function owner. A refusal record cannot be forged and cannot be written
-- by a second path, because there is no second path.
CREATE OR REPLACE FUNCTION app.compliance_record(
  p_owner_user_id    uuid,
  p_contact_id       uuid,
  p_channel          app.channel,
  p_attempted_via    app.attempt_origin,
  p_verdict          app.gate_verdict,
  p_event_verdict    text,
  p_override_id      uuid,
  p_zones            text[],
  p_contact_phone_id uuid,
  p_at               timestamptz,
  p_actor_type       app.actor_type,
  p_source_system    app.source_system
)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = app, ref, pg_catalog
AS $fn$
DECLARE
  v_tenant uuid;
  v_story  uuid;
  v_audit  uuid;
  v_local  text;
  v_event  uuid;
BEGIN
  v_tenant := app.current_tenant();
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'CG012: compliance_record called outside a tenant session';
  END IF;

  v_story := uuidv7();

  -- THE LAWYER'S ROW, WRITTEN FOR EVERY ATTEMPT INCLUDING `allow`. US-9.13
  -- wants one row per attempt, unbucketed -- so `p_dedupe_minutes` is 0, which
  -- is also the default, and the 60-second collapse happens only on the
  -- seller's timeline.
  v_audit := app.audit_write(
    'compliance.gate_checked', 'contact', p_contact_id,
    NULL, NULL, NULL,
    p_verdict,
    jsonb_build_object('channel', p_channel::text,
                       'event_verdict', p_event_verdict,
                       'zones', coalesce(p_zones, ARRAY[]::text[]),
                       'attempted_via', p_attempted_via::text,
                       'contact_phone_id', p_contact_phone_id),
    p_override_id, v_story, p_actor_type, 0);

  -- Unreachable today: `audit_write` inserts unconditionally when
  -- `p_dedupe_minutes` is 0 (0053:303). It exists so a future edit passing a
  -- window fails loudly instead of producing the key 'gate_block:' for every
  -- refusal in the tenant, which would silently dedupe the second one ever
  -- against the first, forever.
  IF v_audit IS NULL THEN
    RAISE EXCEPTION 'CG013: the gate produced no audit row, so this refusal has no idempotency key';
  END IF;

  -- THE ALLOW TEST IS `p_event_verdict IS NULL`, NOT `p_verdict <> 'allow'`.
  -- 0038's last RETURN QUERY is the only branch with a NULL event verdict, so
  -- one condition means there is no second predicate to fall out of sync.
  --
  -- `p_owner_user_id IS NULL` means the contact is invisible to this session.
  -- `event_log.owner_user_id` is NOT NULL and is the RLS silo column: emitting
  -- anyway would either raise, or -- if the owner were fetched definer-blind --
  -- write a timeline entry into a COLLEAGUE'S silo because somebody guessed a
  -- uuid. The lawyer still gets the probe; the audit row above is
  -- unconditional.
  IF p_event_verdict IS NULL OR p_owner_user_id IS NULL THEN
    RETURN NULL;
  END IF;

  -- One zone or nothing. `calling_window_check` judges the whole set with
  -- `bool_and`, so a Florida lead genuinely has two simultaneous local times
  -- and no single string can hold them. NULL is the honest answer.
  v_local := CASE WHEN coalesce(array_length(p_zones, 1), 0) = 1
                  THEN to_char(p_at AT TIME ZONE p_zones[1], 'HH24:MI') || ' ' || p_zones[1]
                  ELSE NULL END;

  -- ⚠️ `clock_timestamp()` AND NEVER `p_at`. `occurred_at` is the partition key
  -- of `event_log`, `app.ensure_event_partitions` creates months FORWARD only
  -- (0057:56-63), and there is no default partition on purpose. A caller
  -- passing a pinned past instant -- which the gate suite does, at
  -- 2026-07-15 -- would raise 23514 and roll back the attempt.
  v_event := app.event_emit(
    uuidv7(), p_owner_user_id, 'compliance.send_blocked',
    'contact', p_contact_id,
    'gate_block:' || v_audit::text,
    jsonb_build_object(
      'channel',               p_channel::text,
      -- 🔴 `p_event_verdict`, NEVER `p_verdict::text`. The catalog's vocabulary
      -- is stop|dnc|10dlc_pending|unknown_timezone|outside_window|
      -- unverified_mapping; the enum's is blocked_*. Putting the enum on the
      -- wire produces a payload that validates against nothing and a timeline
      -- entry that dead-letters.
      'verdict',               p_event_verdict,
      'contact_id',            p_contact_id,
      'contact_phone_id',      p_contact_phone_id,
      -- Both producers today are contact- and meeting-scoped. A pass-through
      -- parameter nobody produces is a hole with no producer; the composer
      -- path adds it in its own migration with its own test.
      'opportunity_id',        NULL,
      'attempted_via',         p_attempted_via::text,
      'local_time_at_contact', v_local,
      -- Structurally NULL on every refusal: 0038 returns the override id only
      -- on the allow branch, which does not emit.
      'override_id',           p_override_id),
    clock_timestamp(), p_source_system, v_story);

  RETURN v_event;
END;
$fn$;--> statement-breakpoint

REVOKE ALL ON FUNCTION app.compliance_record(uuid, uuid, app.channel, app.attempt_origin,
  app.gate_verdict, text, uuid, text[], uuid, timestamptz, app.actor_type,
  app.source_system) FROM PUBLIC;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 5 · THE ONLY DOOR
-- ---------------------------------------------------------------------------
-- The four returned columns are EXACTLY what `compliance_check` returned
-- before this migration, with the same names, so every caller is a function
-- rename plus one argument.
--
-- `p_actor_type` and `p_source_system` are NOT parameters. This door is only
-- ever a human on the app; a parameter would be a way to lie about that.
CREATE OR REPLACE FUNCTION app.compliance_attempt(
  p_contact_id    uuid,
  p_channel       app.channel,
  p_attempted_via app.attempt_origin,
  p_at            timestamptz DEFAULT now()
)
RETURNS TABLE (verdict app.gate_verdict, event_verdict text, override_id uuid, zones text[])
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = app, ref, pg_catalog
AS $fn$
DECLARE
  v_tenant   uuid;
  v_owner    uuid;
  v_verdict  app.gate_verdict;
  v_event    text;
  v_override uuid;
  v_zones    text[];
  v_phone_id uuid;
BEGIN
  v_tenant := app.current_tenant();
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'CG010: compliance_attempt called outside a tenant session';
  END IF;

  -- The owner decides the ENVELOPE and never the verdict -- same predicate as
  -- 0038:216-220, and the gate below is still asked unconditionally. A second
  -- copy of the DECISION is exactly what the one-gate rule forbids; reading
  -- the owner is not a decision.
  SELECT c.owner_user_id INTO v_owner
    FROM app.contact c
   WHERE c.tenant_id = v_tenant
     AND c.id = p_contact_id
     AND (c.owner_user_id = app.current_user_id() OR app.scope_is_global());

  SELECT g.verdict, g.event_verdict, g.override_id, g.zones, g.contact_phone_id
    INTO v_verdict, v_event, v_override, v_zones, v_phone_id
    FROM app.compliance_check(p_contact_id, p_channel, p_at) g;

  PERFORM app.compliance_record(
    v_owner, p_contact_id, p_channel, p_attempted_via,
    v_verdict, v_event, v_override, v_zones, v_phone_id, p_at,
    'human'::app.actor_type, 'app'::app.source_system);

  RETURN QUERY SELECT v_verdict, v_event, v_override,
                      coalesce(v_zones, ARRAY[]::text[]);
END;
$fn$;--> statement-breakpoint

REVOKE ALL ON FUNCTION app.compliance_attempt(uuid, app.channel, app.attempt_origin,
  timestamptz) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.compliance_attempt(uuid, app.channel, app.attempt_origin,
  timestamptz) TO crm_app;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 6 · THE REMINDER DOOR, RECORDING AFTER THE RESTORE
-- ---------------------------------------------------------------------------
-- Signature and its three output columns are UNCHANGED, so
-- `app/modules/calendar/dispatch.ts` is untouched and the terminal string
-- `'skipped: sms_disabled'` survives byte-for-byte -- it is asserted by value
-- in three places.
--
-- Body transcribed from 0058:48-119. The deltas are the two new locals, the
-- five-column SELECT, and the record call.
CREATE OR REPLACE FUNCTION app.reminder_gate(p_job_id uuid)
RETURNS TABLE (verdict app.gate_verdict, event_verdict text, override_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = app, ref, pg_catalog
AS $fn$
DECLARE
  v_tenant   uuid;
  v_owner    uuid;
  v_subject  uuid;
  v_kind     app.scheduled_kind;
  v_contact  uuid;
  v_prev     text;
  v_verdict  app.gate_verdict;
  v_event    text;
  v_override uuid;
  v_zones    text[];
  v_phone_id uuid;
BEGIN
  v_tenant := app.current_tenant();
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'RG001: reminder_gate called with no tenant context'
      USING HINT = 'The dispatcher opens withSystemWork(tenant) per job before asking.';
  END IF;

  -- The owner is READ, never passed. A caller that could name it could ask the
  -- gate about somebody else's lead by naming them.
  SELECT j.owner_user_id, j.subject_id, j.kind
    INTO v_owner, v_subject, v_kind
    FROM app.scheduled_job j
   WHERE j.tenant_id = v_tenant AND j.id = p_job_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'RG002: no such scheduled job in this tenant';
  END IF;

  IF v_kind <> 'meeting_reminder' THEN
    RAISE EXCEPTION 'RG003: % is not a reminder, and only reminders contact anybody', v_kind;
  END IF;

  SELECT m.contact_id INTO v_contact
    FROM app.meeting m
   WHERE m.tenant_id = v_tenant AND m.id = v_subject;

  -- FAILS CLOSED in both directions. A job with no owner cannot be evaluated on
  -- anybody's behalf, and a reminder whose meeting has no contact has nobody to
  -- check -- and "we could not tell" must never resolve to "go ahead".
  --
  -- Records NOTHING, deliberately: there is no contact to attribute a refusal
  -- to, and `contact_id` is NOT NULL in both `audit_log` and `event_log`.
  IF v_owner IS NULL OR v_contact IS NULL THEN
    RETURN QUERY SELECT 'blocked_timezone_unknown'::app.gate_verdict,
                        'unknown_timezone'::text, NULL::uuid;
    RETURN;
  END IF;

  -- 🔴 ACTING AS THE OWNER, TRANSACTION-LOCALLY. `set_config(..., true)` is
  -- reverted at COMMIT or ROLLBACK with everything else the unit of work set,
  -- and it is restored below anyway rather than left to the transaction -- a
  -- dispatcher that processes one job and then keeps a seller's identity would
  -- scope whatever it did next to them.
  --
  -- This is an ELEVATION and it is bounded to the narrowest thing that works:
  -- the value comes from the row, it lives for one function call, and the only
  -- thing done while it is set is asking a STABLE function a question.
  v_prev := coalesce(current_setting('app.user_id', true), '');
  PERFORM set_config('app.user_id', v_owner::text, true);

  BEGIN
    SELECT c.verdict, c.event_verdict, c.override_id, c.zones, c.contact_phone_id
      INTO v_verdict, v_event, v_override, v_zones, v_phone_id
      FROM app.compliance_check(v_contact, 'sms'::app.channel) c;
  EXCEPTION WHEN OTHERS THEN
    -- Restore before propagating. Without this a gate that raises leaves the
    -- session wearing a seller's identity for the rest of the transaction.
    PERFORM set_config('app.user_id', v_prev, true);
    RAISE;
  END;

  PERFORM set_config('app.user_id', v_prev, true);

  -- 🔴 RECORDED AFTER THE RESTORE, AND THAT ORDERING IS THE WHOLE POINT.
  -- `app.event_emit` stamps `actor_user_id := app.current_user_id()` (0052:100)
  -- and `app.audit_write` does the same (0053:274). Recording while still
  -- elevated would put the SELLER'S uuid on a decision a scheduler made, and
  -- `app.timeline_read`'s branch at 0059:344 would then render "You" on her own
  -- history for a text nobody attempted. Under `withSystemWork` the restored
  -- value is '', so `current_user_id()` is NULL -- which is the truth.
  PERFORM app.compliance_record(
    v_owner, v_contact, 'sms'::app.channel, 'reminder_dispatch'::app.attempt_origin,
    v_verdict, v_event, v_override, v_zones, v_phone_id, clock_timestamp(),
    'scheduler'::app.actor_type, 'scheduler'::app.source_system);

  RETURN QUERY SELECT v_verdict, v_event, v_override;
END;
$fn$;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 7 · THE ACTOR REACHES THE PROJECTOR
-- ---------------------------------------------------------------------------
-- `app.timeline_upsert` takes an actor and the relay has been passing the
-- OWNER, because `outbox_payload` never returned the actor. Every projected
-- kind therefore reads "You" on the seller's own history -- true for her own
-- drag, and false for anything an admin or a scheduler did to her lead.
--
-- 🔴 THIS IS A CORRECTION RIDING ALONG, and it is named rather than slipped in.
-- Without it §6's ordering buys nothing: the reminder would still say "You".
--
-- DROP is forced -- adding an OUT column is a return-type change. This function
-- is on the delivery path of EVERY projected kind, so a mistake here breaks all
-- fourteen at once, which is the right direction for a mistake.
DROP FUNCTION app.outbox_payload(uuid);--> statement-breakpoint

CREATE FUNCTION app.outbox_payload(p_event_id uuid)
RETURNS TABLE (event_name app.event_name, owner_user_id uuid, actor_user_id uuid,
               subject_type text, subject_id uuid, payload jsonb,
               occurred_at timestamptz, correlation_id uuid)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = app, ref, pg_catalog
AS $fn$
DECLARE
  v_tenant uuid;
BEGIN
  v_tenant := app.current_tenant();
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'OB001: outbox_payload called with no tenant context'
      USING HINT = 'The relay establishes the tenant from the claim row before reading a body.';
  END IF;

  RETURN QUERY
  SELECT el.event_name, el.owner_user_id, el.actor_user_id, el.subject_type,
         el.subject_id, el.payload, el.occurred_at, el.correlation_id
    FROM app.event_log el
   WHERE el.tenant_id = v_tenant
     AND el.event_id = p_event_id;
END;
$fn$;--> statement-breakpoint

REVOKE ALL ON FUNCTION app.outbox_payload(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.outbox_payload(uuid) TO crm_app;--> statement-breakpoint

SELECT security.harden();
