-- ===========================================================================
-- MVP item 27: contact field editing, and the bad-number flag.
--
-- `contact_phone.bad_number_at` has been declared since migration 0010 and
-- written by nobody. That is the second dead column this work has found by the
-- same method — asking who writes a column before building on it — and its
-- consequence is concrete: A NUMBER THAT HAS ALREADY BOUNCED IS STILL OFFERED
-- FOR DIALLING, so a seller burns attempts on a line that cannot connect and
-- the vendor's data-quality rate is unmeasurable.
--
-- Both functions are SECURITY INVOKER on purpose. `contact` and `contact_phone`
-- are owner_scoped, so RLS scopes them to the caller's own book with no
-- hand-written ownership predicate — the same shape that made
-- app.calling_window_check the better half of the calling-window work. One
-- fewer definer is one fewer place the silo can be switched off by accident.
-- ===========================================================================

CREATE OR REPLACE FUNCTION app.contact_flag_bad_number(
  p_contact_phone_id uuid,
  p_reason           text
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
AS $fn$
DECLARE
  v_hit integer;
BEGIN
  IF length(btrim(coalesce(p_reason, ''))) = 0 THEN
    RAISE EXCEPTION 'CB001: a bad-number flag needs a reason'
      USING HINT = 'The reason is what makes vendor data quality measurable. "bad" is not one.';
  END IF;

  -- FIRST FLAG WINS. `bad_number_at` is the moment we LEARNED the number was
  -- bad, and a later failed dial does not make it newly bad — overwriting it
  -- would quietly move the evidence of when the vendor sold us a dead line.
  UPDATE app.contact_phone cp
     SET bad_number_at     = clock_timestamp(),
         bad_number_reason = p_reason
   WHERE cp.id = p_contact_phone_id
     AND cp.bad_number_at IS NULL;

  GET DIAGNOSTICS v_hit = ROW_COUNT;
  RETURN v_hit > 0;
END;
$fn$;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION app.contact_flag_bad_number(uuid, text) TO crm_app;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.contact_clear_bad_number(p_contact_phone_id uuid)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
AS $fn$
DECLARE
  v_hit integer;
BEGIN
  -- Reversible on purpose: a number flagged from one carrier rejection can be
  -- fine, and a flag nobody can lift becomes a lead nobody can ever call again.
  -- The clear is a separate verb rather than an argument, so it cannot happen
  -- by passing the wrong value to the flag.
  UPDATE app.contact_phone cp
     SET bad_number_at = NULL, bad_number_reason = NULL
   WHERE cp.id = p_contact_phone_id
     AND cp.bad_number_at IS NOT NULL;

  GET DIAGNOSTICS v_hit = ROW_COUNT;
  RETURN v_hit > 0;
END;
$fn$;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION app.contact_clear_bad_number(uuid) TO crm_app;
--> statement-breakpoint

-- Field editing. NULL means "leave this one alone", so a caller sending one
-- field cannot blank the other three by omission — the shape of accident a
-- partial update invites.
CREATE OR REPLACE FUNCTION app.contact_edit(
  p_contact_id uuid,
  p_full_name  text    DEFAULT NULL,
  p_email      text    DEFAULT NULL,
  p_state_code char(2) DEFAULT NULL,
  p_zip5       char(5) DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
AS $fn$
DECLARE
  v_hit integer;
BEGIN
  IF p_full_name IS NOT NULL AND length(btrim(p_full_name)) = 0 THEN
    RAISE EXCEPTION 'CB002: a contact cannot be renamed to nothing';
  END IF;

  -- Lowercased here, not at a call site. `email_norm` is citext so the type
  -- already folds case for comparison, but the STORED value is what a seller
  -- reads back, and two spellings of one address reading differently on two
  -- screens is how a duplicate gets created by hand.
  UPDATE app.contact c
     SET full_name  = coalesce(p_full_name, c.full_name),
         email_norm = coalesce(lower(btrim(p_email)), c.email_norm),
         state_code = coalesce(p_state_code, c.state_code),
         -- ZIP drives the calling-window resolver, so changing it changes when
         -- this lead may legally be called. It is not a cosmetic field.
         zip5       = coalesce(p_zip5, c.zip5)
   WHERE c.id = p_contact_id;

  GET DIAGNOSTICS v_hit = ROW_COUNT;
  RETURN v_hit > 0;
END;
$fn$;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION app.contact_edit(uuid, text, text, char, char) TO crm_app;
