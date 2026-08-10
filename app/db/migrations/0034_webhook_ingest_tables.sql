CREATE TABLE "app"."inbound_webhook_event" (
	"tenant_id" uuid NOT NULL,
	"id" uuid DEFAULT uuidv7() NOT NULL,
	"provider" text NOT NULL,
	"provider_event_id" text NOT NULL,
	"raw_payload_id" uuid NOT NULL,
	"provider_event" text,
	"aloware_call_id" text,
	"parse_status" text NOT NULL,
	"signature_valid" boolean,
	"received_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "inbound_webhook_event_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "inbound_webhook_event_parse_status" CHECK ("app"."inbound_webhook_event"."parse_status" IN ('parsed', 'unparsed')),
	CONSTRAINT "inbound_webhook_event_digest_shape" CHECK ("app"."inbound_webhook_event"."provider_event_id" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "app"."raw_payload_vault" (
	"tenant_id" uuid NOT NULL,
	"id" uuid DEFAULT uuidv7() NOT NULL,
	"provider" text NOT NULL,
	"body" "bytea" NOT NULL,
	"body_sha256" "bytea" NOT NULL,
	"received_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"purge_after" timestamp with time zone NOT NULL,
	CONSTRAINT "raw_payload_vault_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "raw_payload_vault_digest_matches" CHECK ("app"."raw_payload_vault"."body_sha256" = sha256("app"."raw_payload_vault"."body")),
	CONSTRAINT "raw_payload_vault_body_present" CHECK (length("app"."raw_payload_vault"."body") > 0),
	CONSTRAINT "raw_payload_vault_purge_after_receipt" CHECK ("app"."raw_payload_vault"."purge_after" > "app"."raw_payload_vault"."received_at")
);
--> statement-breakpoint
ALTER TABLE "app"."inbound_webhook_event" ADD CONSTRAINT "inbound_webhook_event_payload_fk" FOREIGN KEY ("tenant_id","raw_payload_id") REFERENCES "app"."raw_payload_vault"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "inbound_webhook_event_transport_uidx" ON "app"."inbound_webhook_event" USING btree ("tenant_id","provider","provider_event_id");--> statement-breakpoint

-- ===========================================================================
-- Classify, then harden
-- ===========================================================================
-- `tenant_scoped` on both, and NOT `owner_scoped`, because a webhook arrives
-- before anybody knows whose lead it is. The owner is resolved by the merge,
-- from `aloware_call_id` against `call` — so an owner predicate here would have
-- to be satisfied by a column the edge cannot fill, and the edge would drop
-- deliveries it could not attribute. Aloware never retries; a dropped delivery
-- is gone.
--
-- 🔴 `app_can_insert = false` ON BOTH, which makes them inert today AND IS THE
-- POINT. §4.2 ruling 1 is that the vault write, the transport-dedupe insert and
-- the job enqueue happen in ONE call inside ONE transaction — three separate
-- statements is three round trips against the one resource both topologies
-- share, and at 333/s that is the single largest lever on storm capacity. That
-- call is `app.webhook_ingest()`, a SECURITY DEFINER function, and it is not
-- written yet. Granting INSERT now would make the shortcut available before the
-- thing that replaces it exists, which is how the shortcut becomes the design.
--
-- ⚠️ The vault holds personal data AND bearer capabilities to call audio, so its
-- retention clock is a compliance control rather than a housekeeping one.
-- `purge_after` records it; §4.6's partition-drop purge is not built.
INSERT INTO security.table_registry
  (schema_name, table_name, policy_class, owner_column, immutable, app_can_insert,
   exception_reason, registered_in_migration)
VALUES
  ('app', 'raw_payload_vault',     'tenant_scoped_read', NULL, false, false, NULL,
   '0034_webhook_ingest_tables'),
  ('app', 'inbound_webhook_event', 'tenant_scoped_read', NULL, false, false, NULL,
   '0034_webhook_ingest_tables')
ON CONFLICT (schema_name, table_name) DO UPDATE
  SET policy_class            = EXCLUDED.policy_class,
      owner_column            = EXCLUDED.owner_column,
      immutable               = EXCLUDED.immutable,
      app_can_insert          = EXCLUDED.app_can_insert,
      exception_reason        = EXCLUDED.exception_reason,
      registered_in_migration = EXCLUDED.registered_in_migration;--> statement-breakpoint

SELECT security.harden();
