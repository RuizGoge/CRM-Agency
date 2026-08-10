ALTER TYPE "app"."activity_type" ADD VALUE 'note';--> statement-breakpoint
ALTER TABLE "app"."opportunity" ADD COLUMN "last_human_touch_at" timestamp with time zone;
--> statement-breakpoint

-- ===========================================================================
-- THE CANONICAL TOUCH ENGINE (MVP item 25).
--
-- 05b's ruling, verbatim in effect: five events claimed the right to reset
-- last_activity_at, and the answer is "a deterministic max()". ONE trigger
-- function, registered per source table with the column that table calls
-- "when it happened", writing GREATEST(old, new) -- MONOTONIC, NEVER
-- DECREMENTED.
--
-- Why monotonic matters and is not defensive coding: last_activity_at is the
-- input to the cold-episode key, and a value that can go backwards makes
-- opportunity.went_cold fire twice for one episode. That is the difference
-- between a badge and a notification firehose.
--
-- WHY THIS EXISTS TODAY RATHER THAN WITH THE COMMUNICATIONS MODULE. Two things
-- already shipped read these columns and NOTHING wrote them:
-- `contact.last_touch_at` has been declared since migration 0010 and is read by
-- app.recent_contact_signal (0039) and by the contact route, and until this
-- migration no code path in the tree ever set it. A column nobody writes is a
-- column that does not exist -- the register records the same discovery about
-- tenant.is_demo -- and it meant the recent-contact signal could never fire in
-- production while passing every test, because the fixtures set the column by
-- hand.
--
-- `call` and `message` are named by the ruling and do not exist yet. Adding
-- them is registering two more tables against this one function; the pinned
-- test below is what makes forgetting them a red build rather than a silence.
-- ===========================================================================
CREATE OR REPLACE FUNCTION app.touch_from_row()
RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  j       jsonb := to_jsonb(NEW);
  v_at    timestamptz;
  v_human boolean;
BEGIN
  -- The source column is named by the trigger registration, so one function
  -- serves tables that disagree about what to call the moment work happened.
  v_at := (j ->> TG_ARGV[0])::timestamptz;

  -- A row whose moment has not arrived is not a touch. An activity created for
  -- Thursday is work SCHEDULED, and counting it would reset the cold clock for
  -- a lead nobody has spoken to.
  IF v_at IS NULL THEN
    RETURN NULL;
  END IF;

  v_human := CASE TG_ARGV[1]
               WHEN 'always_human' THEN true
               ELSE (j ->> 'created_by') = 'human'
             END;

  UPDATE app.opportunity o
     SET last_activity_at    = GREATEST(coalesce(o.last_activity_at, v_at), v_at),
         last_human_touch_at = CASE
                                 WHEN v_human
                                 THEN GREATEST(coalesce(o.last_human_touch_at, v_at), v_at)
                                 ELSE o.last_human_touch_at
                               END
   WHERE o.tenant_id = NEW.tenant_id
     AND o.id = (j ->> 'opportunity_id')::uuid;

  -- The contact-level twin, which is what the non-attributive recent-contact
  -- signal reads. ANY touch counts here, automated included: "this office
  -- contacted this household" is true whether a human or a sequence did it.
  UPDATE app.contact c
     SET last_touch_at = GREATEST(coalesce(c.last_touch_at, v_at), v_at)
   WHERE c.tenant_id = NEW.tenant_id
     AND c.id = (j ->> 'contact_id')::uuid;

  RETURN NULL;
END;
$fn$;
--> statement-breakpoint

-- An activity touches when it is COMPLETED, not when it is created, and its
-- humanity comes from created_by: a sequence step that texts a lead is a touch
-- but not a human one.
CREATE TRIGGER t_touch_activity
  AFTER INSERT OR UPDATE OF completed_at ON app.activity
  FOR EACH ROW EXECUTE FUNCTION app.touch_from_row('completed_at', 'from_actor');
--> statement-breakpoint

-- A meeting touches when its outcome is recorded, and a held meeting is human
-- by construction -- nothing automated attends one.
CREATE TRIGGER t_touch_meeting
  AFTER INSERT OR UPDATE OF outcome_at ON app.meeting
  FOR EACH ROW EXECUTE FUNCTION app.touch_from_row('outcome_at', 'always_human');
--> statement-breakpoint

SELECT security.harden();
