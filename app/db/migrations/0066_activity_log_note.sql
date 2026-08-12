-- ===========================================================================
-- A SELLER CAN WRITE DOWN WHAT HAPPENED. The second missing writer.
--
-- `app.activity` has had a schema, three CHECKs, a My Day surface that reads it
-- and a `note` timeline kind waiting for it, and NO WRITER ANYWHERE IN `app/`.
-- The seed writes rows; the product does not. So the only thing that could ever
-- reach a seller's history was a stage move — which is why the Activity region
-- opens with one kind of line and nothing else.
--
-- ⚠️ `activity.completed` IS THE ONLY EVENT THIS TABLE HAS, and it is about
-- COMPLETING rather than creating. That is not a mismatch to work around, it is
-- the shape of the thing: a note is already complete the moment it is written.
-- There is no `activity.created` in the canonical 49 and inventing one would be
-- a bug rather than a feature. So the note is inserted with `completed_at` set
-- and the completion is what gets emitted.
--
-- 🔴 A DEFINER FOR THE SAME REASON AS 0065, and the reason is worth repeating
-- because it is now the shape of every writer this product will grow. `crm_app`
-- holds INSERT on `app.activity` — the row is not the problem. 0061 revoked
-- `event_emit`, and the row and its event belong in ONE transaction, so they
-- have to live in one function. The compensation is the same too: a note cannot
-- be written without its event, because there is one door and the emit is
-- inside it.
-- ===========================================================================

CREATE OR REPLACE FUNCTION app.activity_log_note(p_contact_id uuid, p_body text)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = app, ref, pg_catalog
AS $fn$
DECLARE
  v_tenant uuid;
  v_owner  uuid;
  v_body   text;
  v_actor  uuid;
  v_id     uuid;
  v_at     timestamptz;
BEGIN
  v_tenant := app.current_tenant();
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'AC001: activity_log_note called outside a tenant session';
  END IF;

  -- 🔴 TRIMMED AND REFUSED EMPTY, IN THE DATABASE. `title` is NOT NULL and a
  -- string of spaces satisfies NOT NULL — so a seller who taps Save on an empty
  -- box would otherwise get a permanent, blank line in a history that has no
  -- delete. The route validates too; this is the half that survives a caller
  -- that forgets.
  v_body := btrim(coalesce(p_body, ''));
  IF v_body = '' THEN
    RAISE EXCEPTION 'AC002: a note with no text is a line the seller cannot remove later';
  END IF;

  -- OWNERSHIP, re-asserted because a definer has no RLS. NULL rather than a
  -- raise: a contact in another book and one that never existed must be the
  -- same answer, and a message that differs between them is the 403 this
  -- project forbids in softer words.
  SELECT c.owner_user_id INTO v_owner
    FROM app.contact c
   WHERE c.tenant_id = v_tenant
     AND c.id = p_contact_id
     AND c.deleted_at IS NULL
     AND (c.owner_user_id = app.current_user_id() OR app.scope_is_global());

  IF v_owner IS NULL THEN
    RETURN NULL;
  END IF;

  -- WHO WROTE IT IS READ FROM THE SESSION, NEVER TAKEN AS A PARAMETER — the
  -- rule `app.audit_write` states plainly and `compliance_attempt` repeats: a
  -- caller that can declare who acted is a caller that can declare somebody
  -- else acted. The note belongs to the CONTACT's owner; the person who typed
  -- it is the actor, and on the timeline that difference is "You" versus
  -- "Handled before this record moved to you".
  v_actor := app.current_user_id();
  v_at    := clock_timestamp();

  INSERT INTO app.activity
    (tenant_id, owner_user_id, contact_id, type, title,
     created_by, completed_at, completed_by_user_id, auto_completed)
  VALUES
    (v_tenant, v_owner, p_contact_id, 'note', v_body,
     'human', v_at, v_actor, false)
  RETURNING id INTO v_id;

  -- `outcome` is NULL: a note has no outcome, and the field belongs to calls
  -- and appointments. `completing_event_*` are NULL because nothing completed
  -- this — it arrived complete, which is what a note is.
  PERFORM app.event_emit(
    uuidv7(), v_owner, 'activity.completed',
    'activity', v_id,
    'activity_note:' || v_id::text,
    jsonb_build_object(
      'activity_id',           v_id,
      'type',                  'note',
      'contact_id',            p_contact_id,
      'opportunity_id',        NULL,
      'completed_at',          to_char(v_at AT TIME ZONE 'UTC',
                                       'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'outcome',               NULL,
      'auto_completed',        false,
      'completing_event_id',   NULL,
      'completing_event_name', NULL),
    v_at);

  RETURN v_id;
END;
$fn$;--> statement-breakpoint

REVOKE ALL ON FUNCTION app.activity_log_note(uuid, text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.activity_log_note(uuid, text) TO crm_app;--> statement-breakpoint

-- No `SELECT security.harden()`: no relation created, no registry row changed,
-- no privilege harden() manages.
