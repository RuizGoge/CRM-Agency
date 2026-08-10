/**
 * GENERATED FROM contracts/events/catalog.json — DO NOT EDIT.
 *
 * Run `npm run events:generate`. `scripts/events-contract.test.ts` fails the
 * build when this file and the contract disagree, in both directions.
 *
 * The catalog is 49: 40 from §4 of docs/02b-integration-map.md and
 * 9 from its Amendment 1. An event outside it is a bug, not a feature.
 */

import type { Money } from '~/lib/money/money'

/** Structured payload fields the contract types as `json`. */
export type JsonValue =
  string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue }

/**
 * §3. Not one of the 262 originally-declared events carried an envelope; this
 * is the missing spine and it is non-negotiable.
 *
 * Default-deny scoping: every consumer filters by `tenant_id` and — unless it
 * is the leaderboard projection, the one legitimate cross-silo broadcast — by
 * `owner_user_id`. `event_id` is the idempotency key because Aloware WILL
 * deliver twice, and `recorded_at_utc_ms` is separate from
 * `occurred_at_utc_ms` so a webhook forty seconds late still threads correctly.
 */
export interface EventEnvelope {
  readonly event_id: string
  readonly tenant_id: string
  readonly owner_user_id: string
  readonly actor_user_id: string | null
  readonly occurred_at_utc_ms: number
  readonly recorded_at_utc_ms: number
  readonly schema_version: number
  readonly source_system: 'app' | 'aloware' | 'vendor_post' | 'scheduler' | 'import'
  readonly correlation_id: string
}

/** Every canonical event name, in catalog order. */
export const EVENT_NAMES = [
  'lead.created',
  'lead.duplicate_detected',
  'lead.import_completed',
  'contact.created',
  'contact.merged',
  'contact.became_client',
  'consent.updated',
  'opportunity.created',
  'opportunity.stage_changed',
  'opportunity.won',
  'opportunity.lost',
  'opportunity.value_changed',
  'opportunity.reopened',
  'opportunity.went_cold',
  'opportunity.recycled',
  'call.initiated',
  'call.completed',
  'call.enriched',
  'message.sent',
  'message.received',
  'message.delivery_failed',
  'appointment.scheduled',
  'appointment.rescheduled',
  'appointment.canceled',
  'appointment.completed',
  'appointment.no_showed',
  'calendar.sync_failed',
  'activity.created',
  'activity.completed',
  'activity.overdue',
  'sequence.enrolled',
  'sequence.paused',
  'sequence.completed',
  'automation.executed',
  'earnings.updated',
  'leaderboard.rank_changed',
  'celebration.triggered',
  'pipeline.stage_config_changed',
  'admin.setting_changed',
  'user.deactivated',
  'lead.reposted',
  'compliance.send_blocked',
  'compliance.override_started',
  'compliance.override_ended',
  'appointment.starting_soon',
  'opportunity.gate_blocked',
  'contact.owner_changed',
  'contact.bad_number_flagged',
  'integration.mapping_verified',
] as const

/**
 * THE MECHANISM. `emit` is typed on this union, so an invented event name is a
 * compile error rather than a runtime surprise nobody notices.
 */
export type EventName = (typeof EVENT_NAMES)[number]

/**
 * Starts the speed-to-lead clock; received_at_utc_ms is millisecond precision because the measurement runs from here. NEVER emit without owner_user_id — in a silo model an unowned lead is invisible to everyone.
 */
export interface LeadCreatedPayload {
  readonly contact_id: string
  readonly opportunity_id: string
  readonly source_channel:
    'vendor_ping_post' | 'web_form' | 'inbound_call' | 'manual' | 'csv_import' | 'referral'
  readonly vendor_id: string | null
  readonly vendor_lead_id: string | null
  readonly received_at_utc_ms: number
  readonly phone_e164: string
  readonly email: string | null
  readonly contact_timezone: string
  readonly state_code: string
  readonly product_interest: 'final_expense' | 'iul'
  readonly tcpa_consent_flag: boolean
  readonly consent_certificate_url: string | null
  readonly consent_captured_at: string | null
  readonly dedupe_status: 'unique' | 'auto_merged' | 'flagged_for_review'
}

/**
 * Silo rule: the payload may name matched_owner_user_id, but no consumer may render the other seller's lead detail to the incoming path.
 */
export interface LeadDuplicateDetectedPayload {
  readonly incoming_payload_ref: string
  readonly incoming_source_channel:
    'vendor_ping_post' | 'web_form' | 'inbound_call' | 'manual' | 'csv_import' | 'referral'
  readonly matched_contact_id: string
  readonly matched_owner_user_id: string
  readonly match_basis: 'phone_e164' | 'email' | 'name_dob'
  readonly match_confidence: number
  readonly incoming_tcpa_consent_flag: boolean
  readonly incoming_consent_certificate_url: string | null
  readonly resolution: 'auto_merged' | 'queued_for_review' | 'rejected'
}

/**
 * Import is the second dedupe checkpoint, not a bypass of the first.
 */
export interface LeadImportCompletedPayload {
  readonly import_id: string
  readonly rows_total: number
  readonly rows_created: number
  readonly rows_merged: number
  readonly rows_rejected: number
  readonly reject_reasons: readonly string[]
  readonly declared_consent_source: string
  readonly default_product_interest: 'final_expense' | 'iul'
}

/**
 * Deliberately low-consumption. NOT an automation trigger — the plain-English vocabulary uses 'lead created'. Keeping both prevents Intake and Contacts from double-emitting the same business fact.
 */
export interface ContactCreatedPayload {
  readonly contact_id: string
  readonly created_via: 'lead_intake' | 'manual' | 'inbound_call' | 'import' | 'merge_survivor'
  readonly phone_e164: string
  readonly email: string | null
  readonly full_name: string
}

/**
 * The cross-silo landmine: a merge can move a closed-won deal between sellers and therefore move money on a public leaderboard. Consent resolution takes the most restrictive value — an opt-out on either record wins.
 */
export interface ContactMergedPayload {
  readonly surviving_contact_id: string
  readonly merged_contact_id: string
  readonly surviving_owner_user_id: string
  readonly merged_owner_user_id: string
  readonly field_resolution_map: JsonValue
  readonly opportunities_moved: readonly JsonValue[]
  readonly timeline_entries_moved_count: number
  readonly consent_resolution: 'most_restrictive_wins'
}

/**
 * Consumed from opportunity.won on the contact's FIRST win. This is what turns a one-shot FE sale into a second opportunity on the same contact.
 */
export interface ContactBecameClientPayload {
  readonly contact_id: string
  readonly first_policy_opportunity_id: string
  readonly first_policy_product_type: 'final_expense' | 'iul'
  readonly annual_premium: Money
  readonly issued_at: string
  readonly cross_sell_eligible_products: readonly string[]
  readonly age_band: string | null
  readonly state_code: string
}

/**
 * ONE canonical consent event. Aloware enforces DNC/STOP on its side; we mirror it so our UI never offers a button that will be refused, and so we can prove state at any point in time.
 */
export interface ConsentUpdatedPayload {
  readonly contact_id: string
  readonly channel: 'sms' | 'call' | 'email' | 'whatsapp_reserved'
  readonly status: 'granted' | 'revoked' | 'dnc_suppressed'
  readonly reason:
    'stop_keyword' | 'manual' | 'dnc_list' | 'vendor_certificate' | 'recycle_revalidation'
  readonly evidence_ref: string | null
  readonly effective_at: string
  readonly previous_status: 'granted' | 'revoked' | 'dnc_suppressed' | null
}

/**
 * Intake-born opportunities are announced by lead.created, which carries opportunity_id — this one is cross-sell, recycle or manual.
 */
export interface OpportunityCreatedPayload {
  readonly opportunity_id: string
  readonly contact_id: string
  readonly pipeline_id: string
  readonly stage_id: string
  readonly product_type: 'final_expense' | 'iul'
  readonly deal_value_annual_premium: Money | null
  readonly created_from: 'cross_sell' | 'recycle' | 'manual' | 'lead_intake'
  readonly parent_opportunity_id: string | null
}

/**
 * Must carry to_stage_is_closed/closed_type RESOLVED AT MOVE TIME — stage config is per-seller mutable, so a consumer re-reading config later can reach a different answer than the moment of the move. Earnings deliberately does NOT consume this; it consumes opportunity.won only.
 */
export interface OpportunityStageChangedPayload {
  readonly opportunity_id: string
  readonly contact_id: string
  readonly from_stage_id: string
  readonly from_stage_name: string
  readonly to_stage_id: string
  readonly to_stage_name: string
  readonly to_stage_is_closed: boolean
  readonly to_stage_closed_type: 'won' | 'lost' | null
  readonly deal_value_annual_premium: Money | null
  readonly product_type: 'final_expense' | 'iul'
  readonly days_in_previous_stage: number
  readonly moved_via: 'kanban_drag' | 'command_palette' | 'mobile' | 'automation'
  readonly required_fields_satisfied: readonly string[]
}

/**
 * THE money event. deal_value_annual_premium is non-null and enforced by the win gate, which is what guarantees Earnings math is never blank.
 */
export interface OpportunityWonPayload {
  readonly opportunity_id: string
  readonly contact_id: string
  readonly deal_value_annual_premium: Money
  readonly product_type: 'final_expense' | 'iul'
  readonly carrier: string | null
  readonly policy_number: string | null
  readonly stage_id: string
  readonly closed_at: string
  readonly source_channel:
    'vendor_ping_post' | 'web_form' | 'inbound_call' | 'manual' | 'csv_import' | 'referral' | null
  readonly vendor_id: string | null
  readonly days_from_lead_created: number | null
  readonly touches_to_close: JsonValue
}

/**
 * Loss reasons are tenant-configurable but the code list must stay stable; Reporting keys on loss_reason_code, never the label.
 */
export interface OpportunityLostPayload {
  readonly opportunity_id: string
  readonly contact_id: string
  readonly loss_reason_code:
    | 'price_affordability'
    | 'not_contactable'
    | 'already_insured'
    | 'does_not_qualify'
    | 'not_interested'
    | 'no_funds'
  readonly loss_reason_note: string | null
  readonly stage_id_at_loss: string
  readonly deal_value_at_loss: Money | null
  readonly product_type: 'final_expense' | 'iul'
  readonly recyclable: boolean
  readonly recycle_eligible_at: string | null
}

/**
 * The single most-forgotten link in the money chain. If Earnings only listens to opportunity.won, editing a premium after close silently corrupts a PUBLIC all-time leaderboard.
 */
export interface OpportunityValueChangedPayload {
  readonly opportunity_id: string
  readonly contact_id: string
  readonly old_value: Money
  readonly new_value: Money
  readonly is_closed_won: boolean
  readonly stage_id: string
  readonly changed_by_user_id: string
  readonly reason_note: string | null
}

/**
 * Non-negotiable for an ALL-TIME board: with no monthly reset, an un-reversed bad win is wrong forever. This is why earnings is an append-only delta ledger, not a mutable total.
 */
export interface OpportunityReopenedPayload {
  readonly opportunity_id: string
  readonly contact_id: string
  readonly from_stage_id: string
  readonly previous_closed_type: 'won' | 'lost'
  readonly to_stage_id: string
  readonly deal_value_reversed: Money
  readonly reason_note: string | null
  readonly reopened_by_user_id: string
}

/**
 * ONE event, not four — 'stale', 'rotting', 'idle', 'dormant' all collapse here. Fires once per crossing (idempotent per opportunity per cold episode) or it becomes notification spam. R1.7: one threshold, cold_threshold_days, default 7. Board rot styling is derived from last_activity_at, not from a second event.
 */
export interface OpportunityWentColdPayload {
  readonly opportunity_id: string
  readonly contact_id: string
  readonly stage_id: string
  readonly stage_name: string
  readonly last_activity_at: string | null
  readonly last_activity_type: string | null
  readonly days_since_last_activity: number
  readonly threshold_days: number
  readonly deal_value_annual_premium: Money | null
  readonly tcpa_consent_flag: boolean
}

/**
 * Recycling aged leads is a TCPA landmine: consent gathered 14 months ago may no longer be defensible. consent_age_days must ride the event so Communications can refuse.
 */
export interface OpportunityRecycledPayload {
  readonly opportunity_id: string
  readonly contact_id: string
  readonly previous_outcome: 'lost' | 'cold'
  readonly previous_loss_reason_code: string | null
  readonly recycled_into_stage_id: string
  readonly consent_revalidated: boolean
  readonly consent_age_days: number
  readonly tcpa_consent_flag: boolean
  readonly new_opportunity_id: string | null
}

/**
 * Emitted by us before Aloware confirms; reconciled by call.completed on aloware_call_id. Carrying consent + local time on the dial event is what makes TCPA provable per call rather than per contact.
 */
export interface CallInitiatedPayload {
  readonly call_id: string
  readonly aloware_call_id: string | null
  readonly contact_id: string
  readonly opportunity_id: string | null
  readonly direction: 'outbound' | 'inbound'
  readonly initiated_via: 'call_now_button' | 'power_dialer' | 'chrome_extension' | 'manual'
  readonly tcpa_consent_flag: boolean
  readonly consent_evidence_ref: string | null
  readonly dnc_checked: boolean
  readonly contact_timezone: string
  readonly local_time_at_contact: string
  readonly seller_caller_id: string
  readonly initiated_at_utc_ms: number
}

/**
 * Idempotent on aloware_call_id — webhooks retry and arrive out of order. 'Missed call' in the automation vocabulary is this event filtered to direction=inbound + disposition_canonical=missed; it is NOT a separate event.
 */
export interface CallCompletedPayload {
  readonly call_id: string
  readonly aloware_call_id: string
  readonly contact_id: string
  readonly opportunity_id: string | null
  readonly direction: 'outbound' | 'inbound'
  readonly disposition_raw: string
  readonly disposition_canonical:
    | 'connected'
    | 'no_answer'
    | 'voicemail'
    | 'busy'
    | 'missed'
    | 'wrong_number'
    | 'dnc_request'
    | 'callback_requested'
  readonly talk_time_seconds: number
  readonly ring_time_seconds: number
  readonly recording_url: string | null
  readonly started_at: string
  readonly ended_at: string
  readonly agent_user_id: string
}

/**
 * Three Aloware webhooks (recording / transcript / summary) collapse into ONE internal event with parts_available[] so consumers need one handler, not three. Updates the EXISTING timeline entry in place — never a duplicate row.
 */
export interface CallEnrichedPayload {
  readonly call_id: string
  readonly aloware_call_id: string
  readonly contact_id: string
  readonly opportunity_id: string | null
  readonly parts_available: readonly string[]
  readonly recording_url: string | null
  readonly transcript_url: string | null
  readonly ai_summary_text: string | null
  readonly detected_next_steps: readonly string[]
  readonly sentiment: string | null
}

/**
 * Channel-agnostic by design — the whatsapp_reserved slot is how WhatsApp arrives later without a new event family. Appointment reminders ARE messages: there is no separate appointment.reminder_sent event, it is this with related_appointment_id.
 */
export interface MessageSentPayload {
  readonly message_id: string
  readonly channel: 'sms' | 'email' | 'whatsapp_reserved'
  readonly contact_id: string
  readonly opportunity_id: string | null
  readonly template_id: string | null
  readonly body: string
  readonly sent_by: 'user' | 'automation'
  readonly sequence_enrollment_id: string | null
  readonly related_appointment_id: string | null
  readonly tcpa_consent_flag: boolean
  readonly provider_message_id: string | null
  readonly provider_status: string | null
}

/**
 * AUTO-PAUSES every active sequence — the reply rule. A lead replying while a robot keeps texting is the fastest way to lose trust and invite a TCPA complaint, so this must reach Automations before the next sequence step is due. intent_hint=stop drives consent.updated.
 */
export interface MessageReceivedPayload {
  readonly message_id: string
  readonly channel: 'sms' | 'email' | 'whatsapp_reserved'
  readonly contact_id: string | null
  readonly opportunity_id: string | null
  readonly body: string
  readonly intent_hint: 'stop' | 'help' | 'reply' | 'out_of_office' | null
  readonly provider_message_id: string
  readonly received_at: string
  readonly unknown_sender: boolean
}

/**
 * Bad-contact-data rate per vendor_id is a purchasing lever for the owner, not just a technical error log.
 */
export interface MessageDeliveryFailedPayload {
  readonly message_id: string
  readonly channel: 'sms' | 'email' | 'whatsapp_reserved'
  readonly contact_id: string
  readonly opportunity_id: string | null
  readonly error_code: string
  readonly provider_error: string
  readonly is_hard_bounce: boolean
  readonly suggested_action: 'mark_bad_number' | 'mark_bad_email' | 'retry'
}

/**
 * starts_at_utc + contact_timezone are both mandatory: reminders fired in the wrong local time are both useless and a TCPA hours risk. Booking also auto-pauses nurture sequences — booked means stop selling the meeting.
 */
export interface AppointmentScheduledPayload {
  readonly appointment_id: string
  readonly contact_id: string
  readonly opportunity_id: string | null
  readonly starts_at_utc: string
  readonly contact_timezone: string
  readonly duration_minutes: number
  readonly appointment_type: 'phone' | 'video' | 'in_person'
  readonly dial_number_or_location: string | null
  readonly created_via: 'pipeline_card' | 'my_day' | 'command_palette' | 'during_call'
  readonly google_event_id: string | null
  readonly reminder_plan: readonly JsonValue[]
}

/**
 * originating_no_show_id is what lets Reporting prove the no-show recovery flow actually recovers revenue.
 */
export interface AppointmentRescheduledPayload {
  readonly appointment_id: string
  readonly contact_id: string
  readonly opportunity_id: string | null
  readonly old_starts_at_utc: string
  readonly new_starts_at_utc: string
  readonly contact_timezone: string
  readonly reason: string | null
  readonly rescheduled_by: 'seller' | 'contact' | 'automation_recovery'
  readonly originating_no_show_id: string | null
}

/**
 * US spelling with one L, matching the catalog. The ghost `meeting.cancelled` is the two-L British form and is registered as such.
 */
export interface AppointmentCanceledPayload {
  readonly appointment_id: string
  readonly contact_id: string
  readonly opportunity_id: string | null
  readonly scheduled_start_utc: string
  readonly canceled_by: 'seller' | 'contact' | 'system'
  readonly reason: string | null
}

/**
 * linked_call_id is what ties an Aloware phone appointment to its recording and AI summary in one timeline entry.
 */
export interface AppointmentCompletedPayload {
  readonly appointment_id: string
  readonly contact_id: string
  readonly opportunity_id: string | null
  readonly scheduled_start_utc: string
  readonly actual_duration_minutes: number | null
  readonly outcome_note: string | null
  readonly linked_call_id: string | null
  readonly marked_by: 'seller' | 'auto_from_call'
}

/**
 * Plain-English named on purpose, not a generic appointment.status_changed — the automation vocabulary must read like a sentence a seller would say.
 */
export interface AppointmentNoShowedPayload {
  readonly appointment_id: string
  readonly contact_id: string
  readonly opportunity_id: string | null
  readonly scheduled_start_utc: string
  readonly contact_timezone: string
  readonly marked_at: string
  readonly marked_by: 'seller' | 'auto_after_grace'
  readonly grace_minutes: number
  readonly attempt_call_ids: readonly string[]
  readonly tcpa_consent_flag: boolean
  readonly reschedule_attempt_number: number
}

/**
 * Silent calendar drift is how a seller misses a meeting and blames the CRM. Self-service reconnection is the point. Google Calendar sync itself is deferred to V1.1 — this event exists so the deferral does not have to be undone by adding a name later.
 */
export interface CalendarSyncFailedPayload {
  readonly user_id: string
  readonly provider: 'google'
  readonly error_code: string
  readonly error_message: string
  readonly affected_appointment_ids: readonly string[]
  readonly retry_count: number
  readonly connection_state: 'expired_token' | 'revoked' | 'rate_limited'
}

/**
 * source_event_name is what lets a seller ask 'why is this on my list today' and get a real answer. A single Activity object is what makes My Day possible.
 */
export interface ActivityCreatedPayload {
  readonly activity_id: string
  readonly type: 'call' | 'sms' | 'email' | 'task' | 'appointment_link' | 'note'
  readonly contact_id: string
  readonly opportunity_id: string | null
  readonly title: string
  readonly due_at_utc: string | null
  readonly priority: string | null
  readonly created_by: 'user' | 'automation' | 'system_rule'
  readonly source_event_id: string | null
  readonly source_event_name: string | null
  readonly linked_appointment_id: string | null
}

/**
 * Auto-completion from call/SMS events is the whole point: the seller never does bookkeeping, and the cold-lead rule stays honest because last_activity_at is real.
 */
export interface ActivityCompletedPayload {
  readonly activity_id: string
  readonly type: 'call' | 'sms' | 'email' | 'task' | 'appointment_link' | 'note'
  readonly contact_id: string
  readonly opportunity_id: string | null
  readonly completed_at: string
  readonly outcome: string | null
  readonly auto_completed: boolean
  readonly completing_event_id: string | null
  readonly completing_event_name: string | null
}

/**
 * Idempotent per activity per escalation_level, or it becomes the notification firehose that trains sellers to ignore the app.
 */
export interface ActivityOverduePayload {
  readonly activity_id: string
  readonly type: 'call' | 'sms' | 'email' | 'task' | 'appointment_link' | 'note'
  readonly contact_id: string
  readonly opportunity_id: string | null
  readonly due_at_utc: string
  readonly hours_overdue: number
  readonly escalation_level: number
}

/**
 * Enrollment state is OURS even when Aloware executes. Two engines with two states is how a replied lead keeps getting texted.
 */
export interface SequenceEnrolledPayload {
  readonly enrollment_id: string
  readonly sequence_id: string
  readonly sequence_name: string
  readonly contact_id: string
  readonly opportunity_id: string | null
  readonly enrolled_by: 'user' | 'automation'
  readonly trigger_event_id: string | null
  readonly steps_count: number
  readonly first_step_due_at: string
  readonly tcpa_consent_flag: boolean
  readonly aloware_sequence_id: string | null
}

/**
 * ONE pause event with a reason, not four differently-named ones. pause_reason=consent_revoked has legal weight and must stay distinguishable from a friendly reply-pause forever. Communications MUST call Aloware disenroll or Aloware keeps sending.
 */
export interface SequencePausedPayload {
  readonly enrollment_id: string
  readonly sequence_id: string
  readonly contact_id: string
  readonly opportunity_id: string | null
  readonly pause_reason:
    | 'contact_replied'
    | 'appointment_booked'
    | 'opportunity_closed'
    | 'consent_revoked'
    | 'dnc'
    | 'manual'
  readonly triggering_event_id: string | null
  readonly triggering_event_name: string | null
  readonly paused_at: string
  readonly steps_remaining: number
}

/**
 * Creates a human-touch task — a finished robot must hand back to a person.
 */
export interface SequenceCompletedPayload {
  readonly enrollment_id: string
  readonly sequence_id: string
  readonly contact_id: string
  readonly opportunity_id: string | null
  readonly steps_executed: number
  readonly outcome: 'no_response' | 'replied_late' | 'booked'
}

/**
 * This is the answer to 'why did the system text my lead?'. Without it, automation becomes a black box sellers distrust and disable. Note what is NOT here: automation.action_requested was deleted so automations call the owning module's command path instead of writing through a parallel path that bypasses every gate.
 */
export interface AutomationExecutedPayload {
  readonly automation_id: string
  readonly template_id: string
  readonly trigger_event_name: string
  readonly trigger_event_id: string
  readonly contact_id: string | null
  readonly opportunity_id: string | null
  readonly actions_performed: readonly string[]
  readonly result: 'success' | 'partial' | 'failed'
  readonly error_code: string | null
  readonly error_message: string | null
}

/**
 * Append-only SIGNED deltas with a period_key on every row. Never store a mutable total as the source of truth. delta is signed: a reversal is a negative append, not an edit — the ledger is forward-only and there is no recompute job.
 */
export interface EarningsUpdatedPayload {
  readonly seller_user_id: string
  readonly delta: Money
  readonly new_total_all_time: Money
  readonly period_key: string
  readonly triggering_opportunity_id: string
  readonly triggering_event_id: string
  readonly triggering_event_name: string
  readonly product_type: 'final_expense' | 'iul' | null
  readonly effective_at: string
}

/**
 * Carries names, avatars, totals and ranks ONLY — never lead data. This is how performance stays public while books of business stay private, and it is the one legitimate cross-silo broadcast.
 */
export interface LeaderboardRankChangedPayload {
  readonly period_key: string
  readonly seller_user_id: string
  readonly seller_display_name: string
  readonly seller_avatar_url: string | null
  readonly old_rank: number | null
  readonly new_rank: number
  readonly new_total_all_time: Money
  readonly podium_entered: boolean
  readonly podium_displaced_user_id: string | null
  readonly overtaken_seller_user_id: string | null
  readonly computed_at: string
}

/**
 * Fired AFTER the undo window (undo_deadline, 5000 ms) — never at the moment of the drag. amount display is a supervisor policy toggle; some floors celebrate the win, not the number.
 */
export interface CelebrationTriggeredPayload {
  readonly celebration_type: 'closed_won' | 'podium_entry' | 'personal_best' | 'most_improved'
  readonly seller_user_id: string
  readonly seller_display_name: string
  readonly amount: Money | null
  readonly product_type: 'final_expense' | 'iul' | null
  readonly source_event_id: string
  readonly message_template_id: string
  readonly broadcast_scope: 'tenant_wide' | 'kiosk_only' | 'owner_only'
  readonly muted_for_user_ids: readonly string[]
}

/**
 * The nastiest hidden dependency in the system: a per-seller stage tweak can silently move a PUBLIC leaderboard. Almost every module spec forgets this event exists. Automations with stage-bound rules may now point at a deleted stage — must be flagged, not silently broken.
 */
export interface PipelineStageConfigChangedPayload {
  readonly pipeline_id: string
  readonly scope: 'tenant_template' | 'user_override'
  readonly affected_user_ids: readonly string[]
  readonly stages_before: readonly JsonValue[]
  readonly stages_after: readonly JsonValue[]
  readonly closed_flags_changed: readonly JsonValue[]
  readonly required_fields_changed: readonly JsonValue[]
  readonly affected_opportunity_count: number
  readonly migration_map: JsonValue
}

/**
 * Deliberately generic ONLY for low-blast-radius settings. Anything that can move money — stage closed flags — gets its own explicit event. Routed to the owning module by setting_key.
 */
export interface AdminSettingChangedPayload {
  readonly setting_key: string
  readonly scope: 'tenant' | 'user'
  readonly scoped_to_user_id: string | null
  readonly old_value: string | null
  readonly new_value: string | null
  readonly changed_by_user_id: string
}

/**
 * An all-time leaderboard with no departure policy eventually shows a #1 who left two years ago. earnings_disposition forces the decision at the moment it matters.
 */
export interface UserDeactivatedPayload {
  readonly user_id: string
  readonly role: 'seller' | 'supervisor' | 'admin'
  readonly book_of_business_size: number
  readonly open_opportunity_ids: readonly string[]
  readonly reassign_to_user_id: string | null
  readonly earnings_disposition: 'keep_in_history' | 'exclude_from_board'
  readonly closed_won_total: Money
}

/**
 * A vendor re-posts a lead the same seller already owns; the record updates in place instead of creating a second card. Without it the re-post is invisible: no timeline entry, and the vendor's duplicate rate cannot be measured.
 *
 * PAYLOAD IS DERIVED, NOT RATIFIED. Amendment 1 gave this event an emitter, a
 * trigger and a rationale but no field list; these fields follow from those and
 * the module that first emits it should settle them.
 */
export interface LeadRepostedPayload {
  readonly contact_id: string
  readonly opportunity_id: string
  readonly vendor_id: string
  readonly vendor_lead_id: string
  readonly previous_received_at_utc_ms: number
  readonly received_at_utc_ms: number
  readonly fields_updated: readonly string[]
}

/**
 * THE NUMBER THAT PROVES THE GATE WORKS. Without it we can count sends and failures but never REFUSALS. The plain-English reason is written to the timeline, so `reason` must stay a stable code that the microcopy maps from.
 *
 * PAYLOAD IS DERIVED, NOT RATIFIED. Amendment 1 gave this event an emitter, a
 * trigger and a rationale but no field list; these fields follow from those and
 * the module that first emits it should settle them.
 */
export interface ComplianceSendBlockedPayload {
  readonly contact_id: string
  readonly opportunity_id: string | null
  readonly channel: 'sms' | 'call' | 'email' | 'whatsapp_reserved'
  readonly reason: 'outside_window' | 'no_consent' | 'stop' | 'dnc' | '10dlc_pending' | 'bad_number'
  readonly attempted_via: string
  readonly lead_local_time: string
  readonly blocked_at: string
}

/**
 * Break-glass. Legally load-bearing: who opened the door, and when.
 *
 * PAYLOAD IS DERIVED, NOT RATIFIED. Amendment 1 gave this event an emitter, a
 * trigger and a rationale but no field list; these fields follow from those and
 * the module that first emits it should settle them.
 */
export interface ComplianceOverrideStartedPayload {
  readonly override_id: string
  readonly scope: 'tenant'
  readonly reason: string
  readonly started_by_user_id: string
  readonly expires_at: string | null
}

/**
 * Duration is what an auditor asks for. sends_permitted_count answers the second question they ask.
 *
 * PAYLOAD IS DERIVED, NOT RATIFIED. Amendment 1 gave this event an emitter, a
 * trigger and a rationale but no field list; these fields follow from those and
 * the module that first emits it should settle them.
 */
export interface ComplianceOverrideEndedPayload {
  readonly override_id: string
  readonly ended_by: 'admin' | 'expiry'
  readonly ended_by_user_id: string | null
  readonly duration_seconds: number
  readonly sends_permitted_count: number
}

/**
 * T-15m. The notification trigger both the flows and the stories assumed existed. Distinct from the T-1h SMS reminder, which is a message.sent with related_appointment_id.
 *
 * PAYLOAD IS DERIVED, NOT RATIFIED. Amendment 1 gave this event an emitter, a
 * trigger and a rationale but no field list; these fields follow from those and
 * the module that first emits it should settle them.
 */
export interface AppointmentStartingSoonPayload {
  readonly appointment_id: string
  readonly contact_id: string
  readonly opportunity_id: string | null
  readonly starts_at_utc: string
  readonly minutes_until: number
}

/**
 * Proves the win/loss guard is FIRING rather than being bypassed. Binds to stage_type, never to a stage name — renaming a column must change nothing.
 *
 * PAYLOAD IS DERIVED, NOT RATIFIED. Amendment 1 gave this event an emitter, a
 * trigger and a rationale but no field list; these fields follow from those and
 * the module that first emits it should settle them.
 */
export interface OpportunityGateBlockedPayload {
  readonly opportunity_id: string
  readonly contact_id: string
  readonly to_stage_id: string
  readonly to_stage_type: 'earning' | 'lost'
  readonly missing_fields: readonly string[]
  readonly attempted_via: 'kanban_drag' | 'command_palette' | 'mobile' | 'automation' | 'api'
  readonly blocked_at: string
}

/**
 * Ownership moves leads AND money between books; it cannot be silent. Admin-only and single-record by design — this is the exact seam where a routing engine would get smuggled in against the silo rule.
 *
 * PAYLOAD IS DERIVED, NOT RATIFIED. Amendment 1 gave this event an emitter, a
 * trigger and a rationale but no field list; these fields follow from those and
 * the module that first emits it should settle them.
 */
export interface ContactOwnerChangedPayload {
  readonly contact_id: string
  readonly old_owner_user_id: string
  readonly new_owner_user_id: string
  readonly opportunities_moved: readonly string[]
  readonly closed_won_moved: Money
  readonly reason: string
  readonly changed_by_user_id: string
}

/**
 * Drives dial suppression and vendor data-quality reporting. A number marked bad must stop being offered by every surface that dials, or the seller keeps burning attempts on a line that cannot connect.
 *
 * PAYLOAD IS DERIVED, NOT RATIFIED. Amendment 1 gave this event an emitter, a
 * trigger and a rationale but no field list; these fields follow from those and
 * the module that first emits it should settle them.
 */
export interface ContactBadNumberFlaggedPayload {
  readonly contact_id: string
  readonly phone_e164: string
  readonly flagged_via: 'failed_dial' | 'delivery_failure' | 'manual'
  readonly source_event_id: string | null
  readonly flagged_at: string
}

/**
 * THE ROLLOUT GUARD: an unverified map silently routes leads into the wrong book. This is item 1 of the first-run checklist, which cannot complete until this event can be emitted.
 *
 * PAYLOAD IS DERIVED, NOT RATIFIED. Amendment 1 gave this event an emitter, a
 * trigger and a rationale but no field list; these fields follow from those and
 * the module that first emits it should settle them.
 */
export interface IntegrationMappingVerifiedPayload {
  readonly user_id: string
  readonly provider: 'aloware'
  readonly provider_number_e164: string
  readonly verified_via: 'test_call' | 'test_sms'
  readonly verified_at: string
}

/** Name → payload, so a handler cannot read a field the event does not carry. */
export interface EventPayloads {
  readonly 'lead.created': LeadCreatedPayload
  readonly 'lead.duplicate_detected': LeadDuplicateDetectedPayload
  readonly 'lead.import_completed': LeadImportCompletedPayload
  readonly 'contact.created': ContactCreatedPayload
  readonly 'contact.merged': ContactMergedPayload
  readonly 'contact.became_client': ContactBecameClientPayload
  readonly 'consent.updated': ConsentUpdatedPayload
  readonly 'opportunity.created': OpportunityCreatedPayload
  readonly 'opportunity.stage_changed': OpportunityStageChangedPayload
  readonly 'opportunity.won': OpportunityWonPayload
  readonly 'opportunity.lost': OpportunityLostPayload
  readonly 'opportunity.value_changed': OpportunityValueChangedPayload
  readonly 'opportunity.reopened': OpportunityReopenedPayload
  readonly 'opportunity.went_cold': OpportunityWentColdPayload
  readonly 'opportunity.recycled': OpportunityRecycledPayload
  readonly 'call.initiated': CallInitiatedPayload
  readonly 'call.completed': CallCompletedPayload
  readonly 'call.enriched': CallEnrichedPayload
  readonly 'message.sent': MessageSentPayload
  readonly 'message.received': MessageReceivedPayload
  readonly 'message.delivery_failed': MessageDeliveryFailedPayload
  readonly 'appointment.scheduled': AppointmentScheduledPayload
  readonly 'appointment.rescheduled': AppointmentRescheduledPayload
  readonly 'appointment.canceled': AppointmentCanceledPayload
  readonly 'appointment.completed': AppointmentCompletedPayload
  readonly 'appointment.no_showed': AppointmentNoShowedPayload
  readonly 'calendar.sync_failed': CalendarSyncFailedPayload
  readonly 'activity.created': ActivityCreatedPayload
  readonly 'activity.completed': ActivityCompletedPayload
  readonly 'activity.overdue': ActivityOverduePayload
  readonly 'sequence.enrolled': SequenceEnrolledPayload
  readonly 'sequence.paused': SequencePausedPayload
  readonly 'sequence.completed': SequenceCompletedPayload
  readonly 'automation.executed': AutomationExecutedPayload
  readonly 'earnings.updated': EarningsUpdatedPayload
  readonly 'leaderboard.rank_changed': LeaderboardRankChangedPayload
  readonly 'celebration.triggered': CelebrationTriggeredPayload
  readonly 'pipeline.stage_config_changed': PipelineStageConfigChangedPayload
  readonly 'admin.setting_changed': AdminSettingChangedPayload
  readonly 'user.deactivated': UserDeactivatedPayload
  readonly 'lead.reposted': LeadRepostedPayload
  readonly 'compliance.send_blocked': ComplianceSendBlockedPayload
  readonly 'compliance.override_started': ComplianceOverrideStartedPayload
  readonly 'compliance.override_ended': ComplianceOverrideEndedPayload
  readonly 'appointment.starting_soon': AppointmentStartingSoonPayload
  readonly 'opportunity.gate_blocked': OpportunityGateBlockedPayload
  readonly 'contact.owner_changed': ContactOwnerChangedPayload
  readonly 'contact.bad_number_flagged': ContactBadNumberFlaggedPayload
  readonly 'integration.mapping_verified': IntegrationMappingVerifiedPayload
}

/** An event on the wire: the envelope, its name, and the payload that name implies. */
export type CanonicalEvent<N extends EventName = EventName> = {
  readonly [K in N]: EventEnvelope & { readonly name: K; readonly payload: EventPayloads[K] }
}[N]

/** The single module allowed to emit each event. Two emitters is two truths. */
export const EVENT_EMITTERS: { readonly [N in EventName]: string } = {
  'lead.created': 'lead-intake',
  'lead.duplicate_detected': 'lead-intake',
  'lead.import_completed': 'lead-intake',
  'contact.created': 'contacts',
  'contact.merged': 'contacts',
  'contact.became_client': 'contacts',
  'consent.updated': 'contacts',
  'opportunity.created': 'pipeline',
  'opportunity.stage_changed': 'pipeline',
  'opportunity.won': 'pipeline',
  'opportunity.lost': 'pipeline',
  'opportunity.value_changed': 'pipeline',
  'opportunity.reopened': 'pipeline',
  'opportunity.went_cold': 'pipeline',
  'opportunity.recycled': 'pipeline',
  'call.initiated': 'communications',
  'call.completed': 'communications',
  'call.enriched': 'communications',
  'message.sent': 'communications',
  'message.received': 'communications',
  'message.delivery_failed': 'communications',
  'appointment.scheduled': 'calendar',
  'appointment.rescheduled': 'calendar',
  'appointment.canceled': 'calendar',
  'appointment.completed': 'calendar',
  'appointment.no_showed': 'calendar',
  'calendar.sync_failed': 'calendar',
  'activity.created': 'activities',
  'activity.completed': 'activities',
  'activity.overdue': 'activities',
  'sequence.enrolled': 'automations',
  'sequence.paused': 'automations',
  'sequence.completed': 'automations',
  'automation.executed': 'automations',
  'earnings.updated': 'earnings',
  'leaderboard.rank_changed': 'earnings',
  'celebration.triggered': 'notifications',
  'pipeline.stage_config_changed': 'admin',
  'admin.setting_changed': 'admin',
  'user.deactivated': 'admin',
  'lead.reposted': 'lead-intake',
  'compliance.send_blocked': 'compliance',
  'compliance.override_started': 'admin',
  'compliance.override_ended': 'admin',
  'appointment.starting_soon': 'calendar',
  'opportunity.gate_blocked': 'pipeline',
  'contact.owner_changed': 'admin',
  'contact.bad_number_flagged': 'contacts',
  'integration.mapping_verified': 'admin',
}

/** Declared consumers, from the catalog. A consumer nobody registered is a consumer nobody notices going quiet. */
export const EVENT_CONSUMERS: { readonly [N in EventName]: readonly string[] } = {
  'lead.created': [
    'pipeline',
    'activities',
    'notifications',
    'communications',
    'automations',
    'contacts',
    'reporting',
    'audit',
  ],
  'lead.duplicate_detected': ['contacts', 'notifications', 'admin', 'reporting', 'audit'],
  'lead.import_completed': ['notifications', 'contacts', 'pipeline', 'reporting', 'audit'],
  'contact.created': ['audit', 'search', 'reporting'],
  'contact.merged': [
    'pipeline',
    'communications',
    'earnings',
    'activities',
    'contacts',
    'reporting',
    'audit',
  ],
  'contact.became_client': ['automations', 'pipeline', 'activities', 'reporting', 'audit'],
  'consent.updated': [
    'communications',
    'automations',
    'pipeline',
    'notifications',
    'admin',
    'reporting',
    'audit',
  ],
  'opportunity.created': ['activities', 'automations', 'contacts', 'reporting', 'audit'],
  'opportunity.stage_changed': [
    'automations',
    'activities',
    'contacts',
    'notifications',
    'reporting',
    'communications',
    'audit',
  ],
  'opportunity.won': [
    'earnings',
    'notifications',
    'contacts',
    'activities',
    'automations',
    'communications',
    'reporting',
    'audit',
  ],
  'opportunity.lost': [
    'automations',
    'activities',
    'contacts',
    'reporting',
    'notifications',
    'audit',
  ],
  'opportunity.value_changed': ['earnings', 'reporting', 'notifications', 'audit'],
  'opportunity.reopened': ['earnings', 'reporting', 'notifications', 'activities', 'audit'],
  'opportunity.went_cold': [
    'pipeline',
    'activities',
    'automations',
    'notifications',
    'reporting',
    'audit',
  ],
  'opportunity.recycled': [
    'activities',
    'automations',
    'communications',
    'contacts',
    'reporting',
    'audit',
  ],
  'call.initiated': ['activities', 'pipeline', 'contacts', 'reporting', 'automations', 'audit'],
  'call.completed': [
    'contacts',
    'activities',
    'pipeline',
    'automations',
    'reporting',
    'earnings',
    'notifications',
    'audit',
  ],
  'call.enriched': ['contacts', 'activities', 'pipeline', 'reporting', 'audit'],
  'message.sent': ['contacts', 'activities', 'pipeline', 'reporting', 'automations', 'audit'],
  'message.received': [
    'automations',
    'notifications',
    'activities',
    'communications',
    'contacts',
    'pipeline',
    'reporting',
    'audit',
  ],
  'message.delivery_failed': [
    'contacts',
    'communications',
    'activities',
    'notifications',
    'reporting',
    'audit',
  ],
  'appointment.scheduled': [
    'pipeline',
    'activities',
    'automations',
    'notifications',
    'contacts',
    'calendar',
    'reporting',
    'audit',
  ],
  'appointment.rescheduled': [
    'activities',
    'automations',
    'pipeline',
    'calendar',
    'notifications',
    'reporting',
    'audit',
  ],
  'appointment.canceled': [
    'activities',
    'automations',
    'pipeline',
    'notifications',
    'reporting',
    'audit',
  ],
  'appointment.completed': [
    'pipeline',
    'activities',
    'automations',
    'contacts',
    'reporting',
    'earnings',
    'audit',
  ],
  'appointment.no_showed': [
    'activities',
    'automations',
    'pipeline',
    'notifications',
    'reporting',
    'contacts',
    'audit',
  ],
  'calendar.sync_failed': ['notifications', 'admin', 'audit'],
  'activity.created': ['my-day', 'pipeline', 'notifications', 'reporting', 'audit'],
  'activity.completed': ['pipeline', 'earnings', 'reporting', 'contacts', 'automations', 'audit'],
  'activity.overdue': ['notifications', 'my-day', 'pipeline', 'reporting', 'audit'],
  'sequence.enrolled': ['communications', 'activities', 'contacts', 'reporting', 'audit'],
  'sequence.paused': ['communications', 'contacts', 'notifications', 'reporting', 'audit'],
  'sequence.completed': ['activities', 'automations', 'reporting', 'audit'],
  'automation.executed': ['admin', 'notifications', 'reporting', 'audit'],
  'earnings.updated': [
    'leaderboard',
    'seller-dashboard',
    'admin',
    'notifications',
    'reporting',
    'audit',
  ],
  'leaderboard.rank_changed': [
    'leaderboard',
    'kiosk',
    'notifications',
    'celebration',
    'reporting',
    'audit',
  ],
  'celebration.triggered': ['in-app-toast', 'kiosk', 'push', 'leaderboard', 'reporting', 'audit'],
  'pipeline.stage_config_changed': [
    'pipeline',
    'earnings',
    'automations',
    'reporting',
    'notifications',
    'audit',
  ],
  'admin.setting_changed': ['reporting', 'notifications', 'audit'],
  'user.deactivated': [
    'earnings',
    'pipeline',
    'communications',
    'calendar',
    'notifications',
    'reporting',
    'audit',
  ],
  'lead.reposted': ['contacts', 'reporting', 'audit'],
  'compliance.send_blocked': ['contacts', 'notifications', 'admin', 'reporting', 'audit'],
  'compliance.override_started': ['communications', 'notifications', 'admin', 'reporting', 'audit'],
  'compliance.override_ended': ['communications', 'notifications', 'admin', 'reporting', 'audit'],
  'appointment.starting_soon': ['notifications', 'my-day', 'audit'],
  'opportunity.gate_blocked': ['reporting', 'audit'],
  'contact.owner_changed': ['pipeline', 'earnings', 'communications', 'reporting', 'audit'],
  'contact.bad_number_flagged': ['communications', 'pipeline', 'reporting', 'audit'],
  'integration.mapping_verified': ['communications', 'admin', 'notifications', 'audit'],
}

/**
 * Payload fields carrying `Money`, per event.
 *
 * Money is `bigint` cents behind a branded type and crosses JSON as a string of
 * whole cents, never a JS number. A serialiser that misses one field ships a
 * float onto a public leaderboard, so the list is generated rather than
 * remembered.
 */
export const MONEY_FIELDS: { readonly [N in EventName]: readonly string[] } = {
  'lead.created': [],
  'lead.duplicate_detected': [],
  'lead.import_completed': [],
  'contact.created': [],
  'contact.merged': [],
  'contact.became_client': ['annual_premium'],
  'consent.updated': [],
  'opportunity.created': ['deal_value_annual_premium'],
  'opportunity.stage_changed': ['deal_value_annual_premium'],
  'opportunity.won': ['deal_value_annual_premium'],
  'opportunity.lost': ['deal_value_at_loss'],
  'opportunity.value_changed': ['old_value', 'new_value'],
  'opportunity.reopened': ['deal_value_reversed'],
  'opportunity.went_cold': ['deal_value_annual_premium'],
  'opportunity.recycled': [],
  'call.initiated': [],
  'call.completed': [],
  'call.enriched': [],
  'message.sent': [],
  'message.received': [],
  'message.delivery_failed': [],
  'appointment.scheduled': [],
  'appointment.rescheduled': [],
  'appointment.canceled': [],
  'appointment.completed': [],
  'appointment.no_showed': [],
  'calendar.sync_failed': [],
  'activity.created': [],
  'activity.completed': [],
  'activity.overdue': [],
  'sequence.enrolled': [],
  'sequence.paused': [],
  'sequence.completed': [],
  'automation.executed': [],
  'earnings.updated': ['delta', 'new_total_all_time'],
  'leaderboard.rank_changed': ['new_total_all_time'],
  'celebration.triggered': ['amount'],
  'pipeline.stage_config_changed': [],
  'admin.setting_changed': [],
  'user.deactivated': ['closed_won_total'],
  'lead.reposted': [],
  'compliance.send_blocked': [],
  'compliance.override_started': [],
  'compliance.override_ended': [],
  'appointment.starting_soon': [],
  'opportunity.gate_blocked': [],
  'contact.owner_changed': ['closed_won_moved'],
  'contact.bad_number_flagged': [],
  'integration.mapping_verified': [],
}

/** A name that was ruled out, what to use instead, and what breaks if you don't. */
export interface Ghost {
  /** The canonical event to use, or `null` when the name was deleted outright. */
  readonly use: EventName | null
  readonly consequence: string
}

/**
 * THE HALF THAT ACTUALLY CATCHES THINGS. §2 of 02b calls the ghosts the real
 * finding: a module waiting for `opportunity.closed_won` never fires on a sale
 * and nothing anywhere goes red. A positive registry sees an unknown name; this
 * map knows the name was RULED OUT and can say what the silence costs.
 */
export const GHOSTS: { readonly [name: string]: Ghost } = {
  'opportunity.closed_won': {
    use: 'opportunity.won',
    consequence:
      'Six modules were waiting for this name. Celebration, task-closing and reporting never fire on a sale — and nothing goes red.',
  },
  'lead.went_cold': {
    use: 'opportunity.went_cold',
    consequence:
      'The 7-day cold rule has no home; board badges never appear. Cold is a property of the opportunity, not of the lead.',
  },
  'email.received': {
    use: 'message.received',
    consequence:
      'Sequences never auto-pause on reply — robots keep texting people who already answered.',
  },
  'sms.received': {
    use: 'message.received',
    consequence:
      'Same as email.received. The channel is an enum on one event, which is also how WhatsApp arrives later without touching a consumer.',
  },
  'sms.opt_out_received': {
    use: 'consent.updated',
    consequence:
      'A STOP is honored on SMS but NOT on the dialer. One canonical consent event is what makes a revocation reach every channel.',
  },
  'meeting.booked': {
    use: 'appointment.scheduled',
    consequence: 'Booked meetings never reach My Day or the card.',
  },
  'meeting.cancelled': {
    use: 'appointment.canceled',
    consequence:
      'Booked meetings never reach My Day or the card. Note the spelling: the catalog is en-US with one L.',
  },
  'task.created': {
    use: 'activity.created',
    consequence:
      'Two activity models. My Day becomes a lie because half the work is in the other one.',
  },
  'task.completed': {
    use: 'activity.completed',
    consequence:
      'Two activity models, and the staleness clock reads the wrong one — so the cold rule fires on leads that were just worked.',
  },
  'task.overdue': {
    use: 'activity.overdue',
    consequence: 'Two activity models; overdue escalation silently covers half the work.',
  },
  'tenant.settings_changed': {
    use: 'admin.setting_changed',
    consequence: 'Cold threshold changes are silently ignored.',
  },
  'pipeline.settings_updated': {
    use: 'pipeline.stage_config_changed',
    consequence:
      'Stage-flag changes are silently ignored — which means a closed_won toggle moves a PUBLIC leaderboard with no recompute.',
  },
  'automation.action_requested': {
    use: null,
    consequence:
      "DELETED, not remapped. Four modules expected it. Automations call the owning module's command path instead; a dedicated action event is a parallel write path that bypasses every gate — including the one compliance gate.",
  },
  'lead.assigned_owner_changed': {
    use: 'contact.owner_changed',
    consequence:
      'Routing sneaking in the back door. Ownership is bound deterministically at the source; there is no routing engine.',
  },
  'lead.owner_changed': {
    use: 'contact.owner_changed',
    consequence:
      "§2's intermediate remap target, superseded by §4b. Reading §2 alone and stopping there produces this name.",
  },
  'speed_to_lead.stopped': {
    use: 'call.completed',
    consequence:
      'Derived, not an event. First-touch latency is a field on the opportunity computed from call.completed. An event here would be a second source of truth for a number the board already shows.',
  },
  'earnings.credited': {
    use: 'earnings.updated',
    consequence:
      'Redundant. earnings.updated carries a SIGNED delta plus the triggering event; three names for one fact re-creates the drift this catalog exists to prevent.',
  },
  'earnings.reversed': {
    use: 'earnings.updated',
    consequence:
      'Redundant — a reversal is a negative delta on the one event. A separate name invites a mutable total.',
  },
  'earnings.adjusted': {
    use: 'earnings.updated',
    consequence:
      'Redundant — an admin adjustment is a signed delta with its own triggering_event_name.',
  },
  'notification.dispatched': {
    use: null,
    consequence:
      'No consumer in the MVP. The notification-fatigue metric it would feed is out of scope.',
  },
  'book.viewed': { use: null, consequence: 'Rejected: surveillance with no operational payoff.' },
  'touch.recorded': {
    use: 'activity.completed',
    consequence:
      'A projection, not an event. last_activity_at is derived; a second writer is how it stops matching the timeline.',
  },
  'conversation.needs_reply': {
    use: 'message.received',
    consequence: 'Derived. It is a state on the thread, not an event.',
  },
  'meeting.outcome_recorded': {
    use: 'appointment.completed',
    consequence:
      'Remapped — the outcome is carried by appointment.completed or appointment.no_showed, which is what makes held-rate reporting possible.',
  },
  'stage_config.changed': {
    use: 'pipeline.stage_config_changed',
    consequence:
      'Stage-flag changes silently ignored, including the closed_won toggle that moves money.',
  },
  'lead.imported': {
    use: 'lead.import_completed',
    consequence:
      'The import is a job with a result, not a per-row fact. Per-row emission would flood every consumer.',
  },
  'call.recording_ready': {
    use: 'call.enriched',
    consequence:
      'Three Aloware webhooks collapse into one internal event with parts_available[]. Three names means three handlers and three chances to duplicate the timeline row.',
  },
  'call.transcript_ready': {
    use: 'call.enriched',
    consequence: 'Same collapse — parts_available[] carries which half arrived.',
  },
  'call.summary_ready': {
    use: 'call.enriched',
    consequence: 'Same collapse — the AloAi summary is a part, not an event.',
  },
  'sms.sent': {
    use: 'message.sent',
    consequence:
      'Channel is an enum on one event. A per-channel event family is what makes WhatsApp a rewrite instead of a new enum member.',
  },
  'email.sent': {
    use: 'message.sent',
    consequence:
      'Channel is an enum on one event. Email itself is deferred to V1.1; the slot is already here.',
  },
  'meeting.reminder_sent': {
    use: 'message.sent',
    consequence:
      'A reminder IS a message — message.sent with related_appointment_id. A separate event would let a reminder skip the one compliance gate that every message passes.',
  },
  'pipeline.card_moved': {
    use: 'opportunity.stage_changed',
    consequence:
      'The board is not an event source. A card is a rendering of an opportunity; emitting from the UI is how a move made by API never reaches a consumer.',
  },
}
