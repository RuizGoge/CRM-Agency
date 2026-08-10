CREATE TYPE "app"."channel" AS ENUM('sms', 'call', 'email', 'whatsapp_reserved');--> statement-breakpoint
CREATE TYPE "app"."consent_source" AS ENUM('stop_keyword', 'manual', 'dnc_list', 'vendor_certificate', 'booking_capture', 'import_attestation', 'recycle_revalidation');--> statement-breakpoint
CREATE TYPE "app"."consent_status" AS ENUM('granted', 'revoked', 'dnc_suppressed');--> statement-breakpoint
CREATE TYPE "app"."consent_type" AS ENUM('express_written', 'implied', 'none');--> statement-breakpoint
CREATE TYPE "app"."contact_value_kind" AS ENUM('phone', 'email');--> statement-breakpoint
CREATE TABLE "app"."consent_ledger" (
	"tenant_id" uuid NOT NULL,
	"id" uuid DEFAULT uuidv7() NOT NULL,
	"contact_value_kind" "app"."contact_value_kind" NOT NULL,
	"contact_value_norm" text NOT NULL,
	"channel" "app"."channel" NOT NULL,
	"status" "app"."consent_status" NOT NULL,
	"consent_type" "app"."consent_type" NOT NULL,
	"source" "app"."consent_source" NOT NULL,
	"vendor_name" text,
	"certificate_url" text,
	"certificate_captured_at" timestamp with time zone,
	"jurisdiction_state" char(2),
	"captured_ip" "inet",
	"attesting_admin_user_id" uuid,
	"contact_id" uuid,
	"previous_status" "app"."consent_status",
	"evidence_ref" text,
	"effective_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"actor_user_id" uuid,
	CONSTRAINT "consent_ledger_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "consent_phone_is_e164" CHECK ("app"."consent_ledger"."contact_value_kind" <> 'phone' OR "app"."consent_ledger"."contact_value_norm" ~ '^\+[1-9][0-9]{7,14}$'),
	CONSTRAINT "consent_import_names_attestor" CHECK ("app"."consent_ledger"."source" <> 'import_attestation' OR "app"."consent_ledger"."attesting_admin_user_id" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "app"."consent_ledger" ADD CONSTRAINT "consent_ledger_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."consent_ledger" ADD CONSTRAINT "consent_contact_fk" FOREIGN KEY ("tenant_id","contact_id") REFERENCES "app"."contact"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."consent_ledger" ADD CONSTRAINT "consent_actor_fk" FOREIGN KEY ("tenant_id","actor_user_id") REFERENCES "app"."app_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."consent_ledger" ADD CONSTRAINT "consent_attesting_admin_fk" FOREIGN KEY ("tenant_id","attesting_admin_user_id") REFERENCES "app"."app_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "consent_value_channel_idx" ON "app"."consent_ledger" USING btree ("tenant_id","contact_value_norm","channel","effective_at" DESC);
--> statement-breakpoint

-- ===========================================================================
-- consent_ledger: the evidentiary half. Everything above this line is the
-- table; everything below is what makes it unreadable, unwritable and
-- unforgeable by the application role.
--
-- The question a TCPA defence has to answer is never "may we contact this
-- person today". It is "what was true at 14:07 on a Tuesday nineteen months
-- ago", and a mutable status column cannot answer it at any price. So: a
-- revocation is a new row, the table is immutable by trigger AND by revoked
-- privilege, and the only writer is a SECURITY DEFINER function.
-- ===========================================================================

CREATE OR REPLACE FUNCTION security.harden()
RETURNS void
LANGUAGE plpgsql AS $fn$
DECLARE
  r           record;
  reg         security.table_registry%ROWTYPE;
  qual        text;
  with_check  text;
  ident       text;
  trg         text;
  cols        text;
  append_only boolean;
  tenant_pred constant text := 'tenant_id = app.current_tenant()';
BEGIN
  FOR r IN SELECT * FROM security.managed_relations() LOOP
    ident := format('%I.%I', r.schema_name, r.table_name);
    trg   := left('t_immutable_' || r.table_name, 63);

    SELECT * INTO reg FROM security.table_registry tr
     WHERE tr.schema_name = r.schema_name AND tr.table_name = r.table_name;

    IF NOT FOUND THEN
      RAISE EXCEPTION
        'HR001: relation % has no security.table_registry row. Classify it in the migration that creates it.',
        ident
        USING HINT = 'Every relation is classified or the deploy fails. This is the keystone, not a formality.';
    END IF;

    append_only := reg.policy_class IN
      ('append_only_owner', 'append_only_tenant', 'append_only_tenant_admin');

    CASE reg.policy_class
      WHEN 'owner_scoped' THEN
        qual := format('%s AND (%I = app.current_user_id() OR app.scope_is_global())',
                       tenant_pred, reg.owner_column);
        with_check := format('%s AND %I = app.current_user_id()',
                             tenant_pred, reg.owner_column);
      WHEN 'append_only_owner' THEN
        qual := format('%s AND (%I = app.current_user_id() OR app.scope_is_global())',
                       tenant_pred, reg.owner_column);
        with_check := 'false';
      WHEN 'tenant_scoped' THEN
        qual := tenant_pred;
        with_check := format('%s AND app.scope_is_admin()', tenant_pred);
      WHEN 'tenant_scoped_read' THEN
        qual := tenant_pred;
        with_check := 'false';
      WHEN 'append_only_tenant' THEN
        qual := tenant_pred;
        with_check := 'false';
      WHEN 'tenant_admin_only' THEN
        qual := format('%s AND app.scope_is_admin()', tenant_pred);
        with_check := format('%s AND app.scope_is_admin()', tenant_pred);
      WHEN 'append_only_tenant_admin' THEN
        qual := format('%s AND app.scope_is_admin()', tenant_pred);
        with_check := 'false';
      WHEN 'definer_only', 'system_cross_tenant' THEN
        qual := 'false';
        with_check := 'false';
      WHEN 'reference' THEN
        qual := 'true';
        with_check := 'false';
      ELSE
        RAISE EXCEPTION 'HR002: policy_class % has no generator', reg.policy_class;
    END CASE;

    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', ident);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', ident);

    EXECUTE format('DROP POLICY IF EXISTS p_app ON %s', ident);
    EXECUTE format('CREATE POLICY p_app ON %s FOR ALL TO crm_app USING (%s) WITH CHECK (%s)',
                   ident, qual, with_check);
    EXECUTE format('DROP POLICY IF EXISTS p_sys ON %s', ident);
    EXECUTE format('CREATE POLICY p_sys ON %s FOR ALL TO crm_migrator USING (true) WITH CHECK (true)',
                   ident);

    EXECUTE format('REVOKE ALL ON %s FROM crm_app', ident);

    -- SELECT STOPS BEING UNCONDITIONAL, and that is this migration's change to
    -- the engine. `definer_only` already generates USING (false), so crm_app
    -- read zero rows -- but it HELD the SELECT privilege, and a privilege that
    -- only a policy neutralises is one dropped policy away from a tenant-wide
    -- read of consent. The constitution ranks a revoked privilege above a
    -- policy; consent_ledger is the first table that actually needs the
    -- ranking, because it is the first `definer_only` table to exist.
    IF reg.policy_class NOT IN ('definer_only', 'system_cross_tenant') THEN
      EXECUTE format('GRANT SELECT ON %s TO crm_app', ident);
    END IF;

    IF NOT append_only THEN
      IF reg.app_can_insert
         AND reg.policy_class NOT IN ('definer_only', 'system_cross_tenant', 'reference',
                                      'tenant_scoped_read') THEN
        EXECUTE format('GRANT INSERT ON %s TO crm_app', ident);
      END IF;

      IF NOT reg.immutable
         AND reg.policy_class NOT IN ('definer_only', 'system_cross_tenant', 'reference',
                                      'tenant_scoped_read') THEN
        IF reg.protected_columns IS NOT NULL AND array_length(reg.protected_columns, 1) > 0 THEN
          -- Grant the ALLOWED columns, never the table.
          --
          -- PostgreSQL does not decompose a table-level grant, so
          -- `GRANT UPDATE ON t` followed by `REVOKE UPDATE (c) ON t` leaves c
          -- writable — the revoke silently removes a column privilege that was
          -- never separately granted. Enumerating the permitted columns is the
          -- only form that actually holds, and a column added later is
          -- protected by default until this list is regenerated.
          SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY a.attnum) INTO cols
          FROM pg_attribute a
          WHERE a.attrelid = ident::regclass
            AND a.attnum > 0
            AND NOT a.attisdropped
            AND a.attname <> ALL (reg.protected_columns);
          EXECUTE format('GRANT UPDATE (%s) ON %s TO crm_app', cols, ident);
        ELSE
          EXECUTE format('GRANT UPDATE ON %s TO crm_app', ident);
        END IF;
      END IF;
    END IF;

    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %s', trg, ident);
    IF reg.immutable OR append_only THEN
      EXECUTE format(
        'CREATE TRIGGER %I BEFORE UPDATE OR DELETE OR TRUNCATE ON %s '
        'FOR EACH STATEMENT EXECUTE FUNCTION security.refuse_mutation()',
        trg, ident);
    END IF;
  END LOOP;

  EXECUTE 'REVOKE ALL ON SCHEMA public FROM crm_app';
  EXECUTE 'REVOKE ALL ON SCHEMA security FROM crm_app';
  EXECUTE 'GRANT USAGE ON SCHEMA app TO crm_app';
  EXECUTE 'GRANT USAGE ON SCHEMA ref TO crm_app';
END
$fn$;
--> statement-breakpoint

-- `definer_only` + immutable. Not `append_only_tenant`, which would have been
-- the lazy fit: that class generates USING (tenant_id = app.current_tenant()),
-- which makes the table READABLE tenant-wide. Consent is tenant-wide by
-- necessity -- a STOP silences a number for every seller -- so a readable
-- consent table is a cross-silo oracle: ask it about a number and learn whether
-- someone else in the agency is working that consumer. The silo is not a UI
-- rule, so the closure is at the privilege level.
INSERT INTO security.table_registry
  (schema_name, table_name, policy_class, owner_column, immutable, app_can_insert,
   protected_columns, exception_reason, registered_in_migration)
VALUES
  ('app', 'consent_ledger', 'definer_only', NULL, true, false,
   NULL, NULL, '0035_consent_ledger')
ON CONFLICT (schema_name, table_name) DO UPDATE
  SET policy_class = EXCLUDED.policy_class,
      immutable    = EXCLUDED.immutable,
      app_can_insert = EXCLUDED.app_can_insert,
      registered_in_migration = EXCLUDED.registered_in_migration;
--> statement-breakpoint

-- The ONLY writer.
CREATE OR REPLACE FUNCTION app.consent_append(
  p_contact_value_kind      app.contact_value_kind,
  p_contact_value_norm      text,
  p_channel                 app.channel,
  p_status                  app.consent_status,
  p_consent_type            app.consent_type,
  p_source                  app.consent_source,
  p_effective_at            timestamptz,
  p_contact_id              uuid        DEFAULT NULL,
  p_vendor_name             text        DEFAULT NULL,
  p_certificate_url         text        DEFAULT NULL,
  p_certificate_captured_at timestamptz DEFAULT NULL,
  p_jurisdiction_state      char(2)     DEFAULT NULL,
  p_captured_ip             inet        DEFAULT NULL,
  p_attesting_admin_user_id uuid        DEFAULT NULL,
  p_evidence_ref            text        DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = app, ref, pg_catalog
AS $fn$
DECLARE
  v_tenant   uuid;
  v_norm     text;
  v_previous app.consent_status;
  v_id       uuid;
BEGIN
  -- Every SECURITY DEFINER body must contain app.current_tenant(); a CI query
  -- over pg_proc.prosrc asserts it. This function runs as crm_migrator, whose
  -- p_sys policy is USING (true) -- RLS protects nothing in here, so the tenant
  -- is established explicitly or not at all.
  v_tenant := app.current_tenant();
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'CN001: consent_append called outside a tenant session'
      USING HINT = 'app.begin_request() or app.begin_job() establishes the tenant. Failing closed here is the point: a consent row written into the wrong tenant is worse than a refused write.';
  END IF;

  -- NORMALISED HERE, NOT AT A CALL SITE. Six ingress points reach consent --
  -- vendor intake, booking capture, the STOP webhook, a DNC import, a manual
  -- revoke, and recycle revalidation -- and a helper that all six must remember
  -- to call is a helper one of them will not. `+1 937 555 0142` and
  -- `+19375550142` are the same permission or the ledger is decorative.
  IF p_contact_value_kind = 'email' THEN
    v_norm := lower(btrim(p_contact_value_norm));
  ELSE
    v_norm := regexp_replace(btrim(p_contact_value_norm), '[^0-9+]', '', 'g');
  END IF;

  -- DERIVED, never passed in. A caller able to state previous_status is a
  -- caller able to state it wrongly, and this column is read as evidence that a
  -- transition happened. Ordered by effective_at because a webhook forty
  -- seconds late still revokes from the moment the consumer sent it.
  SELECT cl.status INTO v_previous
    FROM app.consent_ledger cl
   WHERE cl.tenant_id          = v_tenant
     AND cl.contact_value_norm = v_norm
     AND cl.channel            = p_channel
   ORDER BY cl.effective_at DESC, cl.recorded_at DESC
   LIMIT 1;

  INSERT INTO app.consent_ledger (
    tenant_id, contact_value_kind, contact_value_norm, channel, status,
    consent_type, source, vendor_name, certificate_url, certificate_captured_at,
    jurisdiction_state, captured_ip, attesting_admin_user_id, contact_id,
    previous_status, evidence_ref, effective_at, actor_user_id
  ) VALUES (
    v_tenant, p_contact_value_kind, v_norm, p_channel, p_status,
    p_consent_type, p_source, p_vendor_name, p_certificate_url,
    p_certificate_captured_at, p_jurisdiction_state, p_captured_ip,
    p_attesting_admin_user_id, p_contact_id,
    v_previous, p_evidence_ref, p_effective_at,
    -- NOT a parameter. A caller that could name the actor could name someone
    -- else; NULL is the honest value for a provider-driven STOP.
    app.current_user_id()
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$fn$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION app.consent_append(app.contact_value_kind, text, app.channel,
  app.consent_status, app.consent_type, app.consent_source, timestamptz, uuid, text,
  text, timestamptz, char, inet, uuid, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.consent_append(app.contact_value_kind, text, app.channel,
  app.consent_status, app.consent_type, app.consent_source, timestamptz, uuid, text,
  text, timestamptz, char, inet, uuid, text) TO crm_app;
--> statement-breakpoint

-- The ONLY reader, and it returns state rather than history.
CREATE OR REPLACE FUNCTION app.consent_state(p_contact_id uuid)
RETURNS TABLE (
  channel      app.channel,
  status       app.consent_status,
  consent_type app.consent_type,
  source       app.consent_source,
  effective_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = app, ref, pg_catalog
AS $fn$
DECLARE
  v_tenant uuid;
  v_norm   text;
BEGIN
  v_tenant := app.current_tenant();
  IF v_tenant IS NULL THEN
    RETURN;
  END IF;

  -- OWNERSHIP IS RE-ASSERTED IN HERE, and this is the line the whole function
  -- exists for. A definer runs as crm_migrator, so the RLS that scopes every
  -- other read in this system is switched off; without this predicate any
  -- seller could pass any contact_id and learn a stranger's consent state.
  --
  -- A contact in someone else's book returns ZERO ROWS, never an error. An
  -- error would confirm the record exists, which is the same leak wearing a
  -- status code.
  SELECT cp.phone_e164 INTO v_norm
    FROM app.contact_phone cp
   WHERE cp.tenant_id  = v_tenant
     AND cp.contact_id = p_contact_id
     AND (cp.owner_user_id = app.current_user_id() OR app.scope_is_global())
   ORDER BY cp.is_primary DESC, cp.created_at ASC
   LIMIT 1;

  IF v_norm IS NULL THEN
    RETURN;
  END IF;

  -- One row per channel: the latest, which is what "state" means for a table
  -- that only ever appends.
  RETURN QUERY
  SELECT DISTINCT ON (cl.channel)
         cl.channel, cl.status, cl.consent_type, cl.source, cl.effective_at
    FROM app.consent_ledger cl
   WHERE cl.tenant_id          = v_tenant
     AND cl.contact_value_norm = v_norm
   ORDER BY cl.channel, cl.effective_at DESC, cl.recorded_at DESC;
END;
$fn$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION app.consent_state(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.consent_state(uuid) TO crm_app;
--> statement-breakpoint

SELECT security.harden();
