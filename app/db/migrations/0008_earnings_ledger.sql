CREATE TYPE "app"."ledger_entry_type" AS ENUM('sale', 'reversal', 'value_correction', 'manual_adjustment', 'projection_repair');--> statement-breakpoint
CREATE TYPE "app"."period_type" AS ENUM('day', 'week', 'month', 'all_time');--> statement-breakpoint
CREATE TYPE "app"."product_type" AS ENUM('final_expense', 'iul');--> statement-breakpoint
CREATE TABLE "app"."earnings_ledger" (
	"tenant_id" uuid NOT NULL,
	"id" uuid DEFAULT uuidv7() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"source_event_id" uuid NOT NULL,
	"source_event_name" text,
	"entry_type" "app"."ledger_entry_type" NOT NULL,
	"delta_cents" bigint NOT NULL,
	"currency" char(3) DEFAULT 'USD' NOT NULL,
	"opportunity_id" uuid,
	"contact_id" uuid,
	"stage_id" uuid,
	"stage_name_snapshot" text,
	"stage_config_version" bigint,
	"product_type" "app"."product_type",
	"period_day" date NOT NULL,
	"period_week" date NOT NULL,
	"period_month" date NOT NULL,
	"business_tz_snapshot" text NOT NULL,
	"reason" text,
	"actor_user_id" uuid,
	"occurred_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"reverses_entry_id" uuid,
	CONSTRAINT "earnings_ledger_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "earnings_delta_nonzero_unless_repair" CHECK ("app"."earnings_ledger"."delta_cents" <> 0 OR "app"."earnings_ledger"."entry_type" = 'projection_repair'),
	CONSTRAINT "earnings_currency_usd" CHECK ("app"."earnings_ledger"."currency" = 'USD'),
	CONSTRAINT "earnings_sale_is_positive" CHECK ("app"."earnings_ledger"."entry_type" <> 'sale' OR "app"."earnings_ledger"."delta_cents" > 0),
	CONSTRAINT "earnings_reversal_is_negative" CHECK ("app"."earnings_ledger"."entry_type" <> 'reversal' OR "app"."earnings_ledger"."delta_cents" < 0),
	CONSTRAINT "earnings_period_month_coherent" CHECK ("app"."earnings_ledger"."period_month" = date_trunc('month', "app"."earnings_ledger"."period_day")::date),
	CONSTRAINT "earnings_period_week_coherent" CHECK ("app"."earnings_ledger"."period_week" = date_trunc('week', "app"."earnings_ledger"."period_day")::date),
	CONSTRAINT "earnings_source_is_a_declared_input" CHECK ("app"."earnings_ledger"."entry_type" IN ('manual_adjustment', 'projection_repair')
          OR "app"."earnings_ledger"."source_event_name" IN ('opportunity.won', 'opportunity.value_changed',
                                      'opportunity.reopened', 'contact.merged')),
	CONSTRAINT "earnings_deal_context_present" CHECK ("app"."earnings_ledger"."entry_type" IN ('manual_adjustment', 'projection_repair')
          OR ("app"."earnings_ledger"."opportunity_id" IS NOT NULL AND "app"."earnings_ledger"."contact_id" IS NOT NULL
              AND "app"."earnings_ledger"."stage_name_snapshot" IS NOT NULL AND "app"."earnings_ledger"."stage_config_version" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "app"."leaderboard_projection" (
	"tenant_id" uuid NOT NULL,
	"period_type" "app"."period_type" NOT NULL,
	"period_key" date NOT NULL,
	"user_id" uuid NOT NULL,
	"total_cents" bigint DEFAULT 0 NOT NULL,
	"entry_count" integer DEFAULT 0 NOT NULL,
	"seq" bigint NOT NULL,
	"last_entry_recorded_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "leaderboard_projection_tenant_id_period_type_period_key_user_id_pk" PRIMARY KEY("tenant_id","period_type","period_key","user_id"),
	CONSTRAINT "leaderboard_all_time_uses_epoch" CHECK ("app"."leaderboard_projection"."period_type" <> 'all_time' OR "app"."leaderboard_projection"."period_key" = DATE '1970-01-01')
);
--> statement-breakpoint
ALTER TABLE "app"."earnings_ledger" ADD CONSTRAINT "earnings_ledger_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."earnings_ledger" ADD CONSTRAINT "earnings_owner_fk" FOREIGN KEY ("tenant_id","owner_user_id") REFERENCES "app"."app_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."leaderboard_projection" ADD CONSTRAINT "leaderboard_projection_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "earnings_source_event_uidx" ON "app"."earnings_ledger" USING btree ("tenant_id","source_event_id");