-- ===========================================================================
-- THE OUTBOX GETS A DELIVERY TIER, AN ACK, A FAILURE LADDER, AND PARTITIONS
-- THAT KEEP BEING CREATED.
--
-- 0043 built the store: `event_log`, `event_outbox`, `app.event_emit()` and
-- `app.outbox_claim()`. What it did not build is everything AFTER the claim —
-- there is no way to say "delivered", no way to say "failed, try again later",
-- and nothing creates tomorrow's partition. This migration closes those three
-- and one more that only became visible when the fan-out was read against
-- ADR-002.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1 · THE DELIVERY TIER, and it is the reason this migration exists at all
-- ---------------------------------------------------------------------------
-- 🔴 A SALE WAS ABOUT TO BE CREDITED TWICE, and nothing in the tree would have
-- said so.
--
-- ADR-002 computes the fan-out as
--   INSERT ... SELECT ... FROM event_consumer
--    WHERE event_name = $1 AND delivery IN ('outbox','pgboss')
-- and the whole weight is on that second predicate: the `inline` tier NEVER
-- receives an outbox row, because an inline consumer already ran inside the
-- emitting transaction.
--
-- `app.event_emit` (0043:359-363) has no such clause, because the column did
-- not exist. So `('earnings','opportunity.won')` gets a fan-out row today —
-- while `app.stage_move` ALREADY appends to the ledger inline
-- (0019_undo_pairs.sql:257 for the sale, :284 for the reversal). The moment a
-- relay grew an `earnings` handler, one sale would have produced two credits:
-- one from the gate and one from the delivery. The ledger is append-only and
-- HAS NO RECOMPUTE JOB by design, so the second credit would be permanent, and
-- the first thing anybody would notice is a public leaderboard reading double.
--
-- The classification below is READ OFF THE TREE, not chosen. `earnings`
-- subscribes to exactly nine events; two of them — `opportunity.won` and
-- `opportunity.reopened` — are the two `app.stage_move` already writes to the
-- ledger itself. Those two pairs are `inline`. Every other pair keeps the
-- delivery it effectively has today.
--
-- ⚠️ THE REMAINING SEVEN `earnings` PAIRS ARE NOT DECIDED HERE. `call.completed`,
-- `contact.merged`, `contact.owner_changed`, `activity.completed`,
-- `appointment.completed`, `opportunity.value_changed`,
-- `pipeline.stage_config_changed` and `user.deactivated` have no inline writer
-- in the tree, so `outbox` is the honest answer for them TODAY. Whether any of
-- them should become inline is a decision about money and belongs to Jorge; it
-- is not one this migration can read off anything.
CREATE TYPE "app"."delivery_tier" AS ENUM('inline', 'outbox', 'pgboss');--> statement-breakpoint

-- The retry policy is a PER-CONSUMER COLUMN (ADR-009), never a global default.
-- A consumer that texts a consumer's phone and a consumer that updates a
-- projection cannot share a retry ladder: retrying the first is a second
-- message to a real person.
ALTER TABLE "app"."event_consumer"
  ADD COLUMN "delivery" "app"."delivery_tier" NOT NULL DEFAULT 'outbox',
  ADD COLUMN "max_attempts" smallint NOT NULL DEFAULT 8,
  ADD COLUMN "backoff_seconds" integer[] NOT NULL DEFAULT '{1,5,25,125,625,3125,3600,3600}',
  ADD COLUMN "external_effect" boolean NOT NULL DEFAULT false;--> statement-breakpoint

ALTER TABLE "app"."event_consumer"
  ADD CONSTRAINT "event_consumer_attempts_positive" CHECK ("max_attempts" >= 1);--> statement-breakpoint

-- An external-effect consumer with a retry ladder is a lead receiving the same
-- text twice. ADR-009 lets it retry only where a provider idempotency key makes
-- the retry safe; with no such key declared anywhere in the tree yet, the
-- constraint is the strict half — and it is a CHECK rather than a convention.
ALTER TABLE "app"."event_consumer"
  ADD CONSTRAINT "event_consumer_external_effect_no_blind_retry"
  CHECK ("external_effect" = false OR "max_attempts" = 1);--> statement-breakpoint

UPDATE app.event_consumer
   SET delivery = 'inline'
 WHERE consumer_name = 'earnings'
   AND event_name IN ('opportunity.won', 'opportunity.reopened');--> statement-breakpoint

-- THE DEFAULT COMES OFF. It existed for the backfill and for nothing else: a
-- consumer row seeded by a later migration must NAME its tier, because the
-- value decides whether a delivery happens twice. A default here would be the
-- "single global retry default" ADR-009 rejects by name, wearing a column.
ALTER TABLE "app"."event_consumer"
  ALTER COLUMN "delivery" DROP DEFAULT,
  ALTER COLUMN "max_attempts" DROP DEFAULT,
  ALTER COLUMN "backoff_seconds" DROP DEFAULT,
  ALTER COLUMN "external_effect" DROP DEFAULT;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2 · THE FAN-OUT LEARNS THE TIER
-- ---------------------------------------------------------------------------
-- Identical to 0043 except for the delivery predicate in the fan-out INSERT.
-- Repeated in full because a function body cannot be patched and a migration is
-- never edited after merge.
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

  -- Idempotent on the NATURAL key, not on the primary key. 0043 states the
  -- reasoning at length and it is unchanged: occurred_at is part of the PK and
  -- defaults to clock_timestamp(), so a second emission of the same event_id
  -- arrives with a different partition key and would insert again.
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

  -- 🔴 THE PREDICATE THIS MIGRATION EXISTS FOR. An `inline` consumer already
  -- ran inside this transaction; giving it an outbox row asks the relay to do
  -- the work a second time.
  INSERT INTO app.event_outbox (tenant_id, created_day, event_id, consumer_name, event_name)
  SELECT v_tenant, p_occurred_at::date, p_event_id, ec.consumer_name, ec.event_name
    FROM app.event_consumer ec
   WHERE ec.event_name = p_event_name
     AND ec.delivery IN ('outbox', 'pgboss')
  ON CONFLICT DO NOTHING;

  RETURN p_event_id;
END;
$fn$;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3 · PARTITIONS THAT KEEP BEING CREATED
-- ---------------------------------------------------------------------------
-- 🔴 THIS HAS A DATE ON IT, AND THE DATE IS 2026-08-25.
--
-- `app.ensure_event_partitions()` ran ONCE, inside migration 0043, and nothing
-- has called it since. It created outbox partitions fourteen days forward, so
-- the last one is `event_outbox_2026_08_24`. There is no DEFAULT partition, on
-- purpose (0043:229-232) — a default would silently absorb rows nobody has a
-- partition for.
--
-- So on 2026-08-25 the outbox INSERT raises 23514. And that INSERT lives inside
-- `app.event_emit`, which lives inside the EMITTING transaction: the whole
-- transaction rolls back. Wired to `app.stage_move`, that reads on a seller's
-- screen as "the card will not move" and in the ledger as a sale that does not
-- exist. Loud, which is the correct direction — but loud in the wrong place.
--
-- 🔴 AND IT COULD NOT HAVE BEEN CALLED ANYWAY. It shipped SECURITY INVOKER, and
-- `crm_app` has no CREATE on schema `app`, so every call from the application
-- would have raised `permission denied for schema app`. A maintenance function
-- the maintainer cannot execute is not a maintenance function.
--
-- 🔴 AND A PARTITION CREATED IN FLIGHT IS BORN WITHOUT RLS. `harden()` hardens
-- each partition individually, resolving the parent through `pg_inherits`
-- (0048:118-128) — but it only does so when something CALLS it. A partition
-- created next month by a job that does not re-harden is a managed relation
-- with FORCE RLS off, which is the exact defect `silo.test.ts` caught once
-- before. So this function ends by hardening, and that is not belt-and-braces:
-- it is the only thing standing between a new month and an unpoliced table.
CREATE OR REPLACE FUNCTION app.ensure_event_partitions(
  p_months integer DEFAULT 3,
  p_days   integer DEFAULT 14
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = app, ref, pg_catalog
AS $fn$
DECLARE
  i     integer;
  m     date;
  d     date;
  made  integer := 0;
BEGIN
  -- DELIBERATELY DOES NOT CALL app.current_tenant(). This operates on the
  -- CLUSTER, not on tenant data: a partition is storage shared by every agency,
  -- and there is no tenant whose session could scope a CREATE TABLE. It is
  -- named in the exemption list of tests/integration/definer-tenancy.test.ts
  -- with that reason written there rather than assumed here.
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

  -- Every partition created above is a managed relation with no policy until
  -- this runs. `crm_app` has no USAGE on schema `security` (0043:210), which is
  -- exactly why this call can only happen inside a definer owned by the
  -- migrator — and why the function had to change owner class to do its job.
  PERFORM security.harden();

  RETURN made;
END;
$fn$;--> statement-breakpoint

REVOKE ALL ON FUNCTION app.ensure_event_partitions(integer, integer) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.ensure_event_partitions(integer, integer) TO crm_app;--> statement-breakpoint

SELECT app.ensure_event_partitions();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4 · THE CLAIM RETURNS THE PARTITION KEY
-- ---------------------------------------------------------------------------
-- `created_day` is part of the primary key, so without it the ACK cannot name
-- the row it is acknowledging and would have to scan every partition to find
-- it. DROP before CREATE because PostgreSQL refuses to change a function's
-- return type in place.
DROP FUNCTION IF EXISTS app.outbox_claim(integer, interval, text);--> statement-breakpoint

CREATE FUNCTION app.outbox_claim(
  p_batch integer DEFAULT 50,
  p_lease interval DEFAULT interval '5 minutes',
  p_worker text DEFAULT NULL
)
RETURNS TABLE (tenant_id uuid, created_day date, event_id uuid,
               consumer_name text, event_name app.event_name)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = app, ref, pg_catalog
AS $fn$
BEGIN
  -- DELIBERATELY DOES NOT CALL app.current_tenant(): a cross-tenant dispatcher
  -- has no tenant to establish yet. Exempted by name, with the reason recorded
  -- in tests/integration/definer-tenancy.test.ts.
  --
  -- STILL NO PAYLOAD. Five columns now instead of four, and the fifth is a
  -- partition key rather than anything about the event. A claim that returned
  -- the body would be a cross-tenant read of every event in the system wearing
  -- the costume of a queue; the relay fetches the body per row, after it has
  -- established the tenant.
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
  RETURNING o.tenant_id, o.created_day, o.event_id, o.consumer_name, o.event_name;
END;
$fn$;--> statement-breakpoint

REVOKE ALL ON FUNCTION app.outbox_claim(integer, interval, text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.outbox_claim(integer, interval, text) TO crm_app;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 5 · READING THE BODY, which the relay cannot do for itself
-- ---------------------------------------------------------------------------
-- 🔴 `event_log` is `append_only_owner`, so its USING clause is
--   tenant_id = current_tenant() AND (owner_user_id = current_user_id()
--                                     OR scope_is_global())
-- and `app.begin_system_work` sets `user_id` to '' and `scope_mode` to
-- 'system' (0003:108-110), while `scope_is_global()` answers true only for
-- 'tenant_read' and 'tenant_admin' (0002:50). A relay running under
-- `withSystemWork` therefore reads ZERO ROWS from `event_log` — not an error,
-- not a denial, just nothing. It would have reported "event not found" for
-- every delivery, forever, and looked like an empty queue.
--
-- This is the same shape as `app.scheduled_job_resolve` (0015:178), which is a
-- definer that scopes by TENANT and not by user for exactly this reason: system
-- work has no user to scope by.
CREATE OR REPLACE FUNCTION app.outbox_payload(p_event_id uuid)
RETURNS TABLE (event_name app.event_name, owner_user_id uuid, subject_type text,
               subject_id uuid, payload jsonb, occurred_at timestamptz,
               correlation_id uuid)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = app, ref, pg_catalog
AS $fn$
DECLARE
  v_tenant uuid;
BEGIN
  v_tenant := app.current_tenant();
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'OB001: outbox_payload called with no tenant context'
      USING HINT = 'The relay establishes the tenant from the claim row before reading a body.';
  END IF;

  RETURN QUERY
  SELECT el.event_name, el.owner_user_id, el.subject_type, el.subject_id,
         el.payload, el.occurred_at, el.correlation_id
    FROM app.event_log el
   WHERE el.tenant_id = v_tenant
     AND el.event_id = p_event_id;
END;
$fn$;--> statement-breakpoint

REVOKE ALL ON FUNCTION app.outbox_payload(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.outbox_payload(uuid) TO crm_app;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 6 · THE ACK
-- ---------------------------------------------------------------------------
-- ADR-001 puts the handler's writes and this mark IN THE SAME TRANSACTION. That
-- is what makes a database-only consumer exactly-once rather than at-least-once:
-- if the handler committed and the ack did not, the lease would expire and the
-- work would run again. The relay therefore calls this from inside the same
-- `withSystemWork` block that ran the handler, and the TypeScript side is
-- written so there is no other way to reach it.
CREATE OR REPLACE FUNCTION app.outbox_ack(
  p_created_day   date,
  p_event_id      uuid,
  p_consumer_name text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = app, ref, pg_catalog
AS $fn$
DECLARE
  v_tenant  uuid;
  v_touched integer;
BEGIN
  v_tenant := app.current_tenant();
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'OB002: outbox_ack called with no tenant context';
  END IF;

  -- `status = 'claimed'` in the predicate, not just the key. A second ack for a
  -- row already delivered returns false instead of rewriting `delivered_at`,
  -- so the timestamp keeps meaning "when this was first delivered".
  UPDATE app.event_outbox o
     SET status       = 'delivered',
         delivered_at = clock_timestamp(),
         last_error   = NULL
   WHERE o.tenant_id     = v_tenant
     AND o.created_day   = p_created_day
     AND o.event_id      = p_event_id
     AND o.consumer_name = p_consumer_name
     AND o.status        = 'claimed';

  GET DIAGNOSTICS v_touched = ROW_COUNT;
  RETURN v_touched = 1;
END;
$fn$;--> statement-breakpoint

REVOKE ALL ON FUNCTION app.outbox_ack(date, uuid, text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.outbox_ack(date, uuid, text) TO crm_app;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 7 · THE FAILURE LADDER
-- ---------------------------------------------------------------------------
-- ⚠️ WITHOUT THIS, `attempts` WAS A COUNTER OF NOISE. The claim already
-- increments it (0043:418) and nothing ever moved `next_attempt_at`, so a
-- consumer that throws would be re-claimed on every pass of the loop — at a one
-- second poll floor that is 3,600 attempts an hour against the same row, each
-- one running the handler again. The ladder is what turns the counter into a
-- backoff, and `dead` is what stops it being infinite.
--
-- The ladder is read from the CONSUMER's own row, never from a constant here:
-- ADR-009 makes retry a per-consumer column precisely so a projection update
-- and a text message to a lead cannot share one.
CREATE OR REPLACE FUNCTION app.outbox_fail(
  p_created_day   date,
  p_event_id      uuid,
  p_consumer_name text,
  p_error         text
)
RETURNS app.outbox_status
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = app, ref, pg_catalog
AS $fn$
DECLARE
  v_tenant   uuid;
  v_row      app.event_outbox%ROWTYPE;
  v_max      smallint;
  v_ladder   integer[];
  v_wait     integer;
  v_status   app.outbox_status;
BEGIN
  v_tenant := app.current_tenant();
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'OB003: outbox_fail called with no tenant context';
  END IF;

  SELECT * INTO v_row FROM app.event_outbox o
   WHERE o.tenant_id     = v_tenant
     AND o.created_day   = p_created_day
     AND o.event_id      = p_event_id
     AND o.consumer_name = p_consumer_name;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT ec.max_attempts, ec.backoff_seconds INTO v_max, v_ladder
    FROM app.event_consumer ec
   WHERE ec.consumer_name = p_consumer_name
     AND ec.event_name    = v_row.event_name;

  IF v_row.attempts >= v_max THEN
    v_status := 'dead';

    UPDATE app.event_outbox o
       SET status = 'dead', last_error = p_error
     WHERE o.tenant_id     = v_tenant
       AND o.created_day   = p_created_day
       AND o.event_id      = p_event_id
       AND o.consumer_name = p_consumer_name;

    -- A dead delivery becomes a DEAD LETTER, because the outbox partition it
    -- lives in is dropped after fourteen days and an exhausted delivery has to
    -- outlive its partition. The subject carries the consumer as well as the
    -- event: two consumers exhausting on one event are two different failures,
    -- and `dead_letter_subject_uidx` would otherwise collapse them into one.
    --
    -- 'outbox_delivery' and not 'outbox': the CHECK on `dead_letter.origin`
    -- (0049:46) enumerates three literals and the documents spell this one
    -- differently from the constraint.
    PERFORM app.dead_letter_record(
      'outbox_delivery',
      'event_outbox',
      p_event_id::text || ':' || p_consumer_name,
      NULL,
      left(coalesce(p_error, 'delivery failed with no message'), 2000));
  ELSE
    v_status := 'pending';

    -- Clamped to the last rung rather than overflowing to NULL: an array index
    -- past the end returns NULL in PostgreSQL, and a NULL interval would set
    -- `next_attempt_at` to NULL, which the claim's `<= clock_timestamp()` reads
    -- as never due. A row that is neither retried nor dead is a delivery that
    -- disappears without ever being counted as lost.
    v_wait := coalesce(v_ladder[least(greatest(v_row.attempts, 1),
                                      coalesce(array_length(v_ladder, 1), 1))], 60);

    UPDATE app.event_outbox o
       SET status          = 'pending',
           claimed_at      = NULL,
           claimed_by      = NULL,
           last_error      = p_error,
           next_attempt_at = clock_timestamp() + make_interval(secs => v_wait)
     WHERE o.tenant_id     = v_tenant
       AND o.created_day   = p_created_day
       AND o.event_id      = p_event_id
       AND o.consumer_name = p_consumer_name;
  END IF;

  RETURN v_status;
END;
$fn$;--> statement-breakpoint

REVOKE ALL ON FUNCTION app.outbox_fail(date, uuid, text, text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.outbox_fail(date, uuid, text, text) TO crm_app;--> statement-breakpoint

SELECT security.harden();
