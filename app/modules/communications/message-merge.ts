import { sql } from 'drizzle-orm'

import { withSystemWork } from '~/db'

import { extractKeys, type CanonicalEvent } from './aloware-ingest'

/**
 * The `message-merge` job — §4.3's SMS lane and §4.4's third rung.
 *
 * Same shape as `call-merge` and deliberately so: the job carries ids, the body
 * is re-read from the vault, and the merge is a definer. What differs is only
 * what the provider actually sends.
 */

export interface MessageMergeJob {
  readonly tenantId: string
  readonly inboundWebhookEventId: string
  readonly alowareCallId: string
  readonly canonical: string
}

export type MessageMergeResult =
  | { readonly status: 'resolved' }
  | { readonly status: 'unmapped' }
  | { readonly status: 'skipped'; readonly reason: 'event_gone' | 'no_mappable_body' }

function bodyText(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (value instanceof Uint8Array) return Buffer.from(value).toString('utf8')
  return null
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

const int = (v: unknown): number | null =>
  typeof v === 'number' && Number.isSafeInteger(v) ? v : null

const e164 = (v: unknown): string | null => {
  const s = str(v)
  return s !== null && /^\+[1-9][0-9]{7,14}$/.test(s) ? s : null
}

/** Aloware's clocks carry no zone; read as UTC so ORDER is preserved. See the call mapper. */
const providerTimestamp = (v: unknown): string | null => {
  const s = str(v)
  if (s === null) return null
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/.exec(s)
  return m === null ? null : `${m[1]}T${m[2]}Z`
}

/**
 * The two states, from the canonical event rather than from a status code.
 *
 * `disposition_status2: 7` is the only SMS disposition in the capture and it
 * means "never delivered". Mapping the numeric codes would mean inventing the
 * ones nobody has seen; §4.3's canonical names already carry the distinction.
 */
const stateOf = (canonical: CanonicalEvent | null): 'received' | 'failed' =>
  canonical === 'message.received' ? 'received' : 'failed'

export async function mergeMessageFromEvent(job: MessageMergeJob): Promise<MessageMergeResult> {
  return withSystemWork(job.tenantId, async (tx) => {
    const rows = await tx.execute<{ body: unknown }>(sql`
      SELECT v.body
        FROM app.inbound_webhook_event w
        JOIN app.raw_payload_vault v
          ON v.tenant_id = w.tenant_id AND v.id = w.raw_payload_id
       WHERE w.tenant_id = app.current_tenant()
         AND w.id = ${job.inboundWebhookEventId}::uuid`)

    const raw = bodyText(rows[0]?.body)
    if (raw === null) return { status: 'skipped', reason: 'event_gone' }

    let envelope: unknown
    try {
      envelope = JSON.parse(raw)
    } catch {
      return { status: 'skipped', reason: 'no_mappable_body' }
    }

    const body = pick(envelope, 'body')
    const providerMessageId = int(pick(body, 'id'))
    if (providerMessageId === null) return { status: 'skipped', reason: 'no_mappable_body' }

    const { canonical } = extractKeys(raw)
    const direction = int(pick(body, 'direction'))

    const merged = await tx.execute<{ outcome: 'resolved' | 'unmapped' }>(sql`
      SELECT app.message_merge(
        ${String(providerMessageId)},
        ${stateOf(canonical)},
        ${direction === 2 ? 'outbound' : direction === 1 ? 'inbound' : null},
        ${int(pick(body, 'user_id'))},
        ${e164(pick(body, 'incoming_number'))},
        ${e164(pick(body, 'lead_number'))},
        ${str(pick(body, 'body'))},
        ${str(pick(body, 'call_disposition'))},
        ${providerTimestamp(pick(body, 'created_at'))}::timestamptz,
        ${providerTimestamp(pick(body, 'updated_at')) ?? providerTimestamp(pick(body, 'created_at'))}::timestamptz
      ) AS outcome`)

    const outcome = merged[0]?.outcome
    if (outcome === undefined) throw new Error('app.message_merge returned no row')
    return { status: outcome }
  })
}
