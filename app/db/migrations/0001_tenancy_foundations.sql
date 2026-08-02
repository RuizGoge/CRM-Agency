CREATE SCHEMA "app";
--> statement-breakpoint
CREATE SCHEMA "ref";
--> statement-breakpoint
CREATE TYPE "app"."earnings_disposition" AS ENUM('keep_in_history', 'exclude_from_board');--> statement-breakpoint
CREATE TYPE "app"."user_role" AS ENUM('seller', 'supervisor', 'admin');--> statement-breakpoint
CREATE TABLE "app"."app_user" (
	"tenant_id" uuid NOT NULL,
	"id" uuid DEFAULT uuidv7() NOT NULL,
	"email" "citext" NOT NULL,
	"full_name" text NOT NULL,
	"display_name" text NOT NULL,
	"avatar_url" text,
	"role" "app"."user_role" NOT NULL,
	"display_tz" text DEFAULT 'America/New_York' NOT NULL,
	"earnings_disposition" "app"."earnings_disposition" DEFAULT 'keep_in_history' NOT NULL,
	"deactivated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "app_user_tenant_id_id_pk" PRIMARY KEY("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "app"."tenant" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid GENERATED ALWAYS AS (id) STORED,
	"name" text NOT NULL,
	"business_tz" text NOT NULL,
	"currency" char(3) DEFAULT 'USD' NOT NULL,
	"sms_enabled" boolean DEFAULT false NOT NULL,
	"reminder_kill_switch" boolean DEFAULT false NOT NULL,
	"cold_threshold_days" smallint DEFAULT 14 NOT NULL,
	"rotting_threshold_days" smallint DEFAULT 7 NOT NULL,
	"custom_fields_enabled" boolean DEFAULT false NOT NULL,
	"tags_enabled" boolean DEFAULT false NOT NULL,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"deactivated_at" timestamp with time zone,
	CONSTRAINT "tenant_currency_usd" CHECK ("app"."tenant"."currency" = 'USD'),
	CONSTRAINT "tenant_rotting_before_cold" CHECK ("app"."tenant"."rotting_threshold_days" < "app"."tenant"."cold_threshold_days")
);
--> statement-breakpoint
ALTER TABLE "app"."app_user" ADD CONSTRAINT "app_user_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "app_user_email_uidx" ON "app"."app_user" USING btree ("tenant_id","email");--> statement-breakpoint
CREATE UNIQUE INDEX "app_user_id_role_uidx" ON "app"."app_user" USING btree ("tenant_id","id","role");--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_single_demo_uidx" ON "app"."tenant" USING btree ("is_demo") WHERE "app"."tenant"."is_demo";