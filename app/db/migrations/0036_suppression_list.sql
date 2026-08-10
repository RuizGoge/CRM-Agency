CREATE TYPE "app"."suppression_kind" AS ENUM('stop', 'start', 'dnc_federal', 'dnc_state', 'internal', 'litigator', 'carrier_block');--> statement-breakpoint
CREATE TABLE "app"."suppression_list" (
	"tenant_id" uuid NOT NULL,
	"id" uuid DEFAULT uuidv7() NOT NULL,
	"phone_e164" text NOT NULL,
	"kind" "app"."suppression_kind" NOT NULL,
	"channel" "app"."channel",
	"source_message_id" uuid,
	"evidence_ref" text,
	"effective_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"actor_user_id" uuid,
	"reason" text,
	CONSTRAINT "suppression_list_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "suppression_phone_is_e164" CHECK ("app"."suppression_list"."phone_e164" ~ '^\+[1-9][0-9]{7,14}$')
);
--> statement-breakpoint
ALTER TABLE "app"."suppression_list" ADD CONSTRAINT "suppression_list_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."suppression_list" ADD CONSTRAINT "suppression_actor_fk" FOREIGN KEY ("tenant_id","actor_user_id") REFERENCES "app"."app_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "suppression_phone_idx" ON "app"."suppression_list" USING btree ("tenant_id","phone_e164","effective_at" DESC);
--> statement-breakpoint

-- ===========================================================================
-- suppression_list: tenant-wide by design, and that is the opposite of every
-- other table in this schema.
--
-- Ping-post resells the same consumer to two sellers inside one agency, so a
-- STOP given to Ana has to silence Ben's dialler too -- immediately, and
-- without Ben ever learning that Ana holds that lead. Owner-scoping this table
-- would produce a product that honours a STOP for the seller who received it
-- and keeps dialling from the desk next door.
-- ===========================================================================

INSERT INTO security.table_registry
  (schema_name, table_name, policy_class, owner_column, immutable, app_can_insert,
   protected_columns, exception_reason, registered_in_migration)
VALUES
  ('app', 'suppression_list', 'definer_only', NULL, true, false,
   NULL, NULL, '0036_suppression_list')
ON CONFLICT (schema_name, table_name) DO UPDATE
  SET policy_class            = EXCLUDED.policy_class,
      immutable               = EXCLUDED.immutable,
      app_can_insert          = EXCLUDED.app_can_insert,
      registered_in_migration = EXCLUDED.registered_in_migration;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.suppression_append(
  p_phone_e164       text,
  p_kind             app.suppression_kind,
  p_effective_at     timestamptz,
  p_channel          app.channel DEFAULT NULL,
  p_source_message_id uuid       DEFAULT NULL,
  p_evidence_ref     text        DEFAULT NULL,
  p_reason           text        DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = app, ref, pg_catalog
AS $fn$
DECLARE
  v_tenant uuid;
  v_norm   text;
  v_id     uuid;
BEGIN
  -- Every SECURITY DEFINER body must contain app.current_tenant();
  -- tests/integration/definer-tenancy.test.ts asserts it over pg_proc.prosrc.
  -- This function runs as crm_migrator, so RLS protects nothing in here.
  v_tenant := app.current_tenant();
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'SP001: suppression_append called outside a tenant session'
      USING HINT = 'app.begin_request() or app.begin_job() establishes the tenant. A STOP written into the wrong tenant silences the wrong agency and cannot be undone: the table is immutable.';
  END IF;

  -- Normalised HERE. A STOP arrives from an Aloware webhook, a DNC import, a
  -- carrier block and a human, and a suppression row whose format does not
  -- match what the dialler queries is a suppression that silently never fires.
  v_norm := regexp_replace(btrim(p_phone_e164), '[^0-9+]', '', 'g');

  INSERT INTO app.suppression_list (
    tenant_id, phone_e164, kind, channel, source_message_id,
    evidence_ref, effective_at, actor_user_id, reason
  ) VALUES (
    v_tenant, v_norm, p_kind, p_channel, p_source_message_id,
    p_evidence_ref, p_effective_at,
    -- Not a parameter: NULL is the honest value for a provider-driven STOP.
    app.current_user_id(), p_reason
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$fn$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION app.suppression_append(text, app.suppression_kind, timestamptz,
  app.channel, uuid, text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.suppression_append(text, app.suppression_kind, timestamptz,
  app.channel, uuid, text, text) TO crm_app;
--> statement-breakpoint

-- NO READER SHIPS WITH THIS MIGRATION, and the absence is the design.
--
-- `app.suppression_state(phone)` would be the obvious companion and it is
-- exactly the cross-silo oracle this class exists to prevent: `stop` means a
-- consumer replied STOP to somebody in this agency, so answering "is this
-- number suppressed" for an arbitrary number answers "is a colleague working
-- this consumer". The only sanctioned reader is app.compliance_check(), which
-- takes a contact the caller owns and returns a verdict -- and it cannot be
-- written until the lead-local calling window exists (MVP item 10), because a
-- gate that answers on consent and suppression while ignoring the clock would
-- return "may send" at 2am in the lead's timezone.
--
-- Until then this table records and does not answer. That is a deliberate
-- half, and recording from day one is what makes the gate correct on the day
-- it lands rather than correct going forward.

SELECT security.harden();
