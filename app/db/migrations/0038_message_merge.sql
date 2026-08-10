CREATE TABLE "app"."message" (
	"tenant_id" uuid NOT NULL,
	"id" uuid DEFAULT uuidv7() NOT NULL,
	"provider_message_id" text NOT NULL,
	"owner_user_id" uuid,
	"contact_id" uuid,
	"direction" text,
	"state" text NOT NULL,
	"body_text" text,
	"failure_reason" text,
	"provider_created_at" timestamp with time zone,
	"provider_last_event_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "message_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "message_direction" CHECK ("app"."message"."direction" IS NULL OR "app"."message"."direction" IN ('inbound', 'outbound')),
	CONSTRAINT "message_state" CHECK ("app"."message"."state" IN ('received', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "app"."message" ADD CONSTRAINT "message_owner_fk" FOREIGN KEY ("tenant_id","owner_user_id") REFERENCES "app"."app_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."message" ADD CONSTRAINT "message_contact_fk" FOREIGN KEY ("tenant_id","contact_id") REFERENCES "app"."contact"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "message_provider_id_uidx" ON "app"."message" USING btree ("tenant_id","provider_message_id");--> statement-breakpoint
CREATE INDEX "message_owner_recent_idx" ON "app"."message" USING btree ("tenant_id","owner_user_id","provider_created_at");
-- ===========================================================================
-- `app.message` and `app.message_merge()` — §4.4's third rung
--
-- 🔴 `provider_message_id` LIVES IN THE SAME ID SPACE AS `aloware_call_id`.
-- §4.4's ladder lists them as separate keys and assumed separate spaces; G2
-- established that Aloware's `body.id` is a COMMUNICATION id, so a call and an
-- SMS are the same kind of object numbered from one sequence. Two tables and
-- two unique indexes still work. What breaks is a reader who assumes an id can
-- only be one of the two.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1 · The merge
-- ---------------------------------------------------------------------------
-- Deliberately simpler than `app.call_merge()`, and the difference is measured
-- rather than stylistic: the capture contains exactly ONE SMS delivery
-- (`OutboundSMS-DispositionInvalid`), so there is no observed second event
-- about one message and therefore no additive/corrective split to make. When a
-- successful send is observed against the real account, this grows a field
-- table like the call merger's — not before.
CREATE OR REPLACE FUNCTION app.message_merge(
  p_provider_message_id text,
  p_state               text,
  p_direction           text        DEFAULT NULL,
  p_aloware_user_id     bigint      DEFAULT NULL,
  p_our_number_e164     text        DEFAULT NULL,
  p_lead_number_e164    text        DEFAULT NULL,
  p_body_text           text        DEFAULT NULL,
  p_failure_reason      text        DEFAULT NULL,
  p_provider_created_at timestamptz DEFAULT NULL,
  p_provider_event_at   timestamptz DEFAULT NULL
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = app, pg_catalog
AS $fn$
DECLARE
  v_tenant  uuid;
  v_owner   uuid;
  v_contact uuid;
BEGIN
  v_tenant := app.current_tenant();
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'MM001: message_merge called with no tenant context';
  END IF;

  IF p_provider_message_id IS NULL OR length(btrim(p_provider_message_id)) = 0 THEN
    RAISE EXCEPTION 'MM002: message_merge needs a provider_message_id — it is the merge key';
  END IF;

  IF p_state NOT IN ('received', 'failed') THEN
    -- `sent` and `delivered` are absent because nothing in the capture reports a
    -- successful send. A state nothing can write is how a screen ends up saying
    -- "Sending…" for ever.
    RAISE EXCEPTION 'MM003: % is not a message state; there are exactly two', p_state;
  END IF;

  -- Same two routes and the same order as the call merger, for the same reason:
  -- the seat is solid where it exists, the number is what saves the rest, and a
  -- Local Presence pool number resolves to nothing rather than to a guess.
  IF p_aloware_user_id IS NOT NULL THEN
    SELECT m.owner_user_id INTO v_owner
      FROM app.aloware_number_mapping m
     WHERE m.tenant_id = v_tenant
       AND m.aloware_user_id = p_aloware_user_id
       AND m.revoked_at IS NULL
       AND m.verified_at IS NOT NULL;
  END IF;

  IF v_owner IS NULL AND p_our_number_e164 IS NOT NULL THEN
    SELECT m.owner_user_id INTO v_owner
      FROM app.aloware_number_mapping m
     WHERE m.tenant_id = v_tenant
       AND m.from_number_e164 = p_our_number_e164
       AND m.revoked_at IS NULL
       AND m.verified_at IS NOT NULL;
  END IF;

  IF v_owner IS NOT NULL AND p_lead_number_e164 IS NOT NULL THEN
    SELECT cp.contact_id INTO v_contact
      FROM app.contact_phone cp
     WHERE cp.tenant_id = v_tenant
       AND cp.owner_user_id = v_owner
       AND cp.phone_e164 = p_lead_number_e164
     ORDER BY cp.is_primary DESC
     LIMIT 1;
  END IF;

  INSERT INTO app.message (
    tenant_id, provider_message_id, owner_user_id, contact_id, direction, state,
    body_text, failure_reason, provider_created_at, provider_last_event_at, updated_at
  ) VALUES (
    v_tenant, p_provider_message_id, v_owner, v_contact, p_direction, p_state,
    p_body_text, p_failure_reason, p_provider_created_at, p_provider_event_at,
    clock_timestamp()
  )
  ON CONFLICT (tenant_id, provider_message_id) DO UPDATE SET
    -- Every field additive, and the ordering property comes free from that: an
    -- absent value never erases a present one and the result does not depend on
    -- which delivery landed first.
    owner_user_id  = COALESCE(EXCLUDED.owner_user_id,  app.message.owner_user_id),
    contact_id     = COALESCE(EXCLUDED.contact_id,     app.message.contact_id),
    direction      = COALESCE(EXCLUDED.direction,      app.message.direction),
    body_text      = COALESCE(EXCLUDED.body_text,      app.message.body_text),
    failure_reason = COALESCE(EXCLUDED.failure_reason, app.message.failure_reason),
    -- `failed` is terminal and `received` cannot undo it: a delivery failure
    -- reported after the fact is the fact that matters for compliance.
    state = CASE WHEN app.message.state = 'failed' THEN 'failed' ELSE EXCLUDED.state END,
    provider_created_at    = LEAST(app.message.provider_created_at, EXCLUDED.provider_created_at),
    provider_last_event_at = GREATEST(app.message.provider_last_event_at,
                                      EXCLUDED.provider_last_event_at),
    updated_at = clock_timestamp()
  RETURNING owner_user_id INTO v_owner;

  IF v_owner IS NULL THEN
    PERFORM app.admin_alert_raise(
      'unmapped_number',
      COALESCE(p_our_number_e164, ''),
      CASE WHEN p_our_number_e164 IS NULL
        THEN 'A text arrived with no number we could match. Nothing was written to a seller''s book.'
        ELSE format('A text arrived on %s, which is not in the number map. Nothing was written to a seller''s book.',
                    p_our_number_e164)
      END);
    RETURN 'unmapped';
  END IF;

  RETURN 'resolved';
END
$fn$;--> statement-breakpoint

REVOKE ALL ON FUNCTION app.message_merge(text, text, text, bigint, text, text, text, text,
  timestamptz, timestamptz) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.message_merge(text, text, text, bigint, text, text, text, text,
  timestamptz, timestamptz) TO crm_app;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2 · Classify
-- ---------------------------------------------------------------------------
-- `owner_scoped_read`, exactly as `app.call`: a seller reads their own texts and
-- writes none of them. Rows arrive through `app.message_merge()` only.
INSERT INTO security.table_registry
  (schema_name, table_name, policy_class, owner_column, immutable, app_can_insert,
   exception_reason, registered_in_migration)
VALUES
  ('app', 'message', 'owner_scoped_read', 'owner_user_id', false, false, NULL,
   '0038_message_merge')
ON CONFLICT (schema_name, table_name) DO UPDATE
  SET policy_class            = EXCLUDED.policy_class,
      owner_column            = EXCLUDED.owner_column,
      immutable               = EXCLUDED.immutable,
      app_can_insert          = EXCLUDED.app_can_insert,
      exception_reason        = EXCLUDED.exception_reason,
      registered_in_migration = EXCLUDED.registered_in_migration;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3 · webhook_ingest, superseding 0035: §4.3 routing instead of calls only
-- ---------------------------------------------------------------------------
-- 0035 stored an SMS delivery and enqueued nothing, because `message-merge`
-- and `app.message` did not exist and handing the CALL merger a row keyed on
-- `provider_message_id` would have been worse than waiting. Both exist now.

-- The queue name is computed from the canonical event and everything below
-- reads it, so the WI004 and WI005 guards now protect both queues rather than
-- naming one of them.
CREATE OR REPLACE FUNCTION app.webhook_ingest(
  p_endpoint_token  text,
  p_body            bytea,
  p_provider_event  text    DEFAULT NULL,
  p_canonical       text    DEFAULT NULL,
  p_aloware_call_id text    DEFAULT NULL,
  p_parse_status    text    DEFAULT 'unparsed',
  p_signature_valid boolean DEFAULT NULL
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = app, ref, pgboss, pg_catalog
AS $fn$
DECLARE
  v_tenant     uuid;
  v_provider   text;
  v_digest     bytea;
  v_key        text;
  v_retention  integer;
  v_payload_id uuid;
  v_event_id   uuid;
  v_policy     text;
  v_queue_name text;
  v_queue      record;
BEGIN
  -- 1 · The credential. A miss returns rather than raises: an unknown token is
  --     a stranger at the door, not a fault, and §4.2 ruling 4 says nothing is
  --     stored for one.
  SELECT e.tenant_id, e.provider
    INTO v_tenant, v_provider
    FROM app.webhook_endpoint e
   WHERE e.token_sha256 = pg_catalog.sha256(pg_catalog.convert_to(p_endpoint_token, 'UTF8'))
     AND e.revoked_at IS NULL;

  IF v_tenant IS NULL THEN
    RETURN 'unknown_token';
  END IF;

  -- 2 · Caller-error checks, and the asymmetry here is the whole ethic of this
  --     function. These RAISE. Nothing derived from PROVIDER data ever does —
  --     Aloware never retries, so a delivery this function refuses is gone for
  --     good, and the vault exists precisely so a mapping bug is a row we can
  --     replay. What may raise is OUR bug: a value only our own edge produces.
  --     Those are deterministic, so they fail every delivery loudly and a test
  --     catches them, instead of losing a fraction of them in silence.
  IF pg_catalog.length(p_body) = 0 THEN
    -- The one provider-shaped input that raises, because it cannot be stored:
    -- `raw_payload_vault_body_present` refuses a zero-byte row, and a delivery
    -- with no bytes has nothing in it to replay later.
    RAISE EXCEPTION 'WI001: webhook_ingest called with an empty body';
  END IF;

  IF p_parse_status NOT IN ('parsed', 'unparsed') THEN
    RAISE EXCEPTION 'WI002: parse_status % is neither parsed nor unparsed', p_parse_status;
  END IF;

  -- Exhaustive, never a pattern — the same reasoning `aloware-ingest.ts` gives
  -- for its event map. A `LIKE 'call.%'` would confidently accept a canonical
  -- name nobody has defined.
  IF p_canonical IS NOT NULL AND p_canonical NOT IN
     ('call.initiated', 'call.completed', 'call.enriched',
      'message.received', 'message.delivery_failed') THEN
    RAISE EXCEPTION 'WI006: % is not one of §4.3''s canonical events', p_canonical;
  END IF;

  v_digest := pg_catalog.sha256(p_body);
  v_key    := pg_catalog.encode(v_digest, 'hex');

  -- 3 · The storm short-circuit.
  --
  -- ⚠️ THIS IS AN OPTIMISATION AND NOT THE GUARANTEE, which §4.4 states as a
  -- rule: "None is an application check-then-insert, because two concurrent
  -- deliveries both pass a check and only a unique index is a constraint under
  -- concurrency." The unique index below is what actually holds. This lookup
  -- exists so a 20 000-webhook replay storm costs one index probe per delivery
  -- instead of an insert and a delete.
  PERFORM 1
     FROM app.inbound_webhook_event w
    WHERE w.tenant_id = v_tenant
      AND w.provider = v_provider
      AND w.provider_event_id = v_key;
  IF FOUND THEN
    RETURN 'duplicate';
  END IF;

  SELECT c.value::integer INTO v_retention
    FROM ref.system_constant c
   WHERE c.key = 'webhook_vault_retention_days';
  IF v_retention IS NULL THEN
    RAISE EXCEPTION 'WI003: ref.system_constant has no webhook_vault_retention_days row';
  END IF;

  -- 4 · The bytes, verbatim.
  --
  -- The digest is computed HERE, once, and feeds both tables — the vault's
  -- `body_sha256` and the event's `provider_event_id`. Handing the edge that
  -- job would create two implementations of one value that
  -- `raw_payload_vault_digest_matches` could only catch on one of them.
  INSERT INTO app.raw_payload_vault (tenant_id, provider, body, body_sha256, purge_after)
  VALUES (v_tenant, v_provider, p_body, v_digest,
          pg_catalog.clock_timestamp() + pg_catalog.make_interval(days => v_retention))
  RETURNING id INTO v_payload_id;

  -- 5 · The transport rung of §4.4's ladder — and G2 promoted this index from
  --     an idempotency convenience to the only replay defence that exists.
  --     Aloware does not sign, so nothing in a request proves freshness and a
  --     captured request replays forever.
  INSERT INTO app.inbound_webhook_event
    (tenant_id, provider, provider_event_id, raw_payload_id, provider_event,
     aloware_call_id, parse_status, signature_valid)
  VALUES (v_tenant, v_provider, v_key, v_payload_id, p_provider_event,
          p_aloware_call_id, p_parse_status, p_signature_valid)
  ON CONFLICT (tenant_id, provider, provider_event_id) DO NOTHING
  RETURNING id INTO v_event_id;

  IF v_event_id IS NULL THEN
    -- The race step 3 cannot cover: another delivery of the same bytes
    -- committed between that lookup and this insert.
    --
    -- Deleting the vault row we just wrote is safe BECAUSE THE KEY IS THE
    -- DIGEST OF THE BODY: a transport duplicate is byte-identical to the row we
    -- are keeping, so nothing is lost. Without this the vault accumulates one
    -- orphan per replayed delivery — PII and recording-bearer-tokens with no
    -- event row pointing at them, which is the opposite of what the retention
    -- clock is for.
    DELETE FROM app.raw_payload_vault
     WHERE tenant_id = v_tenant AND id = v_payload_id;
    RETURN 'duplicate';
  END IF;

  -- 6 · §4.2 ruling 3. Stored and dead-lettered, never rejected.
  --
  -- ⚠️ HALF-IMPLEMENTED, AND SAID RATHER THAN GLOSSED: the `dead_letter` row
  -- §4.6 specifies is not written, because that table does not exist yet. What
  -- IS enforced is the behaviour that matters — the bytes are kept and no job
  -- runs. The branch is unreachable today in any case: G2 established that
  -- Aloware sends no signature, so `signature_valid` is NULL on every real
  -- delivery. It is written now so that the day a signature exists, the
  -- decision is already made.
  IF p_signature_valid IS FALSE THEN
    RETURN 'quarantined';
  END IF;

  -- 7 · The enqueue.
  --
  -- §4.3's routing table, and it is EXHAUSTIVE rather than a prefix match.
  --
  -- 0035 dropped `message.*` on the floor because neither the queue nor the
  -- table existed; both arrive in this migration, so an SMS now reaches its own
  -- merger instead of waiting for a replay. A canonical name with no queue
  -- still enqueues nothing — that is a visible unmapped delivery rather than a
  -- job handed to a consumer that cannot key it.
  --
  -- `LIKE 'call.%'` would be shorter and would route a canonical event nobody
  -- has defined yet to the call merger with confidence.
  v_queue_name := CASE
    WHEN p_canonical IN ('call.initiated', 'call.completed', 'call.enriched')
      THEN 'call-merge'
    WHEN p_canonical IN ('message.received', 'message.delivery_failed')
      THEN 'message-merge'
    ELSE NULL
  END;

  IF v_queue_name IS NOT NULL AND p_aloware_call_id IS NOT NULL THEN

    -- 🔴 THE QUEUE IS READ, NOT ASSUMED, and this is the check that earns its
    -- place. `pgboss.job.name` has a FK to `pgboss.queue(name)` that is
    -- DEFERRABLE INITIALLY DEFERRED — so a missing queue does not fail this
    -- INSERT, it fails the COMMIT, taking the vault write and the dedupe row
    -- with it. The edge would have every reason to believe it had stored the
    -- delivery. Aloware never retries. One missing row would discard traffic
    -- silently and permanently, so it is named here instead.
    SELECT q.policy, q.retry_limit, q.retry_delay, q.retry_backoff,
           q.expire_seconds, q.retention_seconds, q.deletion_seconds, q.dead_letter
      INTO v_queue
      FROM pgboss.queue q
     WHERE q.name = v_queue_name;

    -- `NOT FOUND` rather than `v_queue IS NULL`: a composite IS NULL is only
    -- true when EVERY field is null, so that form would depend on the queue
    -- never having an all-null row rather than on the lookup having missed.
    IF NOT FOUND THEN
      RAISE EXCEPTION 'WI004: pg-boss queue "%" does not exist', v_queue_name
        USING HINT = 'Run npm run db:migrate && npm run db:jobs. The FK is deferred, so without this check the failure would surface at COMMIT with the vault write already discarded.';
    END IF;

    v_policy := v_queue.policy;

    -- 🔴 AND THE POLICY IS ASSERTED, because getting it wrong is silent.
    -- `policy` is a column on every JOB ROW, and pg-boss's partial unique
    -- indexes read it from the row rather than from the queue:
    --
    --   job_common_i8  UNIQUE (name, singleton_key)
    --                  WHERE state IN (active, retry, failed)
    --                    AND policy = 'key_strict_fifo'
    --
    -- A job inserted with a NULL or mismatched policy satisfies no index at
    -- all. Everything still runs; the serialisation §4.5 asks for just quietly
    -- is not there, and two webhooks about one call race each other into the
    -- merge. `key_strict_fifo` rather than `exclusive` because exclusive
    -- REFUSES the second job while the first is active — and G2 measured
    -- `Call-Disposed` arriving 6.6 s after the disposition it restates.
    IF v_policy <> 'key_strict_fifo' THEN
      RAISE EXCEPTION 'WI005: queue "%" has policy %, expected key_strict_fifo',
        v_queue_name, v_policy;
    END IF;

    -- The queue's own settings are copied onto the row, which is what
    -- pg-boss's `send()` does in JavaScript. Leaving the column defaults would
    -- give this queue the table's defaults instead of its own.
    INSERT INTO pgboss.job
      (name, data, policy, singleton_key,
       retry_limit, retry_delay, retry_backoff,
       expire_seconds, deletion_seconds, keep_until, dead_letter)
    VALUES (
      v_queue_name,
      pg_catalog.jsonb_build_object(
        'tenantId',              v_tenant,
        'inboundWebhookEventId', v_event_id,
        'alowareCallId',         p_aloware_call_id,
        'canonical',             p_canonical
      ),
      v_policy,
      -- §4.5's singleton key. `key_strict_fifo` CHECKs that this is NOT NULL,
      -- which is why the branch above requires a call id to get here.
      p_aloware_call_id,
      v_queue.retry_limit, v_queue.retry_delay, v_queue.retry_backoff,
      v_queue.expire_seconds, v_queue.deletion_seconds,
      pg_catalog.clock_timestamp() + pg_catalog.make_interval(secs => v_queue.retention_seconds),
      v_queue.dead_letter
    );
  END IF;

  RETURN 'accepted';
END
$fn$;--> statement-breakpoint

SELECT security.harden();
