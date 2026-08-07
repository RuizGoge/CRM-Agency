/**
 * THE GATE-2 CAPTURE, replayed as a fixture.
 *
 * Every number, timestamp, byte count and event name below was read off
 * `evidence/aloware/webhooks.ndjson` — the 22 deliveries the Gate-2 spike
 * received on 2026-08-05 before it was torn down. This is the whole of what the
 * Aloware integration has ever actually produced, and there will be no more:
 * the spike deleted its webhook subscription during teardown, so a call placed
 * today delivers nothing anywhere.
 *
 * 🔴 WHY THE SUBJECT IS A DUMMY. The captured call dialled a real lead out of
 * the client's production book. Their name, phone, email, city and date of birth
 * are in those bytes, and a fixture is committed to git — a clock far longer
 * than anything CCPA minimisation contemplates. So the PII is replaced with a
 * synthetic subject on a number from the North American reserved fictional range
 * (555-0100..0199), the same lawful-subject rule errata E9 imposes on probes.
 *
 * **Every non-personal value is real and unmodified.** The seconds, the status
 * ladders, the ids, the inter-arrival gaps and the event names are exactly what
 * Aloware sent. Those are the facts that decide the design; the name attached to
 * them is not.
 */

/** The synthetic subject standing in for the real lead. */
export const CAPTURE_SUBJECT = {
  displayName: 'Aloware Capture (demo)',
  phoneE164: '+12025550142',
  email: 'capture.demo@example.test',
  city: 'Austin',
  state: 'TX',
  note: 'Not a person. A stand-in for the real lead the captured call dialled.',
} as const

export interface CapturedDelivery {
  readonly seq: number
  /** UTC, exactly as the receiver stamped it. */
  readonly receivedAt: string
  /** Milliseconds since the first delivery of this call. */
  readonly offsetMs: number
  readonly event: string
  readonly bytes: number
  /** What our receiver answered. Not a precondition of anything — see 0031. */
  readonly answered: number
  /** The field values that moved, or that matter. */
  readonly notable: readonly { readonly field: string; readonly value: string }[]
  readonly comment: string | null
}

/**
 * The one completed two-legged call: `940868616`, 63 seconds of talk.
 *
 * ⚠️ READ THE GAP BETWEEN #1 AND #2. Seventy point four seconds, and nothing in
 * it. The call was ringing, then connected, then talking for 63 seconds, and the
 * provider sent NOTHING until it was over. That is the measurement behind "live
 * call state has no webhook source", and it is the reason the banner cannot
 * render a `Connected · {timer}` state: there is no frame that says connected.
 */
export const CAPTURED_CALL: readonly CapturedDelivery[] = [
  {
    seq: 5,
    receivedAt: '2026-08-05T20:58:49.930Z',
    offsetMs: 0,
    event: 'OutboundPhoneCall',
    bytes: 4186,
    answered: 204,
    notable: [
      { field: 'current_status2', value: '1 — initiated' },
      { field: 'disposition_status2', value: '1' },
      { field: 'talk_time / wait_time / duration', value: '0 / 0 / 0' },
      { field: 'customer_leg_status', value: 'null — the lead leg has not been reached' },
      { field: 'has_recording', value: 'false' },
      { field: 'direct_recording_url', value: 'ABSENT — the field does not exist on this event' },
    ],
    comment:
      'The establishment event. Note what is missing rather than null: `current_status`, `disposition_status`, `direct_recording_url` and `call_disposition` are not keys on this payload at all.',
  },
  {
    seq: 6,
    receivedAt: '2026-08-05T21:00:00.295Z',
    offsetMs: 70365,
    event: 'OutboundPhoneCall-DispositionCompleted',
    bytes: 4372,
    answered: 204,
    notable: [
      { field: 'current_status2', value: '9 — closed' },
      { field: 'disposition_status2', value: '4 — completed' },
      { field: 'wait_time', value: '2 — the seller answered their own leg in 2 s' },
      { field: 'talk_time', value: '63' },
      { field: 'duration', value: '66' },
      { field: 'customer_leg_status', value: '6 — arrives only now' },
      { field: 'call_disposition_id', value: '31227 — "No Answer", on a 63-second conversation' },
      { field: 'has_recording', value: 'true' },
      {
        field: 'has_transcription',
        value: 'false — and it is wrong; transcripts arrive 42 s later',
      },
    ],
    comment:
      '🔴 70.4 SECONDS AFTER THE FIRST DELIVERY, with nothing in between. The entire live portion of the call produced zero webhooks.',
  },
  {
    seq: 7,
    receivedAt: '2026-08-05T21:00:04.305Z',
    offsetMs: 74375,
    event: 'Recording-Saved',
    bytes: 4372,
    answered: 204,
    notable: [
      {
        field: 'direct_recording_url',
        value: 'https://app.aloware.io/static/recording/32c1a2f8-…',
      },
    ],
    comment:
      '🚨 That URL needs no credentials. A HEAD with nothing attached 302s to a one-hour pre-signed S3 link to the audio. The UUID is the whole of the access control, and it travels inside the webhook body.',
  },
  {
    seq: 8,
    receivedAt: '2026-08-05T21:00:06.931Z',
    offsetMs: 77001,
    event: 'Call-Disposed',
    bytes: 4372,
    answered: 204,
    notable: [
      { field: 'id', value: '940868616 — the same call' },
      { field: 'current_status2', value: '9 — the same status' },
      { field: 'disposition_status2', value: '4 — the same disposition' },
      { field: 'talk_time', value: '63 — the same seconds' },
    ],
    comment:
      '🔴 THE DISPOSITION, A SECOND TIME, UNDER A SECOND NAME. Identical state, 6.6 s later. The bytes differ (the event name is in the body), so sha256 does not dedupe it — mapping both names to `call.completed` counts the dial twice.',
  },
  {
    seq: 9,
    receivedAt: '2026-08-05T21:00:48.564Z',
    offsetMs: 118634,
    event: 'transcription.call.summarized',
    bytes: 8623,
    answered: 204,
    notable: [
      {
        field: 'envelope',
        value: 'body.{ summary, json_summary, transcription, contact, communication }',
      },
      { field: 'body.id', value: 'ABSENT — the call id is nested in body.communication' },
    ],
    comment:
      '🔴 A THIRD NAMING CONVENTION, and a different envelope. §4.2 specifies a SHALLOW key extraction to fill `aloware_call_id`; shallow returns null here, so the transcript cannot be attached to its call.',
  },
  {
    seq: 10,
    receivedAt: '2026-08-05T21:00:48.581Z',
    offsetMs: 118651,
    event: 'transcription.open_search.saved',
    bytes: 9482,
    answered: 204,
    notable: [
      {
        field: 'envelope',
        value: 'body.{ parsed_transcription, transcription, contact, communication, summary }',
      },
    ],
    comment:
      '🔴 A THIRTEENTH EVENT NAME, on neither the 12-item subscribable list nor §4.3’s mapping table. Search-index plumbing, arriving 17 ms after the summary, unasked for.',
  },
]

/** The failed dial, for contrast: the agent leg was never answered. */
export const CAPTURED_FAILED_CALL: readonly CapturedDelivery[] = [
  {
    seq: 3,
    receivedAt: '2026-08-05T20:54:21.597Z',
    offsetMs: 0,
    event: 'OutboundPhoneCall',
    bytes: 4186,
    answered: 204,
    notable: [{ field: 'current_status2', value: '1 — initiated' }],
    comment: null,
  },
  {
    seq: 4,
    receivedAt: '2026-08-05T20:54:53.343Z',
    offsetMs: 31746,
    event: 'OutboundPhoneCall-DispositionFailed',
    bytes: 4372,
    answered: 204,
    notable: [
      { field: 'current_status2', value: '9 — closed' },
      { field: 'disposition_status2', value: '5 — failed' },
      { field: 'wait_time', value: '30 — the agent leg rang for 30 s and gave up' },
      { field: 'talk_time', value: '0' },
      { field: 'customer_leg_status', value: 'null — the lead was NEVER DIALLED' },
    ],
    comment:
      '🔴 The two-legged call rings the SELLER first. If that leg is never answered the lead’s phone never rings at all. Good for compliance, and it reshapes the UI problem: the silence is agent-leg wait first, lead ring second.',
  },
]

/**
 * The deliveries that answer the delivery-guarantee questions. Not part of any
 * one call — these are the experiment.
 */
export const CAPTURED_GUARANTEES: readonly {
  readonly question: string
  readonly finding: string
  readonly evidence: string
}[] = [
  {
    question: 'Are the webhooks signed?',
    finding: 'No. Authenticated at best, never signed.',
    evidence:
      'Six headers arrived and that is all Aloware sends: Host · User-Agent: GuzzleHttp/7 · Content-Length · Accept-Encoding · Connection · Content-Type. No signature, no timestamp, no nonce. The subscription form offers None · Basic · Bearer and no HMAC option.',
  },
  {
    question: 'Do they retry a failed delivery?',
    finding: 'Never. Not once, in over three hours.',
    evidence:
      'Six real deliveries were answered HTTP 500 across two event families — three OutboundAppointment and the three of a real inbound call. Zero were redelivered. Delivery is at-most-once with no recovery path, and there is no call-list API to reconcile against.',
  },
  {
    question: 'Is there a delivery id or an event id?',
    finding: 'Neither, in headers or body.',
    evidence:
      'The envelope is { body, event }. `provider_event_id` has to be built from sha256(raw body), which makes that unique index the only replay defence there is.',
  },
  {
    question: 'Does the provider demand a fast response?',
    finding: 'No deadline worth the name. At least 110 seconds of tolerance.',
    evidence:
      'One delivery was held for 110 023 ms and Aloware never hung up (client_aborted: false), then accepted the 204. So the correct posture at the edge is the opposite of the reflex: never fail fast, queue and take the time. A 500 returned in 2 ms is permanent data loss.',
  },
  {
    question: 'Is the same body ever delivered twice?',
    finding: 'Yes — and it collides under the sha256 key.',
    evidence:
      'The provider’s own `{"test_payload":true}` arrived twice, seven hours apart, byte-identical (sha 381e0c21…). Harmless for a test payload; it is the demonstration that two genuinely distinct events with identical bodies are indistinguishable to a content-hash key.',
  },
]
