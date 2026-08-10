import type { call } from '~/db/schema/communications'
import { CALL_STATE_ORDINAL, type CallState } from '~/db/schema/communications'

import type { CanonicalEvent } from './aloware-ingest'

/**
 * The provider's call payload, mapped onto the columns `app.call_merge()` takes.
 *
 * This is the layer §4.2 ruling 2 keeps OUT of the edge: the edge does shallow
 * key extraction and nothing else, and every field below is business meaning.
 * It runs in the merge job, from the vaulted body, so a mapping defect is a row
 * we can replay rather than a delivery that never arrived.
 *
 * 🔬 EVERY FIELD NAME HERE WAS READ OFF THE 22 CAPTURED DELIVERIES, not guessed
 * and not taken from documentation. The key inventory per event name is stable
 * across the capture and the differences between events are real — see
 * `pickNumber` and `stateOf` for the two that bite.
 */

/** Every column on `app.call`. */
type CallColumn = keyof typeof call.$inferSelect

/**
 * Columns that are not merged field-by-field, each for a stated reason.
 *
 * `tenantId`/`id`/`createdAt`/`updatedAt` are bookkeeping. `alowareCallId` is
 * the merge KEY, not a merged value. `ownerUserId`/`contactId` are resolved
 * inside the definer from the identity map, never sent by the caller — that is
 * what stops a job payload from choosing whose book a call lands in.
 * `state`/`stateOrdinal` are clamped by the monotonic trigger, and the two
 * provider clocks drive the corrective guard rather than being guarded by it.
 */
type NotFieldMerged =
  | 'tenantId'
  | 'id'
  | 'alowareCallId'
  | 'ownerUserId'
  | 'contactId'
  | 'state'
  | 'stateOrdinal'
  | 'providerCreatedAt'
  | 'providerLastEventAt'
  | 'createdAt'
  | 'updatedAt'

/**
 * 🎯 DERIVED FROM THE TABLE, WHICH IS THE MECHANISM. Add a column to `app.call`
 * and this union grows; `CALL_MERGE` below then has a missing key and the
 * TYPECHECK FAILS. Classifying it as not-merged is still possible — you add it
 * to `NotFieldMerged` — but that is an explicit act naming the column, which is
 * exactly what "classify it" means. What cannot happen is a merge-relevant
 * column arriving with no decision attached to it.
 */
export type MergeableCallField = Exclude<CallColumn, NotFieldMerged>

/**
 * §4.5's declared field table. The two classes fail in opposite directions and
 * that is why neither can be the default:
 *
 *   additive    order-free. A late `Recording-Saved` must not erase a
 *               transcript that arrived first — and it would, because a
 *               provider payload omits fields rather than nulling them.
 *   corrective  guarded by the PROVIDER's clock. Arrival order is not the
 *               provider's order: the queue serializes deliveries, it cannot
 *               un-send one that left late.
 *
 * The SQL that honours this lives in `app.call_merge()`, and
 * `call-merge.test.ts` reads `pg_proc.prosrc` to assert the two agree — so this
 * record is a gate rather than a comment.
 */
export const CALL_MERGE: Readonly<Record<MergeableCallField, 'additive' | 'corrective'>> = {
  direction: 'additive',
  recordingUrl: 'additive',
  transcriptUrl: 'additive',
  aiSummaryText: 'additive',
  dispositionRaw: 'corrective',
  talkTimeSeconds: 'corrective',
  waitTimeSeconds: 'corrective',
}

/** What the merge job hands `app.call_merge()`. Every field may be null but the key. */
export interface CallMergeFields {
  readonly alowareCallId: string
  readonly state: CallState
  readonly direction: 'inbound' | 'outbound' | null
  readonly alowareUserId: number | null
  readonly ourNumberE164: string | null
  readonly leadNumberE164: string | null
  readonly dispositionRaw: string | null
  readonly talkTimeSeconds: number | null
  readonly waitTimeSeconds: number | null
  readonly recordingUrl: string | null
  readonly transcriptUrl: string | null
  readonly aiSummaryText: string | null
  readonly providerCreatedAt: string | null
  readonly providerEventAt: string | null
}

function pick(source: unknown, ...path: readonly string[]): unknown {
  let current = source
  for (const key of path) {
    if (current === null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim().length > 0 ? v : null)

/** Integers only, and never via `Number(` — the money guard bans it outside app/lib/money. */
const int = (v: unknown): number | null =>
  typeof v === 'number' && Number.isSafeInteger(v) ? v : null

/** E.164 or nothing. The capture has both number fields arriving with a leading `+`. */
const e164 = (v: unknown): string | null => {
  const s = str(v)
  return s !== null && /^\+[1-9][0-9]{7,14}$/.test(s) ? s : null
}

/**
 * 🔴 THE PROVIDER'S TIMESTAMPS CARRY NO ZONE. Measured: `created_at` and
 * `updated_at` arrive shaped `YYYY-MM-DD HH:MM:SS`, with no offset and no `Z`.
 *
 * They are read as UTC, consistently, and the reason that is safe is narrow and
 * worth stating: what `app.call_merge()` uses these for is **ordering** —
 * whether this delivery is newer than the one already merged — and a constant
 * offset applied to every value preserves order exactly. What it does NOT make
 * safe is rendering one to a seller as a wall-clock time. Until the account's
 * zone is confirmed against the live account, `provider_created_at` is a
 * sortable instant and not a time of day.
 */
const providerTimestamp = (v: unknown): string | null => {
  const s = str(v)
  if (s === null) return null
  const iso = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/.exec(s)
  if (iso === null) return null
  return `${iso[1]}T${iso[2]}Z`
}

/**
 * `current_status2`, measured across the capture: `1` outbound initiated,
 * `2` inbound ringing, `9` closed, `19` SMS invalid.
 *
 * When it is absent — `transcription.*` carries five keys and none of them is a
 * status — the canonical event decides, and an enrichment falls to the FLOOR
 * rather than guessing. That is safe because `t_call_state_monotonic` clamps: a
 * transcript arriving after the disposition cannot pull a `completed` call back
 * to `initiated`, and one arriving before it creates a row that the disposition
 * then moves forward.
 */
function stateOf(body: unknown, canonical: CanonicalEvent | null): CallState {
  const status = int(pick(body, 'current_status2'))
  if (status === 9 || status === 19) return 'completed'
  if (status === 1 || status === 2) return 'initiated'
  return canonical === 'call.completed' ? 'completed' : 'initiated'
}

/**
 * ⚠️ `lead_number` IS THE LEAD AND `destination_number` IS NOT, which is the
 * opposite of what the names suggest on an outbound call.
 *
 * Measured across all 22 deliveries: `lead_number` is present on every call
 * event and always differs from `incoming_number`; `destination_number` is
 * **null on every inbound** and differs from `lead_number` on outbound. A
 * mapper reaching for `destination_number` would attach outbound calls to the
 * wrong contact and inbound calls to none.
 */
const leadNumber = (body: unknown): string | null => e164(pick(body, 'lead_number'))

/** Our line. The inbound attribution route, and the outbound fallback — see below. */
const ourNumber = (body: unknown): string | null => e164(pick(body, 'incoming_number'))

export function mapCallFields(
  envelope: unknown,
  canonical: CanonicalEvent | null,
): CallMergeFields | null {
  const body = pick(envelope, 'body')

  // `transcription.*` hides the communication id one level deeper, and carries
  // its summary at the ENVELOPE level rather than inside `body`.
  const alowareCallId = idText(pick(body, 'id')) ?? idText(pick(body, 'communication', 'id'))
  if (alowareCallId === null) return null

  const direction = int(pick(body, 'direction'))

  return {
    alowareCallId,
    state: stateOf(body, canonical),
    direction: direction === 2 ? 'outbound' : direction === 1 ? 'inbound' : null,
    /**
     * 🔴 NULL ON THE ESTABLISHMENT EVENT, and this is a finding the corpus did
     * not have. `user_id` is null on `OutboundPhoneCall` and on
     * `InboundPhoneCall`; it appears only on the disposition. It is also null on
     * `InboundPhoneCall-DispositionMissed` — nobody picked up, so there is no
     * seat.
     *
     * CONTEXT.md records that the dial "carries an explicit `user_id`, so
     * attribution never has to come from the number". That is true of the
     * outbound API REQUEST and NOT of the webhook that follows it. So the number
     * route in `app.call_merge()` is load-bearing for the first delivery about
     * every call, which is precisely where the Local Presence pool hurts.
     */
    alowareUserId: int(pick(body, 'user_id')),
    ourNumberE164: ourNumber(body),
    leadNumberE164: leadNumber(body),
    // Enrichment only, never the outcome (US-604). Captured as `null | string`.
    dispositionRaw: str(pick(body, 'call_disposition')),
    talkTimeSeconds: int(pick(body, 'talk_time')),
    waitTimeSeconds: int(pick(body, 'wait_time')),
    recordingUrl: str(pick(body, 'direct_recording_url')),
    /**
     * ⚠️ NO SOURCE, AND SAID RATHER THAN FAKED. `transcription.*` carries a
     * `transcription` OBJECT of ids (`id`, `transcription_id`, `opensearch_id`,
     * `driver`, `communication_id`) and no URL anywhere. §4.3 lists a transcript
     * part; the provider does not send one in a form we can store. It stays null
     * until somebody asks the account for the retrieval endpoint.
     */
    transcriptUrl: null,
    aiSummaryText: str(pick(envelope, 'body', 'summary')),
    providerCreatedAt: providerTimestamp(pick(body, 'created_at')),
    providerEventAt:
      providerTimestamp(pick(body, 'updated_at')) ?? providerTimestamp(pick(body, 'created_at')),
  }
}

/** Same rule as the extractor's: an id over 2^53 must not round through JSON. */
function idText(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) return value
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value)
  return null
}

/** The ordinal the database will store, exported so tests can assert agreement. */
export const ordinalFor = (state: CallState): number => CALL_STATE_ORDINAL[state]
