-- ===========================================================================
-- THE REMINDER DISPATCHER GETS THE COMPLIANCE GATE. MVP item 11, second half.
--
-- The dial went through `app.compliance_check` when the gate was first wired.
-- The reminder path did not, and it could not: `app/modules/calendar/dispatch.ts`
-- reimplements step 1 of the chain in TypeScript — it reads `tenant.sms_enabled`
-- itself and resolves the job as `skipped: sms_disabled`. One gate with two
-- implementations is not one gate.
--
-- 🔴 TWO MEASURED OBSTACLES STOOD IN THE WAY, AND NEITHER IS OBVIOUS.
--
-- (1) UNDER `withSystemWork` THE GATE REFUSES EVERYTHING. `app.begin_system_work`
--     sets `app.user_id` to '' and `app.scope_mode` to 'system' (0003:108-110),
--     `app.current_user_id()` therefore returns NULL, and `app.scope_is_global()`
--     answers true only for 'tenant_read' and 'tenant_admin' (0002:50). So
--     `compliance_check`'s visibility predicate — `owner_user_id =
--     current_user_id() OR scope_is_global()` — is NULL/false for every contact,
--     the early exit at 0038:231 fires, and the answer is
--     `blocked_timezone_unknown` for the entire book.
--
--     Wiring it naively would have resolved EVERY reminder as blocked by an
--     unknown timezone, written that terminal row, and passed the tests that
--     exist — a dispatcher that lies in a durable, auditable way.
--
-- (2) THE DISPATCHER CANNOT FIND THE JOB'S OWNER EITHER. `scheduled_job` is
--     `owner_scoped` (0015:223), so under the system scope it reads zero rows,
--     and `app.scheduled_job_claim` returns four columns with no owner among
--     them (0015:151). There is no path in TypeScript.
--
-- THE SHAPE: a definer that DERIVES the owner from the job row and evaluates the
-- one gate on its behalf. The caller passes a job id and nothing else, so it
-- cannot name whose reminder this is — the same relationship `app.webhook_ingest`
-- has with the endpoint token, where asking the caller for the tenant would be
-- asking it for the answer.
--
-- ⚠️ AND `compliance_check` IS NOT MODIFIED. It stays the single choke point
-- with the signature everything else calls. A second parameter meaning "on
-- behalf of" would have been a second way to ask the question, and the whole
-- argument for one gate is that there is only one.
-- ===========================================================================

CREATE OR REPLACE FUNCTION app.reminder_gate(p_job_id uuid)
RETURNS TABLE (verdict app.gate_verdict, event_verdict text, override_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = app, ref, pg_catalog
AS $fn$
DECLARE
  v_tenant  uuid;
  v_owner   uuid;
  v_subject uuid;
  v_kind    app.scheduled_kind;
  v_contact uuid;
  v_prev    text;
  v_verdict app.gate_verdict;
  v_event   text;
  v_override uuid;
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
  -- check — and "we could not tell" must never resolve to "go ahead".
  IF v_owner IS NULL OR v_contact IS NULL THEN
    RETURN QUERY SELECT 'blocked_timezone_unknown'::app.gate_verdict,
                        'unknown_timezone'::text, NULL::uuid;
    RETURN;
  END IF;

  -- 🔴 ACTING AS THE OWNER, TRANSACTION-LOCALLY. `set_config(..., true)` is
  -- reverted at COMMIT or ROLLBACK with everything else the unit of work set,
  -- and it is restored below anyway rather than left to the transaction — a
  -- dispatcher that processes one job and then keeps a seller's identity would
  -- scope whatever it did next to them.
  --
  -- This is an ELEVATION and it is bounded to the narrowest thing that works:
  -- the value comes from the row, it lives for one function call, and the only
  -- thing done while it is set is asking a STABLE function a question.
  v_prev := coalesce(current_setting('app.user_id', true), '');
  PERFORM set_config('app.user_id', v_owner::text, true);

  BEGIN
    SELECT c.verdict, c.event_verdict, c.override_id
      INTO v_verdict, v_event, v_override
      FROM app.compliance_check(v_contact, 'sms'::app.channel) c;
  EXCEPTION WHEN OTHERS THEN
    -- Restore before propagating. Without this a gate that raises leaves the
    -- session wearing a seller's identity for the rest of the transaction.
    PERFORM set_config('app.user_id', v_prev, true);
    RAISE;
  END;

  PERFORM set_config('app.user_id', v_prev, true);

  RETURN QUERY SELECT v_verdict, v_event, v_override;
END;
$fn$;--> statement-breakpoint

REVOKE ALL ON FUNCTION app.reminder_gate(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.reminder_gate(uuid) TO crm_app;--> statement-breakpoint

SELECT security.harden();
