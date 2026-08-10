CREATE TYPE "app"."lookup_kind" AS ENUM('suppression_check', 'recent_contact');--> statement-breakpoint
CREATE TABLE "app"."tenant_lookup_meter" (
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"minute_bucket" timestamp with time zone NOT NULL,
	"lookup_kind" "app"."lookup_kind" NOT NULL,
	"lookup_count" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "tenant_lookup_meter_tenant_id_user_id_minute_bucket_lookup_kind_pk" PRIMARY KEY("tenant_id","user_id","minute_bucket","lookup_kind")
);
--> statement-breakpoint
ALTER TABLE "app"."tenant_lookup_meter" ADD CONSTRAINT "tenant_lookup_meter_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."tenant_lookup_meter" ADD CONSTRAINT "lookup_meter_user_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "app"."app_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

INSERT INTO security.table_registry
  (schema_name, table_name, policy_class, owner_column, immutable, app_can_insert,
   protected_columns, exception_reason, registered_in_migration)
VALUES
  ('app', 'tenant_lookup_meter', 'definer_only', NULL, false, false, NULL, NULL,
   '0039_recent_contact_signal')
ON CONFLICT (schema_name, table_name) DO UPDATE
  SET policy_class = EXCLUDED.policy_class,
      registered_in_migration = EXCLUDED.registered_in_migration;
--> statement-breakpoint

-- ===========================================================================
-- THE NON-ATTRIBUTIVE RECENT-CONTACT SIGNAL.
--
-- Ping-post resells the same consumer to two sellers in one agency, often
-- inside the hour. Ben needs to know the office already reached this household
-- so he does not phone a person who was called twenty minutes ago -- and he
-- must NOT learn that the other lead is Ana's, or that it exists as a record,
-- or anything he could use to find it.
--
-- So the data crosses the silo and the ANSWER does not. What comes back is a
-- status and a number of minutes. No name, no contact id, no owner, not even a
-- count of how many colleagues touched it: a count of two is a fact about the
-- agency's book that nobody needs in order to decide not to dial.
--
-- WHY THE METER IS WELDED TO THE LOOKUP. This is a privacy oracle. Ask once and
-- you learn one fact; ask sixty thousand times and you have enumerated the
-- agency's whole book one phone number at a time without reading a row you were
-- not entitled to. Quick-add makes that cheap -- a seller can mint a contact for
-- any number they like -- so "only your own contacts" is a speed bump, not the
-- boundary. The boundary is the meter, and it is incremented in the same
-- statement that authorises the read, inside the only function that can perform
-- it. There is no other door to forget to meter.
-- ===========================================================================
CREATE OR REPLACE FUNCTION app.recent_contact_signal(p_contact_id uuid)
RETURNS TABLE (status text, minutes_ago integer)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = app, ref, pg_catalog
AS $fn$
DECLARE
  v_tenant uuid;
  v_user   uuid;
  v_phone  text;
  v_count  integer;
  v_last   timestamptz;
  c_cap    constant integer := 60;
  c_window constant integer := 60;
BEGIN
  v_tenant := app.current_tenant();
  v_user   := app.current_user_id();
  IF v_tenant IS NULL OR v_user IS NULL THEN
    RAISE EXCEPTION 'RC001: recent_contact_signal called outside a user session';
  END IF;

  -- THE METER FIRST, so a refused lookup still costs a tick. Metering after the
  -- read would let an attacker spend the whole budget on successful answers.
  INSERT INTO app.tenant_lookup_meter
    (tenant_id, user_id, minute_bucket, lookup_kind, lookup_count)
  VALUES
    (v_tenant, v_user, date_trunc('minute', clock_timestamp()), 'recent_contact', 1)
  ON CONFLICT (tenant_id, user_id, minute_bucket, lookup_kind)
  DO UPDATE SET lookup_count = app.tenant_lookup_meter.lookup_count + 1
  RETURNING lookup_count INTO v_count;

  IF v_count > c_cap THEN
    RETURN QUERY SELECT 'rate_limited'::text, NULL::integer;
    RETURN;
  END IF;

  -- Ownership: a caller may only ask about a contact in their own book. This is
  -- the speed bump. A supervisor reads globally, which is their sanctioned
  -- scope everywhere else too.
  SELECT cp.phone_e164 INTO v_phone
    FROM app.contact_phone cp
   WHERE cp.tenant_id = v_tenant
     AND cp.contact_id = p_contact_id
     AND (cp.owner_user_id = v_user OR app.scope_is_global())
   ORDER BY cp.is_primary DESC, cp.created_at ASC
   LIMIT 1;

  IF v_phone IS NULL THEN
    -- Indistinguishable from "nobody has touched this household", on purpose. A
    -- distinct answer for "that contact is not yours" would confirm the record
    -- exists, which is the owner-scoped not-found rule wearing a status code.
    RETURN QUERY SELECT 'none'::text, NULL::integer;
    RETURN;
  END IF;

  -- THE CROSS-SILO READ. Same number, a DIFFERENT owner, touched inside the
  -- window. `<> v_user` is what makes the signal mean "somebody else": a seller
  -- already sees their own activity on the timeline, and a signal that fired on
  -- their own call would be noise that teaches them to ignore it.
  SELECT max(c.last_touch_at) INTO v_last
    FROM app.contact_phone cp
    JOIN app.contact c
      ON c.tenant_id = cp.tenant_id AND c.id = cp.contact_id
   WHERE cp.tenant_id = v_tenant
     AND cp.phone_e164 = v_phone
     AND c.owner_user_id <> v_user
     AND c.last_touch_at IS NOT NULL
     AND c.last_touch_at > clock_timestamp() - make_interval(mins => c_window);

  IF v_last IS NULL THEN
    RETURN QUERY SELECT 'none'::text, NULL::integer;
  ELSE
    RETURN QUERY SELECT 'recent'::text,
      greatest(0, floor(extract(epoch FROM clock_timestamp() - v_last) / 60))::integer;
  END IF;
END;
$fn$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION app.recent_contact_signal(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.recent_contact_signal(uuid) TO crm_app;
--> statement-breakpoint

SELECT security.harden();
