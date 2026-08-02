CREATE TYPE "app"."actor_type" AS ENUM('human', 'system', 'automation', 'import', 'webhook', 'scheduler');--> statement-breakpoint
CREATE TYPE "app"."moved_via" AS ENUM('kanban_drag', 'move_sheet', 'keyboard', 'wrap_up', 'command_palette', 'api', 'automation');--> statement-breakpoint
CREATE TYPE "app"."opportunity_created_from" AS ENUM('lead_intake', 'manual', 'inbound_call', 'import', 'cross_sell');--> statement-breakpoint
CREATE TYPE "app"."premium_mode" AS ENUM('monthly', 'annual');--> statement-breakpoint
CREATE TYPE "app"."stage_type" AS ENUM('open', 'earning', 'lost');--> statement-breakpoint
CREATE TABLE "app"."lost_reason" (
	"tenant_id" uuid NOT NULL,
	"id" uuid DEFAULT uuidv7() NOT NULL,
	"code" text NOT NULL,
	"label" text NOT NULL,
	"sort_order" smallint NOT NULL,
	"deactivated_at" timestamp with time zone,
	CONSTRAINT "lost_reason_tenant_id_id_pk" PRIMARY KEY("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "app"."opportunity" (
	"tenant_id" uuid NOT NULL,
	"id" uuid DEFAULT uuidv7() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"pipeline_id" uuid NOT NULL,
	"stage_id" uuid NOT NULL,
	"current_stage_type" "app"."stage_type" NOT NULL,
	"premium_monthly_cents" bigint,
	"premium_annual_cents" bigint,
	"premium_mode" "app"."premium_mode",
	"product_type" "app"."product_type",
	"carrier" text,
	"policy_number" text,
	"draft_date" date,
	"lost_reason_id" uuid,
	"lost_reason_note" text,
	"parent_opportunity_id" uuid,
	"created_from" "app"."opportunity_created_from" NOT NULL,
	"stage_entered_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"last_activity_at" timestamp with time zone,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"first_touch_latency_seconds" integer,
	"celebrated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "opportunity_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "opportunity_win_gate" CHECK ("app"."opportunity"."current_stage_type" <> 'earning' OR "app"."opportunity"."premium_annual_cents" IS NOT NULL),
	CONSTRAINT "opportunity_loss_gate" CHECK ("app"."opportunity"."current_stage_type" <> 'lost' OR "app"."opportunity"."lost_reason_id" IS NOT NULL),
	CONSTRAINT "opportunity_annualization_exact" CHECK ("app"."opportunity"."premium_monthly_cents" IS NULL
          OR "app"."opportunity"."premium_annual_cents" = "app"."opportunity"."premium_monthly_cents" * 12),
	CONSTRAINT "opportunity_premium_in_range" CHECK ("app"."opportunity"."premium_annual_cents" IS NULL
          OR "app"."opportunity"."premium_annual_cents" BETWEEN 100 AND 10000000),
	CONSTRAINT "opportunity_premium_mode_declared" CHECK (("app"."opportunity"."premium_mode" IS NULL) = ("app"."opportunity"."premium_annual_cents" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "app"."pipeline" (
	"tenant_id" uuid NOT NULL,
	"id" uuid DEFAULT uuidv7() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "pipeline_tenant_id_id_pk" PRIMARY KEY("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "app"."stage" (
	"tenant_id" uuid NOT NULL,
	"id" uuid DEFAULT uuidv7() NOT NULL,
	"pipeline_id" uuid NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"stage_type" "app"."stage_type" NOT NULL,
	"sort_order" smallint NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "stage_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "stage_id_type_uq" UNIQUE("tenant_id","id","stage_type"),
	CONSTRAINT "stage_sort_order_non_negative" CHECK ("app"."stage"."sort_order" >= 0)
);
--> statement-breakpoint
CREATE TABLE "app"."stage_transition" (
	"tenant_id" uuid NOT NULL,
	"id" uuid DEFAULT uuidv7() NOT NULL,
	"opportunity_id" uuid NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"from_stage_id" uuid,
	"from_stage_name_snapshot" text,
	"from_stage_type" "app"."stage_type",
	"to_stage_id" uuid NOT NULL,
	"to_stage_type" "app"."stage_type" NOT NULL,
	"to_stage_name_snapshot" text NOT NULL,
	"actor_user_id" uuid,
	"actor_type" "app"."actor_type" NOT NULL,
	"moved_via" "app"."moved_via" NOT NULL,
	"client_move_key" uuid,
	"stage_config_version" bigint NOT NULL,
	"days_in_previous_stage" integer,
	"occurred_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "stage_transition_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "stage_transition_earning_is_human" CHECK ("app"."stage_transition"."to_stage_type" <> 'earning' OR "app"."stage_transition"."actor_type" = 'human')
);
--> statement-breakpoint
ALTER TABLE "app"."lost_reason" ADD CONSTRAINT "lost_reason_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."opportunity" ADD CONSTRAINT "opportunity_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."opportunity" ADD CONSTRAINT "opportunity_owner_fk" FOREIGN KEY ("tenant_id","owner_user_id") REFERENCES "app"."app_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."opportunity" ADD CONSTRAINT "opportunity_contact_fk" FOREIGN KEY ("tenant_id","contact_id") REFERENCES "app"."contact"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."opportunity" ADD CONSTRAINT "opportunity_stage_type_fk" FOREIGN KEY ("tenant_id","stage_id","current_stage_type") REFERENCES "app"."stage"("tenant_id","id","stage_type") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."opportunity" ADD CONSTRAINT "opportunity_lost_reason_fk" FOREIGN KEY ("tenant_id","lost_reason_id") REFERENCES "app"."lost_reason"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."pipeline" ADD CONSTRAINT "pipeline_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."pipeline" ADD CONSTRAINT "pipeline_owner_fk" FOREIGN KEY ("tenant_id","owner_user_id") REFERENCES "app"."app_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."stage" ADD CONSTRAINT "stage_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."stage" ADD CONSTRAINT "stage_pipeline_fk" FOREIGN KEY ("tenant_id","pipeline_id") REFERENCES "app"."pipeline"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."stage_transition" ADD CONSTRAINT "stage_transition_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "lost_reason_code_uidx" ON "app"."lost_reason" USING btree ("tenant_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "pipeline_one_per_owner_uidx" ON "app"."pipeline" USING btree ("tenant_id","owner_user_id") WHERE "app"."pipeline"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "stage_transition_move_uidx" ON "app"."stage_transition" USING btree ("tenant_id","client_move_key") WHERE "app"."stage_transition"."client_move_key" IS NOT NULL;