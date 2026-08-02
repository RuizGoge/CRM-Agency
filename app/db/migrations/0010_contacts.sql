CREATE TYPE "app"."contact_created_via" AS ENUM('lead_intake', 'manual', 'inbound_call', 'import', 'merge_survivor');--> statement-breakpoint
CREATE TYPE "app"."phone_kind" AS ENUM('mobile', 'landline', 'voip', 'unknown');--> statement-breakpoint
CREATE TYPE "app"."tz_confidence" AS ENUM('high', 'medium', 'low', 'unknown');--> statement-breakpoint
CREATE TYPE "app"."tz_source" AS ENUM('zip', 'area_code', 'state', 'manual');--> statement-breakpoint
CREATE TABLE "app"."contact" (
	"tenant_id" uuid NOT NULL,
	"id" uuid DEFAULT uuidv7() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"full_name" text NOT NULL,
	"email_norm" "citext",
	"state_code" char(2),
	"zip5" char(5),
	"lead_local_tz" text,
	"tz_confidence" "app"."tz_confidence" DEFAULT 'unknown' NOT NULL,
	"tz_source" "app"."tz_source",
	"created_via" "app"."contact_created_via" NOT NULL,
	"became_client_at" timestamp with time zone,
	"last_touch_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"redacted_at" timestamp with time zone,
	"redaction_reason" text,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "contact_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "contact_tz_confidence_coherent" CHECK (("app"."contact"."tz_confidence" = 'unknown') = ("app"."contact"."lead_local_tz" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "app"."contact_phone" (
	"tenant_id" uuid NOT NULL,
	"id" uuid DEFAULT uuidv7() NOT NULL,
	"contact_id" uuid NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"phone_e164" text NOT NULL,
	"kind" "app"."phone_kind" DEFAULT 'mobile' NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"bad_number_at" timestamp with time zone,
	"bad_number_reason" text,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"redacted_at" timestamp with time zone,
	CONSTRAINT "contact_phone_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "contact_phone_is_e164" CHECK ("app"."contact_phone"."phone_e164" ~ '^\+[1-9][0-9]{7,14}$')
);
--> statement-breakpoint
ALTER TABLE "app"."contact" ADD CONSTRAINT "contact_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."contact" ADD CONSTRAINT "contact_owner_fk" FOREIGN KEY ("tenant_id","owner_user_id") REFERENCES "app"."app_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."contact_phone" ADD CONSTRAINT "contact_phone_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."contact_phone" ADD CONSTRAINT "contact_phone_contact_fk" FOREIGN KEY ("tenant_id","contact_id") REFERENCES "app"."contact"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."contact_phone" ADD CONSTRAINT "contact_phone_owner_fk" FOREIGN KEY ("tenant_id","owner_user_id") REFERENCES "app"."app_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "contact_email_owner_uidx" ON "app"."contact" USING btree ("tenant_id","owner_user_id","email_norm") WHERE "app"."contact"."email_norm" IS NOT NULL AND "app"."contact"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "contact_phone_owner_uidx" ON "app"."contact_phone" USING btree ("tenant_id","owner_user_id","phone_e164");--> statement-breakpoint
CREATE UNIQUE INDEX "contact_phone_primary_uidx" ON "app"."contact_phone" USING btree ("tenant_id","contact_id") WHERE "app"."contact_phone"."is_primary";