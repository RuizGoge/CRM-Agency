/**
 * The shallow key extraction §4.2 ruling 2 specifies — and the three ways the
 * Gate-2 capture proved "shallow" was not enough.
 *
 * The edge never parses business meaning. It performs one pass over a delivered
 * body to fill the columns the merge is keyed on, and **this function cannot
 * throw**: any failure yields all-nulls and `parseStatus: 'unparsed'`, and the
 * row is stored anyway. A parser that throws at the edge turns a mapping bug
 * into data loss, which is exactly what `raw_payload_vault` exists to prevent.
 *
 * WHAT THE CAPTURE CHANGED, all three measured rather than assumed:
 *
 * 1. **Three naming conventions in one stream.** `OutboundPhoneCall`,
 *    `OutboundPhoneCall-DispositionCompleted`, and lowercase-dotted
 *    `transcription.call.summarized`. A map keyed on one convention loses the
 *    others in silence, which is the worst possible failure here — nothing
 *    errors, calls simply stop appearing.
 *
 * 2. **`transcription.*` has no `body.id`.** The call id sits in
 *    `body.communication.id`, one level deeper. Literally shallow extraction
 *    returns null and the transcript can never be attached to its call.
 *
 * 3. **`Call-Disposed` restates a disposition already delivered.** Same call,
 *    same status, same talk time, 6.6 s after
 *    `OutboundPhoneCall-DispositionCompleted`. Different bytes, so a
 *    `sha256(body)` transport key does NOT dedupe it. Both map to
 *    `call.completed`, and the merge is keyed on `aloware_call_id` so the row
 *    is safe — but anything COUNTING dispositions (the day strip's dial count,
 *    attempt totals) would count the call twice. `restatesDisposition` is how a
 *    consumer tells the second one apart.
 */

/** The canonical events §4.3 maps provider deliveries onto. */
export type CanonicalEvent =
  | 'call.initiated'
  | 'call.completed'
  | 'call.enriched'
  | 'message.received'
  | 'message.delivery_failed'

export type EnrichmentPart = 'recording' | 'transcript' | 'ai_summary'

export interface ExtractedKeys {
  /** The provider's own event name, verbatim, or null when there was none. */
  readonly providerEvent: string | null
  /** What §4.3 maps it to. `null` means "we have no canonical name for this". */
  readonly canonical: CanonicalEvent | null
  /**
   * Aloware's communication id. Named `alowareCallId` because that is the
   * column, but the value is NOT call-specific: SMS carries the same field in
   * the same id space, which G2 established and §4.4's ladder had assumed were
   * two spaces.
   */
  readonly alowareCallId: string | null
  readonly direction: 'inbound' | 'outbound' | null
  /** Which parts a `call.enriched` carries. Empty for every other event. */
  readonly enrichmentParts: readonly EnrichmentPart[]
  /** See (3) above. Never true for an event that carries new state. */
  readonly restatesDisposition: boolean
  readonly parseStatus: 'parsed' | 'unparsed'
}

const UNPARSED: ExtractedKeys = {
  providerEvent: null,
  canonical: null,
  alowareCallId: null,
  direction: null,
  enrichmentParts: [],
  restatesDisposition: false,
  parseStatus: 'unparsed',
}

/**
 * Provider event name → canonical event.
 *
 * DELIBERATELY EXHAUSTIVE AND DELIBERATELY NOT PATTERN-MATCHED. A regex over
 * `-Disposition` would be shorter and would also silently swallow a name the
 * provider adds next month, mapping it to something plausible. An unlisted name
 * yields `canonical: null`, which is a visible unmapped delivery rather than a
 * confident wrong answer.
 *
 * ⚠️ These are the names OBSERVED ON THE WIRE, not the subscription form's
 * checkboxes (`Communication Initiated`, `Call Disposed`, `Recording Saved`).
 * What you subscribe to and what arrives are named differently — a map built
 * from the checkbox list matches nothing at all.
 */
const CANONICAL: Readonly<Record<string, CanonicalEvent>> = {
  OutboundPhoneCall: 'call.initiated',
  InboundPhoneCall: 'call.initiated',
  'OutboundPhoneCall-DispositionCompleted': 'call.completed',
  'OutboundPhoneCall-DispositionFailed': 'call.completed',
  'InboundPhoneCall-DispositionCompleted': 'call.completed',
  // A missed inbound is NOT a separate event — §4.3 already ruled that, and the
  // provider's shape agrees.
  'InboundPhoneCall-DispositionMissed': 'call.completed',
  'Call-Disposed': 'call.completed',
  'Recording-Saved': 'call.enriched',
  'transcription.call.summarized': 'call.enriched',
  'OutboundSMS-DispositionInvalid': 'message.delivery_failed',
}

/**
 * Names that repeat state another delivery already carried.
 *
 * `Call-Disposed` is the one the capture proved. `Communication-Disposed` is
 * listed on the subscription form and was never observed on the wire; it is
 * here because if it ever arrives it is the same shape, and finding out by
 * double-counting a seller's dials is a bad way to learn.
 */
const RESTATES = new Set(['Call-Disposed', 'Communication-Disposed'])

/**
 * Names we know about and map to nothing, on purpose.
 *
 * `transcription.open_search.saved` is a thirteenth event on neither the
 * subscribable list nor §4.3's table — search-index plumbing that arrived 17 ms
 * after the summary, unasked for. `OutboundAppointment` is real production
 * traffic that escaped a line filter. Both are RECOGNISED so they do not read
 * as unmapped, and neither produces a domain event.
 */
const KNOWN_UNMAPPED = new Set(['transcription.open_search.saved', 'OutboundAppointment'])

/** Which enrichment part an event carries. */
const PARTS: Readonly<Record<string, EnrichmentPart>> = {
  'Recording-Saved': 'recording',
  'transcription.call.summarized': 'ai_summary',
  'Transcription-Saved': 'transcript',
}

/**
 * True when the name is one we have seen or listed, mapped or not. Lets the
 * caller separate "a name we do not handle" from "a name nobody has ever seen",
 * which are different admin alerts.
 */
export function isKnownEvent(name: string): boolean {
  return name in CANONICAL || KNOWN_UNMAPPED.has(name) || name in PARTS
}

/** Reads a nested value without trusting any level of it to be an object. */
function pick(source: unknown, ...path: readonly string[]): unknown {
  let current = source
  for (const key of path) {
    if (current === null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

/**
 * Renders an id as text without `Number(` — which is a build error outside
 * `app/lib/money/**` — and without trusting the provider to keep sending the
 * same JSON type. `940868616` has arrived as a number; a string would be just
 * as valid JSON and must not become `null`.
 */
function idOf(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) return value
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value)
  return null
}

/**
 * The extractor. **Never throws.** Verified by `aloware-ingest.test.ts` against
 * truncated JSON, non-JSON bytes, deeply nested objects, arrays where objects
 * are expected, and every captured body.
 */
export function extractKeys(raw: string): ExtractedKeys {
  let envelope: unknown
  try {
    envelope = JSON.parse(raw)
  } catch {
    return UNPARSED
  }

  // `Array.isArray` is not pedantry: an array is `typeof 'object'`, so without
  // it `[]` reads as a well-formed envelope carrying no event — indistinguishable
  // from the provider's own `{"test_payload":true}`, which IS a legitimate
  // delivery. `parsed` has to mean "this was the envelope shape", or the
  // `unparsed` counter on the admin page stops counting the thing it names.
  if (envelope === null || typeof envelope !== 'object' || Array.isArray(envelope)) return UNPARSED

  const eventValue = pick(envelope, 'event')
  const providerEvent = typeof eventValue === 'string' && eventValue.length > 0 ? eventValue : null

  // The provider's own test delivery is `{"test_payload":true}` — valid JSON,
  // no event, no id. It parses fine and yields nothing, which is correct: it is
  // a delivery, it is not a domain fact.
  if (providerEvent === null) {
    return { ...UNPARSED, parseStatus: 'parsed' }
  }

  // TWO LEVELS, and the second one is why. `transcription.*` carries no
  // `body.id`; its communication id is at `body.communication.id`.
  const alowareCallId =
    idOf(pick(envelope, 'body', 'id')) ?? idOf(pick(envelope, 'body', 'communication', 'id'))

  const directionValue = pick(envelope, 'body', 'direction')
  const direction =
    directionValue === 2
      ? 'outbound'
      : directionValue === 1
        ? 'inbound'
        : directionFromName(providerEvent)

  const canonical = CANONICAL[providerEvent] ?? null
  const part = PARTS[providerEvent]

  return {
    providerEvent,
    canonical,
    alowareCallId,
    direction,
    enrichmentParts: canonical === 'call.enriched' && part !== undefined ? [part] : [],
    restatesDisposition: RESTATES.has(providerEvent),
    parseStatus: 'parsed',
  }
}

/**
 * Falls back to the NAME when `body.direction` is absent.
 *
 * `Recording-Saved` and the `transcription.*` pair carry a direction in their
 * body, but `Call-Disposed` and anything new might not, and a direction of
 * `null` on a call event is a row the merge cannot place.
 */
function directionFromName(name: string): 'inbound' | 'outbound' | null {
  if (name.startsWith('Outbound')) return 'outbound'
  if (name.startsWith('Inbound')) return 'inbound'
  return null
}
