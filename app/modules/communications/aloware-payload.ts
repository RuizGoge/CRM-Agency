/**
 * WHAT ALOWARE ACTUALLY GIVES US — the field catalog, derived from the Gate-2
 * capture and from nothing else.
 *
 * This file is a **reference surface, not a runtime contract.** Nothing in the
 * product reads it to make a decision; it exists so that the question "what do
 * we get out of this integration" has one answer that was measured rather than
 * remembered. Every entry below was read off `evidence/aloware/webhooks.ndjson`
 * — 22 real deliveries captured on 2026-08-05, of which exactly one is a
 * completed outbound two-legged call (`940868616`: 63 s of talk, a recording, a
 * transcription and an AI summary).
 *
 * ⚠️ THREE THINGS THIS CATALOG IS NOT:
 *
 * 1. **It is not the shape of every event.** The field SET differs between
 *    events of the same family — `OutboundPhoneCall` carries no
 *    `current_status`, no `disposition_status`, no `direct_recording_url` and
 *    no `call_disposition`, while `OutboundPhoneCall-DispositionCompleted`
 *    carries all four. `presentOn` records which events actually carried each
 *    field, because a mapper written against one event and applied to the
 *    family reads `undefined` and calls it `null`.
 *
 * 2. **It is not live.** The Gate-2 spike deleted its webhook subscription
 *    during teardown, so no call placed today delivers anything anywhere. What
 *    is rendered from this catalog is the captured evidence, not a feed.
 *
 * 3. **It is not a promise that we store any of it.** `useInCrm` says what the
 *    design does with a field, and `null` means nothing — which is most of them.
 */

/** Where a field belongs when a human is reading the payload. */
export type FieldGroup =
  'identity' | 'routing' | 'outcome' | 'timing' | 'media' | 'compliance' | 'contact' | 'unused'

export const FIELD_GROUP_LABEL: Record<FieldGroup, string> = {
  identity: 'Identity — what this call is',
  routing: 'Routing — who dialled, from where',
  outcome: 'Outcome — how it ended',
  timing: 'Timing — the seconds',
  media: 'Media — recording, transcript, summary',
  compliance: 'Compliance flags Aloware carries',
  contact: 'The contact record, as Aloware holds it',
  unused: 'Present and unused',
}

export interface AlowareField {
  /** Dotted path inside the delivered JSON, from the envelope root. */
  readonly path: string
  readonly label: string
  readonly group: FieldGroup
  readonly type: 'string' | 'number' | 'boolean' | 'timestamp' | 'url' | 'enum' | 'json'
  /** Whether the value identifies a real person. Drives redaction, everywhere. */
  readonly pii: boolean
  /** What the provider means by it. */
  readonly meaning: string
  /** What THIS product does with it, or null when the answer is nothing. */
  readonly useInCrm: string | null
  /** Which captured events actually carried it. */
  readonly presentOn: readonly string[]
}

const INIT = 'OutboundPhoneCall'
const DONE = 'OutboundPhoneCall-DispositionCompleted'
const REC = 'Recording-Saved'
const DISP = 'Call-Disposed'
const ALL_CALL = [INIT, DONE, REC, DISP] as const

export const ALOWARE_CALL_FIELDS: readonly AlowareField[] = [
  // ---------------------------------------------------------------- identity
  {
    path: 'event',
    label: 'Event name',
    group: 'identity',
    type: 'string',
    pii: false,
    meaning:
      'The only thing that says what happened. THREE naming conventions appear in one stream: `OutboundPhoneCall`, `OutboundPhoneCall-DispositionCompleted` and lowercase-dotted `transcription.call.summarized`.',
    useInCrm:
      'Maps to a canonical event. A mapper keyed on one convention loses the others in silence.',
    presentOn: ALL_CALL,
  },
  {
    path: 'body.id',
    label: 'Communication id',
    group: 'identity',
    type: 'number',
    pii: false,
    meaning:
      'Aloware’s id for the communication. NOT call-specific: SMS carries the same field in the same space, so there is one id space for all "communications".',
    useInCrm: '`call.aloware_call_id` — the natural key of the merge (§4.4 rung 2).',
    presentOn: ALL_CALL,
  },
  {
    path: 'body.contact_id',
    label: 'Aloware contact id',
    group: 'identity',
    type: 'number',
    pii: false,
    meaning: 'The contact in Aloware’s own book that this call belongs to.',
    useInCrm: null,
    presentOn: ALL_CALL,
  },
  {
    path: 'body.attempt',
    label: 'Attempt number',
    group: 'identity',
    type: 'number',
    pii: false,
    meaning: 'Which dial attempt this is against the contact.',
    useInCrm: 'Cross-check only. Our own attempt count is ours and is not read from here.',
    presentOn: ALL_CALL,
  },
  {
    path: 'body.direction',
    label: 'Direction',
    group: 'identity',
    type: 'enum',
    pii: false,
    meaning: '`2` outbound, `1` inbound. Numeric, undocumented in the payload itself.',
    useInCrm: '`call.direction`.',
    presentOn: ALL_CALL,
  },

  // ----------------------------------------------------------------- routing
  {
    path: 'body.user_id',
    label: 'Aloware user id',
    group: 'routing',
    type: 'number',
    pii: false,
    meaning: 'The Aloware seat that placed the call. Verified to carry per-seller attribution.',
    useInCrm: '`aloware_number_mapping` — this is the join that makes the silo buildable on REST.',
    presentOn: ALL_CALL,
  },
  {
    path: 'body.owner_id',
    label: 'Owner id',
    group: 'routing',
    type: 'number',
    pii: false,
    meaning:
      'Who owns the communication. Equal to `user_id` on the captured call; `-1` means the company with no owner.',
    useInCrm: null,
    presentOn: ALL_CALL,
  },
  {
    path: 'body.ring_group_id',
    label: 'Ring group (inbox)',
    group: 'routing',
    type: 'number',
    pii: false,
    meaning: 'The inbox the agent leg rang. `29109` is Default Inbox on this account.',
    useInCrm: null,
    presentOn: ALL_CALL,
  },
  {
    path: 'body.campaign_id',
    label: 'Line id',
    group: 'routing',
    type: 'number',
    pii: false,
    meaning:
      'Aloware calls a line a "campaign" here. `63949` is the Test Line, `65123` the 58-number Local Presence pool.',
    useInCrm:
      'Per-call caller ID. The dial takes `line_id` per request, so per-seller numbers are reachable.',
    presentOn: ALL_CALL,
  },
  {
    path: 'body.incoming_number',
    label: 'Our number (caller ID shown)',
    group: 'routing',
    type: 'string',
    pii: true,
    meaning: 'The E.164 the lead saw.',
    useInCrm: '`aloware_number_mapping.from_number_e164`.',
    presentOn: ALL_CALL,
  },
  {
    path: 'body.lead_number',
    label: 'Lead number',
    group: 'routing',
    type: 'string',
    pii: true,
    meaning: 'The number dialled. A real consumer’s phone.',
    useInCrm: 'Matched against `contact_phone.phone_e164` to attach the call to a contact.',
    presentOn: ALL_CALL,
  },
  {
    path: 'body.creator_type',
    label: 'Creator type',
    group: 'routing',
    type: 'enum',
    pii: false,
    meaning:
      'How the call was created. Worth knowing because the MCP surface tags everything `MCP` with no per-seller detail, which is why MCP is incompatible with the silo.',
    useInCrm: null,
    presentOn: ALL_CALL,
  },

  // ----------------------------------------------------------------- outcome
  {
    path: 'body.current_status',
    label: 'Status (text)',
    group: 'outcome',
    type: 'string',
    pii: false,
    meaning: '`completed`. ABSENT on the initiation event — it appears only at disposition.',
    useInCrm: null,
    presentOn: [DONE, REC, DISP],
  },
  {
    path: 'body.current_status2',
    label: 'Status (numeric)',
    group: 'outcome',
    type: 'enum',
    pii: false,
    meaning:
      '`1` initiated, `2` inbound ringing, `9` closed, `19` on a failed SMS. The numeric ladder is the only status present on the initiation event.',
    useInCrm: '`call.state_ordinal`, which is monotonic by trigger so a late event cannot regress.',
    presentOn: ALL_CALL,
  },
  {
    path: 'body.disposition_status2',
    label: 'Disposition (numeric)',
    group: 'outcome',
    type: 'enum',
    pii: false,
    meaning:
      'Observed: `4` completed, `5` failed, `3` missed, `11` on appointments, `7` on an invalid SMS.',
    useInCrm: '`disposition_raw`, carried as enrichment only.',
    presentOn: ALL_CALL,
  },
  {
    path: 'body.call_disposition_id',
    label: 'Agency disposition id',
    group: 'outcome',
    type: 'number',
    pii: false,
    meaning:
      'Points at one of the account’s 11 agency-authored dispositions. ⚠️ Observed as `31227` = "No Answer" on a call with 63 seconds of talk time, which nobody set by hand.',
    useInCrm:
      'Enrichment ONLY. US-604 rules the semantic outcome comes from our wrap-up sheet, and this is the direct evidence for why.',
    presentOn: ALL_CALL,
  },
  {
    path: 'body.customer_leg_status',
    label: 'Lead-leg status',
    group: 'outcome',
    type: 'number',
    pii: false,
    meaning:
      '🔴 `null` on the initiation event and `6` at disposition. It describes the lead’s leg and it ARRIVES ONLY AT THE END — which is why live call state has no webhook source.',
    useInCrm: null,
    presentOn: ALL_CALL,
  },

  // ------------------------------------------------------------------ timing
  {
    path: 'body.wait_time',
    label: 'Agent-leg wait',
    group: 'timing',
    type: 'number',
    pii: false,
    meaning:
      'Seconds the seller’s own phone rang before they answered. Measured: **2 s** when answered, **30 s** when abandoned. §6’s "5–15 seconds" is not what was observed.',
    useInCrm:
      'The banner’s escalation schedule should be built on this, not on the written figure.',
    presentOn: ALL_CALL,
  },
  {
    path: 'body.talk_time',
    label: 'Talk time',
    group: 'timing',
    type: 'number',
    pii: false,
    meaning: 'Seconds of conversation. `63` on the captured call.',
    useInCrm:
      '`call.talk_time_seconds`, a corrective merge field guarded by the provider timestamp.',
    presentOn: ALL_CALL,
  },
  {
    path: 'body.duration',
    label: 'Total duration',
    group: 'timing',
    type: 'number',
    pii: false,
    meaning: 'Wait plus talk. `66` on the captured call.',
    useInCrm: null,
    presentOn: ALL_CALL,
  },
  {
    path: 'body.hold_time',
    label: 'Hold time',
    group: 'timing',
    type: 'number',
    pii: false,
    meaning: 'Seconds on hold.',
    useInCrm: null,
    presentOn: ALL_CALL,
  },
  {
    path: 'body.created_at',
    label: 'Created at (provider)',
    group: 'timing',
    type: 'timestamp',
    pii: false,
    meaning: '⚠️ No timezone marker: `"2026-08-05 20:58:44"`. A naive string, not an ISO instant.',
    useInCrm:
      'Must be interpreted, never `new Date()`-parsed by goodwill — the same trap `scheduled_job.fire_at` already cost this project once.',
    presentOn: ALL_CALL,
  },
  {
    path: 'body.updated_at',
    label: 'Updated at (provider)',
    group: 'timing',
    type: 'timestamp',
    pii: false,
    meaning: 'Moves per delivery. This is what makes the body hash differ between events.',
    useInCrm: '`call.provider_last_event_at` — the guard that makes corrective merges order-free.',
    presentOn: ALL_CALL,
  },

  // ------------------------------------------------------------------- media
  {
    path: 'body.has_recording',
    label: 'Has recording',
    group: 'media',
    type: 'boolean',
    pii: false,
    meaning: '`false` on initiation, `true` at disposition.',
    useInCrm: '`call.recording_at` presence flag.',
    presentOn: ALL_CALL,
  },
  {
    path: 'body.direct_recording_url',
    label: 'Recording URL',
    group: 'media',
    type: 'url',
    pii: true,
    meaning:
      '🚨 **A BEARER CAPABILITY.** Unauthenticated: a HEAD with no credentials 302s to a one-hour pre-signed S3 link to the audio. The UUID is the whole of the access control.',
    useInCrm:
      'Storing it makes `raw_payload_vault` a store of keys to call audio, and a CCPA erasure of our row revokes nothing. A reason not to lengthen the vault window.',
    presentOn: [DONE, REC, DISP],
  },
  {
    path: 'body.has_transcription',
    label: 'Has transcription',
    group: 'media',
    type: 'boolean',
    pii: false,
    meaning:
      '⚠️ `false` at disposition even though transcription events arrived 42 s later. It is stale at the moment it is delivered.',
    useInCrm: 'Not trusted. Transcript presence comes from the `transcription.*` event arriving.',
    presentOn: ALL_CALL,
  },
  {
    path: 'body.call_summary',
    label: 'AI summary',
    group: 'media',
    type: 'json',
    pii: true,
    meaning: 'AloAi’s summary of the conversation. Contains whatever the lead said.',
    useInCrm: '`call.ai_summary_text`, an additive merge field.',
    presentOn: ALL_CALL,
  },

  // -------------------------------------------------------------- compliance
  {
    path: 'body.contact.is_dnc',
    label: 'Do-not-call',
    group: 'compliance',
    type: 'boolean',
    pii: false,
    meaning: 'Aloware’s DNC flag on the contact.',
    useInCrm:
      'Mirrored into our consent ledger, never trusted as a control. The gate is ours and server-side.',
    presentOn: ALL_CALL,
  },
  {
    path: 'body.contact.text_authorized',
    label: 'Text authorised',
    group: 'compliance',
    type: 'boolean',
    pii: false,
    meaning:
      '🔴 Observed `0` on a contact Aloware then texted anyway via the REST API. **Their flag is data, not a control.**',
    useInCrm: 'The empirical case for the pre-send compliance gate being ours and server-side.',
    presentOn: ALL_CALL,
  },
  {
    path: 'body.contact.is_opted_out',
    label: 'Opted out',
    group: 'compliance',
    type: 'boolean',
    pii: false,
    meaning: 'STOP was received at some point.',
    useInCrm: 'Mirrored into the consent ledger.',
    presentOn: ALL_CALL,
  },
  {
    path: 'body.contact.lrn_type',
    label: 'Line type',
    group: 'compliance',
    type: 'number',
    pii: false,
    meaning:
      '`1` on the contact whose SMS came back `DispositionInvalid`, which commonly denotes a landline. Unconfirmed — the Number Lookup API would settle it.',
    useInCrm: 'Candidate gate: do not offer SMS on a landline. Not built.',
    presentOn: ALL_CALL,
  },

  // ----------------------------------------------------------------- contact
  {
    path: 'body.contact.intake_source',
    label: 'Intake source',
    group: 'contact',
    type: 'string',
    pii: false,
    meaning:
      '`gohighlevel` — GHL confirmed as the system of record, from the data rather than from a description.',
    useInCrm: 'Migration fact: this CRM replaces GHL.',
    presentOn: ALL_CALL,
  },
  {
    path: 'body.contact.contact_source',
    label: 'Contact source',
    group: 'contact',
    type: 'string',
    pii: false,
    meaning: '`Lead IUL - 2 Pasos` — the vendor campaign, in Spanish, authored by the agency.',
    useInCrm: null,
    presentOn: ALL_CALL,
  },
  {
    path: 'body.contact.name',
    label: 'Full name',
    group: 'contact',
    type: 'string',
    pii: true,
    meaning: 'Plus `first_name` and `last_name` separately.',
    useInCrm: '`contact.display_name`.',
    presentOn: ALL_CALL,
  },
  {
    path: 'body.contact.phone_number',
    label: 'Phone',
    group: 'contact',
    type: 'string',
    pii: true,
    meaning: 'The contact’s number as Aloware holds it.',
    useInCrm: 'Normalised to E.164 and matched against our owner-scoped unique index.',
    presentOn: ALL_CALL,
  },
  {
    path: 'body.contact.date_of_birth',
    label: 'Date of birth',
    group: 'contact',
    type: 'string',
    pii: true,
    meaning: '⚠️ Observed as a FUTURE date on a real record. Their book carries junk today.',
    useInCrm: null,
    presentOn: ALL_CALL,
  },
  {
    path: 'body.contact.outbound_call_count',
    label: 'Call counters',
    group: 'contact',
    type: 'number',
    pii: false,
    meaning:
      'Plus `inbound_call_count`, `inbound_sms_count`, `outbound_sms_count`, `nb_communications`, `unread_*`.',
    useInCrm: 'Cross-check only. Our attempt count is derived from our own rows.',
    presentOn: ALL_CALL,
  },
  {
    path: 'body.contact.rango_edad',
    label: 'Custom fields (Spanish)',
    group: 'contact',
    type: 'string',
    pii: true,
    meaning:
      'Plus `edad`, `gender`, `coverage_requested`. Agency-authored custom fields, all `null` on the captured contact.',
    useInCrm: null,
    presentOn: ALL_CALL,
  },

  // ------------------------------------------------------------------ unused
  {
    path: 'body.workflow_id',
    label: 'Automation ids',
    group: 'unused',
    type: 'number',
    pii: false,
    meaning:
      'Plus `broadcast_id`, `sequence_id`. All null — no Aloware automation touched this call.',
    useInCrm: null,
    presentOn: ALL_CALL,
  },
  {
    path: 'body.transfer_prior_user_ids',
    label: 'Transfer fields',
    group: 'unused',
    type: 'json',
    pii: false,
    meaning:
      'Plus `transfer_target_user_ids`, `in_cold_transfer`, `transfer_type`. Live transfers are not in the MVP.',
    useInCrm: null,
    presentOn: ALL_CALL,
  },
  {
    path: 'body.csat_score',
    label: 'CSAT',
    group: 'unused',
    type: 'number',
    pii: false,
    meaning: 'Always `0`. Not a feature this account uses.',
    useInCrm: null,
    presentOn: ALL_CALL,
  },
  {
    path: 'body.engagement_data',
    label: 'Engagement data',
    group: 'unused',
    type: 'json',
    pii: false,
    meaning: 'Empty array on every capture. Plus `public_metadata`, also always empty.',
    useInCrm: null,
    presentOn: ALL_CALL,
  },
]

/** How a provider event name is spelled. Three conventions, one stream. */
export type NameConvention = 'PascalCase' | 'PascalCase-Hyphen' | 'dotted.lowercase'

export interface AlowareEvent {
  readonly name: string
  readonly convention: NameConvention
  readonly canonical: string | null
  readonly note: string
}

/**
 * Every event name OBSERVED on the wire. Deliberately not the subscription
 * form’s checkbox list: those read `Communication Initiated`, `Call Disposed`,
 * `Recording Saved`. **What you subscribe to and what arrives are named
 * differently**, so a mapping built from the checkboxes matches nothing.
 */
export const ALOWARE_EVENTS: readonly AlowareEvent[] = [
  {
    name: 'OutboundPhoneCall',
    convention: 'PascalCase',
    canonical: 'call.initiated',
    note: 'Fires at establishment. Carries no status text and no recording URL.',
  },
  {
    name: 'OutboundPhoneCall-DispositionCompleted',
    convention: 'PascalCase-Hyphen',
    canonical: 'call.completed',
    note: 'The close. 70.4 s after initiation on the captured 63-second call — with NOTHING in between.',
  },
  {
    name: 'OutboundPhoneCall-DispositionFailed',
    convention: 'PascalCase-Hyphen',
    canonical: 'call.completed',
    note: 'The agent leg was never answered, so the lead was never dialled. `wait_time: 30`.',
  },
  {
    name: 'InboundPhoneCall',
    convention: 'PascalCase',
    canonical: 'call.initiated',
    note: '`current_status2: 2`.',
  },
  {
    name: 'InboundPhoneCall-DispositionCompleted',
    convention: 'PascalCase-Hyphen',
    canonical: 'call.completed',
    note: 'Answered inbound — sometimes by the AloAi agent rather than a human.',
  },
  {
    name: 'InboundPhoneCall-DispositionMissed',
    convention: 'PascalCase-Hyphen',
    canonical: 'call.completed',
    note: 'A disposition on the inbound family, not a separate event — which is what §4.3 already ruled.',
  },
  {
    name: 'Recording-Saved',
    convention: 'PascalCase-Hyphen',
    canonical: 'call.enriched',
    note: 'Carries the unauthenticated recording URL.',
  },
  {
    name: 'Call-Disposed',
    convention: 'PascalCase-Hyphen',
    canonical: 'call.completed',
    note: '🔴 DUPLICATES the disposition. Same id, same statuses, same talk time, 6.6 s later — but different bytes, so a sha256 key does NOT dedupe it. Mapping both to `call.completed` double-counts the dial.',
  },
  {
    name: 'transcription.call.summarized',
    convention: 'dotted.lowercase',
    canonical: 'call.enriched',
    note: '🔴 No `body.id`. The call id is nested in `body.communication`, so a SHALLOW key extractor returns null here.',
  },
  {
    name: 'transcription.open_search.saved',
    convention: 'dotted.lowercase',
    canonical: null,
    note: '🔴 A 13th name, on neither the subscribable list nor §4.3’s map. Search-index plumbing, arriving unbidden 17 ms after the summary.',
  },
  {
    name: 'OutboundSMS-DispositionInvalid',
    convention: 'PascalCase-Hyphen',
    canonical: 'message.delivery_failed',
    note: 'Arrived after a `202 {"message":"Message sent."}`. The 202 means accepted, never sent.',
  },
  {
    name: 'OutboundAppointment',
    convention: 'PascalCase',
    canonical: null,
    note: '⚠️ Production traffic that escaped a `Skip lines` filter — an appointment has no line, so a line exclusion cannot apply to it.',
  },
]

/** Deliveries per call, measured rather than modelled. This is OQ-2's multiplier. */
export const ALOWARE_FAN_OUT: readonly {
  readonly kind: string
  readonly deliveries: number
  readonly note: string
}[] = [
  {
    kind: 'Outbound call, completed',
    deliveries: 6,
    note: 'Init · Disposition · Recording · Call-Disposed · transcription.summarized · transcription.open_search',
  },
  { kind: 'Outbound call, failed', deliveries: 2, note: 'Init · DispositionFailed, 31.7 s apart' },
  { kind: 'Inbound call', deliveries: 3, note: 'Init · Disposition · Recording' },
  { kind: 'SMS', deliveries: 1, note: 'Its disposition only' },
]
