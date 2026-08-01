# 05 — Data Model (Phase 5B, draft)

> **Phase 5 deliverable, companion to [`05-architecture.md`](05-architecture.md).** 45 tables. Normative precedence: errata §0.2 and Part I rulings of `05-architecture.md` win over this file — in particular **E4** (the ETag pending term is `min()`, not `max()`) and **E1/E5**.

## ER Diagram

```mermaid
erDiagram
    %% All tables carry tenant_id as the LEADING column of the PK. Every FK is composite
    %% (tenant_id, x_id), so a cross-tenant reference is structurally impossible.
    %% Money is ALWAYS bigint cents. Tables marked APPEND-ONLY have a BEFORE UPDATE OR
    %% DELETE OR TRUNCATE statement trigger plus REVOKE UPDATE, DELETE, TRUNCATE.

    TENANT ||--o{ APP_USER : "employs"
    TENANT ||--o{ PIPELINE : "scopes"
    TENANT ||--o{ STAGE_TEMPLATE : "seeds"
    TENANT ||--o{ LOST_REASON : "seeds"
    TENANT ||--o{ LEAD_SOURCE : "seeds"
    TENANT ||--o{ TAG : "scopes dormant"
    TENANT ||--o{ CUSTOM_FIELD_DEFINITION : "scopes dormant"
    TENANT ||--o{ CONTACT : "scopes"
    TENANT ||--o{ SUPPRESSION_LIST : "tenant wide"
    TENANT ||--o{ CONSENT_LEDGER : "tenant wide"
    TENANT ||--o{ BREAK_GLASS_OVERRIDE : "tenant wide"
    TENANT ||--o{ EARNINGS_LEDGER : "scopes"
    TENANT ||--o{ AUDIT_LOG : "scopes"
    TENANT ||--o{ EVENT_LOG : "scopes"
    TENANT ||--o{ INTAKE_SOURCE : "scopes"
    TENANT ||--o{ ALOWARE_NUMBER_MAPPING : "scopes"
    TENANT ||--o{ CHANNEL_WATERMARK : "scopes"
    TENANT ||--o{ LEADERBOARD_PROJECTION : "scopes"
    TENANT ||--o{ SYSTEM_CONSTANT : "scopes"
    TENANT ||--o{ TENANT_LOOKUP_METER : "scopes"

    APP_USER ||--o{ CONTACT : "owns"
    APP_USER ||--o{ OPPORTUNITY : "owns"
    APP_USER ||--o{ PIPELINE : "owns"
    APP_USER ||--o{ EARNINGS_LEDGER : "earned by"
    APP_USER ||--o| ALOWARE_NUMBER_MAPPING : "dials from"
    APP_USER ||--o{ INTAKE_SOURCE : "receives leads at"
    APP_USER ||--o{ NOTIFICATION : "receives"
    APP_USER ||--o{ EXPORT_JOB : "requests"

    PIPELINE ||--o{ STAGE : "contains"
    STAGE ||--o{ OPPORTUNITY : "currently holds"
    STAGE ||--o{ STAGE_TRANSITION : "target of"

    CONTACT ||--o{ CONTACT_PHONE : "reachable at"
    CONTACT ||--o{ OPPORTUNITY : "may have many"
    CONTACT ||--o{ ACTIVITY : "generates"
    CONTACT ||--o{ NOTE : "annotated by"
    CONTACT ||--o{ MEETING : "attends"
    CONTACT ||--o{ CONVERSATION : "threads"
    CONTACT ||--o{ CALL : "receives"
    CONTACT ||--o{ TIMELINE_ENTRY : "projected into"
    CONTACT ||--o{ CONTACT_TAG : "tagged dormant"
    CONTACT ||--o{ CUSTOM_FIELD_VALUE : "extended dormant"

    OPPORTUNITY ||--o{ STAGE_TRANSITION : "moved by"
    OPPORTUNITY ||--o{ EARNINGS_LEDGER : "credits"
    OPPORTUNITY ||--o{ COLD_EPISODE : "goes cold in"
    OPPORTUNITY ||--o{ ACTIVITY : "scheduled on"
    OPPORTUNITY ||--o{ MEETING : "booked for"
    OPPORTUNITY ||--o| OPPORTUNITY : "cross sell parent of"
    LOST_REASON ||--o{ OPPORTUNITY : "explains loss of"
    LEAD_SOURCE ||--o{ CONTACT : "originated"

    CONVERSATION ||--o{ MESSAGE : "holds"
    CALL ||--o| MEETING : "linked to"
    MEETING ||--o{ SCHEDULED_JOB : "reminded by"
    ACTIVITY ||--o| CALL : "auto completed by"

    INTAKE_SOURCE ||--o{ RAW_PAYLOAD_VAULT : "posts to"
    RAW_PAYLOAD_VAULT ||--o| CONTACT : "materializes"
    ALOWARE_NUMBER_MAPPING ||--o{ INBOUND_WEBHOOK_EVENT : "attributes"
    INBOUND_WEBHOOK_EVENT ||--o| CALL : "merges into"
    INBOUND_WEBHOOK_EVENT ||--o| MESSAGE : "merges into"
    INBOUND_WEBHOOK_EVENT ||--o{ DEAD_LETTER : "fails into"
    INBOUND_WEBHOOK_EVENT ||--o| UNMAPPED_INBOUND_QUARANTINE : "quarantines as"

    EVENT_LOG ||--o{ EVENT_OUTBOX : "fans out to"
    EVENT_CONSUMER ||--o{ EVENT_OUTBOX : "defines rows of"
    EVENT_OUTBOX ||--o{ DEAD_LETTER : "fails into"
    EVENT_LOG ||--o{ EVENT_ARCHIVE_MANIFEST : "archived by month into"
    EVENT_LOG ||--o{ TIMELINE_ENTRY : "projects into"

    EARNINGS_LEDGER ||--|| LEADERBOARD_PROJECTION : "sums into"
    BREAK_GLASS_OVERRIDE ||--o{ AUDIT_LOG : "referenced by"
    CONSENT_LEDGER ||--o{ AUDIT_LOG : "referenced by"
    SUPPRESSION_LIST ||--o{ AUDIT_LOG : "referenced by"
    SCHEDULED_JOB ||--o{ AUDIT_LOG : "terminal state audited in"
    ADMIN_ALERT }o--|| TENANT : "raised for"
    SECURITY_TABLE_REGISTRY }o--|| TENANT : "classifies schema of"

    TENANT {
        uuid id PK
        uuid tenant_id "GENERATED ALWAYS AS id STORED"
        text business_tz "IANA - stamps period_key only"
        char3 currency "USD pinned by CHECK"
        bool sms_enabled "SMS dark launch flag"
        bool reminder_kill_switch
        int cold_threshold_days
        bool is_demo "unique partial index - one demo tenant"
    }

    APP_USER {
        uuid tenant_id PK
        uuid id PK
        enum role "seller supervisor admin - ENUM not table"
        text display_tz "formats human timestamps only"
        timestamptz deactivated_at "never deleted"
        enum earnings_disposition "keep_in_history exclude_from_board"
    }

    CONTACT {
        uuid tenant_id PK
        uuid id PK
        uuid owner_user_id FK "denormalized silo predicate"
        text full_name
        text email_norm "lowercased - partial unique per owner"
        text lead_local_tz "calling window resolver only"
        enum tz_confidence "high medium low unknown"
        timestamptz redacted_at "CCPA erase in place"
        timestamptz deleted_at "archive - excluded by live view"
    }

    CONTACT_PHONE {
        uuid tenant_id PK
        uuid id PK
        uuid contact_id FK
        uuid owner_user_id "denormalized for owner unique"
        text phone_e164 "normalized at every ingress"
        bool is_primary
        timestamptz bad_number_at
    }

    OPPORTUNITY {
        uuid tenant_id PK
        uuid id PK
        uuid owner_user_id FK
        uuid contact_id FK
        uuid stage_id FK
        enum current_stage_type "FK guaranteed copy of stage.stage_type"
        bigint premium_monthly_cents "NEVER float"
        bigint premium_annual_cents "CHECK equals monthly times 12"
        enum premium_mode "monthly annual - no default"
        uuid lost_reason_id FK
        timestamptz stage_entered_at "board sort key"
        timestamptz last_activity_at "single writer max rule"
        timestamptz celebrated_at "set once forever"
        int first_touch_latency_seconds "written once"
    }

    STAGE {
        uuid tenant_id PK
        uuid id PK
        uuid pipeline_id FK
        uuid owner_user_id "per seller stage set"
        text name "renaming changes nothing"
        enum stage_type "open earning lost - IMMUTABLE"
        int sort_order
        timestamptz deleted_at
    }

    STAGE_TRANSITION {
        uuid tenant_id PK
        uuid id PK
        uuid opportunity_id FK
        uuid to_stage_id FK
        enum to_stage_type "snapshot at move time"
        text to_stage_name_snapshot
        enum actor_type "CHECK earning implies human"
        uuid client_move_key UK "sendBeacon idempotency"
        int days_in_previous_stage
    }

    EARNINGS_LEDGER {
        uuid tenant_id PK
        uuid id PK
        uuid owner_user_id "earning seller - never re attributed"
        uuid source_event_id UK "exactly once"
        enum entry_type "sale reversal value_correction manual_adjustment"
        bigint delta_cents "signed - CHECK not zero"
        date period_day "tenant business tz"
        date period_week
        date period_month
        text stage_name_snapshot
        timestamptz recorded_at "undo window predicate uses this"
    }

    LEADERBOARD_PROJECTION {
        uuid tenant_id PK
        enum period_type PK
        date period_key PK
        uuid user_id PK
        bigint total_cents "sum of ALL entries"
        bigint seq "ETag source"
    }

    CONSENT_LEDGER {
        uuid tenant_id PK
        uuid id PK
        text contact_value_norm "E164 or lowercased email"
        enum channel "sms call email whatsapp_reserved"
        enum status "granted revoked dnc_suppressed"
        enum consent_type "express_written implied none"
        text certificate_url
        uuid attesting_admin_user_id
        timestamptz effective_at
    }

    SUPPRESSION_LIST {
        uuid tenant_id PK
        uuid id PK
        text phone_e164 "tenant wide NOT owner scoped"
        enum kind "stop start dnc_federal dnc_state internal litigator carrier_block"
        timestamptz effective_at
        text evidence_ref
    }

    AUDIT_LOG {
        uuid tenant_id PK
        timestamptz occurred_at PK
        uuid id PK
        uuid actor_user_id
        enum actor_type
        text action "closed enum incl book.viewed"
        jsonb before
        jsonb after
        uuid override_id FK
        timestamptz dedupe_bucket "5 min bucket for book.viewed"
    }

    EVENT_LOG {
        uuid tenant_id PK
        timestamptz occurred_at PK
        uuid event_id PK
        uuid owner_user_id "NOT NULL - no unowned events"
        uuid actor_user_id
        bigint occurred_at_ms "ms precision for speed to lead"
        bigint recorded_at_ms
        smallint schema_version
        enum source_system "app aloware vendor_post scheduler import"
        uuid correlation_id
        enum event_name "closed enum of 49 labels"
        jsonb payload
    }

    EVENT_OUTBOX {
        uuid tenant_id PK
        date created_day PK
        uuid event_id PK
        text consumer_name PK
        enum status "pending claimed delivered dead"
        int attempts
        timestamptz next_attempt_at
        text last_error
    }

    EVENT_CONSUMER {
        text consumer_name PK
        enum event_name PK
        enum delivery "inline outbox pgboss"
        text singleton_key_expr
    }

    INBOUND_WEBHOOK_EVENT {
        uuid tenant_id PK
        timestamptz received_at PK
        uuid id PK
        enum provider "aloware"
        text provider_event_id UK
        text aloware_call_id
        bool signature_valid "nullable until spike"
        enum status "received merged failed dead"
        int attempt_count
        uuid raw_payload_id FK
    }

    RAW_PAYLOAD_VAULT {
        uuid tenant_id PK
        timestamptz received_at PK
        uuid id PK
        enum origin "intake webhook"
        uuid intake_source_id FK
        bytea body_raw "nulled after R2 offload"
        text r2_object_key "CHECK at least one present"
        jsonb headers
        inet source_ip
        text dedupe_key UK
        date dedupe_bucket UK
    }

    DEAD_LETTER {
        uuid tenant_id PK
        uuid id PK
        enum origin "inbound_webhook outbox job"
        uuid subject_id
        jsonb payload_snapshot
        text last_error
        int attempt_count
        timestamptz replayed_at
    }

    SCHEDULED_JOB {
        uuid tenant_id PK
        uuid id PK
        enum kind "meeting_reminder cold_episode activity_escalation celebration_broadcast retention_purge"
        text idempotency_key UK
        uuid subject_id
        timestamptz fire_at
        enum status "pending fired skipped canceled"
        text terminal_reason "skipped sms_disabled etc"
        text boss_job_id
    }

    INTAKE_SOURCE {
        uuid tenant_id PK
        uuid id PK
        uuid owner_user_id "deterministic binding - no routing engine"
        bytea token_hash UK "never stored in plaintext"
        text token_last4
        timestamptz grace_until "rotation with grace"
        timestamptz revoked_at
        jsonb field_map
        int rate_limit_per_minute
    }

    ALOWARE_NUMBER_MAPPING {
        uuid tenant_id PK
        uuid id PK
        uuid user_id FK
        text aloware_user_id
        text from_number_e164 UK "one number one seller"
        enum status "unverified verified revoked"
        timestamptz verified_at
    }

    BREAK_GLASS_OVERRIDE {
        uuid tenant_id PK
        uuid id PK
        uuid started_by_user_id FK
        text reason "CHECK length at least 10"
        timestamptz started_at
        timestamptz expires_at "GENERATED started_at plus 60 min"
        timestamptz ended_at
        enum scope "timezone_and_window only"
    }

    ACTIVITY {
        uuid tenant_id PK
        uuid id PK
        uuid owner_user_id FK
        uuid contact_id FK
        uuid opportunity_id FK
        enum type "call sms email task appointment_link"
        timestamptz due_at "hard due time"
        timestamptz completed_at
        bool auto_completed
        uuid source_event_id "why is this on my list"
    }

    MEETING {
        uuid tenant_id PK
        uuid id PK
        uuid owner_user_id FK
        uuid contact_id FK
        uuid opportunity_id FK
        timestamptz starts_at_utc
        text contact_timezone "snapshot - never joined"
        enum outcome "held no_show canceled rescheduled sold"
        uuid rescheduled_from_meeting_id FK
        uuid linked_call_id FK
    }

    NOTE {
        uuid tenant_id PK
        uuid id PK
        uuid owner_user_id FK
        uuid contact_id FK
        uuid opportunity_id FK
        text body "max 5000 chars"
        int version "If-Match optimistic concurrency"
        bool pinned
        timestamptz redacted_at
    }

    MESSAGE {
        uuid tenant_id PK
        uuid id PK
        uuid conversation_id FK
        enum channel "sms email whatsapp_reserved"
        enum direction "inbound outbound"
        text provider_message_id UK
        text body "redactable"
        enum intent_hint "stop help reply out_of_office"
        enum provider_status
    }

    CALL {
        uuid tenant_id PK
        uuid id PK
        uuid owner_user_id FK
        uuid contact_id FK
        text aloware_call_id UK "nullable until confirmed"
        uuid correlation_id "survives provider round trip"
        enum state "monotonic - late event cannot regress"
        text disposition_raw
        enum disposition_canonical
        timestamptz recording_at "per part presence flag"
        timestamptz transcript_at
        timestamptz ai_summary_at
    }

    CONVERSATION {
        uuid tenant_id PK
        uuid id PK
        uuid owner_user_id "the silo at the data layer"
        uuid contact_id FK
        enum channel
        timestamptz needs_reply_since
    }

    TIMELINE_ENTRY {
        uuid tenant_id PK
        uuid id PK
        uuid contact_id FK
        timestamptz occurred_at
        enum kind
        text ref_type UK
        uuid ref_id UK "upsert in place - never duplicate"
        jsonb render_payload
    }

    NOTIFICATION {
        uuid tenant_id PK
        uuid id PK
        uuid owner_user_id FK
        text collapse_key UK
        uuid source_event_id UK
        timestamptz read_at
        text deep_link
    }

    CHANNEL_WATERMARK {
        uuid tenant_id PK
        uuid owner_user_id PK
        enum channel PK
        bigint seq "cheap 304 ETag source"
        timestamptz updated_at
    }

    COLD_EPISODE {
        uuid tenant_id PK
        uuid id PK
        uuid opportunity_id FK
        int ordinal UK "stable idempotency key"
        timestamptz started_at
        timestamptz ended_at
    }

    EXPORT_JOB {
        uuid tenant_id PK
        uuid id PK
        uuid requested_by_user_id FK
        enum scope "own supervisor tenant"
        bool masking_applied
        text reason
        int row_count
        text r2_object_key
        timestamptz expires_at
    }

    ADMIN_ALERT {
        uuid tenant_id PK
        uuid id PK
        enum kind "unmapped_number unmapped_disposition nonhuman_earning_attempt dlq_depth"
        uuid subject_id
        timestamptz acknowledged_at
    }

    UNMAPPED_INBOUND_QUARANTINE {
        uuid tenant_id PK
        uuid id PK
        text from_number_e164
        uuid raw_payload_id FK
        uuid promoted_to_contact_id FK "emits lead.created only on promotion"
    }

    SECURITY_TABLE_REGISTRY {
        text schema_name PK
        text table_name PK
        enum policy_class "owner_scoped tenant_scoped definer_only append_only reference"
        text owner_column
        bool immutable
        text exception_reason "required when class is reference"
    }

    SYSTEM_CONSTANT {
        uuid tenant_id PK
        text key PK "undo_window_ms undo_projection_guard_ms environment"
        bigint value_num
        text value_text
    }

    TENANT_LOOKUP_METER {
        uuid tenant_id PK
        uuid user_id PK
        timestamptz minute_bucket PK
        int lookup_count "privacy oracle rate limit"
    }

    EVENT_ARCHIVE_MANIFEST {
        uuid tenant_id PK
        date archived_month PK
        text r2_object_key
        bigint row_count
        bytea sha256
    }

    STAGE_TEMPLATE {
        uuid tenant_id PK
        uuid id PK
        text name
        enum stage_type
        int sort_order
    }

    LOST_REASON {
        uuid tenant_id PK
        uuid id PK
        text code UK "reporting keys on code never label"
        text label
        timestamptz deactivated_at
    }

    LEAD_SOURCE {
        uuid tenant_id PK
        uuid id PK
        text code UK
        text label
        timestamptz deactivated_at
    }

    PIPELINE {
        uuid tenant_id PK
        uuid id PK
        uuid owner_user_id FK
        text name
        timestamptz deleted_at
    }

    TAG {
        uuid tenant_id PK
        uuid id PK
        text label
        timestamptz deleted_at "DORMANT in MVP"
    }

    CONTACT_TAG {
        uuid tenant_id PK
        uuid contact_id PK
        uuid tag_id PK
        uuid owner_user_id "DORMANT in MVP"
    }

    CUSTOM_FIELD_DEFINITION {
        uuid tenant_id PK
        uuid id PK
        text key UK
        enum data_type
        timestamptz deleted_at "DORMANT in MVP"
    }

    CUSTOM_FIELD_VALUE {
        uuid tenant_id PK
        uuid id PK
        uuid definition_id FK
        uuid contact_id FK
        text value_text "DORMANT in MVP"
    }
```

## Tables

### `tenant`
Tenancy root and the only home for tenant-wide configuration and feature flags. Holds business_tz (the timezone that stamps every period_key and NOTHING else), sms_enabled (SMS-dark launch), reminder_kill_switch, cold/rotting thresholds, and is_demo. Flags are typed columns, never a jsonb blob: a typo in a jsonb key is invisible at runtime, a missing column is a compile error.

- **Columns:** id uuid PK DEFAULT uuidv7(); tenant_id uuid GENERATED ALWAYS AS (id) STORED (so the catalog gate 'every table has a tenant_id column' has zero special cases); name text NOT NULL; business_tz text NOT NULL; currency char(3) NOT NULL DEFAULT 'USD'; sms_enabled boolean NOT NULL DEFAULT false; reminder_kill_switch boolean NOT NULL DEFAULT false; cold_threshold_days smallint NOT NULL DEFAULT 14; rotting_threshold_days smallint NOT NULL DEFAULT 7; custom_fields_enabled boolean NOT NULL DEFAULT false; tags_enabled boolean NOT NULL DEFAULT false; is_demo boolean NOT NULL DEFAULT false; created_at timestamptz NOT NULL DEFAULT clock_timestamp(); deactivated_at timestamptz
- **Constraints:** PK (id). CHECK (currency = 'USD') — multi-tenant-ready column, pinned today. CHECK (business_tz IN (SELECT name FROM pg_timezone_names)) is not possible in a CHECK (not immutable); instead a BEFORE INSERT/UPDATE trigger validates business_tz against pg_timezone_names and raises. CHECK (rotting_threshold_days < cold_threshold_days). CREATE UNIQUE INDEX ON tenant (is_demo) WHERE is_demo — at most one demo tenant, ever. Trigger refuses INSERT of is_demo=true when system_constant['environment'].value_text = 'production' (this is the mechanical form of 'the demo seed refuses to run in production'). Trigger blocks business_tz changes unless an audit row with action='tenant.business_tz_changed' is written in the same transaction; period_keys are NEVER rewritten (forward-only).
- **RLS:** FOR ALL TO crm_app USING (id = app.current_tenant()) WITH CHECK (id = app.current_tenant() AND app.scope_is_admin()). Reading your own tenant row is required on every request (flags); writing requires the admin scope, verified by re-reading app_user.role inside app.scope_is_admin(), not by trusting the GUC. Second policy FOR ALL TO crm_migrator USING (true) WITH CHECK (true).
- **Soft delete:** deactivated_at only. A tenant is never deleted: every ledger, consent and audit row is FK-anchored to it and the whole product's evidentiary value depends on that anchor surviving.

### `app_user`
The 50 sellers plus supervisors and admins. Named app_user because USER is a reserved word and quoting it forever is a bug farm. Carries display_tz (formats every human-facing timestamp and nothing else) and earnings_disposition (whether a departed seller stays on the all-time board).

- **Columns:** tenant_id uuid; id uuid DEFAULT uuidv7(); email citext NOT NULL; full_name text NOT NULL; display_name text NOT NULL; avatar_url text; role app.user_role NOT NULL (ENUM: seller|supervisor|admin); display_tz text NOT NULL DEFAULT 'America/New_York'; earnings_disposition app.earnings_disposition NOT NULL DEFAULT 'keep_in_history'; deactivated_at timestamptz; created_at timestamptz NOT NULL DEFAULT clock_timestamp()
- **Constraints:** PK (tenant_id, id). FK (tenant_id) REFERENCES tenant(id). UNIQUE (tenant_id, email). UNIQUE (tenant_id, id, role) — this redundant unique exists so other tables can carry an FK-guaranteed denormalized role copy if ever needed. app.user_role is a Postgres ENUM with exactly three labels; a fourth role requires ALTER TYPE, i.e. a migration and a review gate. A CI test asserts enum_range(NULL::app.user_role) has exactly 3 labels — this is the mechanical form of 'no fourth role, no role builder, no permission matrix'. There is deliberately NO roles table and NO user_permission table: their absence IS the guarantee.
- **RLS:** FOR ALL TO crm_app USING (tenant_id = app.current_tenant()) WITH CHECK (tenant_id = app.current_tenant() AND app.scope_is_admin()). Read is tenant-wide on purpose and this is a deliberate, documented widening: the leaderboard legitimately carries display names and avatars tenant-wide (ARR-EVT-23), supervisors need the seller list, and owner labels must render. Critically, the USING clause does NOT call app.scope_is_global() — if it did, and app.scope_is_global() reads app_user, Postgres raises 'infinite recursion detected in policy for relation app_user'. This is a real trap and the reason app_user's policy is the one owner-bearing table that is tenant-readable.
- **Soft delete:** deactivated_at. Never deleted: earnings_ledger.owner_user_id, audit_log.actor_user_id and every owned record point at it. A hard delete would orphan the all-time board.

### `pipeline`
A seller's own board. One per seller in the MVP (multiple typed pipelines are out of scope), but modelled as a table so the per-seller stage set has a parent and so 'stages belong to a board' is an FK fact.

- **Columns:** tenant_id uuid; id uuid DEFAULT uuidv7(); owner_user_id uuid NOT NULL; name text NOT NULL; created_at timestamptz NOT NULL; deleted_at timestamptz
- **Constraints:** PK (tenant_id, id). FK (tenant_id, owner_user_id) REFERENCES app_user(tenant_id, id). UNIQUE (tenant_id, owner_user_id) WHERE deleted_at IS NULL — exactly one live board per seller in the MVP; lifting the restriction later is dropping one index, not a migration.
- **RLS:** owner_scoped class. FOR ALL TO crm_app USING (tenant_id = app.current_tenant() AND (owner_user_id = app.current_user_id() OR app.scope_is_global())) WITH CHECK (tenant_id = app.current_tenant() AND owner_user_id = app.current_user_id()).
- **Soft delete:** deleted_at, and crm_app reads only the security_invoker view pipeline_live. A deleted pipeline's stages and their name snapshots must survive so historical ledger rows stay explicable.

### `stage`
The per-seller stage set. stage_type (open|earning|lost) is the ONLY thing the two gates bind to; the name is the seller's own and renaming it is semantically inert. This table is where the single most dangerous historical bug in the spec (a gate bound to a stage NAME) is made impossible.

- **Columns:** tenant_id uuid; id uuid DEFAULT uuidv7(); pipeline_id uuid NOT NULL; owner_user_id uuid NOT NULL; name text NOT NULL; stage_type app.stage_type NOT NULL (ENUM: open|earning|lost); sort_order smallint NOT NULL; created_at timestamptz NOT NULL; deleted_at timestamptz
- **Constraints:** PK (tenant_id, id). FK (tenant_id, pipeline_id) REFERENCES pipeline. UNIQUE (tenant_id, id, stage_type) — redundant on its own, but it is the target of opportunity's composite FK, which is what makes the denormalized current_stage_type provably equal to the stage's real type. UNIQUE (tenant_id, pipeline_id, sort_order) DEFERRABLE INITIALLY DEFERRED so reordering is one UPDATE statement. STAGE_TYPE IS IMMUTABLE: a BEFORE UPDATE trigger raises if NEW.stage_type <> OLD.stage_type. RATIONALE — this single trigger deletes an entire class of catastrophe: if a stage's type can never flip, pipeline.stage_config_changed can never move money, the 'nastiest hidden dependency in the system' (a per-seller stage tweak silently moving a PUBLIC leaderboard) cannot occur, and the documented contradiction between 'recompute on stage-flag change' and 'no recompute job exists' resolves in favour of the latter with zero ambiguity. A seller who wants a different type creates a new stage and moves cards, which is a normal gated move. CHECK (sort_order >= 0).
- **RLS:** owner_scoped class, identical shape to pipeline. Supervisors read tenant-wide; only the owning seller (or an admin acting through the admin command path) can write.
- **Soft delete:** deleted_at. Hard-deleting a stage would orphan stage_transition.to_stage_id and make stage_name_snapshot the only surviving evidence. Soft delete plus the snapshot means deleting a stage cannot rewrite history.

### `stage_template`
The seeded default board that a new seller's stage set is instantiated from. Tenant-scoped seed data, not a live board.

- **Columns:** tenant_id uuid; id uuid DEFAULT uuidv7(); name text NOT NULL; stage_type app.stage_type NOT NULL; sort_order smallint NOT NULL
- **Constraints:** PK (tenant_id, id). UNIQUE (tenant_id, sort_order). CHECK — a deferrable statement-level constraint trigger asserts the template contains at least one stage of each of open, earning and lost, so a seeded board can never be gate-incapable.
- **RLS:** tenant_scoped class. FOR ALL TO crm_app USING (tenant_id = app.current_tenant()) WITH CHECK (tenant_id = app.current_tenant() AND app.scope_is_admin()).
- **Soft delete:** None. Templates are replaced wholesale by an admin action; instantiated stages are independent rows so editing a template never touches a live board.

### `lost_reason`
Seeded, tenant-configurable typified loss reasons. Reporting keys on code, never on label, so relabelling never breaks a report.

- **Columns:** tenant_id uuid; id uuid DEFAULT uuidv7(); code text NOT NULL; label text NOT NULL; sort_order smallint NOT NULL; deactivated_at timestamptz
- **Constraints:** PK (tenant_id, id). UNIQUE (tenant_id, code). No delete path at the privilege level (crm_app has no DELETE anywhere).
- **RLS:** tenant_scoped class: readable by everyone in the tenant, writable only under the admin scope.
- **Soft delete:** deactivated_at, never deleted. Historical opportunities carry lost_reason_id FKs; removing a reason would either break the FK or silently blank a closed deal's explanation.

### `lead_source`
Seeded lead-source vocabulary stamped on every lead. Feeds the vendor-quality reporting that turns duplicate rate and bad-number rate into a purchasing decision.

- **Columns:** tenant_id uuid; id uuid DEFAULT uuidv7(); code text NOT NULL; label text NOT NULL; vendor_name text; deactivated_at timestamptz
- **Constraints:** PK (tenant_id, id). UNIQUE (tenant_id, code).
- **RLS:** tenant_scoped class, admin write.
- **Soft delete:** deactivated_at only, same reasoning as lost_reason.

### `contact`
The person. Owner-scoped identity: two sellers who both buy the same consumer get two contact rows, by design, because identity is owner-wide while suppression is tenant-wide. Holds the three-timezone model's lead_local_tz plus its confidence and source.

- **Columns:** tenant_id uuid; id uuid DEFAULT uuidv7(); owner_user_id uuid NOT NULL; full_name text NOT NULL; email_norm citext; state_code char(2); zip5 char(5); lead_local_tz text; tz_confidence app.tz_confidence NOT NULL DEFAULT 'unknown' (ENUM: high|medium|low|unknown); tz_source app.tz_source (ENUM: zip|area_code|state|manual); lead_source_id uuid; created_via app.contact_created_via NOT NULL (ENUM: lead_intake|manual|inbound_call|import|merge_survivor); became_client_at timestamptz; last_touch_at timestamptz; created_at timestamptz NOT NULL; redacted_at timestamptz; redaction_reason text; deleted_at timestamptz
- **Constraints:** PK (tenant_id, id). FK (tenant_id, owner_user_id) REFERENCES app_user. FK (tenant_id, lead_source_id) REFERENCES lead_source. UNIQUE (tenant_id, owner_user_id, email_norm) WHERE email_norm IS NOT NULL AND deleted_at IS NULL — owner-scoped identity; note it does NOT exclude redacted rows (see softDelete). CHECK ((tz_confidence = 'unknown') = (lead_local_tz IS NULL)). DEFERRABLE INITIALLY DEFERRED CONSTRAINT TRIGGER: at COMMIT, a contact with created_via='lead_intake' that has zero opportunity rows raises — this is the database-level form of 'a lead never exists without a card' and it makes the atomicity of contact+opportunity a Postgres fact rather than a code convention.
- **RLS:** owner_scoped class. USING (tenant_id = app.current_tenant() AND (owner_user_id = app.current_user_id() OR app.scope_is_global())) WITH CHECK (tenant_id = app.current_tenant() AND owner_user_id = app.current_user_id()). The asymmetry IS the supervisor rule: a supervisor's SELECT passes USING, their UPDATE passes USING but fails WITH CHECK with SQLSTATE 42501, which the API maps to 403 'Supervisors have read-only access'. A seller's cross-silo read simply returns zero rows, which the API maps to the owner-scoped not-found. Two denial semantics fall out of one policy shape instead of being hand-written per route.
- **Soft delete:** BOTH, and they are different things. deleted_at = archived, excluded by the contact_live security_invoker view which is the only relation crm_app can read. redacted_at = CCPA erasure: full_name, email_norm, zip5 blanked in place, phone rows kept (see contact_phone). The unique index deliberately does NOT exclude redacted rows: a redacted contact keeps its identity slot so a re-post of the same person matches the skeleton and is refused, rather than creating a shadow record for someone who asked to be erased.

### `contact_phone`
Numbers are first-class because contactability facts (bad number, suppression, dedupe, webhook attribution) are per-number, not per-contact. Separating them is a required correction flagged in the functional map; without it the same physical number in two records has two truths.

- **Columns:** tenant_id uuid; id uuid DEFAULT uuidv7(); contact_id uuid NOT NULL; owner_user_id uuid NOT NULL (denormalized); phone_e164 text NOT NULL; kind app.phone_kind NOT NULL DEFAULT 'mobile'; is_primary boolean NOT NULL DEFAULT false; bad_number_at timestamptz; bad_number_reason text; created_at timestamptz NOT NULL; redacted_at timestamptz
- **Constraints:** PK (tenant_id, id). FK (tenant_id, contact_id) REFERENCES contact. FK (tenant_id, owner_user_id) REFERENCES app_user. CHECK (phone_e164 ~ '^\+[1-9][0-9]{7,14}$') — E.164 normalization becomes unfalsifiable at the storage layer, not a helper someone can forget at one of the six ingress points. UNIQUE (tenant_id, owner_user_id, phone_e164) WHERE deleted-equivalent IS NULL — owner-scoped identity, the exact scope the dedupe rule requires. UNIQUE (tenant_id, contact_id) WHERE is_primary — one primary per contact.
- **RLS:** owner_scoped class, same shape as contact.
- **Soft delete:** redacted_at only, and redaction deliberately does NOT blank phone_e164. Documented minimization exception: the number is the key by which we are legally obliged to refuse future contact; hashing or blanking it would destroy the ability to honor a STOP. Same argument as suppression_list.

### `opportunity`
The sale process, decoupled from the contact so one contact can carry an FE policy and, 45 days later, an independent IUL opportunity with its own card, premium and close date on one unbroken timeline. Holds both money columns and the denormalized current_stage_type that turns both gates into CHECK constraints.

- **Columns:** tenant_id uuid; id uuid DEFAULT uuidv7(); owner_user_id uuid NOT NULL; contact_id uuid NOT NULL; pipeline_id uuid NOT NULL; stage_id uuid NOT NULL; current_stage_type app.stage_type NOT NULL; premium_monthly_cents bigint; premium_annual_cents bigint; premium_mode app.premium_mode; product_type app.product_type; carrier text; policy_number text; draft_date date; lost_reason_id uuid; lost_reason_note text; parent_opportunity_id uuid; created_from app.opportunity_created_from NOT NULL; stage_entered_at timestamptz NOT NULL DEFAULT clock_timestamp(); last_activity_at timestamptz; attempt_count integer NOT NULL DEFAULT 0; first_touch_latency_seconds integer; celebrated_at timestamptz; created_at timestamptz NOT NULL; deleted_at timestamptz
- **Constraints:** PK (tenant_id, id). FK (tenant_id, contact_id) REFERENCES contact. FK (tenant_id, stage_id, current_stage_type) REFERENCES stage (tenant_id, id, stage_type) — the composite FK makes the denormalized stage type provably identical to the stage's real type without a trigger and without a join. THE TWO GATES AS DATABASE CONSTRAINTS: CHECK (current_stage_type <> 'earning' OR premium_annual_cents IS NOT NULL) and CHECK (current_stage_type <> 'lost' OR lost_reason_id IS NOT NULL). A raw API call, a CSV import, an automation or a future route that skips the service layer cannot produce the row at all. MONEY CONSTRAINTS: CHECK (premium_annual_cents IS NULL OR premium_annual_cents BETWEEN 100 AND 10000000) ($1–$100,000/yr); CHECK (premium_monthly_cents IS NULL OR premium_annual_cents = premium_monthly_cents * 12) — exact annualization is a database invariant, so a float bug produces a constraint violation and the seller sees the specified failure copy instead of a silently-wrong public number; CHECK ((premium_mode IS NULL) = (premium_annual_cents IS NULL)) — no premium without an explicit Monthly/Annual choice, which is the durable form of 'no preselected default'. COLUMN IMMUTABILITY TRIGGERS: celebrated_at may transition NULL -> value exactly once and never again; first_touch_latency_seconds may be written once and never overwritten. FK (tenant_id, parent_opportunity_id) REFERENCES opportunity — self-reference for cross-sell.
- **RLS:** owner_scoped class, identical shape to contact.
- **Soft delete:** deleted_at exists but is used only for admin-corrected mis-creations, and crm_app reads only opportunity_live. Opportunities are normally retired by moving to a lost stage, never removed: a removed opportunity would break the ledger's triggering_opportunity_id reference and make an all-time board unexplainable.

### `stage_transition`
Append-only record of every stage move: the row the gate writes, the evidence a ledger entry points back to, the home of the sendBeacon idempotency key, and the source of opportunity.stage_changed. Time-in-stage history was 'cut' as a feature, but this table is not a feature — it is where three separate non-negotiables have to live.

- **Columns:** tenant_id uuid; id uuid DEFAULT uuidv7(); opportunity_id uuid NOT NULL; from_stage_id uuid; from_stage_name_snapshot text; from_stage_type app.stage_type; to_stage_id uuid NOT NULL; to_stage_type app.stage_type NOT NULL; to_stage_name_snapshot text NOT NULL; actor_user_id uuid; actor_type app.actor_type NOT NULL (ENUM: human|system|automation|import|webhook|scheduler); moved_via app.moved_via NOT NULL (kanban_drag|move_sheet|keyboard|wrap_up|command_palette|api|automation); client_move_key uuid; stage_config_version bigint NOT NULL; days_in_previous_stage integer; occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
- **Constraints:** PK (tenant_id, id). UNIQUE (tenant_id, client_move_key) WHERE client_move_key IS NOT NULL — the sendBeacon-plus-retry double delivery becomes a success path, not a duplicate move. HUMAN-ONLY EARNING TRANSITIONS AS A CHECK: CHECK (to_stage_type <> 'earning' OR actor_type = 'human'). A CSV import, a webhook, a reminder job, a merge or an API token physically cannot write a row that credits money; the service layer's job is only to produce the friendly error and the admin_alert row. APPEND-ONLY: BEFORE UPDATE OR DELETE OR TRUNCATE FOR EACH STATEMENT trigger raising AP001, plus REVOKE UPDATE, DELETE, TRUNCATE.
- **RLS:** append_only_owner class. USING (tenant_id = app.current_tenant() AND (owner_user_id-of-parent via denormalized owner_user_id column = app.current_user_id() OR app.scope_is_global())) WITH CHECK (false) for crm_app — writes go only through app.stage_move(), a SECURITY DEFINER function, so the 'exactly one server-side stage-transition service' ruling becomes a privilege fact rather than a code-review promise. (owner_user_id is denormalized onto this table for exactly this predicate.)
- **Soft delete:** None. Immutable append-only.

### `earnings_ledger`
The one artifact the product cannot reconstruct. Append-only signed deltas, single writer, exactly-once per source_event_id, period_key stamped from day one, forward-only with corrections as new reversing rows. Its owner_user_id is the seller who EARNED the money and is never re-attributed, so the leaderboard never joins through contact.owner_user_id.

- **Columns:** tenant_id uuid; id uuid DEFAULT uuidv7(); owner_user_id uuid NOT NULL; source_event_id uuid NOT NULL; source_event_name app.event_name NOT NULL; entry_type app.ledger_entry_type NOT NULL (ENUM: sale|reversal|value_correction|manual_adjustment); delta_cents bigint NOT NULL; currency char(3) NOT NULL DEFAULT 'USD'; opportunity_id uuid NOT NULL; contact_id uuid NOT NULL; stage_id uuid; stage_name_snapshot text NOT NULL; stage_config_version bigint NOT NULL; product_type app.product_type; period_day date NOT NULL; period_week date NOT NULL; period_month date NOT NULL; business_tz_snapshot text NOT NULL; reason text; actor_user_id uuid; occurred_at timestamptz NOT NULL; recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(); reverses_entry_id uuid
- **Constraints:** PK (tenant_id, id). UNIQUE (tenant_id, source_event_id) — the exactly-once guarantee; the second delivery is caught as a SUCCESS path (logged, not surfaced) by the writer function. CHECK (delta_cents <> 0). CHECK (currency = 'USD'). CHECK (entry_type <> 'sale' OR delta_cents > 0). CHECK (entry_type <> 'reversal' OR delta_cents < 0). CHECK (period_month = date_trunc('month', period_day)::date) and CHECK (period_week = date_trunc('week', period_day)::date) — internal consistency of the three period keys, so a partially-wrong timezone computation cannot produce three mutually incoherent buckets. FK (tenant_id, reverses_entry_id) REFERENCES earnings_ledger. IMMUTABLE BY ENGINE: BEFORE UPDATE OR DELETE OR TRUNCATE FOR EACH STATEMENT trigger raising SQLSTATE AP001 unconditionally (statement-level so even a zero-row DELETE errors loudly, and TRUNCATE — which bypasses row triggers and DELETE privileges entirely — is covered), plus REVOKE INSERT, UPDATE, DELETE, TRUNCATE FROM crm_app. crm_app has NO DML at all: the only write path is app.ledger_append(...), SECURITY DEFINER. Consequence Jorge can see: when the model writes .onConflictDoUpdate() on the ledger — and it will, because that is the public idiom of upsert — Postgres returns permission denied, the gate returns 500, and the seller reads the specified copy on screen that minute.
- **RLS:** append_only_owner class. FOR ALL TO crm_app USING (tenant_id = app.current_tenant() AND (owner_user_id = app.current_user_id() OR app.scope_is_global())) WITH CHECK (false). WITH CHECK is literally false and therefore non-null, satisfying the every-policy-declares-both gate while making the write path structurally impossible for the app role. Second policy FOR ALL TO crm_migrator USING (true) WITH CHECK (true) is what lets the SECURITY DEFINER writer function through.
- **Soft delete:** None, and none is possible. This is the definition of the table.

### `leaderboard_projection`
The maintained aggregate the 5-second poll reads, so the board never SUMs the ledger and never scans opportunities. One row per (tenant, period_type, period_key, user). Carries the monotonic seq that is the ETag source.

- **Columns:** tenant_id uuid; period_type app.period_type NOT NULL (ENUM: day|week|month|all_time); period_key date NOT NULL (epoch date 1970-01-01 for all_time); user_id uuid NOT NULL; total_cents bigint NOT NULL DEFAULT 0; entry_count integer NOT NULL DEFAULT 0; seq bigint NOT NULL; last_entry_recorded_at timestamptz; updated_at timestamptz NOT NULL
- **Constraints:** PK (tenant_id, period_type, period_key, user_id). CHECK (period_type <> 'all_time' OR period_key = DATE '1970-01-01'). seq comes from a per-tenant sequence bumped inside app.ledger_append so the ETag is write-derived. NOTE THE ETag SUBTLETY, which is a real correctness trap: the public value is time-dependent (entries younger than the undo window are excluded), so a purely write-derived ETag would return 304 while the visible number changed as a pending entry aged out. The ETag is therefore hash(max(seq), pending_watermark) where pending_watermark is the max recorded_at inside the window or 0. It changes exactly once more per win and is stable the rest of the time.
- **RLS:** tenant_scoped_read class and it is SANCTIONED CROSS-SILO EXCEPTION #1 of exactly two. FOR ALL TO crm_app USING (tenant_id = app.current_tenant()) WITH CHECK (false) — every seller in the tenant reads every row, nobody writes. The column set contains no lead, contact or opportunity data, so the thing that cannot be leaked is the thing that is not there.
- **Soft delete:** None. Fully rebuildable from earnings_ledger by one replay job; that rebuildability is what makes 'a monthly reset is a config flip' true.

### `consent_ledger`
Append-only, per channel, per contact VALUE (E.164 or lowercased email), tenant-scoped. A revocation is a new row, never an update, so the state at the moment of any past send is provable years later. Carries the vendor certificate reference and the attesting admin for CSV imports.

- **Columns:** tenant_id uuid; id uuid DEFAULT uuidv7(); contact_value_kind app.contact_value_kind NOT NULL (phone|email); contact_value_norm text NOT NULL; channel app.channel NOT NULL (sms|call|email|whatsapp_reserved); status app.consent_status NOT NULL (granted|revoked|dnc_suppressed); consent_type app.consent_type NOT NULL (express_written|implied|none); source app.consent_source NOT NULL (stop_keyword|manual|dnc_list|vendor_certificate|booking_capture|import_attestation|recycle_revalidation); vendor_name text; certificate_url text; certificate_captured_at timestamptz; jurisdiction_state char(2); captured_ip inet; attesting_admin_user_id uuid; contact_id uuid; previous_status app.consent_status; evidence_ref text; effective_at timestamptz NOT NULL; recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(); actor_user_id uuid
- **Constraints:** PK (tenant_id, id). CHECK (contact_value_kind <> 'phone' OR contact_value_norm ~ '^\+[1-9][0-9]{7,14}$'). CHECK (source <> 'import_attestation' OR attesting_admin_user_id IS NOT NULL) — an import cannot assert consent without naming the admin who attested it. IMMUTABLE BY ENGINE: same statement-level trigger raising AP001 plus REVOKE INSERT, UPDATE, DELETE, TRUNCATE from crm_app; the only writer is app.consent_append(), SECURITY DEFINER.
- **RLS:** definer_only class. FOR ALL TO crm_app USING (false) WITH CHECK (false) — an EXPLICIT deny policy, not the absence of a policy, so the catalog gate's 'at least one policy' rule is met honestly. crm_app cannot SELECT this table at all; it may only EXECUTE app.compliance_check(contact_id) which returns a verdict enum plus a reason code and never a row, and app.consent_state(contact_id) which re-asserts ownership inside the function body. The cross-silo privacy oracle is closed at the privilege level rather than by discipline.
- **Soft delete:** None. Immutable append-only. Erasure of the underlying contact never touches consent rows: the minimal skeleton that lets us legally refuse future contact is explicitly exempt from erasure.

### `suppression_list`
Tenant-scoped, keyed on E.164, append-only. STOP adds a row; START/UNSTOP appends a re-opt-in row preserving the prior one. A STOP disables Call and Text for that number for every seller immediately, which is why this table is deliberately NOT owner-scoped: ping-post resells the same consumer to two sellers in one agency.

- **Columns:** tenant_id uuid; id uuid DEFAULT uuidv7(); phone_e164 text NOT NULL; kind app.suppression_kind NOT NULL (stop|start|dnc_federal|dnc_state|internal|litigator|carrier_block); channel app.channel; source_message_id uuid; evidence_ref text; effective_at timestamptz NOT NULL; recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(); actor_user_id uuid; reason text
- **Constraints:** PK (tenant_id, id). CHECK (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'). IMMUTABLE BY ENGINE, same mechanism as consent_ledger. I am ADDING this table to the immutable set beyond the three named in the brief: it costs one trigger and one REVOKE, it is exactly the same evidentiary class, and an UPDATE that flips a STOP to a START is the single cheapest way to commit a TCPA violation.
- **RLS:** definer_only class. crm_app has no SELECT and no DML; access is only through app.compliance_check() and app.suppression_append(). Every SECURITY DEFINER function's body must contain app.current_tenant(), asserted by a CI query over pg_proc.prosrc — a grep-level gate that catches the one way a definer function can become a cross-tenant hole.
- **Soft delete:** None. Immutable append-only.

### `audit_log`
The append-only sink for every privileged write and for supervisor book views. Actor, timestamp, entity, before/after. No API path updates or deletes a row, admins included. Partitioned monthly because every gate verdict and every dial attempt writes one and volume is 10k–30k/day.

- **Columns:** tenant_id uuid; occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(); id uuid DEFAULT uuidv7(); actor_user_id uuid; actor_type app.actor_type NOT NULL; action text NOT NULL; subject_type text NOT NULL; subject_id uuid; before jsonb; after jsonb; reason text; verdict app.gate_verdict; verdict_input_snapshot jsonb; override_id uuid; correlation_id uuid; source_ip inet; user_agent text; dedupe_bucket timestamptz
- **Constraints:** PARTITION BY RANGE (occurred_at), monthly. PK (tenant_id, occurred_at, id). CHECK (action = ANY(app.audit_action_list())) where the list is generated from the same registry file that generates the TypeScript union. UNIQUE (tenant_id, action, actor_user_id, subject_id, dedupe_bucket) WHERE dedupe_bucket IS NOT NULL — this is how book.viewed stays cheap enough to run on every supervisor global read without blowing API p95: one row per 5-minute bucket via INSERT ... ON CONFLICT DO NOTHING. Bucketing by INSERT-or-nothing, never by UPDATE, because the table is immutable. NOTE: book.viewed is an AUDIT ROW, not an event — the event catalog explicitly rejected it as an event name, and that is consistent, because audit rows are not required to be events. IMMUTABLE BY ENGINE, same mechanism; writes only through app.audit_write().
- **RLS:** append_only_tenant_admin class. FOR ALL TO crm_app USING (tenant_id = app.current_tenant() AND app.scope_is_admin()) WITH CHECK (false).
- **Soft delete:** None. Never purged, never archived out of Postgres. This and earnings_ledger and consent_ledger are the permanent-in-Postgres set.

### `event_log`
The event store: all 49 canonical events with the mandatory 9-field envelope as real columns plus a jsonb payload. It is the system of record for replay — not the queue, not pg-boss, not a broker retention window — because an all-time board must be rebuildable from scratch as one job.

- **Columns:** tenant_id uuid; occurred_at timestamptz NOT NULL; event_id uuid NOT NULL; owner_user_id uuid NOT NULL; actor_user_id uuid; occurred_at_ms bigint NOT NULL; recorded_at_ms bigint NOT NULL; schema_version smallint NOT NULL; source_system app.source_system NOT NULL (app|aloware|vendor_post|scheduler|import); correlation_id uuid NOT NULL; event_name app.event_name NOT NULL; subject_type text NOT NULL; subject_id uuid NOT NULL; idempotency_key text NOT NULL; payload jsonb NOT NULL; seq bigint NOT NULL DEFAULT nextval('app.event_seq'); retention_class app.retention_class NOT NULL (permanent|archivable)
- **Constraints:** PARTITION BY RANGE (occurred_at), monthly. PK (tenant_id, occurred_at, event_id). owner_user_id NOT NULL — an unowned event is invisible to everyone in a silo model, so an inbound call from an unknown number goes to unmapped_inbound_quarantine, which is deliberately NOT an event table. app.event_name is a Postgres ENUM with exactly 49 labels generated from one registry file that also generates the TypeScript union; a CI test asserts enum_range matches the registry exactly, so an event outside the catalog cannot be written and a consumer subscribing to a non-existent name fails at build. NOTE ON event_id UNIQUENESS: a globally unique index across partitions requires the partition key in the key, which it is not. Global uniqueness is guaranteed by generation (uuidv7 minted at the four ingress adapters) and enforced per-partition; the dedupe that actually matters for external redelivery is the natural key, per the catalog's own rule. IMMUTABLE BY ENGINE; only writer is app.event_emit(), which in the SAME transaction writes the event row AND its event_outbox fan-out rows.
- **RLS:** append_only_owner class for crm_app reads (owner or global scope), WITH CHECK (false). The outbox relay's cross-tenant claim happens on event_outbox through a definer function, never on event_log.
- **Soft delete:** None. retention_class='permanent' (money, consent, contact, opportunity, admin — roughly 30 of the 49) never leaves Postgres. retention_class='archivable' (the high-volume operational tail: call.*, message.*, activity.*, appointment.starting_soon) has its partitions COPYed to R2 and DETACHed after 13 months, recorded in event_archive_manifest. Nothing is ever deleted; the archive tier is R2 and the manifest is permanent. This is the one storage line that grows monotonically and it is the only serious reason to reconsider the platform within a year.

### `event_outbox`
Durable at-least-once fan-out: one row per (event, consumer) written in the SAME transaction as the event, so a consumer can never be lost by a process dying mid-dispatch. Division of labour with pg-boss is deliberate and total: THE OUTBOX OWNS FAN-OUT, PG-BOSS OWNS TIME (delays, schedules, singleton serialization).

- **Columns:** tenant_id uuid; created_day date NOT NULL; event_id uuid NOT NULL; consumer_name text NOT NULL; event_name app.event_name NOT NULL; status app.outbox_status NOT NULL DEFAULT 'pending' (pending|claimed|delivered|dead); attempts smallint NOT NULL DEFAULT 0; next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(); claimed_at timestamptz; claimed_by text; last_error text; delivered_at timestamptz; replay_of_run_id uuid
- **Constraints:** PARTITION BY RANGE (created_day), daily. PK (tenant_id, created_day, event_id, consumer_name). FK (consumer_name, event_name) REFERENCES event_consumer — a row for a consumer that does not exist cannot be written. Claim uses SELECT ... FOR UPDATE SKIP LOCKED inside app.outbox_claim(batch), a SECURITY DEFINER function that is one of the four enumerated CROSS-TENANT system paths (the others: scheduled-job dispatcher, retention purge, restore drill). It returns only (tenant_id, event_id, consumer_name, event_name) — no joins, no payload — and dispatch then sets the per-row tenant/owner context before touching anything else.
- **RLS:** system_cross_tenant class. FOR ALL TO crm_app USING (false) WITH CHECK (false); FOR ALL TO crm_migrator USING (true) WITH CHECK (true).
- **Soft delete:** None; the whole partition is dropped after 14 days, and the pruner refuses to drop a partition containing any row with status <> 'delivered' (non-delivered rows are moved to dead_letter first). Replay does not read this table: replay reads event_log and re-materializes outbox rows, and idempotency on replay is carried by each consumer's natural key, which is the catalog's own rule.

### `event_consumer`
The compile-checkable consumer registry. Declares which consumer handles which event name, whether delivery is inline (in the emitting transaction), outbox (post-commit fan-out) or pgboss (needs time or singleton serialization), and the singleton key expression when it does.

- **Columns:** consumer_name text; event_name app.event_name; delivery app.delivery_mode NOT NULL; singleton_key_expr text; max_attempts smallint NOT NULL DEFAULT 8; backoff_seconds integer[] NOT NULL
- **Constraints:** PK (consumer_name, event_name). CHECK (delivery <> 'pgboss' OR singleton_key_expr IS NOT NULL) for the serialization-critical consumers. Seeded from a generated file; a CI test asserts the table's contents equal the registry file and that every consumer_name has an exported handler in the TypeScript union — this is what makes 'a subscriber to a name that does not exist fails at build' true. The two-tier classification (inline vs post-commit) is DECLARED here rather than discovered: only the ledger append and the gate emission are inline; the other seven-to-nine consumers of lead.created and opportunity.won are post-commit, which is what protects the 300ms API p95 on the single most important gesture in the product.
- **RLS:** reference class — on the versioned exception list, reason: global registry with no tenant dimension, read-only to crm_app, seeded by migration only. Lives in schema ref.
- **Soft delete:** None.

### `inbound_webhook_event`
The durable landing zone for every Aloware webhook. Write-first, respond-fast, process-async: the handler INSERTs verbatim, enqueues one pg-boss job with singletonKey = aloware_call_id, and returns 204. It never merges, never parses business meaning, never touches the domain.

- **Columns:** tenant_id uuid; received_at timestamptz NOT NULL DEFAULT clock_timestamp(); id uuid DEFAULT uuidv7(); provider app.provider NOT NULL DEFAULT 'aloware'; provider_event_id text; provider_event_type text; aloware_call_id text; provider_message_id text; from_number_e164 text; to_number_e164 text; signature_valid boolean; signature_scheme text; raw_payload_id uuid NOT NULL; occurred_at_provider timestamptz; status app.webhook_status NOT NULL DEFAULT 'received' (received|merged|quarantined|failed|dead); attempt_count smallint NOT NULL DEFAULT 0; last_error text; merged_call_id uuid; merged_message_id uuid
- **Constraints:** PARTITION BY RANGE (received_at), monthly. PK (tenant_id, received_at, id). UNIQUE (tenant_id, provider, provider_event_id) WHERE provider_event_id IS NOT NULL — provider-level dedupe. signature_valid is NULLABLE ON PURPOSE: the spike has not yet established whether Aloware signs at all, and a NOT NULL boolean would force a lie. FK (tenant_id, raw_payload_id) REFERENCES raw_payload_vault. An unmapped from_number writes an admin_alert of kind unmapped_number and an unmapped_inbound_quarantine row; it is never silently dropped and never written to any seller's book.
- **RLS:** tenant_admin_only class: FOR ALL TO crm_app USING (tenant_id = app.current_tenant() AND app.scope_is_admin()) WITH CHECK (false). Ingestion writes through app.webhook_ingest(), definer.
- **Soft delete:** None at row level. Metadata rows are retained 13 months then archived with their partition; the PII-bearing bodies live in raw_payload_vault on a much shorter clock. Separating the two lifecycles is both the privacy answer and the cheapest storage answer.

### `raw_payload_vault`
Verbatim bodies for BOTH vendor ping-post intake and Aloware webhooks, stored before validation, parsing or dedupe so a mapping bug is recoverable and a rejected payload is never lost. This is the storage-cost driver, so it is the one table with a two-stage residence: Postgres first (durability), R2 after (cost).

- **Columns:** tenant_id uuid; received_at timestamptz NOT NULL DEFAULT clock_timestamp(); id uuid DEFAULT uuidv7(); origin app.vault_origin NOT NULL (intake|webhook); intake_source_id uuid; body_raw bytea; body_sha256 bytea NOT NULL; body_bytes integer NOT NULL; r2_object_key text; content_type text; headers jsonb NOT NULL; source_ip inet NOT NULL; signature_valid boolean; parse_status app.parse_status NOT NULL DEFAULT 'unparsed' (unparsed|parsed|rejected_no_contact_point|rejected_schema|duplicate_ignored); reject_reason text; dedupe_key text; dedupe_bucket date; materialized_contact_id uuid; replay_of_id uuid; purge_after date NOT NULL
- **Constraints:** PARTITION BY RANGE (received_at), monthly, so retention purge is a DROP PARTITION (O(1), no bloat) instead of a mass DELETE. PK (tenant_id, received_at, id). CHECK (body_raw IS NOT NULL OR r2_object_key IS NOT NULL) — the body is never nowhere; the offloader job uploads to R2 and only then nulls body_raw. COMPOSITE INTAKE IDEMPOTENCY: UNIQUE (tenant_id, intake_source_id, dedupe_key, dedupe_bucket) WHERE origin='intake', where dedupe_key = coalesce(vendor_lead_id, encode(sha256(phone_e164 || body_sha256),'hex')) and dedupe_bucket = received_at::date. This implements the ruling that vendor_lead_id cannot be relied on (many vendors send none) with a 24-hour window expressed as a real unique index rather than an application check-then-insert. The intake error log is not a separate table: it is parse_status <> 'parsed' plus a partial index, exposed as the view app.intake_error.
- **RLS:** tenant_admin_only class, WITH CHECK (false); writes via app.vault_write(), definer.
- **Soft delete:** None. purge_after drives partition drop; R2 lifecycle rules do the object expiry mechanically so there is no purge job anyone can forget. The retention window itself (30/45/90 days) is unresolved in the source documents and is an open question below.

### `dead_letter`
One table for every terminal failure: an inbound webhook that failed signature verification or threw after N retries, an outbox delivery that exhausted its backoff, or a pg-boss job that died N times. Nothing is ever discarded. Its row count is the admin-visible counter on /admin/integration-health.

- **Columns:** tenant_id uuid; id uuid DEFAULT uuidv7(); origin app.dlq_origin NOT NULL (inbound_webhook|outbox|job); subject_type text NOT NULL; subject_id uuid NOT NULL; consumer_name text; event_name app.event_name; raw_payload_id uuid; payload_snapshot jsonb; attempt_count smallint NOT NULL; last_error text NOT NULL; first_failed_at timestamptz NOT NULL; dead_lettered_at timestamptz NOT NULL DEFAULT clock_timestamp(); replayed_at timestamptz; replayed_by_user_id uuid; resolution text
- **Constraints:** PK (tenant_id, id). UNIQUE (tenant_id, origin, subject_type, subject_id) — a subject dead-letters once; a second failure of the same subject updates attempt_count rather than creating noise. FK (tenant_id, raw_payload_id) REFERENCES raw_payload_vault so the raw body is retained by reference, never copied and never lost. NOT on the immutable list on purpose: replay must be able to mark a row resolved.
- **RLS:** tenant_admin_only class; replay is an admin-only definer function that re-materializes an outbox row or re-enqueues the merge job.
- **Soft delete:** None. Rows persist with resolution set; the count of unresolved rows is the metric.

### `scheduled_job`
The DOMAIN-level scheduling intent, distinct from pg-boss's own job table which we do not duplicate or wrap around. This is where episode-scoped idempotency and auditable terminal states live: the T-1h reminder, the cold episode, the activity escalation, the celebration broadcast, the retention purge.

- **Columns:** tenant_id uuid; id uuid DEFAULT uuidv7(); kind app.scheduled_kind NOT NULL (meeting_reminder|cold_sweep|activity_escalation|celebration_broadcast|retention_purge|reconciliation_backfill|aloware_health_probe); idempotency_key text NOT NULL; subject_type text NOT NULL; subject_id uuid NOT NULL; owner_user_id uuid; fire_at timestamptz NOT NULL; status app.job_status NOT NULL DEFAULT 'pending' (pending|fired|skipped|canceled|dropped_late); terminal_reason text; boss_job_id text; created_at timestamptz NOT NULL; resolved_at timestamptz; canceled_at timestamptz
- **Constraints:** PK (tenant_id, id). UNIQUE (tenant_id, kind, idempotency_key) WHERE canceled_at IS NULL — this single partial unique index carries all three episode-scoped idempotency requirements at once: the T-1h reminder is kind='meeting_reminder' with idempotency_key = meeting_id||':t_minus_60m' (the (meeting_id, kind) uniqueness the brief demands), the cold episode is opportunity_id||':'||ordinal, the escalation is activity_id||':'||level. Reschedule sets canceled_at on the old row and inserts a new one, so there is always exactly ONE live job per (subject, kind) and never a second enqueue. terminal_reason carries 'skipped: sms_disabled', 'skipped: suppressed', 'dropped: more than 15 minutes late' — a skipped job is a first-class auditable terminal state, which is what makes the SMS-dark rehearsal pass without any path erroring. The compliance gate is re-evaluated AT FIRE TIME from subject_id; the payload deliberately carries no precomputed 'allowed' decision.
- **RLS:** owner_scoped where owner_user_id is set, tenant_scoped otherwise. The dispatcher is one of the four enumerated cross-tenant definer paths.
- **Soft delete:** canceled_at, which is not a soft delete but a real domain state (a reschedule cancels a reminder). Rows are retained: they are the evidence that a reminder was skipped rather than lost.

### `intake_source`
The per-seller ping-post endpoint. The token binds the lead deterministically to one seller with no routing engine anywhere. Tokens are stored hashed with rotation-with-grace, because the adversarial review ruled HMAC and IP allowlists unrealistic for FE lead vendors: the real control set is hashed tokens plus per-source rate limits plus the payload vault.

- **Columns:** tenant_id uuid; id uuid DEFAULT uuidv7(); owner_user_id uuid NOT NULL; label text NOT NULL; token_hash bytea NOT NULL; token_last4 char(4) NOT NULL; rotated_from_id uuid; grace_until timestamptz; lead_source_id uuid NOT NULL; field_map jsonb NOT NULL DEFAULT '{}'; rate_limit_per_minute smallint NOT NULL DEFAULT 120; dedupe_window_hours smallint NOT NULL DEFAULT 24; created_at timestamptz NOT NULL; revoked_at timestamptz
- **Constraints:** PK (tenant_id, id). UNIQUE (token_hash) — deliberately WITHOUT a tenant_id lead, because the token is what RESOLVES the tenant. That makes it a documented cross-tenant index, reachable only through app.resolve_intake_token(hash), a SECURITY DEFINER function that returns (tenant_id, owner_user_id, source_id) or null and nothing else, and that increments its own rate meter. FK (tenant_id, owner_user_id) REFERENCES app_user. Unknown, revoked or malformed token returns 401 with nothing written; a valid token with no usable phone or email returns 422 phone_or_email_required while still persisting the raw body — that asymmetry is why the vault write precedes token-scoped business logic.
- **RLS:** tenant_admin_only for management, definer-only for resolution. crm_app never SELECTs token_hash: the column is not in the readable view.
- **Soft delete:** revoked_at plus grace_until. Never deleted: a revoked token must remain resolvable-to-401 and its historical payloads must remain attributable to the source that sent them.

### `aloware_number_mapping`
The identity map on the hot path of every inbound event: seller to Aloware user to outbound E.164, with a mandatory verification step. Until a real test call resolves to that seller, Call and Text are disabled for them and no webhook is accepted for that number. Forbids a shared outbound line.

- **Columns:** tenant_id uuid; id uuid DEFAULT uuidv7(); user_id uuid NOT NULL; aloware_user_id text NOT NULL; from_number_e164 text NOT NULL; status app.mapping_status NOT NULL DEFAULT 'unverified' (unverified|verified|revoked); verified_at timestamptz; verified_by_call_id uuid; created_at timestamptz; revoked_at timestamptz
- **Constraints:** PK (tenant_id, id). UNIQUE (tenant_id, from_number_e164) WHERE revoked_at IS NULL — one E.164 maps to exactly one seller, enforced by the database rather than by a rollout checklist. UNIQUE (tenant_id, user_id) WHERE revoked_at IS NULL — one live mapping per seller. CHECK (status <> 'verified' OR verified_at IS NOT NULL). CHECK (from_number_e164 ~ '^\+[1-9][0-9]{7,14}$').
- **RLS:** tenant_scoped read (a seller must see their own mapping status to understand why Call is disabled), admin write. USING (tenant_id = app.current_tenant()) WITH CHECK (tenant_id = app.current_tenant() AND app.scope_is_admin()).
- **Soft delete:** revoked_at. Never deleted: historical calls and webhooks are attributed through it, and a departed seller's number must stay resolvable for the audit trail.

### `unmapped_inbound_quarantine`
The one path where 'who owns this?' has no deterministic answer: an inbound call or message from a number matching no mapping. Deliberately NOT an event table, because a quarantined item has no owner_user_id and therefore cannot satisfy the mandatory envelope. Promotion to a real record is what emits lead.created, once, with an owner bound.

- **Columns:** tenant_id uuid; id uuid DEFAULT uuidv7(); from_number_e164 text NOT NULL; to_number_e164 text; raw_payload_id uuid NOT NULL; inbound_webhook_event_id uuid; first_seen_at timestamptz NOT NULL; occurrence_count integer NOT NULL DEFAULT 1; promoted_to_contact_id uuid; promoted_by_user_id uuid; promoted_at timestamptz; dismissed_at timestamptz
- **Constraints:** PK (tenant_id, id). UNIQUE (tenant_id, from_number_e164) WHERE promoted_at IS NULL AND dismissed_at IS NULL — repeated inbound from the same unknown number increments a counter instead of flooding the admin queue. It is explicitly NOT a shared pool and there is no assignment logic: an admin picks an owner, or the row is dismissed.
- **RLS:** tenant_admin_only. FOR ALL TO crm_app USING (tenant_id = app.current_tenant() AND app.scope_is_admin()) WITH CHECK (tenant_id = app.current_tenant() AND app.scope_is_admin()).
- **Soft delete:** dismissed_at. Retained so the number of unattributable inbounds is measurable — it is one of the five health metrics the MVP must serve from tables we already own.

### `activity`
The ONE activity object: every unit of work. A separate tasks table is forbidden by the boundary ruling; app.task is a security_invoker VIEW over activity WHERE type='task', so the name exists for callers without a second object and without a second source of truth for last_activity_at.

- **Columns:** tenant_id uuid; id uuid DEFAULT uuidv7(); owner_user_id uuid NOT NULL; contact_id uuid; opportunity_id uuid; type app.activity_type NOT NULL (call|sms|email|task|appointment_link); title text NOT NULL; due_at timestamptz; priority smallint NOT NULL DEFAULT 0; created_by app.actor_type NOT NULL; source_event_id uuid; source_event_name app.event_name; linked_meeting_id uuid; linked_call_id uuid; completed_at timestamptz; completed_by_user_id uuid; outcome text; auto_completed boolean NOT NULL DEFAULT false; escalation_level smallint NOT NULL DEFAULT 0; created_at timestamptz NOT NULL; canceled_at timestamptz
- **Constraints:** PK (tenant_id, id). FK composites to contact, opportunity, meeting, call. CHECK (contact_id IS NOT NULL OR opportunity_id IS NOT NULL). CHECK (type <> 'task' OR due_at IS NOT NULL) — a scheduled callback has a hard due time by construction. source_event_name is what lets a seller ask 'why is this on my list today' and get a real answer, so it is NOT NULL whenever created_by <> 'human'.
- **RLS:** owner_scoped class.
- **Soft delete:** canceled_at (a cancelled task is not a deleted one, and My Day must be able to explain the difference). No redacted_at: the title can carry PII, so erasure blanks title and outcome in place via the redaction routine, keyed off the parent contact's redacted_at rather than a column here.

### `note`
Content, not work, and therefore its own table rather than an activity type. It needs a mutable body, a version column for If-Match optimistic concurrency, a pinned flag and independent redaction — none of which belong on an append-ish work object. The timeline projects notes and activities together; nothing writes the timeline directly.

- **Columns:** tenant_id uuid; id uuid DEFAULT uuidv7(); owner_user_id uuid NOT NULL; contact_id uuid NOT NULL; opportunity_id uuid; body text NOT NULL; version integer NOT NULL DEFAULT 1; pinned boolean NOT NULL DEFAULT false; created_by_user_id uuid NOT NULL; created_at timestamptz NOT NULL; updated_at timestamptz NOT NULL; redacted_at timestamptz; deleted_at timestamptz
- **Constraints:** PK (tenant_id, id). CHECK (length(body) <= 5000). A BEFORE UPDATE trigger enforces version = OLD.version + 1 and refuses an update whose supplied version does not match — so the 412 path is a database fact, not a service-layer if-statement, and last-write-wins is unreachable. FK (tenant_id, contact_id) REFERENCES contact.
- **RLS:** owner_scoped class.
- **Soft delete:** Both deleted_at (seller removes a note) and redacted_at (CCPA blanks the body, keeps the row so the timeline's ordering and the audit trail survive). crm_app reads only note_live.

### `meeting`
The phone appointment, linked to BOTH contact and opportunity. starts_at_utc and contact_timezone are both mandatory and the timezone is a SNAPSHOT, never a join to the contact — a later contact edit must not retroactively move a past meeting's local time or a reminder's legality.

- **Columns:** tenant_id uuid; id uuid DEFAULT uuidv7(); owner_user_id uuid NOT NULL; contact_id uuid NOT NULL; opportunity_id uuid NOT NULL; starts_at_utc timestamptz NOT NULL; duration_minutes smallint NOT NULL DEFAULT 30; contact_timezone text NOT NULL; meeting_type app.meeting_type NOT NULL DEFAULT 'phone'; created_via app.meeting_created_via NOT NULL; outcome app.meeting_outcome (held|no_show|canceled_by_lead|rescheduled|sold); outcome_at timestamptz; rescheduled_from_meeting_id uuid; originating_no_show_meeting_id uuid; linked_call_id uuid; reminder_consent_captured boolean NOT NULL DEFAULT false; canceled_at timestamptz; created_at timestamptz NOT NULL
- **Constraints:** PK (tenant_id, id). Self-FKs on rescheduled_from and originating_no_show. CHECK (contact_timezone IS NOT NULL) with a trigger validating it against pg_timezone_names. UNIQUE (tenant_id, owner_user_id, starts_at_utc, contact_id) WHERE canceled_at IS NULL — the duplicate guard the two-click Quick Schedule requires, as an index rather than a client check. needs_outcome is a derived predicate (starts_at_utc < now() AND outcome IS NULL), not a stored column, so it can never go stale.
- **RLS:** owner_scoped class.
- **Soft delete:** canceled_at only. A cancelled meeting is evidence (no-show recovery rate, reschedule chains); deleting it would break originating_no_show_meeting_id and the reporting that proves the recovery flow recovers revenue.

### `conversation`
One thread per contact per channel, carrying owner_user_id — the silo at the data layer for messaging. Channel-agnostic from day one with a whatsapp_reserved enum value, so adding WhatsApp later touches zero consumers.

- **Columns:** tenant_id uuid; id uuid DEFAULT uuidv7(); owner_user_id uuid NOT NULL; contact_id uuid NOT NULL; channel app.channel NOT NULL; last_message_at timestamptz; needs_reply_since timestamptz; created_at timestamptz NOT NULL
- **Constraints:** PK (tenant_id, id). UNIQUE (tenant_id, contact_id, channel). needs_reply is a state on the thread, not an event — the catalog explicitly rejected conversation.needs_reply as an event name and this column is where that ruling lands.
- **RLS:** owner_scoped class.
- **Soft delete:** None. The thread is the container; redaction happens on messages.

### `message`
Channel-agnostic outbound and inbound messages. Idempotent on provider_message_id. Carries intent_hint so the legally load-bearing STOP chain (message.received -> consent.updated) has a typed input rather than a regex buried in a handler.

- **Columns:** tenant_id uuid; id uuid DEFAULT uuidv7(); conversation_id uuid NOT NULL; owner_user_id uuid NOT NULL; contact_id uuid NOT NULL; opportunity_id uuid; channel app.channel NOT NULL; direction app.direction NOT NULL; body text; provider_message_id text; provider_status app.provider_status; error_code text; is_hard_bounce boolean; intent_hint app.intent_hint; sent_by app.actor_type; related_meeting_id uuid; unknown_sender boolean NOT NULL DEFAULT false; occurred_at timestamptz NOT NULL; recorded_at timestamptz NOT NULL; redacted_at timestamptz
- **Constraints:** PK (tenant_id, id). UNIQUE (tenant_id, provider_message_id) WHERE provider_message_id IS NOT NULL — the natural-key idempotency the brief demands, and the second delivery is a success path. FK composites to conversation, contact, meeting. CHECK (direction <> 'outbound' OR sent_by IS NOT NULL).
- **RLS:** owner_scoped class.
- **Soft delete:** redacted_at, which blanks body only. Erasure must preserve the row: the fact that a message was sent at a given time to a given number is exactly the evidence a TCPA defense needs, and it is the counterpart of the suppression skeleton.

### `call`
The internal call record, reconciled against Aloware on aloware_call_id. Per-part presence flags rather than one status column, and a monotonic state machine, so a webhook that arrives late can never regress a completed call to pending. Recording and transcript are REFERENCED, never mirrored — no media storage tier exists in this product.

- **Columns:** tenant_id uuid; id uuid DEFAULT uuidv7(); owner_user_id uuid NOT NULL; contact_id uuid NOT NULL; contact_phone_id uuid; opportunity_id uuid; direction app.direction NOT NULL; aloware_call_id text; correlation_id uuid NOT NULL; initiated_via app.call_initiated_via NOT NULL; source app.call_source NOT NULL DEFAULT 'api' (api|manual_degraded|inbound); state app.call_state NOT NULL (initiated|ringing|connected|completed|failed); state_ordinal smallint NOT NULL; disposition_raw text; disposition_canonical app.disposition; talk_time_seconds integer; ring_time_seconds integer; started_at timestamptz; ended_at timestamptz; recording_url text; recording_at timestamptz; transcript_url text; transcript_at timestamptz; ai_summary_text text; ai_summary_at timestamptz; local_time_at_contact timestamptz; gate_verdict app.gate_verdict NOT NULL; override_id uuid; provider_last_event_at timestamptz; merged_manual_call_id uuid; redacted_at timestamptz
- **Constraints:** PK (tenant_id, id). UNIQUE (tenant_id, aloware_call_id) WHERE aloware_call_id IS NOT NULL — nullable at insert and backfilled, because call.initiated is emitted before Aloware confirms and a 5xx after the seller's handset already rang must not erase the attempt. MONOTONIC STATE: BEFORE UPDATE trigger raises if NEW.state_ordinal < OLD.state_ordinal, and merges use COALESCE(NEW.x, OLD.x) per field, so out-of-order arrival produces a final state identical to in-order arrival. THE MERGE HAS EXACTLY ONE HOME: pg-boss queue 'call-merge' with singletonKey = aloware_call_id, with the singleton key in the handler's TYPE SIGNATURE so omitting it does not compile. Two webhooks 50ms apart for the same call are serialized by the queue, not by a SELECT-then-UPDATE that loses one of them. CHECK (gate_verdict IS NOT NULL) — every dial carries the verdict that permitted it, so TCPA is provable per call rather than per contact.
- **RLS:** owner_scoped class.
- **Soft delete:** redacted_at, blanking ai_summary_text and nulling recording_url/transcript_url plus issuing the outbound Aloware media-deletion request. Whether Aloware exposes such an API is unverified, so the row carries a partial-completion state rather than a promise we cannot keep.

### `timeline_entry`
The unified per-contact timeline as a DERIVED PROJECTION. No module writes it. call.enriched updates the existing entry in place and never inserts a second row. Adding a channel touches zero consumers.

- **Columns:** tenant_id uuid; id uuid DEFAULT uuidv7(); contact_id uuid NOT NULL; owner_user_id uuid NOT NULL; occurred_at timestamptz NOT NULL; kind app.timeline_kind NOT NULL (call|message|note|meeting|stage_move|consent|send_blocked|lead_created|repost); ref_type text NOT NULL; ref_id uuid NOT NULL; render_payload jsonb NOT NULL; dedupe_bucket timestamptz; verdict app.gate_verdict; built_from_event_id uuid NOT NULL; built_at timestamptz NOT NULL
- **Constraints:** PK (tenant_id, id). UNIQUE (tenant_id, ref_type, ref_id) — the upsert key that makes late enrichment update in place. UNIQUE (tenant_id, contact_id, verdict, dedupe_bucket) WHERE kind='send_blocked' — one suppressed-send entry per distinct verdict per contact per 60-second bucket, while audit_log gets an un-deduplicated row for EVERY attempt. Two write paths with different dedupe semantics from one evaluation: the timeline is for the seller, the audit log is for the lawyer. WRITE MONOPOLY IS A PRIVILEGE FACT: crm_app has no INSERT or UPDATE on this table; only app.timeline_upsert() (SECURITY DEFINER), called by the projector consumer, can write it. 'Nobody writes timeline rows directly' stops being a code-review rule.
- **RLS:** owner_scoped class for reads, WITH CHECK (false) for crm_app.
- **Soft delete:** None. Fully rebuildable from event_log by the replay job; a corrupt projection is repaired by rebuilding, never by patching.

### `notification`
Owner-scoped, cursor-paginated, deduped by collapse key and source event so a replayed event produces no second notification.

- **Columns:** tenant_id uuid; id uuid DEFAULT uuidv7(); owner_user_id uuid NOT NULL; kind text NOT NULL; severity smallint NOT NULL DEFAULT 1; collapse_key text NOT NULL; source_event_id uuid NOT NULL; title_key text NOT NULL; params jsonb NOT NULL; deep_link text; read_at timestamptz; created_at timestamptz NOT NULL
- **Constraints:** PK (tenant_id, id). UNIQUE (tenant_id, owner_user_id, collapse_key, source_event_id) — replay-safe by construction. Title is a string-catalog KEY plus params, never a rendered sentence, because zero hard-coded user-facing strings is a build-breaking rule and a notification written today must re-render correctly under a future locale.
- **RLS:** owner_scoped class, and notably WITHOUT the scope_is_global() widening: a supervisor has no business reading a seller's notification inbox, and the narrower USING clause is how that is enforced rather than by a route check.
- **Soft delete:** None at row level. Partitioned monthly and dropped after 180 days — a documented retention class that does NOT violate the no-hard-delete rule, because the underlying event is permanent in event_log and a notification is a delivery artifact, not a business fact.

### `break_glass_override`
Admin-only, reason-required, self-expiring at 60 minutes, scoped to exactly two verdicts. Expiry needs no job: it is computed on every read. Suppression, STOP, DNC and sms_enabled are not overridable by any role, and the schema is what makes that true rather than the code.

- **Columns:** tenant_id uuid; id uuid DEFAULT uuidv7(); started_by_user_id uuid NOT NULL; reason text NOT NULL; scope app.override_scope NOT NULL DEFAULT 'timezone_and_window'; started_at timestamptz NOT NULL DEFAULT clock_timestamp(); expires_at timestamptz GENERATED ALWAYS AS (started_at + interval '60 minutes') STORED; ended_at timestamptz; ended_by_user_id uuid; end_reason app.override_end_reason (manual|auto_expired)
- **Constraints:** PK (tenant_id, id). CHECK (length(btrim(reason)) >= 10). CHECK (scope = 'timezone_and_window') — a single-value enum, so the schema literally cannot express an override of suppression or consent. Adding a second value is ALTER TYPE, a migration, a review gate. UNIQUE (tenant_id) WHERE ended_at IS NULL — at most one un-ended override per tenant; clock_timestamp() cannot appear in an index predicate (not immutable), so the engage path first closes any expired row (ended_at := expires_at, end_reason := 'auto_expired'), a deterministic two-statement fixup. Every permitted dial writes an audit row carrying override_id.
- **RLS:** tenant_scoped read (the amber banner must reach every signed-in user, including supervisors), admin write. Seller and supervisor requests to the override ENDPOINT return the owner-scoped not-found, never a 403 — the not-found rule extends from records to routes.
- **Soft delete:** None. Ended overrides are permanent evidence; duration is the first thing an auditor asks for.

### `cold_episode`
Makes opportunity.went_cold idempotent per cold EPISODE rather than per opportunity, which is the difference between a badge and a notification firehose. Also stabilizes the episode key that the five would-be writers of last_activity_at were destabilizing.

- **Columns:** tenant_id uuid; id uuid DEFAULT uuidv7(); opportunity_id uuid NOT NULL; owner_user_id uuid NOT NULL; ordinal smallint NOT NULL; threshold_days smallint NOT NULL; started_at timestamptz NOT NULL; ended_at timestamptz; ended_by_activity_id uuid
- **Constraints:** PK (tenant_id, id). UNIQUE (tenant_id, opportunity_id, ordinal). UNIQUE (tenant_id, opportunity_id) WHERE ended_at IS NULL — one open episode at a time, so the sweeper cannot double-fire. RELATED RULING: opportunity.last_activity_at has EXACTLY ONE writer — an AFTER INSERT trigger on activity, call, message and meeting that sets last_activity_at := GREATEST(OLD, NEW.occurred_at). It is monotonic and deterministic, which closes the documented five-writers ambiguity with a max() rule rather than a naming argument.
- **RLS:** owner_scoped class.
- **Soft delete:** None.

### `channel_watermark`
The cheap-304 machine. One row per (tenant, owner, channel) holding a monotonic seq bumped inside the same transaction as the underlying write. A poll reads one row by primary key and answers 304 in single-digit milliseconds instead of re-running the board query. Without this, half a million conditional GETs a day become half a million board queries.

- **Columns:** tenant_id uuid; owner_user_id uuid NOT NULL (the all-zero uuid for tenant-level channels); channel app.poll_channel NOT NULL (board|my_day|notifications|leaderboard|degraded_banner|call_state); seq bigint NOT NULL DEFAULT 0; updated_at timestamptz NOT NULL
- **Constraints:** PK (tenant_id, owner_user_id, channel) — the read is a single index-only lookup. Bumped by the SECURITY DEFINER writers and by AFTER triggers on the underlying tables. The leaderboard row is a per-tenant serialization point for closes; at a few dozen closes a day that is free, and idle_in_transaction_session_timeout bounds the blast radius of a transaction that dies mid-gate holding it alongside the opportunity row lock.
- **RLS:** owner_scoped for per-seller channels, tenant_scoped for the tenant-level ones, WITH CHECK (false) for crm_app.
- **Soft delete:** None.

### `export_job`
Exports are first-class auditable objects, not a streaming response, because the stated catastrophic scenario is a departing agent exporting the whole book. Async job, stored artifact in R2, expiring link, masking driven by a PII classification rather than by a hand-maintained per-report field list.

- **Columns:** tenant_id uuid; id uuid DEFAULT uuidv7(); requested_by_user_id uuid NOT NULL; scope app.export_scope NOT NULL (own|supervisor|tenant); filters jsonb NOT NULL; masking_applied boolean NOT NULL; reason text; row_count integer; r2_object_key text; status app.export_status NOT NULL; requested_at timestamptz NOT NULL; completed_at timestamptz; expires_at timestamptz NOT NULL
- **Constraints:** PK (tenant_id, id). CHECK (scope <> 'tenant' OR reason IS NOT NULL) — a tenant-wide export cannot exist without a written reason. CHECK (scope <> 'supervisor' OR masking_applied). The job runs with the requester's own tenant/owner context set, so an export is scoped by the SAME RLS predicate as the screen it mirrors; there is no privileged export path.
- **RLS:** owner_scoped for the requester, admin-readable tenant-wide.
- **Soft delete:** None. The job row is the insider-exfiltration control; the artifact expires in R2 via lifecycle rule, the record does not.

### `admin_alert`
The five health signals the MVP must serve from tables we already own, materialized as rows rather than reconstructed from logs: unmapped_number, unmapped_disposition, a non-human attempt on an earning stage, DLQ depth crossing a threshold, and an unverified seller mapping.

- **Columns:** tenant_id uuid; id uuid DEFAULT uuidv7(); kind app.admin_alert_kind NOT NULL; subject_type text; subject_id uuid; detail jsonb; first_seen_at timestamptz NOT NULL; last_seen_at timestamptz NOT NULL; occurrence_count integer NOT NULL DEFAULT 1; acknowledged_at timestamptz; acknowledged_by_user_id uuid
- **Constraints:** PK (tenant_id, id). UNIQUE (tenant_id, kind, subject_id) WHERE acknowledged_at IS NULL — repeated occurrences increment a counter instead of flooding the console.
- **RLS:** tenant_admin_only class.
- **Soft delete:** acknowledged_at. Retained: an acknowledged alert is the record that someone saw the problem.

### `tag / contact_tag`
DORMANT IN THE MVP. The governed tag library was explicitly cut as an admin-surface anti-pattern; nothing in the lead lifecycle depends on tags. The tables ship because they are two relations plus generated policies, and because additive schema evolution is a DoD rule so adding them later is legal but adding them now is free.

- **Columns:** tag: tenant_id uuid; id uuid; label text NOT NULL; color text; deleted_at timestamptz. contact_tag: tenant_id uuid; contact_id uuid; tag_id uuid; owner_user_id uuid NOT NULL; created_at timestamptz
- **Constraints:** tag PK (tenant_id, id), UNIQUE (tenant_id, lower(label)) WHERE deleted_at IS NULL. contact_tag PK (tenant_id, contact_id, tag_id). BOTH CARRY A DORMANCY GUARD: a BEFORE INSERT trigger raises unless tenant.tags_enabled is true, and tags_enabled defaults to false with no MVP surface to flip it. A boot assertion asserts both tables are empty when the environment is production. This is the honest way to ship a door without shipping a feature. I flag it as a decision Jorge can reverse: not shipping them at all is equally defensible and removes two relations from the RLS and CI surface.
- **RLS:** tag: tenant_scoped, admin write. contact_tag: owner_scoped (the assignment is the seller's, the vocabulary is the tenant's).
- **Soft delete:** tag.deleted_at; contact_tag has none (unassigning is a real delete, but crm_app has no DELETE privilege anywhere, so unassignment is implemented as a dormant-feature concern deferred with the rest).

### `custom_field_definition / custom_field_value`
DORMANT IN THE MVP, same treatment and same reasoning as tags. The blank-canvas field editor was cut; the MVP ships the four descriptive fields (product_type, carrier, policy_number, draft_date) as REAL TYPED COLUMNS on opportunity, because a typed column is checkable and an EAV row is not.

- **Columns:** custom_field_definition: tenant_id; id; key text NOT NULL; label text NOT NULL; data_type app.cf_type NOT NULL; applies_to app.cf_subject NOT NULL; sort_order smallint; deleted_at timestamptz. custom_field_value: tenant_id; id; definition_id uuid NOT NULL; subject_type text NOT NULL; subject_id uuid NOT NULL; owner_user_id uuid NOT NULL; value_text text; value_number bigint; value_date date; value_bool boolean
- **Constraints:** definition PK (tenant_id, id), UNIQUE (tenant_id, key). value PK (tenant_id, id), UNIQUE (tenant_id, definition_id, subject_id). CHECK on value: exactly one of the four typed value columns is non-null, matched to the definition's data_type by a trigger. Note value_number is bigint, never numeric or double: if a custom field is ever used for money it lands in the same cents discipline as everything else. Same dormancy trigger keyed on tenant.custom_fields_enabled.
- **RLS:** definition: tenant_scoped, admin write. value: owner_scoped.
- **Soft delete:** definition.deleted_at (a deleted definition must not orphan historical values); value: none.

### `system_constant`
The single source of the numbers that must not drift across four languages. undo_window_ms and undo_projection_guard_ms are read by SQL; the same seed file generates the TypeScript token, the CSS custom property and the pg-boss celebration delay, and a CI test fails if any of the four diverge.

- **Columns:** tenant_id uuid; key text NOT NULL; value_num bigint; value_text text; updated_at timestamptz NOT NULL
- **Constraints:** PK (tenant_id, key). CHECK (value_num IS NOT NULL OR value_text IS NOT NULL). Seeded keys: undo_window_ms=5000, undo_projection_guard_ms=500, environment. app.undo_window() returns make_interval(secs => (undo_window_ms + undo_projection_guard_ms)/1000.0), is marked STABLE, and is the ONLY place the leaderboard predicate gets its interval. A CI grep gate fails the build on any occurrence of now() or CURRENT_TIMESTAMP inside the leaderboard SQL module, because now() is transaction start time and being wrong by 200ms is invisible until the day of the demo.
- **RLS:** tenant_scoped read, admin write.
- **Soft delete:** None.

### `tenant_lookup_meter`
Rate-limits the two legitimate cross-silo reads (suppression check and the tenant-wide non-attributive recent-contact signal), because a cross-silo lookup is a privacy oracle that could otherwise be used to enumerate the whole agency's book one phone number at a time.

- **Columns:** tenant_id uuid; user_id uuid NOT NULL; minute_bucket timestamptz NOT NULL; lookup_kind app.lookup_kind NOT NULL; lookup_count integer NOT NULL DEFAULT 1
- **Constraints:** PK (tenant_id, user_id, minute_bucket, lookup_kind). Incremented by INSERT ... ON CONFLICT DO UPDATE inside the same SECURITY DEFINER function that performs the lookup, so the meter cannot be bypassed by calling the lookup a different way — there is no different way. Over the cap the function returns rate_limited and writes an admin_alert.
- **RLS:** definer_only class.
- **Soft delete:** None. Partitioned by day and dropped after 30 days.

### `event_archive_manifest`
The permanent index of archived event partitions in R2. Nothing is deleted; archivable-class months move out of Postgres after 13 months and this manifest is how a replay of an old period finds and verifies them.

- **Columns:** tenant_id uuid; archived_month date NOT NULL; r2_object_key text NOT NULL; row_count bigint NOT NULL; sha256 bytea NOT NULL; min_seq bigint NOT NULL; max_seq bigint NOT NULL; archived_at timestamptz NOT NULL; verified_at timestamptz
- **Constraints:** PK (tenant_id, archived_month). Immutable by engine (same trigger family). verified_at is written by the monthly restore drill, which downloads the object, checks the digest and asserts the row count — so 'the archive exists' is a measured fact with an age, not an assumption.
- **RLS:** tenant_admin_only, WITH CHECK (false).
- **Soft delete:** None.

### `security.table_registry`
THE KEYSTONE OF THE WHOLE RLS DESIGN. Every table in the application schema must be classified here, and security.harden() generates its policies, its GRANTs, its FORCE flag and its immutability trigger FROM the classification. Policies are not authored; they are generated. That removes at the source the entire class of hand-written USING-only policies, which is the single failure mode with no compiler, no type, no exception and no functional test.

- **Columns:** schema_name text; table_name text; policy_class app.policy_class NOT NULL (owner_scoped|tenant_scoped|tenant_admin_only|append_only_owner|append_only_tenant|definer_only|system_cross_tenant|reference); owner_column text; immutable boolean NOT NULL DEFAULT false; app_can_insert boolean NOT NULL DEFAULT true; exception_reason text; registered_in_migration text NOT NULL
- **Constraints:** PK (schema_name, table_name). CHECK (policy_class <> 'reference' OR exception_reason IS NOT NULL) — a table can only be exempted with a written reason. CHECK (policy_class <> 'owner_scoped' OR owner_column IS NOT NULL). THE MECHANISM: security.harden() loops over pg_class in schemas app and ref, and RAISES if it finds a relation with no registry row. It is the LAST statement of the one-shot pre-deploy migration job. Therefore a migration that creates a table without classifying it FAILS THE DEPLOY — the enforcement is not a CI grep that someone can amend, it is the deploy itself. harden() also re-applies everything to newly created PARTITIONS, which is the specific hole a partitioned schema opens and which the brief calls out. A Postgres EVENT TRIGGER on ddl_command_end would automate this further, but CREATE EVENT TRIGGER requires superuser and Render's managed Postgres does not grant it — so the design does NOT depend on one; verify in Sprint 0 and add it as belt-and-braces if available. Second net: the CI pg_class query (FORCE + at least one policy + every policy has both qual and with_check + no policy with cmd <> 'ALL' outside the exception list + crm_app has no DELETE anywhere + crm_app has no UPDATE on immutable tables). Third net: the boot assertion. Fourth net: the monthly restore drill.
- **RLS:** Lives in schema security, on the versioned exception list, reason: it is the metadata that defines RLS and is readable only by crm_migrator; crm_app has no grants on schema security at all.
- **Soft delete:** None.


## Indexes

- opportunity_board_idx BTREE (tenant_id, owner_user_id, stage_id, stage_entered_at DESC, id DESC) INCLUDE (premium_annual_cents, current_stage_type, last_activity_at) WHERE deleted_at IS NULL :: the kanban board — 20 cards per column plus the server-computed count and annualized sum, per column, one round trip :: tenant_id leads because it is the partition key and always an equality; owner_user_id second because it is the silo predicate and P7 explicitly fails an index that only serves the supervisor's global read; stage_id third because each column is one equality; stage_entered_at DESC last because it is the ORDER BY ... LIMIT 20 and it is stable within a stage (unlike last_activity_at, which would make cards jump while the seller watches). INCLUDE carries the premium so the per-column SUM is an index-only scan instead of 300 heap fetches.
- opportunity_cold_sweep_idx BTREE (tenant_id, last_activity_at) WHERE deleted_at IS NULL AND current_stage_type = 'open' :: the staleness sweeper and the rot badges :: partial on open stages only, because closed cards can never go cold and excluding them removes ~70% of the rows from a job that must never fan out per-lead across tenants without a bound. tenant_id leads so the sweeper iterates one tenant at a time by construction.
- contact_name_trgm_idx GIN (tenant_id, owner_user_id, full_name gin_trgm_ops) [requires btree_gin] :: global search Cmd+K, name matching, p95 <= 200ms against 25k contacts :: the two uuid columns are in the GIN key via btree_gin so the ownership predicate is INSIDE the index rather than a post-retrieval filter — a tenant-wide index filtered after retrieval is exactly the silo leak that rules out a separate search service. Fallback if btree_gin/uuid is unavailable on Render PG 18: plain GIN (full_name gin_trgm_ops) plus an owner recheck, which is acceptable at 25k rows but must be MEASURED in Sprint 0, not assumed.
- contact_email_idx BTREE (tenant_id, owner_user_id, email_norm) WHERE email_norm IS NOT NULL AND deleted_at IS NULL :: search by email and intake dedupe by exact lowercased email :: same three-column prefix as every other owner-scoped index so one mental model covers the schema; citext makes the lowercasing a type property rather than a call site anyone can forget.
- contact_phone_owner_idx UNIQUE BTREE (tenant_id, owner_user_id, phone_e164) :: intake dedupe, search by any phone format normalized to E.164, and the owner-scoped identity rule :: this index IS the dedupe rule — identity is owner-wide, so the uniqueness is owner-wide. Two sellers who both buy the same consumer get two contacts and neither can see the other, which is the requirement.
- contact_phone_tenant_idx BTREE (tenant_id, phone_e164) :: the tenant-wide suppression match, the non-attributive recent-contact signal, and inbound webhook attribution :: deliberately WITHOUT owner_user_id — this is the second key scope on the same phone number and the reason contact_phone is a separate table. Reachable only through SECURITY DEFINER functions that return a boolean and a reason code, never a row.
- activity_my_day_idx BTREE (tenant_id, owner_user_id, due_at) WHERE completed_at IS NULL AND canceled_at IS NULL :: My Day 'due now' and 'today', the largest section of the highest-frequency screen :: partial on open work only, so the index stays roughly the size of one seller's open list rather than the 200k historical activities in the perf fixture; due_at last because the section is a range scan ordered by urgency.
- activity_escalation_idx BTREE (tenant_id, due_at, escalation_level) WHERE completed_at IS NULL AND canceled_at IS NULL AND type = 'task' :: the overdue-escalation scheduler :: due_at leads within the tenant because the sweeper asks a time question, not an owner question; escalation_level is in the key so the idempotency lookup for (activity_id, escalation_level) never touches the heap.
- meeting_today_idx BTREE (tenant_id, owner_user_id, starts_at_utc) WHERE canceled_at IS NULL :: today's appointment strip, the Needs Outcome section, and the T-1h reminder scheduler :: starts_at_utc last for the day-range scan; the partial keeps cancelled meetings (which are retained as no-show-recovery evidence) out of every hot read.
- earnings_source_event_uidx UNIQUE BTREE (tenant_id, source_event_id) :: exactly-once credit :: this is not a performance index, it is the correctness mechanism. A double-tap, a retry or a replay hits it and the writer treats the violation as a SUCCESS path — logged, total unchanged, not surfaced as an error. Application-level check-then-insert cannot do this under concurrency; two concurrent gate submissions both pass a check.
- earnings_my_view_idx BTREE (tenant_id, owner_user_id, period_month DESC, recorded_at DESC) INCLUDE (delta_cents, entry_type) :: the seller's own My Earnings ledger view and the period selector :: owner second because My Earnings is owner-scoped and never widened; period_month before recorded_at because the period selector is the outer filter and recorded_at is the ordering inside it; INCLUDE makes the running total index-only.
- earnings_pending_window_idx BTREE (tenant_id, recorded_at DESC) INCLUDE (owner_user_id, delta_cents, period_day, period_week, period_month) :: the 5-second undo-window exclusion on every public leaderboard read :: leads with tenant then recorded_at DESC so the query 'entries newer than clock_timestamp() minus the window' is a two-or-three-row range scan at the head of the index for the ENTIRE tenant, computed once per request as a CTE and subtracted per seller. Without INCLUDE this becomes a heap fetch per pending row on the hottest endpoint in the product.
- leaderboard_rank_idx BTREE (tenant_id, period_type, period_key, total_cents DESC, user_id) :: the ranked board read for the 5-second poll, all four periods :: period_type and period_key are the two equalities the period selector supplies; total_cents DESC gives the ranking without a sort; user_id breaks ties deterministically so two screens can never disagree. The board reads THIS, never a SUM over the ledger and never a scan of opportunities.
- channel_watermark_pk BTREE (tenant_id, owner_user_id, channel) :: every conditional GET — roughly half a million polls a day, of which almost all must answer 304 in p95 <= 80ms :: a single-row primary-key lookup returning one bigint. This index is the difference between 500k cheap 304s and 500k board queries; it is the highest-leverage index in the schema and it exists only because the watermark is a table rather than a derived max().
- timeline_contact_idx BTREE (tenant_id, contact_id, occurred_at DESC, id DESC) :: the unified contact timeline, virtualized above 100 entries :: keyset pagination on (occurred_at, id) rather than OFFSET, because OFFSET on a long timeline degrades linearly and the timeline is the deepest scroll in the product.
- timeline_ref_uidx UNIQUE BTREE (tenant_id, ref_type, ref_id) :: the upsert key for call.enriched updating an existing entry in place :: makes 'never a duplicate row' a constraint rather than a handler behaviour; a late recording webhook that would otherwise append a second call entry conflicts and merges.
- call_aloware_uidx UNIQUE BTREE (tenant_id, aloware_call_id) WHERE aloware_call_id IS NOT NULL :: webhook idempotency and the out-of-order merge :: partial because the id is nullable at insert (call.initiated is emitted before Aloware confirms), so a NOT NULL unique would forbid the very case the design requires.
- message_provider_uidx UNIQUE BTREE (tenant_id, provider_message_id) WHERE provider_message_id IS NOT NULL :: inbound and outbound SMS idempotency :: same pattern as calls, one shared idempotency shape rather than a second implementation.
- webhook_provider_uidx UNIQUE BTREE (tenant_id, provider, provider_event_id) WHERE provider_event_id IS NOT NULL :: provider-level webhook dedupe at the ingest edge, before any business logic :: the ingest handler's ON CONFLICT DO NOTHING makes a replayed delivery a 204 in under a millisecond, which is what lets a 20,000-webhook recovery storm at 333/s land without touching the domain.
- vault_intake_uidx UNIQUE BTREE (tenant_id, intake_source_id, dedupe_key, dedupe_bucket) WHERE origin = 'intake' :: the composite intake idempotency that returns 200 duplicate_ignored with exactly one contact and one lead.created :: dedupe_bucket (the receipt date) is in the key because the requirement is a WINDOW, and a unique index cannot express 'within 24 hours' any other way; a genuine re-sale the next day is correctly a new lead.
- outbox_claim_idx BTREE (status, next_attempt_at) WHERE status IN ('pending','claimed') :: the relay's FOR UPDATE SKIP LOCKED claim across all tenants :: deliberately NOT led by tenant_id, because the relay is a cross-tenant system path; it is one of exactly four such paths, each confined to a SECURITY DEFINER function that returns ids only and sets per-row tenant context before any domain access. Partial keeps the index the size of the backlog, not the size of the day.
- scheduled_job_uidx UNIQUE BTREE (tenant_id, kind, idempotency_key) WHERE canceled_at IS NULL :: the T-1h reminder, the cold episode and the activity escalation, all three :: one partial unique index carries every episode-scoped idempotency requirement in the product. Reschedule cancels and re-inserts, so exactly one live job per (subject, kind) exists at any instant and a second enqueue is impossible rather than merely unlikely.
- scheduled_job_due_idx BTREE (fire_at) WHERE status = 'pending' :: the dispatcher :: cross-tenant by design, same enumerated-path treatment as the outbox claim.
- consent_temporal_idx BTREE (tenant_id, contact_value_norm, channel, effective_at DESC, recorded_at DESC) :: 'what was the consent state for this number on this channel at time T' — the bitemporal question a TCPA defense actually asks :: the DISTINCT ON (channel) current-state read and the as-of read are the same index scan; effective_at then recorded_at so a backdated correction row still orders correctly.
- suppression_current_idx BTREE (tenant_id, phone_e164, effective_at DESC) :: the STOP/START current-state read on every single dial and text, fail-closed :: tenant then value with no owner column, because a STOP must disable Call and Text for that number for EVERY seller immediately; the compliance gate reads this live on every attempt and never a per-session cache.
- audit_subject_idx BTREE (tenant_id, subject_type, subject_id, occurred_at DESC) :: the admin audit trail for one record, and the compliance export :: on a monthly-partitioned table this is a partitioned index; queries that carry a time range prune to one or two partitions, and queries that do not are admin-only and rare.
- audit_bucket_uidx UNIQUE BTREE (tenant_id, action, actor_user_id, subject_id, dedupe_bucket) WHERE dedupe_bucket IS NOT NULL :: book.viewed on every supervisor global read, without blowing the API p95 :: the bucket collapses a supervisor's reading session into one row per five minutes via INSERT ... ON CONFLICT DO NOTHING. Bucketing by insert-or-nothing rather than by UPDATE is mandatory here, because the table is immutable by engine and an UPDATE would raise.
- event_replay_idx BTREE (tenant_id, seq) :: rebuilding every projection from scratch as one job, and the monthly reset that ships later as a config flip :: seq comes from a global sequence so it is a total order; on a monthly-partitioned parent the planner merge-appends per-partition indexes, which is exactly the streaming access a replay wants.
- stage_transition_move_uidx UNIQUE BTREE (tenant_id, client_move_key) WHERE client_move_key IS NOT NULL :: the sendBeacon flush on tab close, which can legitimately deliver the same move twice :: sendBeacon cannot be retried safely without this; the second arrival conflicts and returns the first result, so the board never double-moves a card and never double-credits a win.
- intake_token_uidx UNIQUE BTREE (token_hash) :: resolving POST /intake/{source_token} to exactly one seller with no routing engine :: the ONLY index in the schema with no tenant_id, because the token is what resolves the tenant. Reachable only through app.resolve_intake_token(); it is on the enumerated cross-tenant path list with its reason written.

## Isolation design (RLS)

## The isolation mechanism, end to end

### 1. Roles

Three Postgres roles, and the separation between them is what makes FORCE meaningful.

- `crm_migrator` — OWNS the schema. Used by exactly one thing: the one-shot pre-deploy migration job. Never by a long-running process.
- `crm_app` — the connection identity of all three application processes (web, worker, ingest). **Not the owner of anything.** NOINHERIT. Subject to RLS twice over: once because it is not the owner, once because FORCE is on.
- `crm_projector` — not needed; the SECURITY DEFINER functions run as `crm_migrator`, which keeps the role count at two plus the auth role.

**Boot assertion (refuses to start, loudly, the first time):** at process start the app runs `SELECT current_user, pg_catalog.pg_get_userbyid(relowner) FROM pg_class WHERE relname='contact'` and **exits non-zero** if `current_user` is the schema owner or has `rolsuper` or `rolbypassrls`. Reason this is the single best mitigation in the whole design: in Postgres the OWNER of a table is exempt from its own policies unless FORCE is set, the connection string the provider's dashboard hands you to copy-paste IS the owner's, and `docker compose` with `postgres:18` hands you the superuser by default — so the development environment trains the broken configuration with perfect fidelity. Without this assertion the app works perfectly, every screen loads, every functional test passes, and each of the fifty sellers sees the full book of all fifty, with no error, no warning and no log line.

### 2. Session context, and why it cannot survive a pooled connection

Three GUCs, set with `set_config(key, value, **true**)` — the third argument is `is_local`, which scopes the setting to the current transaction and resets it at COMMIT or ROLLBACK:

- `app.tenant_id`
- `app.user_id`
- `app.scope_mode` ∈ `owner | tenant_read | tenant_admin | system`

**Every unit of work is an explicit transaction whose FIRST statement is those three `set_config` calls.** Not most units — every one: HTTP request, pg-boss job handler, webhook consumer, CSV importer, export job, outbox relay dispatch. That invariant is what makes PgBouncer in **transaction mode** safe, and it is the entire reason session mode is forbidden: a session-mode or session-shared pooler reuses a server connection across different clients, so `app.user_id` set by seller A's request survives on that connection and is inherited by seller B — the pages render perfectly, just with the wrong rows.

Mechanical enforcement, four layers:
1. **`set_config(..., false)` breaks the build.** A lint rule fails on any occurrence of a non-`true` third argument, and on any bare `SET` (as opposed to `SET LOCAL`) in the SQL corpus.
2. **The raw client is unreachable.** The only export from `src/db/` is `withTenant(ctx, fn)`; the pool object is module-private and a dependency-cruiser rule (already in the pre-merge CI matrix) fails the build if anything outside `src/db/**` imports it.
3. **Zero rows, not an error, when context is missing.** `app.current_tenant()` is `current_setting('app.tenant_id', true)::uuid`, which returns NULL when unset. `tenant_id = NULL` is NULL, so the policy denies. A query that escapes the wrapper returns nothing, in every one of the five execution contexts — asserted by test.
4. **Inheritance test.** An integration test runs a pg-boss job immediately after an HTTP request on the same pooled connection and asserts the job sees none of the request's context.

`idle_in_transaction_session_timeout` is set **explicitly on every role**, because a transaction orphaned mid-close-gate holds locks on the opportunity row *and* on the leaderboard watermark row, blocking every subsequent close in the tenant. Each pool has a hard `max` sized against the **measured** connection ceiling of the instance with 2× headroom for a rolling redeploy.

### 3. Policies are GENERATED, never authored — this is the core of the design

The brief's requirement is that **every policy declares USING *and* WITH CHECK**. Postgres will not let you satisfy that literally with per-command policies:

| Policy form | USING | WITH CHECK |
|---|---|---|
| `FOR SELECT` | required | **syntax error** |
| `FOR INSERT` | **syntax error** | required |
| `FOR UPDATE` | allowed | allowed |
| `FOR DELETE` | required | **syntax error** |
| `FOR ALL` | allowed | allowed |

So a CI query that fails on `pg_policies.with_check IS NULL` would reject any `FOR SELECT` policy — meaning the naive version of the gate is unsatisfiable and would be "fixed" by weakening it. **The resolution: `FOR ALL` is the only permitted policy form.** Every table gets exactly two policies, both `FOR ALL`, both with a non-null `qual` and a non-null `with_check`:

```sql
CREATE POLICY p_app ON app.contact FOR ALL TO crm_app
  USING      (tenant_id = app.current_tenant()
              AND (owner_user_id = app.current_user_id() OR app.scope_is_global()))
  WITH CHECK (tenant_id = app.current_tenant()
              AND owner_user_id = app.current_user_id());

CREATE POLICY p_sys ON app.contact FOR ALL TO crm_migrator
  USING (true) WITH CHECK (true);
```

Postgres applies `USING` to SELECT, to DELETE, and to the *old* row of an UPDATE; it applies `WITH CHECK` to INSERT and to the *new* row of an UPDATE. The asymmetry between the two clauses is not decoration — **it is the entire authorization model**, and both required denial semantics fall out of it mechanically:

- A seller reaching another seller's record: `USING` excludes the row → zero rows → the API renders the owner-scoped not-found. Byte-identical to a genuine 404, on route, on search, on notification deep link, and on admin-only routes like break-glass.
- A **supervisor** who may legitimately read a record and attempts to write it: `USING` passes (global read), `WITH CHECK` fails → SQLSTATE **42501** → the API returns 403 "Supervisors have read-only access to seller books". This leaks nothing they could not already see.
- A seller writing a row owned by someone else — the exact scenario the brief describes, where a USING-only policy lets the write succeed and the row vanishes from the writer's own view with nobody ever finding out: `WITH CHECK` rejects it. And because the API never accepts `owner_user_id` from the client (it is always the session user), that path is unreachable twice.

**And the policies are not written by hand.** `security.table_registry` classifies every table (`owner_scoped`, `tenant_scoped`, `tenant_admin_only`, `append_only_owner`, `append_only_tenant`, `definer_only`, `system_cross_tenant`, `reference`), and `security.harden()` *generates* the two policies, the GRANTs, `ENABLE`/`FORCE ROW LEVEL SECURITY`, and the immutability trigger from that classification. The failure mode the brief names — the public RLS corpus is full of USING-only examples, so USING-only is what the model writes by inertia — **is removed at the source: there is no place to write a policy.**

### 4. How the hardening survives every future migration and every new partition

`security.harden()` is **the last statement of the one-shot pre-deploy migration job**, not a line in each migration file. It is idempotent, it loops over `pg_class` in schemas `app` and `ref`, and it **RAISES if it finds any relation with no registry row**. Therefore:

> **A migration that creates a table without classifying it fails the deploy.**

That is stronger than a CI check, because CI can be amended and a deploy that will not proceed cannot. It also re-applies to newly created **partitions**, which is the specific hole a partitioned schema opens (the catalog gate sees partitions as separate relations, and a partition attached without FORCE is a silo hole with no symptom).

A Postgres **EVENT TRIGGER** on `ddl_command_end` would make this fully automatic. `CREATE EVENT TRIGGER` requires superuser, and Render's managed Postgres does not grant it — so **the design does not depend on one.** Verify in Sprint 0; if superuser is available, add it as belt-and-braces, never as the primary.

Four independent nets, in order of when they fire:
1. **Deploy** — `harden()` raises on an unclassified relation.
2. **CI (pre-merge, ~6–8 min tier)** — a query over `pg_class` and `pg_policies` fails the build if any relation in `app` lacks `relrowsecurity AND relforcerowsecurity`, or has zero policies, or has any policy with a null `qual` or null `with_check`, or has any policy whose `cmd <> 'ALL'` (this last one is what stops someone "fixing" a red build by writing a `FOR SELECT` policy), or if `crm_app` holds DELETE on anything, or UPDATE on an immutable table.
3. **Boot** — the ownership assertion above.
4. **Monthly restore drill** — restores the dump into a Testcontainers Postgres and runs the *complete* silo and append-only suite against the restored system, asserting that custom roles, revoked GRANTs, immutability triggers and **`FORCE ROW LEVEL SECURITY`** all survived. "The provider takes backups" is not "our data is restorable to a working system": a restore that comes back without FORCE **disables the silo silently and the system boots looking healthy.**

### 5. The versioned exception list

Adding an entry requires a PR that touches that file **and nothing else**. Each entry carries its reason in the row (`exception_reason` is `NOT NULL` for class `reference`).

| Exempt | Reason |
|---|---|
| schema `auth` (better-auth session/account/verification) | The session is looked up **before** we know who the user is, so the context cannot exist yet. Compensating controls: no seller business data in these tables; tokens hashed at rest; imports confined to `src/auth/**` by dependency-cruiser. |
| schema `pgboss` | pg-boss owns its own DDL and knows nothing about our context. Compensating control: the queue is treated as **untrusted transport** — every handler opens its own transaction, sets context from the payload's ids, and every query it then runs is RLS-scoped. Job payloads carry ids and scalars only. |
| schema `ref` (`zip_timezone` ≈41k rows, `area_code_timezone`, `state_timezone`, `event_consumer`) | Static, non-PII, identical for every tenant, `SELECT`-only to `crm_app`. Adding a `tenant_id` here would be exactly the decorative column the brief forbids. |
| schema `security` (`table_registry`) | It is the metadata that *defines* RLS. `crm_app` has no grants on the schema at all. |

### 6. Sanctioned cross-boundary paths — enumerable code artifacts, not conventions

**Cross-silo, within a tenant — exactly two:**
1. `leaderboard_projection`: `USING (tenant_id = app.current_tenant()) WITH CHECK (false)`. It is a physically separate table whose column set contains no lead, contact or opportunity data — *you cannot leak a column the projection does not contain.*
2. Supervisor/admin global read: the **same** queries with the ownership filter lifted by `app.scope_is_global()`. No separate report endpoints exist.

**Cross-tenant, system-level — exactly four**, each confined to one SECURITY DEFINER function that returns ids only and sets per-row context before touching anything else: `app.outbox_claim()`, `app.scheduled_job_claim()`, `app.retention_purge()`, `app.resolve_intake_token()`.

### 7. `app.scope_is_global()` and the recursion trap

```sql
CREATE FUNCTION app.scope_is_global() RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT current_setting('app.scope_mode', true) IN ('tenant_read','tenant_admin')
     AND EXISTS (SELECT 1 FROM app.app_user u
                  WHERE u.tenant_id = app.current_tenant()
                    AND u.id        = app.current_user_id()
                    AND u.role IN ('supervisor','admin')
                    AND u.deactivated_at IS NULL);
$$;
```

The `EXISTS` is the point: the function **re-verifies the role against the database** instead of trusting the GUC, so a seller session cannot produce `scope_mode = tenant_read` even if something upstream sets it. Cost is one index probe on a 50-row table that lives permanently in shared buffers.

**The trap, and it will cost a day if it is discovered in Sprint 0 instead of here:** if `app_user`'s own policy called `app.scope_is_global()`, and that function queries `app_user`, Postgres raises `infinite recursion detected in policy for relation app_user`. This is why `app_user` is the one owner-bearing table whose policy is plain `tenant_id = app.current_tenant()` — a deliberate, justified widening (the leaderboard legitimately carries display names and avatars tenant-wide, supervisors need the seller list, owner labels must render).

### 8. Single-writer guarantees as privilege facts

`crm_app` has **no DML at all** on `earnings_ledger`, `audit_log`, `consent_ledger`, `suppression_list`, `event_log`, `timeline_entry` and `leaderboard_projection`. All writes go through a handful of short SECURITY DEFINER functions (`app.ledger_append`, `app.audit_write`, `app.consent_append`, `app.suppression_append`, `app.event_emit`, `app.timeline_upsert`, `app.stage_move`). Consequences:

- "One writer for Earnings", "the timeline is never written directly", "exactly one stage-transition service" stop being boundary rulings and become **`permission denied`**.
- Drizzle cannot model those inserts, so the money path is visually distinct in the codebase — a feature, not a cost.
- The entire violable surface of the product's most dangerous rulings collapses to ~7 short SQL functions, which is small enough for Jorge to have a second model audit them line by line even though he does not read code.
- A CI query over `pg_proc.prosrc` asserts **every** SECURITY DEFINER function's body contains `app.current_tenant()` — a definer function that forgets to re-assert tenancy is the one way this design can become a cross-tenant hole, and it is grep-checkable.

### 9. No hard deletes, as a privilege rather than a policy

`REVOKE DELETE ON ALL TABLES IN SCHEMA app FROM crm_app`, universally. Redact-in-place is no longer a discipline anyone can forget; the alternative does not exist. Retention is implemented as `DROP PARTITION` executed by the migrator inside `app.retention_purge()`, which is O(1) and generates no bloat.

The genuine hazard the brief flags — *a badly-placed soft delete is a silo leak waiting to happen* — is closed by making the soft-delete filter unreachable rather than optional: **`crm_app` has SELECT on no base table that carries a `deleted_at` column.** It reads `*_live` views declared `WITH (security_invoker = true)` (so the caller's RLS still applies) that hard-code `deleted_at IS NULL`. A query that "forgets the filter" has nothing to query. The CI gate asserts that property directly.

`redacted_at` is a *different* thing and deliberately does **not** hide the row: a redacted contact keeps its identity slot and its plaintext `phone_e164`, so a repost matches the skeleton instead of creating a shadow record for someone who asked to be erased, and so a STOP can still be honored. That retention is a documented minimization exception with the same legal basis as `suppression_list`.

## Contact / Opportunity separation

## Why Contact and Opportunity are two tables, and why their birth is atomic anyway

### They are decoupled, 1:N, and that is load-bearing

A contact can carry many opportunities across time. This is not future-proofing; it is the story the product exists to tell. Doris buys a Final Expense policy at $1,380. Forty-five days later `contact.became_client` has already scheduled the cross-sell task, and Marcus opens a **second, independent opportunity** on the same contact — its own card, its own stage set position, its own premium, its own close date — while every call, text, recording and note from the FE sale stays on one unbroken timeline underneath. Three weeks later the IUL closes at $3,600 from a contact the agency already paid for months ago, at zero acquisition cost.

Collapsing the two into one row would make that a hack: you would need a second contact record for the same human (destroying the timeline, duplicating the phone, splitting consent) or an in-place mutation of a closed-won record (destroying the ledger's ability to explain an all-time board). The 1:N decoupling is also what makes the recycle path (`opportunity.recycled`, `previous_outcome`, `parent_opportunity_id`) and the repost-on-a-lost-opportunity path expressible without inventing a second object.

**Schema consequences:**
- `opportunity.contact_id` is `NOT NULL`; `contact` has no `opportunity_id`.
- `opportunity.parent_opportunity_id` is a self-FK carrying the cross-sell lineage, plus `created_from ∈ (lead_intake | cross_sell | recycle | manual)`.
- **`opportunity.owner_user_id` is denormalized, not derived from `contact.owner_user_id`.** This matters twice: the RLS predicate must be a column on the row being filtered (a join in a policy is a performance and recursion hazard), and an audited ownership transfer must be able to move both consistently in one transaction without the silo depending on a join.

### But the birth is one transaction, and the database enforces it

The rule is: on `lead.created` from any source, the Opportunity is created **within the same transaction** as the Contact, owned by the same seller, in the **first stage of that seller's own stage set**. If the opportunity insert fails, the contact write rolls back. A lead never exists without either a card or an explicit "No open deal" chip.

Writing that in a service function is not a guarantee — it is a thing the code currently does. The mechanical version:

```sql
CREATE CONSTRAINT TRIGGER contact_must_have_opportunity
  AFTER INSERT ON app.contact
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.assert_intake_contact_has_opportunity();
```

Deferred to commit time, the trigger raises if a contact with `created_via = 'lead_intake'` has zero rows in `opportunity`. Because it is `DEFERRABLE INITIALLY DEFERRED`, the two inserts may happen in either order within the transaction — but the transaction **cannot commit** with a card-less intake lead. "A lead never exists without a card" becomes a Postgres fact.

It keys on `created_via` deliberately, because the MVP rule is *auto-open an opportunity on `lead.created` only, never on import*: `created_via = 'import'` and `created_via = 'merge_survivor'` are exempt, which is the same ruling expressed as a predicate instead of as a comment.

### The first-stage binding

The opportunity is placed in the seller's **own** first stage, not a tenant default: `SELECT id FROM stage WHERE tenant_id=? AND owner_user_id=? AND deleted_at IS NULL ORDER BY sort_order LIMIT 1`, resolved inside the same transaction. Two guards make that safe: `UNIQUE (tenant_id, pipeline_id, sort_order)` means "first" is unambiguous, and the seeded stage template is asserted by a deferred constraint trigger to contain at least one stage of each of `open`, `earning` and `lost`, so a seller can never end up with a board that has no landing stage or no gate-capable stage.

### The dedupe fork, and why it is owner-scoped

Intake dedupe matches **exactly** on normalized E.164 or lowercased email, **within the current owner's book only** — no fuzzy name matching. That scope is expressed as an index, not as a WHERE clause someone maintains: `UNIQUE (tenant_id, owner_user_id, phone_e164)` on `contact_phone` and `UNIQUE (tenant_id, owner_user_id, email_norm)` on `contact`. Three outcomes, all falling out of the same shape:

1. **Same owner, match, existing opportunity still open** → update the contact in place, emit `lead.reposted` instead of `lead.created`, no second card. The deferred trigger is not even consulted (no INSERT on contact).
2. **Same owner, match, existing opportunity is `lost` or `earning`** → a **new** opportunity opens on the same contact with `created_from='recycle'`. This is precisely the case that the 1:N model makes trivial and a merged model makes impossible.
3. **Different owner in the same tenant** → a **separate contact in my book**. The lookup query itself carries the owner predicate, so the other record is never read, referenced or surfaced, and no cross-owner merge is offered anywhere. A tenant-wide dedupe lookup would leak; the index scope is what stops it, one layer below any code that could get it wrong.

### The money boundary

`earnings_ledger.owner_user_id` is the seller who **earned** the credit and is written once, into an immutable row. It is never a join to the contact's present owner. So an audited single-record transfer moves the contact, its opportunities, activities, notes and timeline to the new owner in one transaction — and moves **no money**. Historical credit stays with the seller who earned it and the leaderboard does not move.

That is enforced structurally rather than by review: the ledger cannot be UPDATEd (trigger + REVOKE), and a CI test greps the leaderboard SQL module and **fails the build if it contains a join to `contact` or `opportunity`**. Computing leaderboard totals by joining through `contact.owner_user_id` — the natural, obvious, wrong implementation — cannot survive a merge.

## Ledger design

## earnings_ledger, audit_log, consent_ledger (+ suppression_list): the immutable core

### 1. Immutability, by engine, on two independent axes

**Axis A — the trigger, which does not care who you are:**

```sql
CREATE FUNCTION security.deny_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'append_only_violation: % on %.% is forbidden',
        TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME
        USING ERRCODE = 'AP001';
END $$;

CREATE TRIGGER t_immutable
  BEFORE UPDATE OR DELETE OR TRUNCATE ON app.earnings_ledger
  FOR EACH STATEMENT EXECUTE FUNCTION security.deny_mutation();
```

Three deliberate choices:
- **`FOR EACH STATEMENT`, not `FOR EACH ROW`.** A row trigger never fires when zero rows match, so `DELETE FROM earnings_ledger WHERE false` would succeed silently. A statement trigger raises on the *attempt*. It is also cheaper.
- **`OR TRUNCATE` is not optional.** TRUNCATE bypasses row triggers *and* bypasses the DELETE privilege entirely. Without it, one statement empties the one artifact the product cannot reconstruct.
- **A distinct SQLSTATE, `AP001`,** deliberately outside the standard classes, so the error handler keys on it exactly and maps it to the specified seller-facing copy rather than pattern-matching an English message.

**Axis B — the privileges:** `REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON app.earnings_ledger FROM crm_app`. The app role has **no DML at all**; the only write path is `app.ledger_append(...)`, SECURITY DEFINER.

They are not redundant. The REVOKE protects against the **application**. The trigger fires regardless of role, so it also covers **the provider's SQL console** — the out-of-band write path that a managed database creates over the one artifact with no recompute job. A superuser can drop the trigger, but dropping a trigger is a deliberate, discoverable act; an UPDATE in passing is not.

**The observable, which is the whole point.** The model will eventually write `.onConflictDoUpdate()` against the ledger, because that is the public idiom of upsert and it appears in every tutorial. When it does: `permission denied` → the gate returns 500 → the seller reads, on screen, that minute, the literal specified copy: *"Couldn't record this sale — nothing was saved. Try again."* Not a log line someone has to go and read. A sentence on a seller's screen.

**Re-application across every future migration and partition:** `security.harden()` re-attaches triggers and re-applies REVOKEs from `security.table_registry`, as the **last statement of the pre-deploy migration job**, and it **raises on any unclassified relation** — so a migration that adds a table (or attaches a partition to `audit_log`) without classifying it *fails the deploy*. Backed by the CI catalog gate, the boot assertion, and the monthly restore drill.

`suppression_list` is added to the immutable set beyond the three named in the brief. It costs one trigger and one REVOKE, it is the same evidentiary class, and an UPDATE flipping a STOP row to a START is the cheapest possible way to commit a TCPA violation.

### 2. Exactly-once, and the second delivery is a SUCCESS path

`UNIQUE (tenant_id, source_event_id)`.

`app.ledger_append()` performs `INSERT ... ON CONFLICT (tenant_id, source_event_id) DO NOTHING RETURNING id`. A NULL return means the entry already existed: the function returns `already_credited`, the caller **logs and proceeds**, the seller's total is unchanged, and nothing surfaces as an error. A double-tap, a `sendBeacon`-plus-retry, a webhook redelivery and a full replay all land on the same behaviour.

Note `DO NOTHING`, never `DO UPDATE` — and the distinction is enforced, not remembered: with no UPDATE grant, `DO UPDATE` raises `permission denied`.

This cannot be done in the application. Two concurrent gate submissions both pass a check-then-insert; only a unique index is a real constraint under concurrency.

**The full close-gate transaction commits or fails as one unit:** required-field gate check → `stage_transition` insert (which carries `CHECK (to_stage_type <> 'earning' OR actor_type = 'human')`) → `opportunity` stage write (which carries `CHECK (current_stage_type <> 'earning' OR premium_annual_cents IS NOT NULL)`) → `app.ledger_append()` → `leaderboard_projection` update → `channel_watermark` bump → `app.event_emit()` writing the event row and its outbox fan-out rows. No queue hop anywhere in that chain. `opportunity.won` may be *published* after commit; the money row cannot be.

### 3. Five inputs, one primitive

The ledger's write API is a single `append(delta_cents, source_event_id, source_event_name, entry_type, period_keys, stage_snapshot)` primitive with five callers, never a `recordSale()` function:

| Trigger | entry_type | Sign |
|---|---|---|
| `opportunity.won` | `sale` | + |
| `opportunity.value_changed` where `is_closed_won` | `value_correction` | ± |
| `opportunity.reopened` (incl. undo inside the window) | `reversal` | − |
| `contact.merged` moving a closed-won opportunity between sellers | `reversal` + `sale` (two rows) | −/+ |
| admin void / adjust-with-reason | `manual_adjustment` | ± |

`opportunity.value_changed` is named in the source material as *the single most-forgotten link in the money chain*: if Earnings only listens to `opportunity.won`, editing a premium after close silently corrupts a public all-time board.

**`contact.owner_changed` (single-record admin transfer) is ruled NOT a ledger input.** Historical credit stays with the seller who earned it; the transfer moves records, not money. The Amendment-1 note calling it a money event is superseded. `contact.merged` *is* an input, because a merge genuinely re-parents a closed-won opportunity — and it appends two reversing rows rather than mutating anything.

**Every row carries `stage_config_version` and `stage_name_snapshot`**, so a later stage rename or deletion cannot orphan or reinterpret history. And because **`stage.stage_type` is immutable by trigger** (a seller who wants a different type creates a new stage and moves cards), `pipeline.stage_config_changed` can never flip an earning flag — which means **no recompute job exists, the job queue is verifiably empty after a stage-config change, and the documented contradiction between "recompute on flag change" and "no recompute job exists" resolves cleanly in favour of the latter.** This single trigger deletes what the source material calls "the nastiest hidden dependency in the system": a per-seller stage tweak silently moving a public leaderboard.

### 4. period_key on every row, from row number one

Three `date` columns — `period_day`, `period_week`, `period_month` — computed **at write time**, inside `app.ledger_append()`, from one timestamp and one timezone read in the same transaction:

```sql
period_day   := (occurred_at AT TIME ZONE t.business_tz)::date;
period_week  := date_trunc('week',  occurred_at AT TIME ZONE t.business_tz)::date;
period_month := date_trunc('month', occurred_at AT TIME ZONE t.business_tz)::date;
```

`date`, not text: range queries and index use are natural and there is no format to get wrong. Stamped in **`tenant.business_tz`** and nothing else — a sale credited at 11:50 pm tenant-business-time counts to that business day for every viewer regardless of their own display timezone, which is only true if the key is computed server-side at write time and stored, never derived at read time. `business_tz_snapshot` rides along on the row so a later tenant timezone change (audited, forward-only, never rewriting keys) leaves history explicable.

Containment against a partially-wrong computation: `CHECK (period_month = date_trunc('month', period_day)::date)` and the same for week. Three mutually incoherent buckets cannot be committed.

Because the keys exist from the first row, a monthly reset later is a `period_type` filter on an existing index — **configuration, not migration, not backfill.**

### 5. The public projection and the 5-second undo window

**The exact predicate:**

```sql
WHERE e.tenant_id  = app.current_tenant()
  AND e.recorded_at <= clock_timestamp() - app.undo_window()
```

**`clock_timestamp()`, never `now()`.** `now()` / `CURRENT_TIMESTAMP` is the *transaction start* time; `clock_timestamp()` is the real wall clock; a `Date.now()` passed as a parameter is a third answer. A model picks among the three essentially at random, and being wrong by 200 ms is invisible — the board is correct almost always and wrong exactly during a demo. A CI grep gate **fails the build** on any occurrence of `now()` or `CURRENT_TIMESTAMP` inside the leaderboard SQL module.

**One source for the number, four representations.** `app.system_constant` holds `undo_window_ms = 5000` and `undo_projection_guard_ms = 500`; the same seed file generates the TypeScript token, the CSS custom property and the pg-boss celebration delay; a CI test asserts all four are equal and fails on any drift. `app.undo_window()` is `make_interval(secs => (undo_window_ms + undo_projection_guard_ms)/1000.0)`.

*Why the guard exists, stated plainly as a refinement:* `recorded_at` is set by `clock_timestamp()` at INSERT, but the row becomes visible at COMMIT and the seller's undo timer starts on the 200 response, which is after commit plus network. Without a margin the public projection can reveal a row a few milliseconds **before** the client's undo window closes. The guard (default 500 ms, commit-tail plus clock skew) is stored in the same table and covered by the same drift test, so it is a second named key from one source rather than a second source. Setting it to 0 is a legitimate alternative if Jorge prefers a literally single number; the residual risk is bounded by transaction tail latency.

**The projection is a table, not a SUM.** `leaderboard_projection` is maintained inside the ledger-append transaction, keyed `(tenant_id, period_type, period_key, user_id)`, carrying `total_cents` and a monotonic `seq`. The board reads it; it never sums the ledger and never scans opportunities. The window exclusion is applied as a small correction: one CTE scans `earnings_ledger` on `(tenant_id, recorded_at DESC)` for rows newer than the window — **zero to two rows for the entire tenant, essentially always** — and subtracts them per seller.

**The ETag trap, which is a real bug worth naming.** The visible value is *time-dependent*: when a pending entry ages out, the public number changes with **no write**. A purely write-derived ETag (`max(seq)`) would therefore return `304` while the board was stale — a silent freeze on the most expensive surface in the product. The ETag is `hash(max(seq), pending_watermark)` where `pending_watermark` is the max `recorded_at` inside the window or `0`. It changes exactly once more per win and is stable the rest of the time, so the 304-dominated steady state (p95 ≤ 80 ms) survives.

**Two read paths over one ledger, and only two:**
- **Public** (leaderboard, any seller in the tenant): projection minus the pending correction. Nobody ever sees a number that later corrects itself.
- **Private** (My Earnings, owner only): the ledger directly, no window filter, with entries younger than the window rendered *marked as pending*. The seller sees their own credit immediately; the floor does not.

**Celebration.** `opportunity.celebrated_at` is server-persisted, set once and forever (a trigger refuses any second write). The client arms the celebration at T+5000 ms ±100 from the gate's 200 response, and it fires only if not undone and only if `celebrated_at` is null. The **tenant-wide** broadcast is emitted from the **server**, after the window closes and after **re-checking that no reversal row exists for that `source_event_id`** — otherwise the whole office sees confetti for a sale that was cancelled. An undo inside the window appends a `reversal` row and is **silent**: no toast, no notification, no broadcast.

### 6. Retention, replay, and the one cost line that rises on its own

**Nothing is ever deleted.** The retention design is a two-tier residence, not an expiry:

- **Permanent in Postgres, forever:** `earnings_ledger`, `audit_log`, `consent_ledger`, `suppression_list`, `event_archive_manifest`, and every `event_log` row whose `retention_class = 'permanent'` — all money events, all consent and compliance events, all contact and opportunity lifecycle events, all admin events (roughly 30 of the 49). These are small: about 10⁴ ledger rows per year.
- **Archived to R2 after 13 months:** `event_log` rows whose `retention_class = 'archivable'` — the high-volume operational tail (`call.*`, `message.*`, `activity.*`, `appointment.starting_soon`). The monthly partition is `COPY`ed to R2 compressed, its digest and row count recorded in the permanent `event_archive_manifest`, then `DETACH`ed and dropped. Replay of an archived period restores from the manifest first. **Archived is not expired** — but Jorge should confirm he reads it that way (open question).
- **Short clock, PII-bearing:** `raw_payload_vault` bodies. Two-stage residence — bytes land in Postgres first so ingestion is genuinely write-first (a round trip to R2 before responding would blow the latency budget *and* make R2 an availability dependency of webhook ingestion), then an offloader moves them to R2 and nulls `body_raw`. `CHECK (body_raw IS NOT NULL OR r2_object_key IS NOT NULL)` guarantees the body is never nowhere. R2 **lifecycle rules** do the expiry, so there is no purge job anyone can forget. The window (30/45/90 days) is unresolved in the source material and is an open question.

**Replay.** Rebuilding every projection is one job: read `event_log` ordered by `(tenant_id, seq)`, re-materialize `event_outbox` rows for the targeted consumers, drain. Idempotency end to end comes from the natural keys (`source_event_id`, `aloware_call_id`, `provider_message_id`, `(intake_source_id, dedupe_key, dedupe_bucket)`), **not** from the outbox rows — which is why outbox partitions can be dropped at 14 days while replay still works from 2027. `schema_version` is on every row and a replay test runs current consumers against stored v1 payloads, because an all-time retention window guarantees v1 rows will still be replayed years from now. The **ledger itself is never replayed** — it is the one projection that is append-only-corrected-by-reversal rather than rebuildable, which is exactly why losing it is total and permanent, and why the paid Postgres with backups is the one non-negotiable line.

**The number Jorge should watch.** At 50 sellers the operational tail dominates: order 20k–50k events/day plus 10k–20k webhooks/day. Event rows run ~600–800 bytes; raw bodies are the bulk and they leave for R2 within hours. Rough year-one steady state is single-digit GB of permanent Postgres plus a growing R2 archive at R2's much lower per-GB cost. Storage on this provider costs roughly double the alternatives and **cannot be shrunk once grown** — so the archive boundary is not an optimization, it is the mechanism that keeps the only monotonic cost line on the cheap tier. The `verified_at` column on `event_archive_manifest` is written by the monthly restore drill, so "the archive exists and is readable" is a measured fact with an age and an alert, not an assumption.

## Open questions

- STAGE_TYPE IMMUTABILITY — I ruled that a stage's stage_type can never change (BEFORE UPDATE trigger raises); a seller wanting a different type creates a new stage and moves cards through the normal gated path. This is the single highest-leverage ruling in the model: it makes pipeline.stage_config_changed structurally incapable of moving money, which resolves the documented contradiction between 'recompute on stage-flag change' (03-mvp-definition item 61) and 'No recompute job exists / verify the job queue is empty' (Area-3 D-2, US-9.4) in favour of the latter, and it deletes what 02b calls 'the nastiest hidden dependency in the system'. The cost: a seller who mis-typed a stage at setup must create a replacement and move cards. Jorge must confirm he accepts that cost. If he does not, the composite FK on (tenant_id, stage_id, current_stage_type) needs ON UPDATE CASCADE and a bounded, idempotent, all-or-nothing recompute job reappears — with all the risk the documents attribute to it.
- contact.owner_changed AND MONEY — I ruled that a single-record admin transfer moves records but NOT money (per ARR-MVP-22 and US-9.12 'money does not move with the record'), so contact.owner_changed is NOT a ledger input, and the Amendment-1 claim that it 'moves leads AND money between books' is superseded. contact.merged with a closed-won opportunity changing owner IS an input (two reversing appends). Jorge must ratify, because the two rulings produce different public leaderboards after an admin transfer and there is no way to have both.
- btree_gin FOR uuid ON RENDER POSTGRES 18 — the primary search index is GIN (tenant_id, owner_user_id, full_name gin_trgm_ops), which needs the btree_gin extension to put uuid columns in a GIN key. If Render does not expose btree_gin (or its uuid opclass), the fallback is a plain trigram GIN plus an owner recheck, which is acceptable at 25k contacts but must be MEASURED against the 200 ms p95 in Sprint 0 rather than assumed. This is a Sprint-0 gate item, one query to answer.
- THE undo_projection_guard_ms REFINEMENT — I added a second constant (default 500 ms) on top of undo_window_ms=5000 for the SQL projection predicate, because recorded_at is stamped at INSERT while the seller's undo timer starts after COMMIT plus network, so a zero-margin predicate can reveal a row a few milliseconds before the client's window closes. Both keys live in one table and both are covered by the four-way drift test. Puerta 10 as written asserts the four representations read 'the SAME number', so either Puerta 10 is amended to cover two named keys from one source, or the guard is set to 0 and the residual risk (bounded by transaction tail latency) is accepted explicitly.
- RAW-PAYLOAD RETENTION WINDOW — the source documents suggest 30 to 90 days for PII-bearing bodies and explicitly record it as unresolved. It is simultaneously a CCPA minimization decision and the main R2 storage line. The schema is indifferent (purge_after column plus monthly partitions plus an R2 lifecycle rule), but the number must be chosen before Sprint 0 because it is written into every vault row at insert.
- IS 'ARCHIVED TO R2' THE SAME AS 'NEVER EXPIRES'? — Jorge's rule is that money-bearing and contact-bearing events never expire. Calls and messages ARE contact-bearing, and they are the volume. I ruled a two-tier residence: permanent-in-Postgres for ~30 of the 49 event names, and archived-to-R2-after-13-months (partition COPYed, digest and row count recorded in a permanent manifest, then detached) for the operational tail. Nothing is deleted; it moves to cheaper storage and replay restores it first. If Jorge reads 'never expires' as 'never leaves Postgres', the archive tier disappears and the Postgres storage line grows monotonically at roughly 4-6x the cost per GB — which is the one line the audits flag as the serious reason to reconsider the platform within a year.
- MANUAL CALL vs LATE WEBHOOK FOR THE SAME PHYSICAL CALL — 04-ux-flows states plainly that after a degraded-mode window 'a manual entry and a late webhook for the same physical call can both land', and no dedupe rule exists anywhere in the corpus. Left unsolved it corrupts attempt_count, last_touch_at, the 7-day cold rule and the rot badges. I propose: the merge job, on landing a webhook call with no matching internal call_id, looks for a call row with source='manual_degraded' on the same (tenant, contact, direction) within +/-10 minutes and with merged_webhook_call_id IS NULL, and merges into it rather than inserting. Deterministic, cheap, and the residual false-negative (two dials to the same lead inside ten minutes during an outage) is documented. Needs a ruling.
- TAGS AND CUSTOM FIELDS SHIP DORMANT, OR NOT AT ALL — the MVP explicitly cut the governed tag library and the custom-field engine, and ships four typed columns on opportunity instead. The brief requires the entities, so I specified four tables behind tenant flags defaulting false, with a BEFORE INSERT trigger that raises unless the flag is on and a boot assertion that they are empty in production. Shipping nothing is equally defensible and removes four relations from the RLS and CI surface; DoD-12's additive-only rule makes adding them later legal. Jorge's call.
- note AS ITS OWN TABLE vs activity type='note' — the canonical catalog lists 'note' among activity types, but a note needs a mutable body, a version column for If-Match optimistic concurrency, a 5000-char limit, a pinned flag and independent redaction, none of which belong on an append-ish work object. I ruled note is its own table, no activity row is emitted for it, and the timeline projects both. Consequence: the 'note' value in the activity type enum is never used, which is a (harmless) catalog inconsistency that Phase 5 should record rather than leave for someone to 'fix'. Related and also open: item 23 says 'Notes (pinning cut)' while US-LCP-06 requires a Pinned block that survives reload — I kept the pinned column; the ruling still has to be written down.
- PG-BOSS SCHEMA ON THE RLS EXCEPTION LIST — pg-boss owns its own DDL and knows nothing about our session context, so schema pgboss is exempt with the reason written. The compensating control is that the queue is treated as untrusted transport: every handler opens its own transaction, sets context from the payload's ids, and every subsequent query is RLS-scoped. That means a job payload with a wrong tenant_id would be scoped to the wrong tenant. Mitigation options to choose between: (a) sign job payloads with an HMAC checked by the handler wrapper, (b) have handlers re-derive tenant_id from the subject_id via a definer function rather than trusting the payload. (b) is cheaper and stronger; it needs a ruling because it changes every handler signature.
- EVENT TRIGGERS REQUIRE SUPERUSER — the ideal re-application mechanism for FORCE RLS, GRANTs and immutability triggers on every future table and every new partition is a Postgres EVENT TRIGGER on ddl_command_end. CREATE EVENT TRIGGER requires superuser and Render's managed Postgres does not grant it. The design therefore does not depend on one: security.harden() runs as the last statement of the pre-deploy migration job and RAISES on any unclassified relation, so an unclassified table fails the DEPLOY. Confirm Render's grant set in the same Sprint-0 hour as Puerta 0, and add the event trigger as belt-and-braces only if it exists.
- SPEED-TO-LEAD STOP POINT — three documents disagree (stop on the tap vs stop on call.completed with a connected/voicemail outcome). I modelled opportunity.first_touch_latency_seconds as write-once (a trigger refuses any second write), which makes the column safe under either ruling but does NOT decide which event writes it. The decision determines whether every no-answer dial reports a fabricated 21-second first touch on the one number that justifies the lead spend. Phase 5 must pick before the consumer is built.
- last_activity_at AUTHORITY — five events currently claim to reset it, and it is the input to the cold-episode key that opportunity.went_cold must be idempotent against. I ruled a deterministic max(): one AFTER INSERT trigger on activity, call, message and meeting sets last_activity_at := GREATEST(old, new.occurred_at), monotonic, never decremented, with cold_episode carrying the stable (opportunity_id, ordinal) key. This closes the instability mechanically rather than by naming one authority. Needs ratification, because a monotonic rule means a deleted/corrected activity never rewinds the clock.
- ONE DEMO TENANT, ENFORCED BY INDEX — I added CREATE UNIQUE INDEX ON tenant (is_demo) WHERE is_demo, plus a trigger refusing demo-tenant creation when system_constant['environment'] = 'production'. That is the mechanical form of 'the demo seed refuses to run in a live account'. Confirm one demo tenant is enough (the E2E fixture and the two-legged synthetic check both need one, and they can share it, but a shared tenant means a failing E2E run can leave state the synthetic check then trips over).
- ZIP-TO-TIMEZONE DATASET: REFRESH CADENCE AND LICENSING — I ruled the resolver chain as bundled ZCTA/zip to IANA (primary, ~41k rows, zero recurring cost) then NANPA area code (fallback, flagged low confidence) then state (last resort), with tz_confidence and tz_source persisted on the contact and re-resolved whenever phone or address changes. Low confidence never blocks intake but unknown fails the gate closed. What is NOT decided: which specific dataset, its licence, and how often it is refreshed. It feeds a HARD block that can stop all fifty sellers from working, so a stale table is an outage, not a data-quality issue.
- AUDIT VOLUME AND THE 5-MINUTE book.viewed BUCKET — every dial attempt and every gate refusal writes an audit row (five taps produce five audit rows and one timeline entry), and every supervisor global read writes one too. To keep the supervisor path inside the API p95 I bucket book.viewed to one row per five minutes via INSERT ... ON CONFLICT DO NOTHING on a unique key including the bucket. Confirm five minutes satisfies the CCPA-hygiene intent; a shorter bucket is more faithful and more expensive, and the bucket cannot be implemented as an UPDATE because the table is immutable by engine.
- TWO NUMBERS THE MODEL DEPENDS ON THAT NOBODY HAS MEASURED — (a) the real connection ceiling of Render Postgres Basic, which sizes every pool and decides whether the three-process split survives a rolling redeploy (Puerta 1); (b) the actual burst shape of ping-post and Aloware webhook traffic, since 100-300 leads/day and 10,000-20,000 webhooks/day are assumptions carried since Phase 0, not measurements (OQ-2). Both are inputs to the partitioning cadence and the ingest index design. The schema is not sensitive to either within an order of magnitude, but the partition granularity (monthly vs weekly) and the outbox prune window are.
