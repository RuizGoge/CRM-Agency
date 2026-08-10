import { sql } from 'drizzle-orm'

import { withSystemWork } from '~/db'

import { mapCallFields } from './aloware-call-fields'
import { extractKeys } from './aloware-ingest'

/**
 * The `call-merge` job. §4.5: one job, one queue, one key.
 *
 * Everything the edge deliberately refused to do happens here — parsing
 * business meaning, resolving an owner, writing a domain row — and it happens
 * from the VAULTED BYTES rather than from the request, which is what makes a
 * mapping defect replayable instead of permanent.
 *
 * 🔴 THE JOB CARRIES IDS, NOT DATA, and that is the property worth protecting.
 * `app.webhook_ingest()` writes `{tenantId, inboundWebhookEventId,
 * alowareCallId, canonical}` and nothing else, so a job row cannot assert a
 * fact about a call. Everything merged below is re-read from the payload the
 * provider actually sent.
 */

export interface CallMergeJob {
  readonly tenantId: string
  readonly inboundWebhookEventId: string
  readonly alowareCallId: string
  readonly canonical: string
}

export type CallMergeResult =
  /** Merged into a seller's book. */
  | { readonly status: 'resolved' }
  /**
   * Merged, owned by nobody. §5: vaulted, written to NO book, and an admin sees
   * "1 call from a number we do not recognize." Never dropped, never guessed.
   */
  | { readonly status: 'unmapped' }
  /** Nothing to merge, with the reason kept apart from a failure. */
  | { readonly status: 'skipped'; readonly reason: SkipReason }

export type SkipReason =
  /** The event row is gone. Expected: the vault purges on its retention clock. */
  | 'event_gone'
  /** Stored `unparsed`, or an envelope with no communication id. */
  | 'no_mappable_body'

/** Reads bytea back as text without assuming which representation the driver chose. */
function bodyText(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (value instanceof Uint8Array) return Buffer.from(value).toString('utf8')
  return null
}

export async function mergeCallFromEvent(job: CallMergeJob): Promise<CallMergeResult> {
  return withSystemWork(job.tenantId, async (tx) => {
    // The join is the point: the event row is the key and the vault holds the
    // bytes. §4.6 keeps the body BY REFERENCE everywhere for the same reason —
    // a second copy would be a second PII store with its own retention clock.
    const rows = await tx.execute<{ body: unknown }>(sql`
      SELECT v.body
        FROM app.inbound_webhook_event w
        JOIN app.raw_payload_vault v
          ON v.tenant_id = w.tenant_id AND v.id = w.raw_payload_id
       WHERE w.tenant_id = app.current_tenant()
         AND w.id = ${job.inboundWebhookEventId}::uuid`)

    const raw = bodyText(rows[0]?.body)
    if (raw === null) {
      // Not an error. A job outliving its payload is what the retention clock
      // is FOR, and treating it as a failure would dead-letter a row that was
      // deleted on purpose.
      return { status: 'skipped', reason: 'event_gone' }
    }

    let envelope: unknown
    try {
      envelope = JSON.parse(raw)
    } catch {
      return { status: 'skipped', reason: 'no_mappable_body' }
    }

    // The canonical name is re-derived rather than trusted from the job. Same
    // reasoning as re-reading the body: the job is a pointer, and the one place
    // that decides what an Aloware event name means is the extractor.
    const { canonical } = extractKeys(raw)
    const fields = mapCallFields(envelope, canonical)
    if (fields === null) {
      return { status: 'skipped', reason: 'no_mappable_body' }
    }

    const merged = await tx.execute<{ outcome: 'resolved' | 'unmapped' }>(sql`
      SELECT app.call_merge(
        ${fields.alowareCallId},
        ${fields.state},
        ${fields.direction},
        ${fields.alowareUserId},
        ${fields.ourNumberE164},
        ${fields.leadNumberE164},
        ${fields.dispositionRaw},
        ${fields.talkTimeSeconds},
        ${fields.waitTimeSeconds},
        ${fields.recordingUrl},
        ${fields.transcriptUrl},
        ${fields.aiSummaryText},
        ${fields.providerCreatedAt}::timestamptz,
        ${fields.providerEventAt}::timestamptz
      ) AS outcome`)

    const outcome = merged[0]?.outcome
    if (outcome === undefined) {
      throw new Error('app.call_merge returned no row')
    }
    return { status: outcome }
  })
}
