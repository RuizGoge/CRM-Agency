-- ===========================================================================
-- "DECLARED BUT NOT BUILT" BECOMES A COLUMN, because today it is the truth
-- about seventeen of the nineteen consumers and nothing anywhere says so.
--
-- `docs/05-architecture.md`:826 rules that "a registry row with no exported
-- handler fails the build; there is no such thing as a declared-but-
-- unimplemented consumer". Applied literally against this tree it would redden
-- the build in seventeen places at once, because `app.event_consumer` declares
-- nineteen consumers and `app/modules/` contains three directories.
--
-- So the rule is kept and the timing is made honest: the gap is NAMED rather
-- than either ignored or turned into a build nobody can green. A consumer with
-- no handler gets NO FAN-OUT ROW, which is the only truthful answer — an outbox
-- row means "this consumer still owes this event", and a consumer that does not
-- exist owes nothing.
--
-- WHY NOT JUST FAIL THE DELIVERY. The relay could claim these rows and call
-- `app.outbox_fail`, and the ladder would dead-letter them after eight
-- attempts. That is defensible and it is wrong here: every single emitted event
-- would produce seven dead letters and seven admin alerts, so the surface built
-- to show an operator what broke would fill with rows saying "a module that was
-- never built was not called". Signal becomes noise, and the first thing lost
-- is the alert that matters.
--
-- WHY A COLUMN AND NOT A LIST IN THE RELAY. A TypeScript list is documentation:
-- `CLAUDE.md` is explicit that a rule enforced by "remember to" is not a rule.
-- As a column it is a fact the engine holds, the fan-out reads it, and
-- `tests/integration/outbox-relay.test.ts` asserts in BOTH directions that the
-- column and the relay's handler registry agree. Shipping a handler without
-- flipping the column — or flipping the column without shipping a handler — is
-- a red build rather than a delivery that silently never happens.
-- ===========================================================================

ALTER TABLE "app"."event_consumer"
  ADD COLUMN "handler_built" boolean NOT NULL DEFAULT false;--> statement-breakpoint

-- `audit` is the first, and it is first because it is the one consumer whose
-- destination this migration's sibling actually builds: every privileged write
-- lands in `app.audit_log`. It also subscribes to more events than any other
-- consumer (49 of the 49), which makes it the widest possible exercise of the
-- relay on day one rather than a happy path.
UPDATE app.event_consumer
   SET handler_built = true
 WHERE consumer_name = 'audit';--> statement-breakpoint

-- Same reasoning as 0051's tier: the default existed for the backfill. A
-- consumer seeded later must state whether its handler exists, because the
-- value decides whether the event is delivered or dropped on the floor.
ALTER TABLE "app"."event_consumer"
  ALTER COLUMN "handler_built" DROP DEFAULT;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- THE FAN-OUT LEARNS THE SECOND HALF
-- ---------------------------------------------------------------------------
-- Identical to 0051 except for `AND ec.handler_built`. Repeated in full because
-- a function body cannot be patched and a migration is never edited after
-- merge.
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
  ON CONFLICT (tenant_id, occurred_at, event_id) DO NOTHING
  RETURNING event_id INTO v_inserted;

  IF v_inserted IS NULL THEN
    RETURN p_event_id;
  END IF;

  -- 🔴 THE EVENT IS STILL WRITTEN IN FULL. Only the DELIVERY is withheld, and
  -- the distinction is the whole reason the store and the queue are two tables:
  -- `event_log` is the system of record for replay, so a consumer built next
  -- month can be backfilled from it. Nothing is lost by not fanning out to a
  -- module that does not exist — the history is complete either way.
  INSERT INTO app.event_outbox (tenant_id, created_day, event_id, consumer_name, event_name)
  SELECT v_tenant, p_occurred_at::date, p_event_id, ec.consumer_name, ec.event_name
    FROM app.event_consumer ec
   WHERE ec.event_name = p_event_name
     AND ec.delivery IN ('outbox', 'pgboss')
     AND ec.handler_built
  ON CONFLICT DO NOTHING;

  RETURN p_event_id;
END;
$fn$;--> statement-breakpoint

SELECT security.harden();
