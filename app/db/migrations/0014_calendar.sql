CREATE TYPE "app"."activity_type" AS ENUM('call', 'sms', 'email', 'task', 'appointment_link');--> statement-breakpoint
CREATE TYPE "app"."job_status" AS ENUM('pending', 'fired', 'skipped', 'canceled', 'dropped_late');--> statement-breakpoint
CREATE TYPE "app"."meeting_created_via" AS ENUM('wrap_up', 'manual', 'quick_schedule', 'reschedule');--> statement-breakpoint
CREATE TYPE "app"."meeting_outcome" AS ENUM('held', 'no_show', 'canceled_by_lead', 'rescheduled', 'sold');--> statement-breakpoint
CREATE TYPE "app"."meeting_type" AS ENUM('phone', 'video', 'in_person');--> statement-breakpoint
CREATE TYPE "app"."scheduled_kind" AS ENUM('meeting_reminder', 'cold_sweep', 'activity_escalation', 'celebration_broadcast', 'retention_purge', 'reconciliation_backfill', 'aloware_health_probe');--> statement-breakpoint
CREATE TABLE "app"."activity" (
	"tenant_id" uuid NOT NULL,
	"id" uuid DEFAULT uuidv7() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"contact_id" uuid,
	"opportunity_id" uuid,
	"type" "app"."activity_type" NOT NULL,
	"title" text NOT NULL,
	"due_at" timestamp with time zone,
	"priority" smallint DEFAULT 0 NOT NULL,
	"created_by" "app"."actor_type" NOT NULL,
	"source_event_id" uuid,
	"source_event_name" text,
	"linked_meeting_id" uuid,
	"completed_at" timestamp with time zone,
	"completed_by_user_id" uuid,
	"outcome" text,
	"auto_completed" boolean DEFAULT false NOT NULL,
	"escalation_level" smallint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"canceled_at" timestamp with time zone,
	CONSTRAINT "activity_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "activity_has_a_subject" CHECK ("app"."activity"."contact_id" IS NOT NULL OR "app"."activity"."opportunity_id" IS NOT NULL),
	CONSTRAINT "activity_task_has_due_at" CHECK ("app"."activity"."type" <> 'task' OR "app"."activity"."due_at" IS NOT NULL),
	CONSTRAINT "activity_machine_work_is_explainable" CHECK ("app"."activity"."created_by" = 'human' OR "app"."activity"."source_event_name" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "app"."meeting" (
	"tenant_id" uuid NOT NULL,
	"id" uuid DEFAULT uuidv7() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"opportunity_id" uuid NOT NULL,
	"starts_at_utc" timestamp with time zone NOT NULL,
	"duration_minutes" smallint DEFAULT 30 NOT NULL,
	"contact_timezone" text NOT NULL,
	"meeting_type" "app"."meeting_type" DEFAULT 'phone' NOT NULL,
	"created_via" "app"."meeting_created_via" NOT NULL,
	"outcome" "app"."meeting_outcome",
	"outcome_at" timestamp with time zone,
	"rescheduled_from_meeting_id" uuid,
	"originating_no_show_meeting_id" uuid,
	"reminder_consent_captured" boolean DEFAULT false NOT NULL,
	"canceled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "meeting_tenant_id_id_pk" PRIMARY KEY("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "app"."scheduled_job" (
	"tenant_id" uuid NOT NULL,
	"id" uuid DEFAULT uuidv7() NOT NULL,
	"kind" "app"."scheduled_kind" NOT NULL,
	"idempotency_key" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"owner_user_id" uuid,
	"fire_at" timestamp with time zone NOT NULL,
	"status" "app"."job_status" DEFAULT 'pending' NOT NULL,
	"terminal_reason" text,
	"boss_job_id" text,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"resolved_at" timestamp with time zone,
	"canceled_at" timestamp with time zone,
	CONSTRAINT "scheduled_job_tenant_id_id_pk" PRIMARY KEY("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "app"."activity" ADD CONSTRAINT "activity_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."activity" ADD CONSTRAINT "activity_owner_fk" FOREIGN KEY ("tenant_id","owner_user_id") REFERENCES "app"."app_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."activity" ADD CONSTRAINT "activity_contact_fk" FOREIGN KEY ("tenant_id","contact_id") REFERENCES "app"."contact"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."activity" ADD CONSTRAINT "activity_opportunity_fk" FOREIGN KEY ("tenant_id","opportunity_id") REFERENCES "app"."opportunity"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."meeting" ADD CONSTRAINT "meeting_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."meeting" ADD CONSTRAINT "meeting_owner_fk" FOREIGN KEY ("tenant_id","owner_user_id") REFERENCES "app"."app_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."meeting" ADD CONSTRAINT "meeting_contact_fk" FOREIGN KEY ("tenant_id","contact_id") REFERENCES "app"."contact"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."meeting" ADD CONSTRAINT "meeting_opportunity_fk" FOREIGN KEY ("tenant_id","opportunity_id") REFERENCES "app"."opportunity"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."scheduled_job" ADD CONSTRAINT "scheduled_job_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activity_my_day_idx" ON "app"."activity" USING btree ("tenant_id","owner_user_id","due_at") WHERE "app"."activity"."completed_at" IS NULL AND "app"."activity"."canceled_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "meeting_no_duplicate_uidx" ON "app"."meeting" USING btree ("tenant_id","owner_user_id","starts_at_utc","contact_id") WHERE "app"."meeting"."canceled_at" IS NULL;--> statement-breakpoint
CREATE INDEX "meeting_today_idx" ON "app"."meeting" USING btree ("tenant_id","owner_user_id","starts_at_utc") WHERE "app"."meeting"."canceled_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "scheduled_job_episode_uidx" ON "app"."scheduled_job" USING btree ("tenant_id","kind","idempotency_key") WHERE "app"."scheduled_job"."canceled_at" IS NULL;--> statement-breakpoint
CREATE INDEX "scheduled_job_due_idx" ON "app"."scheduled_job" USING btree ("fire_at") WHERE "app"."scheduled_job"."status" = 'pending';