-- ===========================================================================
-- THE TIMELINE. MVP item 20, and the root of the daily loop.
--
-- It has been blocked since the audit, and it stopped being blocked YESTERDAY:
-- `built_from_event_id` is NOT NULL, its only writer is a projector over
-- `event_log`, and until 0051–0054 there was no transport and no emitter. The
-- register recorded the consequence at the time — building it earlier would
-- have meant relaxing a provenance NOT NULL to hold an event id that never
-- existed, which is the shape of fix this project refuses.
--
-- THE SENTENCE THAT DECIDES THE WHOLE DESIGN: "the timeline is for the seller,
-- the audit log is for the lawyer." The timeline carries ONE entry per verdict
-- per contact per 60-second window; `audit_log` carries one row per ATTEMPT.
-- Both are built from the same events and neither is a view of the other.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1 · THE VOCABULARY
-- ---------------------------------------------------------------------------
CREATE TYPE "app"."timeline_kind" AS ENUM(
  'call', 'message', 'note', 'meeting', 'stage_move',
  'consent', 'send_blocked', 'lead_created', 'repost');--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2 · THE PROJECTION
-- ---------------------------------------------------------------------------
-- NOT PARTITIONED, and that is read off 05b rather than assumed: the timeline
-- appears in none of its six PARTITION BY declarations, carries no retention
-- class and no `deleted_at`. It is permanent in Postgres and "fully rebuildable
-- from event_log by the replay job; a corrupt projection is repaired by
-- rebuilding, never by patching."
--
-- 🔴 THAT NON-PARTITIONING IS ALSO WHY THIS IS SIMPLER THAN `audit_log`. 0053
-- had to create its partial unique index PER PARTITION — a unique index on a
-- partitioned parent must contain every partitioning column — and therefore
-- could not use `ON CONFLICT` at all. Neither correction applies here, so the
-- upsert below is a real upsert.
CREATE TABLE "app"."timeline_entry" (
  "tenant_id" uuid NOT NULL,
  "id" uuid DEFAULT uuidv7() NOT NULL,

  "contact_id" uuid NOT NULL,
  "owner_user_id" uuid NOT NULL,

  /* The instant the THING happened, never the instant the projector ran. A
     replay that stamped `clock_timestamp()` would reorder a seller's entire
     history into the order we happened to rebuild it in. */
  "occurred_at" timestamp with time zone NOT NULL,

  "kind" "app"."timeline_kind" NOT NULL,

  /* The natural key of the underlying thing, and the reason a late recording
     webhook MERGES into the call entry instead of adding a second one. */
  "ref_type" text NOT NULL,
  "ref_id" uuid NOT NULL,

  "render_payload" jsonb NOT NULL,

  /* Only `send_blocked` uses this. Every other kind deduplicates on the ref. */
  "dedupe_bucket" timestamp with time zone,
  "verdict" "app"."gate_verdict",

  /**
   * 🔴 A REAL COLUMN, AND `crm_app` MUST NEVER READ IT. §10.8 / ADR-086 add it
   * so the timeline can say WHO without leaking who: the seller sees
   * "you" / "system" / "previous owner", never a colleague's name. The identity
   * lives here and the view below does not carry it.
   */
  "actor_user_id" uuid,

  /* Provenance. NOT NULL: every row claims an event it was built from. */
  "built_from_event_id" uuid NOT NULL,
  "built_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,

  CONSTRAINT "timeline_entry_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),

  /**
   * 🔴 THE CHECK THAT MAKES THE 60-SECOND DEDUPE ACTUALLY HAPPEN.
   *
   * The dedupe index below is UNIQUE (tenant_id, contact_id, verdict,
   * dedupe_bucket) WHERE kind = 'send_blocked'. In PostgreSQL, NULLS are
   * DISTINCT by default — so a `send_blocked` row written with a NULL verdict
   * conflicts with NOTHING, the window silently stops deduplicating, and the
   * timeline fills with one entry per attempt. That is precisely the failure
   * the governing sentence exists to prevent, and it would look like it was
   * working right up until somebody counted.
   *
   * The constraint makes the omission impossible rather than remembered.
   */
  CONSTRAINT "timeline_blocked_needs_verdict"
    CHECK ("kind" <> 'send_blocked' OR ("verdict" IS NOT NULL AND "dedupe_bucket" IS NOT NULL)),

  /**
   * ⚠️ AND NO IDENTITY MAY HIDE IN THE PAYLOAD. §10.8 lists the keys by name:
   * moving a colleague's display name into `render_payload` would satisfy every
   * privilege check above and leak exactly what they buy.
   */
  CONSTRAINT "timeline_no_actor_in_payload"
    CHECK (NOT ("render_payload" ?| ARRAY['actor_name','actor_display_name',
                                          'actor_initials','actor_avatar_url','actor_user_id']))
) ;--> statement-breakpoint

ALTER TABLE "app"."timeline_entry" ADD CONSTRAINT "timeline_entry_contact_fk"
  FOREIGN KEY ("tenant_id","contact_id") REFERENCES "app"."contact"("tenant_id","id")
  ON DELETE no action ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "app"."timeline_entry" ADD CONSTRAINT "timeline_entry_owner_fk"
  FOREIGN KEY ("tenant_id","owner_user_id") REFERENCES "app"."app_user"("tenant_id","id")
  ON DELETE no action ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "app"."timeline_entry" ADD CONSTRAINT "timeline_entry_actor_fk"
  FOREIGN KEY ("tenant_id","actor_user_id") REFERENCES "app"."app_user"("tenant_id","id")
  ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- ⚠️ NO FOREIGN KEY ON `built_from_event_id`, and it is not an oversight.
--
-- `event_log` is PRIMARY KEY (tenant_id, occurred_at, event_id) and PARTITION
-- BY RANGE (occurred_at), so a composite FK would need the event's own
-- `occurred_at` carried here as well. Even with it, PostgreSQL refuses to
-- DETACH or DROP a partition of a referenced parent while referencing rows
-- exist — and 05b mandates COPY-to-R2 plus DETACH of archivable partitions at
-- thirteen months. The FK would turn archiving into an error.
--
-- The precedent is already built and carries the same shape:
-- `earnings_ledger.source_event_id` is a uuid with a UNIQUE and no FK.
-- Provenance declared, not referential.

CREATE INDEX "timeline_contact_idx" ON "app"."timeline_entry"
  USING btree ("tenant_id","contact_id","occurred_at" DESC,"id" DESC);--> statement-breakpoint

-- The upsert key. ARR-EVT-17: `call.enriched` UPDATES the existing entry and can
-- never create a second one — a late recording webhook merges in place. This is
-- also what makes the L2 assertion true: replaying the whole event_log twice
-- produces ZERO new timeline rows.
CREATE UNIQUE INDEX "timeline_ref_uidx" ON "app"."timeline_entry"
  USING btree ("tenant_id","ref_type","ref_id");--> statement-breakpoint

-- The 60-second window, and only for the one kind that has one.
CREATE UNIQUE INDEX "timeline_blocked_uidx" ON "app"."timeline_entry"
  USING btree ("tenant_id","contact_id","verdict","dedupe_bucket")
  WHERE "kind" = 'send_blocked';--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3 · THE CLASSIFICATION, and why it is not the obvious one
-- ---------------------------------------------------------------------------
-- 🔴 `definer_only`, NOT `owner_scoped`. 05b:847 says "owner_scoped class for
-- reads" and §10.8 supersedes it, for a mechanical reason rather than a taste:
--
-- `harden()` grants SELECT AT TABLE LEVEL to every class except `definer_only`
-- and `system_cross_tenant` (0048:213-215). A table-level SELECT in PostgreSQL
-- confers privilege on EVERY column — including `actor_user_id`, which is
-- exactly what §10.8 forbids. `harden()` can restrict columns on UPDATE
-- (protected_columns, 0048:227-242) and has no equivalent for SELECT.
--
-- So the only class that keeps the promise is the one that grants no SELECT at
-- all. The seller reads through `app.timeline_read()`; anything that wants the
-- rows without the identity reads `app.timeline_entry_live`.
INSERT INTO security.table_registry
  (schema_name, table_name, policy_class, owner_column, immutable, app_can_insert,
   protected_columns, exception_reason, registered_in_migration)
VALUES
  ('app', 'timeline_entry', 'definer_only', NULL, false, false, NULL,
   'A derived projection whose only writer is app.timeline_upsert() and whose only reader is app.timeline_read(). definer_only is the one class that grants no table-level SELECT, which is what keeps actor_user_id unreadable by crm_app — harden() cannot restrict columns on SELECT the way it can on UPDATE.',
   '0059_timeline')
ON CONFLICT (schema_name, table_name) DO UPDATE
  SET policy_class = EXCLUDED.policy_class,
      immutable    = EXCLUDED.immutable,
      app_can_insert = EXCLUDED.app_can_insert,
      exception_reason = EXCLUDED.exception_reason,
      registered_in_migration = EXCLUDED.registered_in_migration;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4 · THE ONLY WRITER
-- ---------------------------------------------------------------------------
-- ⚠️ THE CORPUS NAMES THIS FUNCTION FOUR TIMES AND SPECIFIES NO SIGNATURE.
-- 05-architecture:776, :785, :2300 and 05b:846, :1099 all assert that it is
-- SECURITY DEFINER, that it is the only writer, and that "the projector
-- consumer" calls it — and none of them give a parameter, a return type or a
-- body. Contrast `app.audit_write`, `app.ledger_append` and `app.stage_move`,
-- which are written out. The shape below is derived from the columns and from
-- the two indexes it has to arbitrate; it is not a citation.
--
-- 🔴 TWO PATHS, BECAUSE ONE STATEMENT CANNOT ARBITRATE TWO UNIQUE INDEXES.
-- `ON CONFLICT` takes one arbiter. `send_blocked` deduplicates on the 60-second
-- window and DISCARDS the second occurrence; everything else merges in place on
-- the natural key. Those are different promises, so they are different
-- statements rather than one clever one.
CREATE OR REPLACE FUNCTION app.timeline_upsert(
  p_contact_id     uuid,
  p_owner_user_id  uuid,
  p_occurred_at    timestamptz,
  p_kind           app.timeline_kind,
  p_ref_type       text,
  p_ref_id         uuid,
  p_render_payload jsonb,
  p_event_id       uuid,
  p_actor_user_id  uuid DEFAULT NULL,
  p_verdict        app.gate_verdict DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = app, ref, pg_catalog
AS $fn$
DECLARE
  v_tenant uuid;
  v_bucket timestamptz;
  v_id     uuid;
BEGIN
  v_tenant := app.current_tenant();
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'TL001: timeline_upsert called with no tenant context'
      USING HINT = 'The relay opens withSystemWork(tenant) per delivery before projecting.';
  END IF;

  IF p_kind = 'send_blocked' THEN
    IF p_verdict IS NULL THEN
      RAISE EXCEPTION 'TL002: a send_blocked entry with no verdict cannot be deduplicated'
        USING HINT = 'NULLs are distinct in a unique index, so the 60s window would silently stop working.';
    END IF;

    -- TRUNCATED to the window rather than rounded, same as `audit_write`: two
    -- refusals inside one bucket collapse, and the boundary is the only place a
    -- second row starts.
    v_bucket := to_timestamp(floor(extract(epoch FROM p_occurred_at) / 60) * 60);

    INSERT INTO app.timeline_entry
      (tenant_id, contact_id, owner_user_id, occurred_at, kind, ref_type, ref_id,
       render_payload, dedupe_bucket, verdict, actor_user_id, built_from_event_id)
    VALUES
      (v_tenant, p_contact_id, p_owner_user_id, p_occurred_at, p_kind, p_ref_type, p_ref_id,
       p_render_payload, v_bucket, p_verdict, p_actor_user_id, p_event_id)
    -- DO NOTHING, never DO UPDATE. The first refusal is the one that happened;
    -- moving its timestamp forward would make a minute of blocked attempts look
    -- like one attempt at the end of it. The COUNT lives in audit_log, one row
    -- per attempt — which is the governing sentence, expressed as two tables.
    ON CONFLICT (tenant_id, contact_id, verdict, dedupe_bucket)
      WHERE kind = 'send_blocked'
      DO NOTHING
    RETURNING id INTO v_id;

    RETURN v_id;
  END IF;

  INSERT INTO app.timeline_entry
    (tenant_id, contact_id, owner_user_id, occurred_at, kind, ref_type, ref_id,
     render_payload, actor_user_id, built_from_event_id)
  VALUES
    (v_tenant, p_contact_id, p_owner_user_id, p_occurred_at, p_kind, p_ref_type, p_ref_id,
     p_render_payload, p_actor_user_id, p_event_id)
  -- MERGE IN PLACE. `call.enriched` arriving after `call.completed` updates the
  -- call's own entry; it can never add a second one. The payload is merged
  -- rather than replaced so a later, narrower event does not erase what an
  -- earlier one already knew.
  ON CONFLICT (tenant_id, ref_type, ref_id) DO UPDATE
    SET render_payload      = app.timeline_entry.render_payload || EXCLUDED.render_payload,
        occurred_at         = least(app.timeline_entry.occurred_at, EXCLUDED.occurred_at),
        built_from_event_id = EXCLUDED.built_from_event_id,
        built_at            = clock_timestamp()
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$fn$;--> statement-breakpoint

REVOKE ALL ON FUNCTION app.timeline_upsert(uuid, uuid, timestamptz, app.timeline_kind, text,
  uuid, jsonb, uuid, uuid, app.gate_verdict) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.timeline_upsert(uuid, uuid, timestamptz, app.timeline_kind, text,
  uuid, jsonb, uuid, uuid, app.gate_verdict) TO crm_app;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 5 · THE VIEW WITHOUT THE IDENTITY
-- ---------------------------------------------------------------------------
-- `security_invoker = true` is load-bearing rather than tidy: without it the
-- view reads under the OWNER's policy, which is USING (true) — a total bypass
-- of the silo wearing the word "view".
CREATE OR REPLACE VIEW app.timeline_entry_live WITH (security_invoker = true) AS
  SELECT tenant_id, id, contact_id, owner_user_id, occurred_at, kind,
         ref_type, ref_id, render_payload, dedupe_bucket, verdict,
         built_from_event_id, built_at
    FROM app.timeline_entry;--> statement-breakpoint

GRANT SELECT ON app.timeline_entry_live TO crm_app;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 6 · THE READ
-- ---------------------------------------------------------------------------
-- KEYSET, NEVER OFFSET. ARR-UX-13: the timeline is the deepest scroll in the
-- product and `timeline_contact_idx` is built (…, occurred_at DESC, id DESC) so
-- the cursor is an index range scan rather than a count-and-discard.
--
-- 🔴 THE ACTOR NEVER LEAVES AS A NAME. The seller learns "you", "system" or
-- "previous owner" and nothing more — a colleague's identity is exactly what
-- §10.8 exists to withhold, and withholding it in the READ rather than in the
-- component is what makes it true of the API as well as of the screen.
CREATE OR REPLACE FUNCTION app.timeline_read(
  p_contact_id uuid,
  p_before_at  timestamptz DEFAULT NULL,
  p_before_id  uuid DEFAULT NULL,
  p_limit      integer DEFAULT 50
)
RETURNS TABLE (
  id uuid,
  occurred_at timestamptz,
  kind app.timeline_kind,
  ref_type text,
  ref_id uuid,
  render_payload jsonb,
  verdict app.gate_verdict,
  actor_label_key text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = app, ref, pg_catalog
AS $fn$
DECLARE
  v_tenant  uuid;
  v_visible boolean;
BEGIN
  v_tenant := app.current_tenant();
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'TL003: timeline_read called with no tenant context';
  END IF;

  -- OWNERSHIP RE-ASSERTED HERE, because a definer has no RLS. A contact in
  -- another book resolves to nothing and this returns an empty timeline —
  -- indistinguishable from a contact that never existed, which is the
  -- owner-scoped not-found rule reaching the projection.
  SELECT true INTO v_visible
    FROM app.contact c
   WHERE c.tenant_id = v_tenant
     AND c.id = p_contact_id
     AND (c.owner_user_id = app.current_user_id() OR app.scope_is_global());

  IF NOT FOUND THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT te.id, te.occurred_at, te.kind, te.ref_type, te.ref_id,
         te.render_payload, te.verdict,
         CASE
           WHEN te.actor_user_id = app.current_user_id() THEN 'timeline.actor.you'
           WHEN te.actor_user_id IS NULL                 THEN 'timeline.actor.system'
           ELSE 'timeline.actor.previous_owner'
         END::text
    FROM app.timeline_entry te
   WHERE te.tenant_id = v_tenant
     AND te.contact_id = p_contact_id
     -- The keyset. Both halves of the cursor or neither: a cursor with only a
     -- timestamp loses every row that shares its second.
     AND (p_before_at IS NULL
          OR (te.occurred_at, te.id) < (p_before_at, coalesce(p_before_id, te.id)))
   ORDER BY te.occurred_at DESC, te.id DESC
   LIMIT least(greatest(p_limit, 1), 200);
END;
$fn$;--> statement-breakpoint

REVOKE ALL ON FUNCTION app.timeline_read(uuid, timestamptz, uuid, integer) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.timeline_read(uuid, timestamptz, uuid, integer) TO crm_app;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 7 · THE CONSUMER TURNS ON
-- ---------------------------------------------------------------------------
-- ⚠️ THE NAME IS `contacts`, NOT `contacts.timeline`. The architecture calls it
-- the second in seven places; `app.event_consumer` — seeded from
-- `contracts/events/catalog.json` — holds the first, and `event_outbox` carries
-- a foreign key to it. The database name is the one that can receive a row.
--
-- This UPDATE and the handler in `app/modules/events/relay.ts` must land in the
-- SAME commit: `outbox-relay.test.ts` asserts equality in both directions
-- between the registry map and this column, so either half alone is a red build.
UPDATE app.event_consumer
   SET handler_built = true
 WHERE consumer_name = 'contacts';--> statement-breakpoint

SELECT security.harden();
