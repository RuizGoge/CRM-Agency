-- ===========================================================================
-- `app.aloware_number_mapping` — seller ↔ Aloware seat ↔ outbound number
--
-- §5 and US-601: **one number, exactly one seller; one live mapping per
-- seller.** Both are partial unique indexes rather than a rollout checklist,
-- because a shared outbound line means two sellers' callbacks land on the same
-- number and neither owns the lead that rings back.
--
-- This is what `POST /api/calls` has been refusing on. Until a row exists the
-- dial answers `no_number`, which is the honest answer and also the first-run
-- checklist's item 1.
--
-- 🔴 IT CONTRADICTS WHAT THE ACCOUNT ACTUALLY DOES, recorded rather than
-- designed around. The client runs a 58-number Local Presence pool (line
-- 65123) and a rotating pool has no stable number-to-seller binding. OUTBOUND
-- is unaffected — the dial carries an explicit `user_id`, so attribution never
-- comes from the number. INBOUND is genuinely open: a callback to a pool
-- number has no owner under `aloware_number_mapping_number_uidx`. The design
-- as signed is what ships; the pool is a fact it has not answered.
--
-- ⚠️ `verified_at` IS NULLABLE AND A NULL MAPPING MUST NEVER DIAL. The
-- three-way verification flow (ADR-042) is not built. What exists is the column
-- and the predicate that reads it, so an unverified row is INERT rather than
-- absent — a seller presenting a number nobody confirmed they hold is the
-- failure that column names.
-- ===========================================================================

CREATE TABLE "app"."aloware_number_mapping" (
	"tenant_id" uuid NOT NULL,
	"id" uuid DEFAULT uuidv7() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"aloware_user_id" bigint NOT NULL,
	"aloware_line_id" bigint NOT NULL,
	"from_number_e164" text NOT NULL,
	"verified_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "aloware_number_mapping_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "aloware_number_mapping_e164" CHECK ("app"."aloware_number_mapping"."from_number_e164" ~ '^\+[1-9][0-9]{7,14}$'),
	CONSTRAINT "aloware_number_mapping_revoked_after_created" CHECK ("app"."aloware_number_mapping"."revoked_at" IS NULL OR "app"."aloware_number_mapping"."revoked_at" >= "app"."aloware_number_mapping"."created_at")
);
--> statement-breakpoint
ALTER TABLE "app"."aloware_number_mapping" ADD CONSTRAINT "aloware_number_mapping_owner_fk" FOREIGN KEY ("tenant_id","owner_user_id") REFERENCES "app"."app_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "aloware_number_mapping_number_uidx" ON "app"."aloware_number_mapping" USING btree ("tenant_id","from_number_e164") WHERE "app"."aloware_number_mapping"."revoked_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "aloware_number_mapping_owner_uidx" ON "app"."aloware_number_mapping" USING btree ("tenant_id","owner_user_id") WHERE "app"."aloware_number_mapping"."revoked_at" IS NULL;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Classify, then harden
-- ---------------------------------------------------------------------------
-- 🔴 `tenant_scoped_read`, AND THE FIRST DRAFT OF THIS FILE HAD IT WRONG in a
-- way worth writing down, because the comment that shipped with it asserted the
-- opposite of what the engine did.
--
-- The obvious classification is `owner_scoped` with `app_can_insert = false`,
-- and the comment claimed that gave `crm_app` "SELECT and nothing else".
-- Reading the grants back said **SELECT and UPDATE**: `app_can_insert` governs
-- INSERT and only INSERT, and `harden()` grants UPDATE to any class that is not
-- immutable and not in the read-only set. So a seller could have updated their
-- OWN row — RLS scopes it to their own, which sounds safe and is not. The row
-- is which caller ID they present and which inbound callbacks route to them.
-- With UPDATE they could point it at a number nobody verified they hold, or
-- write their own `verified_at`. **That is precisely the failure the comment
-- said the design prevented.**
--
-- The other two ways out were worse. `immutable = true` installs a statement
-- level refusal that binds the owner too, so revocation and verification —
-- legitimate admin writes — become impossible. Listing every column in
-- `protected_columns` makes `harden()` build `GRANT UPDATE () ON …`, which is a
-- syntax error that takes the whole hardening pass down.
--
-- `tenant_scoped_read` grants SELECT and no write at all, which is what this
-- table needs: rows arrive by migration, by seed, or by the ADR-042 verification
-- flow, and that flow will be a `SECURITY DEFINER` function like
-- `app.ledger_append()` rather than an endpoint with a grant.
--
-- ⚠️ WHAT IT COSTS, said rather than glossed: reads are scoped to the TENANT,
-- not to the owner, so every seller can read every seller's mapping. That is
-- accepted deliberately — an outbound company number is infrastructure rather
-- than lead data, and the roster is already public on the leaderboard. It is a
-- real widening of read scope and it is the price of having no write grant.
--
-- `owner_column` is kept even though this class does not build a predicate from
-- it: it names the column the verification function will scope by, and the
-- table has an owner whether or not the policy reads it.
INSERT INTO security.table_registry
  (schema_name, table_name, policy_class, owner_column, immutable, app_can_insert,
   exception_reason, registered_in_migration)
VALUES
  ('app', 'aloware_number_mapping', 'tenant_scoped_read', 'owner_user_id', false, false,
   NULL, '0033_aloware_number_mapping')
ON CONFLICT (schema_name, table_name) DO UPDATE
  SET policy_class            = EXCLUDED.policy_class,
      owner_column            = EXCLUDED.owner_column,
      immutable               = EXCLUDED.immutable,
      app_can_insert          = EXCLUDED.app_can_insert,
      exception_reason        = EXCLUDED.exception_reason,
      registered_in_migration = EXCLUDED.registered_in_migration;--> statement-breakpoint

SELECT security.harden();
