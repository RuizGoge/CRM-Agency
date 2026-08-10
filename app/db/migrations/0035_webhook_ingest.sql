-- ===========================================================================
-- `app.webhook_ingest()` — the one door into the two ingest tables
--
-- §4.2 ruling 1: the vault write, the transport-dedupe insert and the job
-- enqueue happen **in one call inside one transaction**. Three statements are
-- three network round trips against the one resource both topologies share,
-- and at 333/s that is the single largest lever on storm capacity. Migration
-- 0034 deliberately left `raw_payload_vault` and `inbound_webhook_event` with
-- no INSERT for `crm_app` so that this function would be the only way in —
-- granting INSERT before it existed is how the shortcut becomes the design.
--
-- 🔴 IT TAKES A CREDENTIAL, NEVER A TENANT ID, and that is the load-bearing
-- decision in this file. The obvious signature is `webhook_ingest(p_tenant_id
-- uuid, …)`, and it is wrong twice over. It would make a fifth cross-tenant
-- path out of a corpus that says "the FOUR enumerated cross-tenant paths" in
-- three migrations and in §0.3, and — worse — it would let the caller NAME the
-- tenant it writes into. This is P3.1's property applied to the edge: the
-- caller says who it is, the engine decides what that means. There is no
-- parameter for the answer.
--
-- ⚠️ `app.current_tenant()` IS NULL FOR THIS ENTIRE FUNCTION, on purpose and
-- uniquely. A webhook arrives with no session, no cookie and no user; there is
-- nothing to have set a context. Migration 0009 carries a comment claiming a CI
-- query over `pg_proc.prosrc` asserts every definer body contains
-- `app.current_tenant()`. **Measured: that query does not exist**, and four of
-- the thirteen existing definers would already fail it (`begin_request`,
-- `begin_system_work`, `resolve_identity`, `scheduled_job_claim`) — every one
-- of them legitimately, for the same reason as this one. Building that gate is
-- a decision with a five-row exception list attached, and it is not this
-- migration's to take. What replaces it here is stronger for this case: the
-- tenant is not read from a forgeable GUC at all, it is produced by a secret.
-- ===========================================================================

CREATE TABLE "app"."webhook_endpoint" (
	"tenant_id" uuid NOT NULL,
	"id" uuid DEFAULT uuidv7() NOT NULL,
	"provider" text NOT NULL,
	"token_sha256" "bytea" NOT NULL,
	"label" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "webhook_endpoint_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "webhook_endpoint_token_digest_len" CHECK (length("app"."webhook_endpoint"."token_sha256") = 32),
	CONSTRAINT "webhook_endpoint_label_present" CHECK (length(btrim("app"."webhook_endpoint"."label")) > 0),
	CONSTRAINT "webhook_endpoint_revoked_after_created" CHECK ("app"."webhook_endpoint"."revoked_at" IS NULL OR "app"."webhook_endpoint"."revoked_at" >= "app"."webhook_endpoint"."created_at")
);
--> statement-breakpoint
-- Unique across the WHOLE table, not per tenant. The token is what produces the
-- tenant, so scoping its uniqueness by tenant would let two tenants hold one
-- secret and make resolution ambiguous — a delivery landing in the wrong
-- agency's book with nothing anywhere reading as broken.
CREATE UNIQUE INDEX "webhook_endpoint_token_uidx" ON "app"."webhook_endpoint" USING btree ("token_sha256");--> statement-breakpoint
ALTER TABLE "ref"."system_constant" ADD CONSTRAINT "system_constant_vault_retention_bounded" CHECK ("ref"."system_constant"."key" <> 'webhook_vault_retention_days'
          OR ("ref"."system_constant"."value" ~ '^[0-9]{1,3}$' AND "ref"."system_constant"."value"::integer BETWEEN 30 AND 90));--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 1 · The retention clock gets a registered home
-- ---------------------------------------------------------------------------
-- `raw_payload_vault.purge_after` is NOT NULL and has been unfillable: nothing
-- in this database said how long a payload lives. The tempting answer is
-- `interval '30 days'` written into the function body, which is exactly the
-- loose number this project refuses — §4.6's window is 30–90 days and the value
-- is a compliance control, not a formatting choice.
--
-- ⚠️ IT CANNOT LIVE IN `ref.timing_constant`, and the reason is mechanical
-- rather than aesthetic: that table's `value_ms` is `integer`, which tops out
-- at ~24.8 days. Thirty days does not fit. The table that holds the undo window
-- is structurally the wrong table for a retention clock, which is a cleaner
-- answer than a taste argument.
INSERT INTO ref.system_constant (key, value, reason)
VALUES (
  'webhook_vault_retention_days',
  '30',
  'How long a raw provider payload lives before it is purgeable. Two controls in one number: CCPA minimisation of consumer PII, and the bound on how long a database backup remains a set of bearer tokens to call audio (Recording-Saved carries a direct_recording_url that 302s to a pre-signed link). §4.6 permits 30-90; the floor is chosen because nothing in the product needs a replay window longer than a month.'
)
ON CONFLICT (key) DO NOTHING;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2 · The function
-- ---------------------------------------------------------------------------
-- Returns §4.2's vocabulary plus the one the ruling implies but does not name:
--
--   accepted     stored; a merge job was enqueued if there was one to enqueue
--   duplicate    these exact bytes are already held. Nothing written.
--   quarantined  stored, no job — the signature was presented and was invalid
--   unknown_token  nothing stored at all. This is the ONLY 401 (§4.2 ruling 4)
--
-- ⚠️ NO FIFTH VALUE FOR "stored but nothing to merge", deliberately. A delivery
-- with no call id and a delivery we mapped are both `accepted` — the edge
-- answers 204 either way, and the distinction is already a fact in the row
-- (`aloware_call_id IS NULL`), where the admin surface can count it. Inventing
-- a return value to carry information a column already carries is how two
-- sources of one truth start.
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
  -- Only `call.*` goes to `call-merge`. §4.3 routes `message.received` and
  -- `message.delivery_failed` to a `message-merge` consumer that does not exist
  -- yet, and neither does the `message` table — so an SMS delivery is vaulted
  -- and left for a replay from the vault when that lands. Enqueuing it here
  -- would hand the call merger a row keyed on `provider_message_id`.
  IF p_canonical IN ('call.initiated', 'call.completed', 'call.enriched')
     AND p_aloware_call_id IS NOT NULL THEN

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
     WHERE q.name = 'call-merge';

    -- `NOT FOUND` rather than `v_queue IS NULL`: a composite IS NULL is only
    -- true when EVERY field is null, so that form would depend on the queue
    -- never having an all-null row rather than on the lookup having missed.
    IF NOT FOUND THEN
      RAISE EXCEPTION 'WI004: pg-boss queue "call-merge" does not exist'
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
      RAISE EXCEPTION 'WI005: queue "call-merge" has policy %, expected key_strict_fifo', v_policy;
    END IF;

    -- The queue's own settings are copied onto the row, which is what
    -- pg-boss's `send()` does in JavaScript. Leaving the column defaults would
    -- give this queue the table's defaults instead of its own.
    INSERT INTO pgboss.job
      (name, data, policy, singleton_key,
       retry_limit, retry_delay, retry_backoff,
       expire_seconds, deletion_seconds, keep_until, dead_letter)
    VALUES (
      'call-merge',
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

-- ⚠️ A RAW INSERT CANNOT FIRE pg-boss's NOTIFY. The `call-merge` queue is
-- created with `notify = false` (the default), so its worker POLLS and picks
-- these rows up on its next tick. If anybody ever turns `notify` on for this
-- queue expecting lower latency, they will get the opposite: jobs enqueued from
-- SQL would wait for a poll that the notify path was meant to replace.
COMMENT ON FUNCTION app.webhook_ingest(text, bytea, text, text, text, text, boolean) IS
  'The single writer for app.raw_payload_vault and app.inbound_webhook_event. Takes an endpoint token, never a tenant id. Returns accepted | duplicate | quarantined | unknown_token.';--> statement-breakpoint

-- PUBLIC would make a cross-tenant writer callable by every role in the
-- database. The pattern exists in 0003, 0005 and 0021 and is applied
-- inconsistently across this tree; on THIS function it is not optional.
REVOKE ALL ON FUNCTION app.webhook_ingest(text, bytea, text, text, text, text, boolean) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.webhook_ingest(text, bytea, text, text, text, text, boolean) TO crm_app;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3 · Classify, then harden
-- ---------------------------------------------------------------------------
-- `definer_only`: `harden()` builds `USING (false) WITH CHECK (false)` and
-- grants no INSERT and no UPDATE, so `crm_app` may issue a SELECT and reads
-- ZERO ROWS. The only reader is the definer above, which runs as the owner and
-- passes through `p_sys`.
--
-- Not `tenant_scoped_read`, which would have been the copy-paste from 0033 and
-- 0034: that class scopes reads by `app.current_tenant()`, and this table is
-- read at a moment when there is no current tenant *by construction* — resolving
-- it is this table's entire job. A tenant-scoped predicate would make the
-- lookup return nothing, always, and the edge would answer `unknown_token` to
-- every genuine delivery.
--
-- 🔴 AND THIS IS THE THIRD TIME IN THIS MODULE THAT `app_can_insert = false`
-- WOULD HAVE BEEN THE WRONG TOOL. It governs INSERT and only INSERT; on any
-- class that is not immutable or read-only, `harden()` still grants UPDATE.
-- Migration 0033 recorded that lesson, 0034 repeated the mistake an hour later,
-- and the reason it does not recur here is that `definer_only` is excluded from
-- both grants by class rather than by flag. The flag is set anyway, so that a
-- future reclassification does not silently hand out INSERT.
INSERT INTO security.table_registry
  (schema_name, table_name, policy_class, owner_column, immutable, app_can_insert,
   exception_reason, registered_in_migration)
VALUES
  ('app', 'webhook_endpoint', 'definer_only', NULL, false, false, NULL,
   '0035_webhook_ingest')
ON CONFLICT (schema_name, table_name) DO UPDATE
  SET policy_class            = EXCLUDED.policy_class,
      owner_column            = EXCLUDED.owner_column,
      immutable               = EXCLUDED.immutable,
      app_can_insert          = EXCLUDED.app_can_insert,
      exception_reason        = EXCLUDED.exception_reason,
      registered_in_migration = EXCLUDED.registered_in_migration;--> statement-breakpoint

SELECT security.harden();
