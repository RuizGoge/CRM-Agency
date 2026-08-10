-- ===========================================================================
-- app.audit_log — MVP item 7, and the third append-only table.
--
-- "The timeline is for the seller, the audit log is for the lawyer." The
-- timeline carries ONE entry per verdict per contact per 60s window; this
-- carries one row per ATTEMPT, unbucketed, because the question it answers is
-- not "what happened to this lead" but "what was true at 14:07 on a Tuesday
-- nineteen months ago, and who did it".
--
-- Append-only BY TRIGGER **and** BY REVOKED PRIVILEGE, which is the ranking
-- `CLAUDE.md` sets and which `harden()` applies for free to
-- `append_only_tenant_admin`: the class generates WITH CHECK (false), grants no
-- INSERT/UPDATE/DELETE to crm_app at all, and installs
-- `security.refuse_mutation()` as a statement trigger covering TRUNCATE. The
-- only way a row arrives is `app.audit_write()`.
--
-- ⚠️ TENANT-ADMIN READ, NOT OWNER READ. A seller cannot read the audit log at
-- all — not even their own rows. `book.viewed` records that a supervisor read
-- somebody's book, and a seller who could query that would learn which of their
-- colleagues is being looked at. The log is evidence about the agency, so it is
-- readable by whoever answers for the agency.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1 · THE ACTION VOCABULARY
-- ---------------------------------------------------------------------------
-- A CHECK against a closed list, not free text. An audit log whose `action` is
-- free text answers "show me every ownership transfer" with a LIKE and a
-- prayer, and the day the spelling drifts the answer is silently short.
--
-- ⚠️ FIVE OF THESE ARE RATIFIED AND ELEVEN ARE DERIVED, and the split is marked
-- because it matters. `docs/05-architecture.md`:1669/:1839 and
-- `docs/05b-data-model.md`:590/:710 and `docs/03-mvp-stories.md`:708 name
-- exactly five literals. `docs/03-mvp-stories.md`:724 (US-9.13) then enumerates
-- eleven further categories that MUST be audited — every gate verdict, every
-- break-glass dial, engage/end, consent, suppression, export, ledger
-- void/adjust, stage-flag change, role change, ownership transfer, user
-- deactivation — and gives none of them a name.
--
-- Naming them here is a proposal that compiles, in the same sense the event
-- catalog marks nine payloads "derived". The alternative was leaving the
-- vocabulary open, and an open vocabulary is how the spelling drifts.
--
-- 05b specifies this as a generated function fed by a registry file. That file
-- does not exist — `contracts/` holds events, the protected list and the loader
-- whitelist and nothing else — so the list lives here until there is one.
CREATE OR REPLACE FUNCTION app.audit_action_list()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
AS $fn$
  SELECT ARRAY[
    -- Ratified by name in the corpus.
    'user.credential_reset',
    'vault.body_viewed',
    'tenant.business_tz_changed',
    'book.viewed',
    'ownership.transferred',
    -- Derived from US-9.13's categories.
    --
    -- 🔴 NONE OF THESE MAY COLLIDE WITH AN EVENT NAME, LIVE OR GHOST, and the
    -- first draft of this list collided with three of each. `earnings.adjusted`
    -- and `lead.owner_changed` are both RULED-OUT event names, and
    -- `scripts/events-contract.test.ts` refused them on sight — correctly,
    -- because it scans string literals and cannot know whether a given one is
    -- meant as an event or an action. That is not a limitation to work around:
    -- an audit action spelled like a discarded event is exactly the ambiguity
    -- the ghost list exists to prevent, and four more collided with LIVE names,
    -- which the ghost gate does not catch at all.
    --
    -- `tests/integration/audit-vocabulary.test.ts` now asserts the separation in
    -- both directions, so this is a mechanism rather than a check somebody
    -- performed once.
    'compliance.gate_checked',
    'compliance.break_glass_engaged',
    'compliance.break_glass_ended',
    'consent.ledger_appended',
    'suppression.ledger_appended',
    'data.exported',
    'ledger.adjusted',
    'stage.config_changed',
    'user.role_assigned',
    'user.access_revoked',
    'close.gate_refused'
  ]
$fn$;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2 · THE TABLE
-- ---------------------------------------------------------------------------
CREATE TABLE "app"."audit_log" (
  "tenant_id" uuid NOT NULL,
  "occurred_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
  "id" uuid DEFAULT uuidv7() NOT NULL,

  -- NULLABLE, and the null is the honest value rather than a gap: a scheduler
  -- tick, a provider webhook and a migration have no user behind them. Writing
  -- a service account here would make "who did this" unanswerable precisely
  -- where it matters.
  "actor_user_id" uuid,
  "actor_type" "app"."actor_type" NOT NULL,

  "action" text NOT NULL,
  "subject_type" text NOT NULL,
  "subject_id" uuid,

  "before" jsonb,
  "after" jsonb,
  "reason" text,

  -- The compliance half. A verdict row carries the verdict AND the inputs it
  -- was computed from, because "the gate said no" is not a defence eighteen
  -- months later — "the gate said no, and here is the zip, the zone set, the
  -- local time and the suppression state it read" is.
  "verdict" "app"."gate_verdict",
  "verdict_input_snapshot" jsonb,
  "override_id" uuid,

  "correlation_id" uuid,
  "source_ip" inet,
  "user_agent" text,

  -- Five-minute bucket, and ONLY the read-ish actions use it. `book.viewed`
  -- unbucketed would write a row per keystroke of a supervisor scrolling.
  -- Every write action leaves it NULL and is therefore never deduplicated —
  -- N dials under break-glass are N rows, which US-9.13 requires by name.
  "dedupe_bucket" timestamp with time zone,

  CONSTRAINT "audit_log_tenant_id_occurred_at_id_pk" PRIMARY KEY("tenant_id","occurred_at","id"),
  CONSTRAINT "audit_log_action_known" CHECK ("action" = ANY(app.audit_action_list())),
  -- An override id without a verdict is a claim that a block was released with
  -- no record of what was blocked.
  CONSTRAINT "audit_log_override_needs_verdict"
    CHECK ("override_id" IS NULL OR "verdict" IS NOT NULL)
) PARTITION BY RANGE ("occurred_at");--> statement-breakpoint

ALTER TABLE "app"."audit_log" ADD CONSTRAINT "audit_log_tenant_id_tenant_id_fk"
  FOREIGN KEY ("tenant_id") REFERENCES "app"."tenant"("id")
  ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- COMPOSITE, like every foreign key in this schema: a cross-tenant reference is
-- structurally impossible to write rather than merely discouraged.
ALTER TABLE "app"."audit_log" ADD CONSTRAINT "audit_log_actor_fk"
  FOREIGN KEY ("tenant_id","actor_user_id") REFERENCES "app"."app_user"("tenant_id","id")
  ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3 · PARTITIONS, and the dedupe index that has to live on each one
-- ---------------------------------------------------------------------------
-- 🔴 THE INDEX 05b SPECIFIES CANNOT BE CREATED AS WRITTEN. A unique index on a
-- partitioned parent must contain every partitioning column, so
--   CREATE UNIQUE INDEX ... ON app.audit_log
--     (tenant_id, action, actor_user_id, subject_id, dedupe_bucket)
--     WHERE dedupe_bucket IS NOT NULL
-- is refused: "unique constraint on partitioned table must include all
-- partitioning columns ... lacks column occurred_at". Adding `occurred_at`
-- would destroy the point, because two views five seconds apart have different
-- `occurred_at` and identical buckets.
--
-- Created PER PARTITION instead, which is exactly the reasoning 05b already
-- applies to `event_id`: global uniqueness comes from generation and is
-- ENFORCED per partition. It is equivalent here rather than merely close —
-- `dedupe_bucket` is `occurred_at` truncated to five minutes and month
-- boundaries fall at 00:00:00, which is 5-minute aligned, so no bucket can
-- straddle two partitions.
CREATE OR REPLACE FUNCTION app.ensure_audit_partitions(p_months integer DEFAULT 3)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = app, ref, pg_catalog
AS $fn$
DECLARE
  i    integer;
  m    date;
  part text;
  made integer := 0;
BEGIN
  -- Cluster storage, not tenant data: same exemption and same reason as
  -- app.ensure_event_partitions. There is no tenant whose session could scope
  -- a CREATE TABLE, because a partition is shared by every agency at once.
  --
  -- NO DEFAULT PARTITION, on purpose. A default silently absorbs rows for a
  -- month nobody created, and the first symptom is a planner scanning it
  -- forever. Without one the INSERT fails loudly — the correct direction for a
  -- log whose whole job is to be complete.
  FOR i IN 0..p_months LOOP
    m := (date_trunc('month', clock_timestamp()) + make_interval(months => i))::date;
    part := 'audit_log_' || to_char(m, 'YYYY_MM');

    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS app.%I PARTITION OF app.audit_log FOR VALUES FROM (%L) TO (%L)',
      part, m, (m + interval '1 month')::date);

    EXECUTE format(
      'CREATE UNIQUE INDEX IF NOT EXISTS %I ON app.%I '
      '(tenant_id, action, actor_user_id, subject_id, dedupe_bucket) '
      'WHERE dedupe_bucket IS NOT NULL',
      left(part || '_dedupe_uidx', 63), part);

    made := made + 1;
  END LOOP;

  -- Every partition above is a managed relation with no policy until this runs,
  -- and harden() resolves a partition's classification through pg_inherits.
  -- Without this call a partition created next month is a table holding
  -- compliance evidence with FORCE RLS off.
  PERFORM security.harden();

  RETURN made;
END;
$fn$;--> statement-breakpoint

REVOKE ALL ON FUNCTION app.ensure_audit_partitions(integer) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.ensure_audit_partitions(integer) TO crm_app;--> statement-breakpoint

INSERT INTO security.table_registry
  (schema_name, table_name, policy_class, owner_column, immutable, app_can_insert,
   protected_columns, exception_reason, registered_in_migration)
VALUES
  ('app', 'audit_log', 'append_only_tenant_admin', NULL, true, false, NULL, NULL,
   '0053_audit_log')
ON CONFLICT (schema_name, table_name) DO UPDATE
  SET policy_class = EXCLUDED.policy_class,
      owner_column = EXCLUDED.owner_column,
      immutable    = EXCLUDED.immutable,
      app_can_insert = EXCLUDED.app_can_insert,
      registered_in_migration = EXCLUDED.registered_in_migration;--> statement-breakpoint

SELECT app.ensure_audit_partitions();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4 · THE ONLY WRITER
-- ---------------------------------------------------------------------------
-- 🔴 `actor_user_id` IS NOT A PARAMETER, and that is the same rule
-- `app.consent_append` applies to its own actor: a caller that can declare who
-- acted is a caller that can declare somebody else acted. It comes from
-- `app.current_user_id()`, which is NULL for system work — the honest value for
-- a scheduler tick.
--
-- `p_dedupe_minutes` defaults to 0, meaning NO bucketing. Every write action is
-- therefore one row per attempt by default, and only a caller that explicitly
-- asks for a window gets one. The dangerous default is the other way round.
CREATE OR REPLACE FUNCTION app.audit_write(
  p_action          text,
  p_subject_type    text,
  p_subject_id      uuid    DEFAULT NULL,
  p_before          jsonb   DEFAULT NULL,
  p_after           jsonb   DEFAULT NULL,
  p_reason          text    DEFAULT NULL,
  p_verdict         app.gate_verdict DEFAULT NULL,
  p_verdict_input   jsonb   DEFAULT NULL,
  p_override_id     uuid    DEFAULT NULL,
  p_correlation_id  uuid    DEFAULT NULL,
  p_actor_type      app.actor_type DEFAULT 'human',
  p_dedupe_minutes  integer DEFAULT 0
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = app, ref, pg_catalog
AS $fn$
DECLARE
  v_tenant uuid;
  v_actor  uuid;
  v_bucket timestamptz;
  v_id     uuid;
BEGIN
  v_tenant := app.current_tenant();
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'AU001: audit_write called with no tenant context'
      USING HINT = 'An audit row with no tenant belongs to no agency and answers for none.';
  END IF;

  v_actor := app.current_user_id();

  IF p_dedupe_minutes > 0 THEN
    -- Truncated to the window rather than rounded: two reads inside one bucket
    -- collapse, and the bucket boundary is the only place a second row starts.
    v_bucket := to_timestamp(
      floor(extract(epoch FROM clock_timestamp()) / (p_dedupe_minutes * 60))
      * (p_dedupe_minutes * 60));
  END IF;

  -- 🔴 INSERT-OR-NOTHING, NEVER AN UPDATE. Bucketing must not rewrite an
  -- existing row: the first read is the one that happened, and moving its
  -- timestamp forward would make a supervisor's five-minute browse look like a
  -- single glance at the end of it.
  --
  -- ⚠️ NOT `ON CONFLICT`. The dedupe index lives on the PARTITIONS, not on the
  -- parent (see above), and `ON CONFLICT (...)` against the parent is refused
  -- with "there is no unique or exclusion constraint matching the ON CONFLICT
  -- specification". WHERE NOT EXISTS carries the intent; the exception handler
  -- carries the race between two sessions that both find nothing.
  BEGIN
    INSERT INTO app.audit_log (
      tenant_id, actor_user_id, actor_type, action, subject_type, subject_id,
      before, after, reason, verdict, verdict_input_snapshot, override_id,
      correlation_id, dedupe_bucket
    )
    SELECT v_tenant, v_actor, p_actor_type, p_action, p_subject_type, p_subject_id,
           p_before, p_after, p_reason, p_verdict, p_verdict_input, p_override_id,
           p_correlation_id, v_bucket
     WHERE v_bucket IS NULL
        OR NOT EXISTS (
             SELECT 1 FROM app.audit_log a
              WHERE a.tenant_id = v_tenant
                AND a.action = p_action
                AND a.actor_user_id IS NOT DISTINCT FROM v_actor
                AND a.subject_id IS NOT DISTINCT FROM p_subject_id
                AND a.dedupe_bucket = v_bucket)
    RETURNING id INTO v_id;
  EXCEPTION WHEN unique_violation THEN
    -- The other session won the bucket. A duplicate is a SUCCESS path here, the
    -- same shape as ledger_append and celebrate_once: the row exists, which is
    -- all the caller needed to be true.
    v_id := NULL;
  END;

  RETURN v_id;
END;
$fn$;--> statement-breakpoint

REVOKE ALL ON FUNCTION app.audit_write(text, text, uuid, jsonb, jsonb, text,
  app.gate_verdict, jsonb, uuid, uuid, app.actor_type, integer) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.audit_write(text, text, uuid, jsonb, jsonb, text,
  app.gate_verdict, jsonb, uuid, uuid, app.actor_type, integer) TO crm_app;--> statement-breakpoint

SELECT security.harden();
