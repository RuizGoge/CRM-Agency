CREATE TABLE "ref"."area_code_timezone" (
	"npa" char(3) NOT NULL,
	"tz" text NOT NULL,
	CONSTRAINT "area_code_timezone_npa_tz_pk" PRIMARY KEY("npa","tz"),
	CONSTRAINT "area_code_timezone_npa_is_digits" CHECK ("ref"."area_code_timezone"."npa" ~ '^[2-9][0-9]{2}$')
);
--> statement-breakpoint
CREATE TABLE "ref"."state_timezone" (
	"state_code" char(2) NOT NULL,
	"tz" text NOT NULL,
	CONSTRAINT "state_timezone_state_code_tz_pk" PRIMARY KEY("state_code","tz"),
	CONSTRAINT "state_timezone_code_is_alpha" CHECK ("ref"."state_timezone"."state_code" ~ '^[A-Z]{2}$')
);
--> statement-breakpoint
CREATE TABLE "ref"."zip_timezone" (
	"zip5" char(5) NOT NULL,
	"tz" text NOT NULL,
	CONSTRAINT "zip_timezone_zip5_tz_pk" PRIMARY KEY("zip5","tz"),
	CONSTRAINT "zip_timezone_zip5_is_digits" CHECK ("ref"."zip_timezone"."zip5" ~ '^[0-9]{5}$')
);
--> statement-breakpoint
CREATE INDEX "zip_timezone_zip5_idx" ON "ref"."zip_timezone" USING btree ("zip5");
--> statement-breakpoint

INSERT INTO security.table_registry
  (schema_name, table_name, policy_class, owner_column, immutable, app_can_insert,
   protected_columns, exception_reason, registered_in_migration)
VALUES
  ('ref', 'zip_timezone', 'reference', NULL, false, false, NULL,
   'Public-domain reference data with no tenant dimension: ZIP to IANA zone. Readable by every tenant because it describes US geography and not anybody book of business. It feeds a HARD BLOCK, so it is writable only by migration.',
   '0037_calling_window'),
  ('ref', 'area_code_timezone', 'reference', NULL, false, false, NULL,
   'Public-domain reference data with no tenant dimension: NANPA area code to IANA zone. Same reasoning as zip_timezone, and its confidence is fixed at low because a ported mobile keeps its old NPA.',
   '0037_calling_window'),
  ('ref', 'state_timezone', 'reference', NULL, false, false, NULL,
   'Public-domain reference data with no tenant dimension: US state to IANA zone. The last resort of the resolver chain, and the only layer small and stable enough to be written by hand.',
   '0037_calling_window')
ON CONFLICT (schema_name, table_name) DO UPDATE
  SET policy_class = EXCLUDED.policy_class, exception_reason = EXCLUDED.exception_reason;
--> statement-breakpoint

-- A ZONE THE DATABASE DOES NOT KNOW IS A ZONE THAT NEVER MATCHES, and a row
-- that never matches in a hard-block dataset is a lead nobody can ever legally
-- call, with no error raised anywhere. `America/Kentucky` (a directory, not a
-- zone) and a plain typo both land here. Validated against the live tzdata
-- catalogue, which is the same catalogue `AT TIME ZONE` evaluates against.
CREATE OR REPLACE FUNCTION ref.assert_known_timezone()
RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = NEW.tz) THEN
    RAISE EXCEPTION 'TZ001: % is not a zone this database knows', NEW.tz
      USING HINT = 'Use an IANA name that appears in pg_timezone_names. A zone that does not resolve silently never matches, and in a calling-window dataset that is a lead nobody can legally call.';
  END IF;
  RETURN NEW;
END;
$fn$;
--> statement-breakpoint

CREATE TRIGGER t_zip_timezone_known BEFORE INSERT OR UPDATE ON ref.zip_timezone
  FOR EACH ROW EXECUTE FUNCTION ref.assert_known_timezone();
--> statement-breakpoint
CREATE TRIGGER t_area_code_timezone_known BEFORE INSERT OR UPDATE ON ref.area_code_timezone
  FOR EACH ROW EXECUTE FUNCTION ref.assert_known_timezone();
--> statement-breakpoint
CREATE TRIGGER t_state_timezone_known BEFORE INSERT OR UPDATE ON ref.state_timezone
  FOR EACH ROW EXECUTE FUNCTION ref.assert_known_timezone();
--> statement-breakpoint

-- The last resort of the chain, and the only layer that can be written
-- correctly without a generated dataset.
INSERT INTO ref.state_timezone (state_code, tz) VALUES
  ('CT','America/New_York'), ('DC','America/New_York'), ('DE','America/New_York'),
  ('GA','America/New_York'), ('MA','America/New_York'), ('MD','America/New_York'),
  ('ME','America/New_York'), ('NC','America/New_York'), ('NH','America/New_York'),
  ('NJ','America/New_York'), ('NY','America/New_York'), ('OH','America/New_York'),
  ('PA','America/New_York'), ('RI','America/New_York'), ('SC','America/New_York'),
  ('VA','America/New_York'), ('VT','America/New_York'), ('WV','America/New_York'),

  ('AL','America/Chicago'), ('AR','America/Chicago'), ('IA','America/Chicago'),
  ('IL','America/Chicago'), ('LA','America/Chicago'), ('MN','America/Chicago'),
  ('MO','America/Chicago'), ('MS','America/Chicago'), ('OK','America/Chicago'),
  ('WI','America/Chicago'),

  ('CO','America/Denver'), ('MT','America/Denver'), ('NM','America/Denver'),
  ('UT','America/Denver'), ('WY','America/Denver'),

  ('CA','America/Los_Angeles'), ('WA','America/Los_Angeles'),
  ('HI','Pacific/Honolulu'),

  -- THE TWELVE THAT SEC-9 NAMES AS AMBIGUOUS. Two rows each, so the window
  -- becomes the intersection instead of a coin flip.
  ('FL','America/New_York'), ('FL','America/Chicago'),
  ('TX','America/Chicago'),  ('TX','America/Denver'),
  ('KS','America/Chicago'),  ('KS','America/Denver'),
  ('NE','America/Chicago'),  ('NE','America/Denver'),
  ('ND','America/Chicago'),  ('ND','America/Denver'),
  ('SD','America/Chicago'),  ('SD','America/Denver'),
  ('IN','America/Indiana/Indianapolis'), ('IN','America/Chicago'),
  ('KY','America/New_York'), ('KY','America/Chicago'),
  ('MI','America/Detroit'),  ('MI','America/Menominee'),
  ('OR','America/Los_Angeles'), ('OR','America/Boise'),
  ('ID','America/Boise'),    ('ID','America/Los_Angeles'),
  ('TN','America/New_York'), ('TN','America/Chicago'),

  -- THREE MORE THAN THE RULING LISTS, and the addition is deliberate rather
  -- than a correction of it. SEC-9 names twelve; these three are genuinely
  -- split too, and the design own arithmetic settles the direction: adding a
  -- candidate can only SHRINK the window. A straddle omitted is the one error
  -- that produces an illegal dial; a straddle added costs a little legal
  -- calling time, which is the trade the ruling already accepted in writing.
  --   AZ: the state does not observe DST, the Navajo Nation inside it does.
  --   NV: Pacific except West Wendover, which runs on Mountain with Utah.
  --   AK: Alaska time except the far western Aleutians.
  ('AZ','America/Phoenix'),  ('AZ','America/Denver'),
  ('NV','America/Los_Angeles'), ('NV','America/Denver'),
  ('AK','America/Anchorage'), ('AK','America/Adak');
--> statement-breakpoint

-- THE CANDIDATE SET. Deliberately NOT SECURITY DEFINER: every table it reads is
-- `reference` class, which crm_app may already read, so there is no privilege to
-- borrow and no tenant to assert. One fewer definer is one fewer place the silo
-- can be switched off by accident.
CREATE OR REPLACE FUNCTION app.resolve_lead_timezones(
  p_zip5       char(5),
  p_npa        char(3),
  p_state_code char(2)
)
RETURNS TABLE (tz text, confidence app.tz_confidence, source app.tz_source)
LANGUAGE plpgsql
STABLE
AS $fn$
BEGIN
  -- ZIP first: exact, except where a ZIP straddles -- and there it is exact
  -- about straddling, which is the point of one row per pair.
  RETURN QUERY
    SELECT z.tz,
           (CASE WHEN count(*) OVER () = 1 THEN 'high' ELSE 'medium' END)::app.tz_confidence,
           'zip'::app.tz_source
      FROM ref.zip_timezone z
     WHERE z.zip5 = p_zip5;
  IF FOUND THEN RETURN; END IF;

  -- Area code: LOW ALWAYS, never high under any circumstance. A consumer who
  -- moved New York to Florida keeps their 718 number, and in this lead market
  -- that is ordinary rather than exotic.
  RETURN QUERY
    SELECT a.tz, 'low'::app.tz_confidence, 'area_code'::app.tz_source
      FROM ref.area_code_timezone a
     WHERE a.npa = p_npa;
  IF FOUND THEN RETURN; END IF;

  RETURN QUERY
    SELECT s.tz,
           (CASE WHEN count(*) OVER () = 1 THEN 'medium' ELSE 'low' END)::app.tz_confidence,
           'state'::app.tz_source
      FROM ref.state_timezone s
     WHERE s.state_code = p_state_code;

  -- No trailing RETURN: an empty set IS the unresolved answer, and the caller
  -- turns it into blocked_timezone_unknown. Failing closed is the whole design.
END;
$fn$;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION app.resolve_lead_timezones(char, char, char) TO crm_app;
--> statement-breakpoint

-- THE WINDOW: 9:00 AM to 8:00 PM lead-local, in EVERY member of the set.
--
-- Also SECURITY INVOKER, and that is the better half of this design. It reads
-- `contact` and `contact_phone`, both owner_scoped, so RLS scopes it to the
-- caller own book WITHOUT a hand-written ownership predicate. A contact in
-- someone else book resolves to no row at all and the answer is
-- blocked_timezone_unknown -- indistinguishable from a contact that does not
-- exist, which is the owner-scoped not-found rule holding for free.
--
-- `p_at` exists for the tests. A window assertion that reads the wall clock
-- passes or fails by the hour of day it happens to run, which is the same as
-- not asserting it at all.
CREATE OR REPLACE FUNCTION app.calling_window_check(
  p_contact_id uuid,
  p_at         timestamptz DEFAULT now()
)
RETURNS TABLE (
  allowed    boolean,
  reason     text,
  zones      text[],
  confidence app.tz_confidence,
  source     app.tz_source
)
LANGUAGE plpgsql
STABLE
AS $fn$
DECLARE
  v_zip   char(5);
  v_state char(2);
  v_npa   char(3);
BEGIN
  SELECT c.zip5, c.state_code INTO v_zip, v_state
    FROM app.contact c
   WHERE c.id = p_contact_id;

  SELECT substring(cp.phone_e164 from 3 for 3) INTO v_npa
    FROM app.contact_phone cp
   WHERE cp.contact_id = p_contact_id
   ORDER BY cp.is_primary DESC, cp.created_at ASC
   LIMIT 1;

  RETURN QUERY
  WITH candidates AS (
    SELECT r.tz, r.confidence, r.source
      FROM app.resolve_lead_timezones(v_zip, v_npa, v_state) r
  ),
  judged AS (
    SELECT c.tz, c.confidence, c.source,
           ((p_at AT TIME ZONE c.tz)::time >= TIME '09:00'
            AND (p_at AT TIME ZONE c.tz)::time < TIME '20:00') AS inside
      FROM candidates c
  )
  SELECT
    CASE WHEN count(*) = 0 THEN false ELSE bool_and(j.inside) END,
    CASE WHEN count(*) = 0            THEN 'blocked_timezone_unknown'
         WHEN bool_and(j.inside)      THEN 'allow'
         ELSE                              'blocked_calling_window'
    END,
    coalesce(array_agg(j.tz ORDER BY j.tz), ARRAY[]::text[]),
    -- The WEAKEST confidence and the LAST source in the chain that produced the
    -- set. Every row of one resolution carries the same pair, so min() is
    -- picking the value rather than reconciling disagreeing ones.
    min(j.confidence::text)::app.tz_confidence,
    min(j.source::text)::app.tz_source
  FROM judged j;
END;
$fn$;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION app.calling_window_check(uuid, timestamptz) TO crm_app;
--> statement-breakpoint

SELECT security.harden();
