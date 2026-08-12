-- ===========================================================================
-- THE TIMELINE STOPS TAKING ANSWERS AND STARTS TAKING SUBJECTS
--
-- 0061's honesty list, item 2 (0061:81-92): "`app.timeline_upsert` IS STILL
-- GRANTED (0059:268) … p_owner_user_id, p_actor_user_id and p_event_id are all
-- parameters; the body checks only that a tenant exists and has NO ownership
-- predicate … ⚠️ AFTER THIS MIGRATION THE TIMELINE IS MORE FORGEABLE THAN THE
-- EVENT LOG."
--
-- 🔴 WHY THERE IS NO OWNERSHIP PREDICATE HERE. The only production caller is the
-- relay, under withSystemWork, where app.current_user_id() is NULL and
-- app.scope_is_global() is false (0003:108-110, 0002:30-33, 0002:48-58). A
-- predicate `p_owner_user_id = app.current_user_id() OR app.scope_is_global()`
-- would refuse 100% of production projections AND PASS EVERY TEST IN THE TREE,
-- because all five direct-drive call sites run under withTenant with a real
-- seller. 0058:10-23 documents that exact trap for compliance_check.
--
-- ⚠️ AND A SCOPE CHECK IS NOT AVAILABLE. `current_setting('app.scope_mode') =
-- 'system'` was tested against the running database as crm_app: `set_config(…)`
-- and a bare `SET LOCAL app.scope_mode = 'system'` each produce 'system' from
-- inside a seller's own request. `app.begin_system_work` does NOT — it raises
-- CTX001 when context is already set — but two paths are two too many.
-- app.scope_is_global() survives forgery only because it re-verifies the role
-- with an EXISTS; 'system' has no user to verify. A gate on that string is a
-- gate the caller sets. What survives is what 0060/0061 used: an absent grant.
--
-- 🔴 WHAT THIS CLOSES AND WHAT IT DOES NOT — stated here, not in a footnote,
-- because the honest sentence is one notch narrower than the obvious one.
-- CLOSED: FABRICATION. After this, no caller can invent a contact, an owner, an
--   actor, an instant, a kind, a ref, a payload or a provenance. Every field is
--   read off app.event_log inside the definer.
-- NOT CLOSED BY THE REVOKE ALONE: CAUSING A PROJECTION. `app.outbox_claim` is
--   granted to crm_app and is EXEMPT from definer-tenancy.test.ts precisely
--   because it has no tenant predicate, so `claimOutbox()` hands a seller-scope
--   transaction every undelivered event id IN EVERY TENANT. Naming a colleague's
--   event is one granted call away, not a uuidv7 guess.
-- WHICH IS WHY §2 EXISTS. `built_from_occurred_at` plus an order-independent
--   merge make every reachable effect of this door IDEMPOTENT and CONVERGENT:
--   the row a hostile caller can produce is byte-identical to the row the relay
--   produces, in any order, any number of times. That is also the property 05b
--   has always required of a derived projection ("fully rebuildable from
--   event_log by the replay job") and never actually had.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1 · THE MAP MOVES INTO THE DATABASE, AND A FOREIGN KEY CHECKS IT
-- ---------------------------------------------------------------------------
-- `PROJECTED` lived in relay.ts:159-176. It cannot stay there: the definer has
-- to know it, and the precedent is already in that file — relay.ts:242-244 moved
-- the verdict inversion into app.gate_verdict_of because "a second map in
-- TypeScript is exactly the drift this project keeps paying for".
--
-- 🔴 THE FOREIGN KEY IS THE POINT, NOT THE TABLE. app.event_consumer is one row
-- per (consumer, event) subscription and event_emit only fans out to rows that
-- exist there, so a projection rule for an event `contacts` does not receive is
-- dead configuration — and with this FK it is unwritable rather than wrong.
--
-- ⚠️ IT CAUGHT ONE. `['consent.updated', {kind:'consent', ref:'subject'}]`
-- (relay.ts:174) has no ('contacts','consent.updated') row — verified against the
-- live catalog, where `contacts` subscribes to 23 events and that is not one of
-- them; catalog.json makes contacts the EMITTER. The `consent` timeline kind has
-- been unreachable since 0059 and nothing said so. Its row is deliberately
-- ABSENT rather than the subscription being added: adding a consumer is a change
-- to the event catalog and belongs to whoever owns that decision.
CREATE TABLE "ref"."timeline_projection" (
  "consumer_name" text NOT NULL DEFAULT 'contacts'
    CONSTRAINT "timeline_projection_is_contacts" CHECK ("consumer_name" = 'contacts'),
  "event_name" "app"."event_name" PRIMARY KEY,
  "kind"       "app"."timeline_kind" NOT NULL,
  "ref_mode"   text NOT NULL
    CONSTRAINT "timeline_projection_ref_mode"
      CHECK ("ref_mode" IN ('correlation', 'subject', 'event')),
  CONSTRAINT "timeline_projection_subscribed_fk"
    FOREIGN KEY ("consumer_name", "event_name")
    REFERENCES "app"."event_consumer" ("consumer_name", "event_name")
);--> statement-breakpoint

INSERT INTO security.table_registry
  (schema_name, table_name, policy_class, owner_column, immutable, app_can_insert,
   protected_columns, exception_reason, registered_in_migration)
VALUES
  ('ref', 'timeline_projection', 'reference', NULL, false, false, NULL,
   'Tenant-independent projector configuration: which of the 49 events become a timeline entry, of which kind, refed on what. No tenant column because every tenant projects identically. `reference` generates USING (true) WITH CHECK (false) — crm_app reads it, only the migrator writes it.',
   '0064_timeline_projector')
ON CONFLICT (schema_name, table_name) DO UPDATE
  SET policy_class = EXCLUDED.policy_class,
      immutable = EXCLUDED.immutable,
      app_can_insert = EXCLUDED.app_can_insert,
      exception_reason = EXCLUDED.exception_reason,
      registered_in_migration = EXCLUDED.registered_in_migration;--> statement-breakpoint

INSERT INTO ref.timeline_projection (event_name, kind, ref_mode) VALUES
  -- ⚠️ `opportunity.stage_changed` AND `opportunity.won` SHARE A REF ON PURPOSE
  -- and the ref is the CORRELATION (0054 gives both the same one), so the seller
  -- reads one line carrying the premium rather than two a millisecond apart.
  ('opportunity.stage_changed', 'stage_move',   'correlation'),
  ('opportunity.won',           'stage_move',   'correlation'),
  ('opportunity.created',       'lead_created', 'subject'),
  ('lead.created',              'lead_created', 'subject'),
  ('lead.reposted',             'repost',       'subject'),
  ('call.completed',            'call',         'subject'),
  ('call.enriched',             'call',         'subject'),
  ('message.received',          'message',      'subject'),
  ('message.sent',              'message',      'subject'),
  ('appointment.scheduled',     'meeting',      'subject'),
  ('appointment.completed',     'meeting',      'subject'),
  ('appointment.no_showed',     'meeting',      'subject'),
  ('activity.completed',        'note',         'subject'),
  -- `compliance.send_blocked` refs on the EVENT: `subject` would write
  -- ('contact', contactId) and collide with that contact's own lead_created row
  -- on timeline_ref_uidx. relay.ts:149-157, compliance-emit.test.ts:459.
  ('compliance.send_blocked',   'send_blocked', 'event');--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2 · PROVENANCE GETS AN INSTANT, AND THE MERGE STOPS DEPENDING ON ORDER
-- ---------------------------------------------------------------------------
-- 🔴 THIS COLUMN IS WHAT MAKES §3'S DOOR SAFE TO GRANT. Without it,
-- re-projecting an OLDER event over a merged entry re-applies the older event's
-- keys and rewrites built_from_event_id. Both values are true and the earlier one
-- wins — which means the projection's content depends on the ORDER of delivery,
-- and a caller who can choose the order can choose the content. On a colleague's
-- row, reached through claimOutbox().
--
-- With it, the merge is a function of the SET of events and not of their order:
-- the newest event's keys always win, an older one contributes only keys nobody
-- has, and occurred_at was already order-free via least(). Replaying the whole
-- log in any order converges on one answer — which is what 05b's replay job has
-- always been promised and never had.
--
-- BACKFILL IS `occurred_at`, and it is exact rather than approximate for every
-- existing row: occurred_at = least(over all merged events) <= every contributing
-- event's instant, so an incoming event still wins, which is today's behaviour.
-- The product has not shipped; there is no production data behind this.
ALTER TABLE "app"."timeline_entry"
  ADD COLUMN "built_from_occurred_at" timestamptz;--> statement-breakpoint
UPDATE app.timeline_entry
   SET built_from_occurred_at = occurred_at
 WHERE built_from_occurred_at IS NULL;--> statement-breakpoint
ALTER TABLE "app"."timeline_entry"
  ALTER COLUMN "built_from_occurred_at" SET NOT NULL;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3 · THE WRITER: A NEW SIGNATURE, A CONTACT GUARD, AN ORDER-FREE MERGE
-- ---------------------------------------------------------------------------
-- 🔴 DROP AND CREATE, NOT CREATE OR REPLACE. A different parameter list makes a
-- SECOND OVERLOAD, not a replacement — and a second overload with the old ACL is
-- the door still standing open next to the one being closed. Dropping also means
-- the new function starts at PostgreSQL's default (EXECUTE TO PUBLIC), which is
-- why §5's REVOKE FROM PUBLIC is doing real work rather than being ceremonial.
--
-- `p_built_from_occurred_at` is REQUIRED and sits before the defaulted
-- parameters, so every existing 10-argument call site fails to resolve. That is
-- deliberate: the five fixtures that manufacture history have to say which
-- instant their row's provenance is, and a defaulted NULL that silently
-- coalesced would be the merge comparison quietly not working.
DROP FUNCTION app.timeline_upsert(uuid, uuid, timestamptz, app.timeline_kind, text,
  uuid, jsonb, uuid, uuid, app.gate_verdict);--> statement-breakpoint

CREATE FUNCTION app.timeline_upsert(
  p_contact_id             uuid,
  p_owner_user_id          uuid,
  p_occurred_at            timestamptz,
  p_kind                   app.timeline_kind,
  p_ref_type               text,
  p_ref_id                 uuid,
  p_render_payload         jsonb,
  p_event_id               uuid,
  p_built_from_occurred_at timestamptz,
  p_actor_user_id          uuid DEFAULT NULL,
  p_verdict                app.gate_verdict DEFAULT NULL
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

    -- TRUNCATED to the window rather than rounded, same as audit_write.
    v_bucket := to_timestamp(floor(extract(epoch FROM p_occurred_at) / 60) * 60);

    INSERT INTO app.timeline_entry
      (tenant_id, contact_id, owner_user_id, occurred_at, kind, ref_type, ref_id,
       render_payload, dedupe_bucket, verdict, actor_user_id, built_from_event_id,
       built_from_occurred_at)
    VALUES
      (v_tenant, p_contact_id, p_owner_user_id, p_occurred_at, p_kind, p_ref_type, p_ref_id,
       p_render_payload, v_bucket, p_verdict, p_actor_user_id, p_event_id,
       p_built_from_occurred_at)
    -- DO NOTHING, never DO UPDATE. The first refusal is the one that happened;
    -- moving its timestamp forward would make a minute of blocked attempts look
    -- like one attempt at the end of it. The COUNT lives in audit_log.
    ON CONFLICT (tenant_id, contact_id, verdict, dedupe_bucket)
      WHERE kind = 'send_blocked'
      DO NOTHING
    RETURNING id INTO v_id;

    -- NULL is a real answer on this branch: the window absorbed the row.
    RETURN v_id;
  END IF;

  INSERT INTO app.timeline_entry
    (tenant_id, contact_id, owner_user_id, occurred_at, kind, ref_type, ref_id,
     render_payload, actor_user_id, built_from_event_id, built_from_occurred_at)
  VALUES
    (v_tenant, p_contact_id, p_owner_user_id, p_occurred_at, p_kind, p_ref_type, p_ref_id,
     p_render_payload, p_actor_user_id, p_event_id, p_built_from_occurred_at)
  ON CONFLICT (tenant_id, ref_type, ref_id) DO UPDATE
    -- 🔴 THE NEWEST EVENT WINS, AND "NEWEST" IS A TOTAL ORDER. The row
    -- comparison breaks a tie on event_id so two events sharing an instant still
    -- converge on one answer; without the tie-break, a replay could produce two
    -- different rows from the same event set.
    SET render_payload = CASE
          WHEN (EXCLUDED.built_from_occurred_at, EXCLUDED.built_from_event_id)
             > (app.timeline_entry.built_from_occurred_at,
                app.timeline_entry.built_from_event_id)
          THEN app.timeline_entry.render_payload || EXCLUDED.render_payload
          -- An OLDER event contributes only keys nobody has. `call.completed`
          -- arriving after `call.enriched` still fills in what only it knows,
          -- and cannot revert what the later event already said.
          ELSE EXCLUDED.render_payload || app.timeline_entry.render_payload
        END,
        occurred_at = least(app.timeline_entry.occurred_at, EXCLUDED.occurred_at),
        actor_user_id = CASE
          WHEN (EXCLUDED.built_from_occurred_at, EXCLUDED.built_from_event_id)
             > (app.timeline_entry.built_from_occurred_at,
                app.timeline_entry.built_from_event_id)
          THEN EXCLUDED.actor_user_id ELSE app.timeline_entry.actor_user_id END,
        built_from_event_id = CASE
          WHEN (EXCLUDED.built_from_occurred_at, EXCLUDED.built_from_event_id)
             > (app.timeline_entry.built_from_occurred_at,
                app.timeline_entry.built_from_event_id)
          THEN EXCLUDED.built_from_event_id ELSE app.timeline_entry.built_from_event_id END,
        built_from_occurred_at = greatest(app.timeline_entry.built_from_occurred_at,
                                          EXCLUDED.built_from_occurred_at),
        built_at = clock_timestamp()
    -- 🔴 THE CONTACT GUARD. timeline_ref_uidx is UNIQUE (tenant_id, ref_type,
    -- ref_id) — contact_id is NOT in it — so without this the merge finds
    -- whatever row holds that pair, ON ANY CONTACT, and rewrites it in place.
    -- Deriving the contact in §4 does not close this: the merge TARGET is still
    -- found by ref alone.
    WHERE app.timeline_entry.contact_id = EXCLUDED.contact_id
  RETURNING id INTO v_id;

  -- The filtered DO UPDATE touches no row and RETURNING yields nothing. It is
  -- the only way to reach here with a NULL on this branch, so the test is exact.
  -- LOUD rather than silent: a silent no-op would be a projection that reports
  -- success and wrote nothing.
  IF v_id IS NULL THEN
    RAISE EXCEPTION
      'TL005: ref (%, %) already names a timeline entry on a different contact',
      p_ref_type, p_ref_id
      USING HINT = 'The merge target is found by ref alone; rewriting it would edit another seller''s book.';
  END IF;

  RETURN v_id;
END;
$fn$;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4 · THE ONLY DOOR
-- ---------------------------------------------------------------------------
-- ⚠️ IT TAKES ONE ARGUMENT AND THAT IS THE SECURITY ARGUMENT. No owner, no
-- actor, no contact, no payload, no kind, no ref, no instant — nothing for a
-- caller to lie about. Combined with §2's order-free merge, the worst a hostile
-- caller achieves is causing a TRUE event to be projected into exactly the row
-- the relay would have produced. That is a replay, which 05b mandates as the
-- repair procedure.
--
-- 🔴 IT ALSO CLOSES `built_from_event_id` WITHOUT A FOREIGN KEY. 0059:115-126
-- refuses the FK because a composite FK into a partitioned parent turns the
-- thirteen-month DETACH into an error. A lookup inside the definer costs the
-- same guarantee in the write direction and constrains DETACH not at all.
CREATE OR REPLACE FUNCTION app.timeline_project(p_event_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = app, ref, pg_catalog
AS $fn$
DECLARE
  v_tenant   uuid;
  v_ev       record;
  v_map      record;
  v_contact  uuid;
  v_ref_type text;
  v_ref_id   uuid;
  v_verdict  app.gate_verdict := NULL;
BEGIN
  v_tenant := app.current_tenant();
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'TL006: timeline_project called with no tenant context'
      USING HINT = 'The relay opens withSystemWork(tenant) per delivery.';
  END IF;

  SELECT el.event_name, el.owner_user_id, el.actor_user_id, el.subject_type,
         el.subject_id, el.payload, el.occurred_at, el.correlation_id
    INTO v_ev
    FROM app.event_log el
   WHERE el.tenant_id = v_tenant AND el.event_id = p_event_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'TL004: no event % in tenant %, so nothing can claim it as provenance',
      p_event_id, v_tenant
      USING HINT = 'built_from_event_id has no FK by design (0059:115-126); this replaces it.';
  END IF;

  SELECT tp.kind, tp.ref_mode INTO v_map
    FROM ref.timeline_projection tp
   WHERE tp.event_name = v_ev.event_name;

  -- Not projected. The `audit` consumer subscribes to all 49 and most have no
  -- place on a seller's history. Silent, exactly as relay.ts:206 was.
  IF NOT FOUND THEN RETURN NULL; END IF;

  -- ⚠️ jsonb_typeof, NOT nullif(… ->> …, ''). `->>` on a JSON NUMBER returns a
  -- string, so a payload carrying `"contact_id": 12345` would cast-fail and
  -- dead-letter where relay.ts's `typeof contactId !== 'string'` silently
  -- returned. Same shape as the TypeScript it replaces, deliberately.
  --
  -- 🔴 AND THE `coalesce` IS NOT DEFENSIVE — WITHOUT IT THE GUARD NEVER FIRES.
  -- When the key is ABSENT, `payload -> 'contact_id'` is SQL NULL and
  -- `jsonb_typeof(NULL)` is NULL, so `NULL <> 'string'` evaluates to NULL and
  -- plpgsql treats a NULL condition as false. The row falls straight through to
  -- the INSERT and dies on `null value in column "contact_id"` — measured, as a
  -- stuck delivery in outbox-relay.test.ts, where the payload is a bare premium
  -- with no contact at all.
  IF coalesce(jsonb_typeof(v_ev.payload -> 'contact_id'), 'absent') <> 'string' THEN
    RETURN NULL;
  END IF;
  v_contact := (v_ev.payload ->> 'contact_id')::uuid;

  v_ref_type := CASE v_map.ref_mode
                  WHEN 'correlation' THEN 'stage_move'
                  WHEN 'event'       THEN 'compliance_block'
                  ELSE v_ev.subject_type END;

  v_ref_id := CASE v_map.ref_mode
                WHEN 'correlation' THEN v_ev.correlation_id
                WHEN 'event'       THEN p_event_id
                ELSE v_ev.subject_id END;

  -- The event carries the CATALOG's vocabulary and the column takes the
  -- DATABASE's enum. gate_verdict_of raises CG011 on anything it cannot invert,
  -- including a missing key — louder and more specific than the TypeScript throw
  -- at relay.ts:250 that it replaces.
  IF v_map.kind = 'send_blocked' THEN
    v_verdict := app.gate_verdict_of(v_ev.payload ->> 'verdict');
  END IF;

  RETURN app.timeline_upsert(
    v_contact,
    -- OWNER AND ACTOR ARE READ, NEVER PASSED IN. app.audit_write refuses the
    -- actor as a parameter outright (0053:234-242); it can, because it runs
    -- synchronously in the actor's own transaction. This runs after the fact,
    -- replaying an event whose actor is a property of the EVENT — an admin
    -- reassigning a lead, a scheduler firing a reminder. The actor still
    -- travels, off the event row instead of off the wire.
    v_ev.owner_user_id,
    -- Full microsecond precision, not round-tripped through a formatted string,
    -- which is where the cursor-truncation defect lived once already.
    v_ev.occurred_at,
    v_map.kind,
    v_ref_type,
    v_ref_id,
    -- Identity never travels in the payload. timeline_no_actor_in_payload
    -- refuses it too; stripping here means the refusal is never reached.
    v_ev.payload - ARRAY['actor_name', 'actor_display_name', 'actor_initials',
                         'actor_avatar_url', 'actor_user_id'],
    p_event_id,
    -- THE PROVENANCE INSTANT. This is what makes the merge order-free.
    v_ev.occurred_at,
    v_ev.actor_user_id,
    v_verdict);
END;
$fn$;--> statement-breakpoint

REVOKE ALL ON FUNCTION app.timeline_project(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.timeline_project(uuid) TO crm_app;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 5 · AND THE OLD DOOR CLOSES
-- ---------------------------------------------------------------------------
-- §3 DROPPED and re-CREATEd this function, so its ACL is PostgreSQL's default —
-- EXECUTE TO PUBLIC, WIDER than 0059 left it. This is not ceremonial.
-- `app.timeline_upsert` ends at proacl {crm_migrator=X/crm_migrator}: reachable
-- by no role, reached by app.timeline_project as the function owner, which is
-- app.compliance_check's shape exactly (0060). A definer's nested calls are
-- checked against the OWNER, never the caller (0061:22-24).
--
-- `security.harden()` cannot undo it: its body issues table GRANTs, policies,
-- triggers and schema USAGE, and contains no ON FUNCTION and no ALTER DEFAULT
-- PRIVILEGES.
REVOKE ALL ON FUNCTION app.timeline_upsert(uuid, uuid, timestamptz, app.timeline_kind, text,
  uuid, jsonb, uuid, timestamptz, uuid, app.gate_verdict) FROM PUBLIC;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- WHAT THIS DOES NOT CLOSE
-- ---------------------------------------------------------------------------
-- 1. `app.outbox_payload` (0051) IS A DEFINER WITH NO OWNERSHIP PREDICATE AND IS
--    GRANTED TO crm_app. A seller reads 0 rows from app.event_log for a
--    colleague's opportunity.won and then reads its full body through
--    outbox_payload — owner id, actor id, annualised premium. A cross-silo READ,
--    unrelated to the timeline, larger than this migration. The id it needs is
--    one granted claimOutbox() call away, not out of band.
-- 2. `app.timeline_project` IS GRANTED TO crm_app, so a route can still make it
--    RUN. What makes that harmless is a property of THIS BODY plus §2's merge:
--    one parameter, every field derived, every effect convergent. A future
--    migration adding an OPTIONAL second parameter keeps the 1-arg signature
--    resolvable and re-opens it — which is why BOOT017 asserts exactly one
--    overload with pronargs = 1 rather than asserting the signature resolves.
-- 3. THE REPLAY JOB 05b MANDATES STILL DOES NOT EXIST, and it cannot be a loop
--    over `SELECT event_id FROM app.event_log` in TypeScript: crm_app reads zero
--    rows there under system scope. It needs its own definer.
-- 4. THE `consent` TIMELINE KIND STAYS UNREACHABLE. The FK proved `contacts`
--    does not consume consent.updated; this records that by omission rather than
--    fixing it. app.timeline_kind still carries the label and
--    KIND_SUMMARY_KEY in app/routes/api/timeline.ts:50 still maps it to a
--    sentence no seller can reach.
-- 5. `contact.merged` IS SUBSCRIBED AND UNIMPLEMENTED. When it lands, a
--    call.enriched arriving after a merge carries the winner's contact_id
--    against an entry on the loser and hits TL005 → eight retries → dead letter.
--    Today it silently corrupts instead, so TL005 is the better failure — but a
--    future merge path owes TL005 a re-home step.
-- 6. THE EVENT LOOKUP FANS OUT one index probe per partition (four today,
--    thirteen at the retention horizon), and `body()` already does the identical
--    scan via outbox_payload — the contacts path now pays for two. Not a
--    budgeted surface; named so it is not a surprise.
--
-- RE-ASSERTION AT BOOT is app/db/boot-assert.ts
-- (`assertTimelineWriterIsDefinerOnly`, BOOT015/016/017).

SELECT security.harden();
