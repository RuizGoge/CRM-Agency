CREATE SEQUENCE IF NOT EXISTS app.event_seq;--> statement-breakpoint
CREATE TYPE "app"."source_system" AS ENUM('app', 'aloware', 'vendor_post', 'scheduler', 'import');--> statement-breakpoint
CREATE TABLE "app"."event_log" (
	"tenant_id" uuid NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"event_id" uuid NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"actor_user_id" uuid,
	"occurred_at_ms" bigint NOT NULL,
	"recorded_at_ms" bigint NOT NULL,
	"schema_version" smallint NOT NULL,
	"source_system" "app"."source_system" NOT NULL,
	"correlation_id" uuid NOT NULL,
	"event_name" "app"."event_name" NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"payload" jsonb NOT NULL,
	"seq" bigint DEFAULT nextval('app.event_seq') NOT NULL,
	"retention_class" "app"."retention_class" NOT NULL,
	CONSTRAINT "event_log_tenant_id_occurred_at_event_id_pk" PRIMARY KEY("tenant_id","occurred_at","event_id")
) PARTITION BY RANGE ("occurred_at");
--> statement-breakpoint
CREATE TABLE "app"."event_outbox" (
	"tenant_id" uuid NOT NULL,
	"created_day" date NOT NULL,
	"event_id" uuid NOT NULL,
	"consumer_name" text NOT NULL,
	"event_name" "app"."event_name" NOT NULL,
	"status" "app"."outbox_status" DEFAULT 'pending' NOT NULL,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"claimed_at" timestamp with time zone,
	"claimed_by" text,
	"last_error" text,
	"delivered_at" timestamp with time zone,
	"replay_of_run_id" uuid,
	CONSTRAINT "event_outbox_tenant_id_created_day_event_id_consumer_name_pk" PRIMARY KEY("tenant_id","created_day","event_id","consumer_name")
) PARTITION BY RANGE ("created_day");
--> statement-breakpoint
ALTER TABLE "app"."event_log" ADD CONSTRAINT "event_log_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."event_outbox" ADD CONSTRAINT "event_outbox_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."event_outbox" ADD CONSTRAINT "outbox_consumer_fk" FOREIGN KEY ("consumer_name","event_name") REFERENCES "app"."event_consumer"("consumer_name","event_name") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

-- ===========================================================================
-- PARTITIONS ARE CREATED THROUGH format(), and that is deliberate rather than
-- incidental: a partition is STORAGE for a declared parent, not a table anybody
-- models. `snapshot-chain.test.ts` requires every table a migration creates to
-- have a schema declaration, and it is right to — but `event_log_2026_08` has
-- no business being declared, while `event_log` is. The dynamic form keeps the
-- gate asking the question it means to ask, and
-- `tests/integration/event-store.test.ts` asserts the parent is declared so the
-- distinction is stated rather than relied upon.
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

    -- A PARTITION INHERITS ITS PARENT'S CLASSIFICATION. It is not a relation
    -- anybody models: `event_log_2026_08` exists because August happened, and
    -- demanding a registry row per month would be a rule kept by whoever
    -- remembers -- which is the failure mode this whole registry replaces.
    --
    -- Inheriting rather than SKIPPING is the correction. The first attempt
    -- excluded partition children from security.managed_relations() entirely,
    -- and silo.test.ts caught it in one run: `app.event_log_2026_08 has RLS
    -- disabled`. Excluding them would have left a managed relation without
    -- FORCE RLS and traded a real invariant for a convenience. Resolving the
    -- parent keeps every partition hardened with exactly the parent's policy.
    IF NOT FOUND THEN
      SELECT tr.* INTO reg
        FROM pg_class c
        JOIN pg_inherits inh ON inh.inhrelid = c.oid
        JOIN pg_class par ON par.oid = inh.inhparent
        JOIN pg_namespace pn ON pn.oid = par.relnamespace
        JOIN security.table_registry tr
          ON tr.schema_name = pn.nspname AND tr.table_name = par.relname
       WHERE c.oid = ident::regclass
         AND c.relispartition;
    END IF;

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

CREATE OR REPLACE FUNCTION app.ensure_event_partitions(
  p_months integer DEFAULT 3,
  p_days   integer DEFAULT 14
)
RETURNS integer
LANGUAGE plpgsql AS $fn$
DECLARE
  i     integer;
  m     date;
  d     date;
  made  integer := 0;
BEGIN
  -- NO DEFAULT PARTITION, on purpose. A default would silently absorb rows
  -- whose month nobody created, and the first anyone would know is a query
  -- planner scanning it forever. Without one the INSERT fails loudly, which is
  -- the correct direction for a store whose whole job is to be complete.
  FOR i IN 0..p_months LOOP
    m := (date_trunc('month', clock_timestamp()) + make_interval(months => i))::date;
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS app.%I PARTITION OF app.event_log FOR VALUES FROM (%L) TO (%L)',
      'event_log_' || to_char(m, 'YYYY_MM'),
      m,
      (m + interval '1 month')::date);
    made := made + 1;
  END LOOP;

  FOR i IN 0..p_days LOOP
    d := (clock_timestamp() + make_interval(days => i))::date;
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS app.%I PARTITION OF app.event_outbox FOR VALUES FROM (%L) TO (%L)',
      'event_outbox_' || to_char(d, 'YYYY_MM_DD'),
      d,
      d + 1);
    made := made + 1;
  END LOOP;

  RETURN made;
END;
$fn$;
--> statement-breakpoint

SELECT app.ensure_event_partitions();
--> statement-breakpoint

INSERT INTO security.table_registry
  (schema_name, table_name, policy_class, owner_column, immutable, app_can_insert,
   protected_columns, exception_reason, registered_in_migration)
VALUES
  ('app', 'event_log', 'append_only_owner', 'owner_user_id', true, false, NULL, NULL,
   '0043_event_store'),
  ('app', 'event_outbox', 'system_cross_tenant', NULL, false, false, NULL, NULL,
   '0043_event_store')
ON CONFLICT (schema_name, table_name) DO UPDATE
  SET policy_class = EXCLUDED.policy_class,
      owner_column = EXCLUDED.owner_column,
      immutable    = EXCLUDED.immutable,
      registered_in_migration = EXCLUDED.registered_in_migration;
--> statement-breakpoint

-- ===========================================================================
-- THE ONLY WRITER. The event row and its fan-out rows land in ONE transaction,
-- which is the entire argument for an outbox: a consumer cannot be lost by a
-- process dying between "the thing happened" and "the consumers were told".
-- The row that says a consumer still owes this event was committed with the
-- event itself.
--
-- The division of labour with pg-boss is total and deliberate: THE OUTBOX OWNS
-- FAN-OUT, PG-BOSS OWNS SCHEDULING. Two systems that both think they deliver is
-- how a lead gets texted twice.
-- ===========================================================================
CREATE OR REPLACE FUNCTION app.event_emit(
  p_event_id        uuid,
  p_owner_user_id   uuid,
  p_event_name      app.event_name,
  p_subject_type    text,
  p_subject_id      uuid,
  p_idempotency_key text,
  p_payload         jsonb,
  p_occurred_at     timestamptz          DEFAULT clock_timestamp(),
  p_source_system   app.source_system    DEFAULT 'app',
  p_correlation_id  uuid                 DEFAULT NULL,
  p_retention_class app.retention_class  DEFAULT 'permanent',
  p_schema_version  smallint             DEFAULT 1
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = app, ref, pg_catalog
AS $fn$
DECLARE
  v_tenant   uuid;
  v_inserted uuid;
BEGIN
  v_tenant := app.current_tenant();
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'EV001: event_emit called outside a tenant session'
      USING HINT = 'An event with no tenant belongs to nobody and is invisible to everyone.';
  END IF;

  -- IDEMPOTENT ON THE NATURAL KEY, NOT ON THE PRIMARY KEY.
  --
  -- The first version leaned on `ON CONFLICT (tenant_id, occurred_at, event_id)`
  -- and deduped nothing: `occurred_at` defaults to clock_timestamp(), so a
  -- second emission of the SAME event_id arrived with a different partition key
  -- and a different PK, and Earnings would have been told about one sale twice.
  --
  -- 05b already ruled the shape: a globally unique index across partitions would
  -- need the partition key in it, which it is not, so uniqueness comes from
  -- generation (uuidv7 at the four ingress adapters) and "the dedupe that
  -- actually matters for external redelivery is the natural key". Aloware
  -- redelivering a call does not reuse our uuid; it reuses aloware_call_id.
  PERFORM 1 FROM app.event_log el
   WHERE el.tenant_id = v_tenant
     AND el.event_name = p_event_name
     AND el.idempotency_key = p_idempotency_key;
  IF FOUND THEN
    RETURN p_event_id;
  END IF;

  INSERT INTO app.event_log (
    tenant_id, occurred_at, event_id, owner_user_id, actor_user_id,
    occurred_at_ms, recorded_at_ms, schema_version, source_system, correlation_id,
    event_name, subject_type, subject_id, idempotency_key, payload, retention_class
  ) VALUES (
    v_tenant, p_occurred_at, p_event_id, p_owner_user_id, app.current_user_id(),
    (extract(epoch FROM p_occurred_at) * 1000)::bigint,
    (extract(epoch FROM clock_timestamp()) * 1000)::bigint,
    p_schema_version, p_source_system, coalesce(p_correlation_id, p_event_id),
    p_event_name, p_subject_type, p_subject_id, p_idempotency_key, p_payload,
    p_retention_class
  )
  -- Idempotent on the primary key. A replayed job or a retried webhook that
  -- reaches here twice with the same event_id writes once and fans out once.
  ON CONFLICT (tenant_id, occurred_at, event_id) DO NOTHING
  RETURNING event_id INTO v_inserted;

  -- Nothing inserted means this event was already emitted, and re-fanning it out
  -- would deliver it twice. The at-least-once guarantee is per emission.
  IF v_inserted IS NULL THEN
    RETURN p_event_id;
  END IF;

  INSERT INTO app.event_outbox (tenant_id, created_day, event_id, consumer_name, event_name)
  SELECT v_tenant, p_occurred_at::date, p_event_id, ec.consumer_name, ec.event_name
    FROM app.event_consumer ec
   WHERE ec.event_name = p_event_name
  ON CONFLICT DO NOTHING;

  RETURN p_event_id;
END;
$fn$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION app.event_emit(uuid, uuid, app.event_name, text, uuid, text, jsonb,
  timestamptz, app.source_system, uuid, app.retention_class, smallint) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.event_emit(uuid, uuid, app.event_name, text, uuid, text, jsonb,
  timestamptz, app.source_system, uuid, app.retention_class, smallint) TO crm_app;
--> statement-breakpoint

-- ===========================================================================
-- THE CLAIM. One of the four enumerated CROSS-TENANT system paths, and the only
-- reason it is allowed to be one: dispatch has to find work across every agency
-- before it knows whose work it is.
--
-- IT RETURNS FOUR COLUMNS AND NO PAYLOAD. No joins, no contact, no lead data —
-- the dispatcher learns that consumer X owes event Y in tenant Z, then sets the
-- per-row tenant and owner context before touching anything else. A claim that
-- returned the payload would be a cross-tenant read of every event body in the
-- system wearing the costume of a queue.
-- ===========================================================================
CREATE OR REPLACE FUNCTION app.outbox_claim(
  p_batch integer DEFAULT 50,
  p_lease interval DEFAULT interval '5 minutes',
  p_worker text DEFAULT NULL
)
RETURNS TABLE (tenant_id uuid, event_id uuid, consumer_name text, event_name app.event_name)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = app, ref, pg_catalog
AS $fn$
BEGIN
  -- DELIBERATELY DOES NOT CALL app.current_tenant(): this is a cross-tenant
  -- dispatcher and there is no tenant to establish yet. That is why it is named
  -- in the exemption list of tests/integration/definer-tenancy.test.ts, with
  -- the reason written there rather than assumed here.
  RETURN QUERY
  WITH due AS (
    SELECT o.tenant_id, o.created_day, o.event_id, o.consumer_name
      FROM app.event_outbox o
     WHERE o.status IN ('pending', 'claimed')
       AND o.next_attempt_at <= clock_timestamp()
       AND (o.claimed_at IS NULL OR o.claimed_at < clock_timestamp() - p_lease)
     ORDER BY o.next_attempt_at
     LIMIT p_batch
     FOR UPDATE SKIP LOCKED
  )
  UPDATE app.event_outbox o
     SET status     = 'claimed',
         claimed_at = clock_timestamp(),
         claimed_by = coalesce(p_worker, 'unnamed'),
         attempts   = o.attempts + 1
    FROM due d
   WHERE o.tenant_id  = d.tenant_id
     AND o.created_day = d.created_day
     AND o.event_id   = d.event_id
     AND o.consumer_name = d.consumer_name
  RETURNING o.tenant_id, o.event_id, o.consumer_name, o.event_name;
END;
$fn$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION app.outbox_claim(integer, interval, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.outbox_claim(integer, interval, text) TO crm_app;
--> statement-breakpoint

SELECT security.harden();
