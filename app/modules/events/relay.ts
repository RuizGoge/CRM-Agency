import { sql } from 'drizzle-orm'

import { claimOutbox, withSystemWork, type ClaimedDelivery, type Tx } from '~/db'

/**
 * The outbox relay: the half of the event transport that 0043 did not build.
 *
 * The store and the fan-out rows have existed since 0043 and nothing consumed
 * them, which made `app.event_emit` a function nobody could safely call — an
 * event emitted into an outbox with no relay is a delivery that is owed
 * forever. This is the consumer.
 *
 * TWO RULES SHAPE EVERYTHING BELOW.
 *
 * ONE TRANSACTION, HANDLER AND ACK TOGETHER. ADR-001 puts the consumer's writes
 * and the `delivered` mark in the SAME transaction, and that is the entire
 * difference between exactly-once and at-least-once for a database-only
 * consumer: if the handler committed and the ack did not, the lease would
 * expire and the work would run a second time. So a handler receives the OPEN
 * transaction and cannot open its own — the signature is the mechanism.
 *
 * THE OUTBOX OWNS FAN-OUT, PG-BOSS OWNS SCHEDULING. This does not run as a
 * pg-boss queue. ADR-005 sets a poll floor of one second and pg-boss's cron
 * floor is a minute (`app/jobs/queues.ts`), so the relay is its own loop. Two
 * systems that both believe they deliver is how a lead gets texted twice.
 */

/**
 * What a consumer handler receives. The transaction is already open, already
 * scoped to the delivery's tenant, and already dropped to `crm_app`.
 */
export interface Delivery {
  readonly tx: Tx
  readonly eventName: string
  readonly eventId: string
  readonly ownerUserId: string
  readonly subjectType: string
  readonly subjectId: string
  readonly correlationId: string
  readonly payload: Record<string, unknown>
}

export type ConsumerHandler = (delivery: Delivery) => Promise<void>

/**
 * 🔴 THE AUDIT HANDLER, and it is the first because it is the only consumer
 * whose destination exists.
 *
 * `audit` subscribes to all 49 events, which makes it the widest possible
 * exercise of the relay rather than a happy path, and it is database-only —
 * so the same-transaction ack above gives it exactly-once with no provider
 * idempotency key to arrange.
 *
 * ⚠️ THE ACTION IS NOT THE EVENT NAME. `app.audit_log.action` is a closed
 * vocabulary of sixteen (`app.audit_action_list()`), and the 49 event names are
 * a different vocabulary answering a different question. Mapping every event to
 * an action would mean inventing 33 action names nobody ratified; mapping none
 * would mean an audit log that records nothing. So the map is EXPLICIT and
 * small, and an event with no entry is not audited — which is honest, because
 * US-9.13 enumerates the writes that must be audited and they are these.
 */
const AUDITED: ReadonlyMap<string, string> = new Map([
  ['opportunity.won', 'ledger.adjusted'],
  ['opportunity.reopened', 'ledger.adjusted'],
  ['opportunity.gate_blocked', 'close.gate_refused'],
  ['pipeline.stage_config_changed', 'stage.config_changed'],
  // ⚠️ `contact.owner_changed` AND NOT `lead.owner_changed`. The second is a
  // GHOST: §2's intermediate remap target, superseded by §4b, and the contract
  // gate refuses it by name. It was written here first and the gate caught it,
  // which is the whole reason the 33 discarded names are in the contract —
  // a positive registry sees an unknown name, not a rejected one.
  ['contact.owner_changed', 'ownership.transferred'],
  ['consent.updated', 'consent.ledger_appended'],
  ['compliance.send_blocked', 'compliance.gate_checked'],
  ['user.deactivated', 'user.access_revoked'],
])

const auditHandler: ConsumerHandler = async (d) => {
  const action = AUDITED.get(d.eventName)
  if (action === undefined) return

  // `actor_type` is 'system' rather than 'human': the relay is what is writing,
  // and the human who caused the event is already named by `actor_user_id`
  // inside the event row. Claiming the relay is a person would put a seller's
  // id on a write they did not make.
  //
  // No dedupe window. Every audited write is one row per attempt, which
  // US-9.13 requires by name — N dials under break-glass are N rows.
  await d.tx.execute(sql`
    SELECT app.audit_write(
      ${action}, ${d.subjectType}, ${d.subjectId}::uuid,
      NULL, ${JSON.stringify(d.payload)}::jsonb, NULL,
      NULL, NULL, NULL, ${d.correlationId}::uuid, 'system'::app.actor_type, 0)`)
}

/**
 * The handler registry.
 *
 * 🔴 THE PAIRING WITH `event_consumer.handler_built` IS A GATE, NOT A HABIT.
 * `tests/integration/outbox-relay.test.ts` asserts in both directions that this
 * map and the column agree: a handler here whose consumer is not marked built
 * receives nothing, and a consumer marked built with no handler here is a
 * delivery that is claimed and can never succeed. Either mistake is silent
 * without the gate, and both are the shape of defect this project keeps
 * finding — a mechanism whose two halves each look correct alone.
 */
export const CONSUMERS: ReadonlyMap<string, ConsumerHandler> = new Map([['audit', auditHandler]])

export interface RelayOutcome {
  readonly claimed: number
  readonly delivered: number
  readonly failed: number
  readonly unhandled: number
}

/** Reads one event body, inside the tenant the claim named. */
async function body(tx: Tx, eventId: string): Promise<Omit<Delivery, 'tx'> | null> {
  const rows = await tx.execute<{
    event_name: string
    owner_user_id: string
    subject_type: string
    subject_id: string
    payload: Record<string, unknown>
    correlation_id: string
  }>(sql`SELECT event_name::text AS event_name, owner_user_id, subject_type,
                subject_id, payload, correlation_id
           FROM app.outbox_payload(${eventId}::uuid)`)

  const row = rows[0]
  if (row === undefined) return null

  return {
    eventName: row.event_name,
    eventId,
    ownerUserId: row.owner_user_id,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    correlationId: row.correlation_id,
    payload: row.payload,
  }
}

/**
 * Delivers one claimed row, handler and ack in one transaction.
 *
 * Returns false when the delivery failed; the caller records the failure in a
 * SEPARATE transaction, because the failed one has already rolled back and a
 * statement issued inside it would be lost with everything else.
 */
async function deliver(claim: ClaimedDelivery, handler: ConsumerHandler): Promise<boolean> {
  return withSystemWork(claim.tenantId, async (tx) => {
    const event = await body(tx, claim.eventId)
    if (event === null) {
      // The outbox row's foreign key is to the consumer, not to the event, so
      // this is reachable in principle — an event whose partition was dropped
      // while a delivery was still owed. Treated as a failure so it climbs the
      // ladder into a dead letter rather than being acked as delivered.
      throw new Error(`event ${claim.eventId} has no body in tenant ${claim.tenantId}`)
    }

    await handler({ ...event, tx })

    const acked = await tx.execute<{ ok: boolean }>(
      sql`SELECT app.outbox_ack(${claim.createdDay}::date, ${claim.eventId}::uuid,
                                ${claim.consumerName}) AS ok`,
    )
    // A false ack means the row was not in `claimed` when we got here — another
    // worker's lease won it. Rolling back is correct: the handler's writes must
    // not survive without the mark that says they happened.
    if (acked[0]?.ok !== true) {
      throw new Error(`lost the lease on ${claim.eventId}/${claim.consumerName}`)
    }
    return true
  })
}

/** Records a failure and lets `app.outbox_fail` decide retry versus dead. */
async function recordFailure(claim: ClaimedDelivery, reason: string): Promise<void> {
  await withSystemWork(claim.tenantId, (tx) =>
    tx.execute(
      sql`SELECT app.outbox_fail(${claim.createdDay}::date, ${claim.eventId}::uuid,
                                 ${claim.consumerName}, ${reason})`,
    ),
  )
}

/**
 * One pass. Claims a batch and delivers each row.
 *
 * Bounded by rounds rather than draining to empty, for the same reason
 * `dispatchDueJobs` is: a tick that never returns is a worker that has stopped
 * ticking, and the next pass is a second away regardless.
 */
export async function relayOnce(limit = 50, maxRounds = 20): Promise<RelayOutcome> {
  let claimed = 0
  let delivered = 0
  let failed = 0
  let unhandled = 0

  for (let round = 0; round < maxRounds; round += 1) {
    const batch = await claimOutbox(limit)
    if (batch.length === 0) break
    claimed += batch.length

    for (const claim of batch) {
      const handler = CONSUMERS.get(claim.consumerName)

      if (handler === undefined) {
        // Should be unreachable: `event_emit` only fans out to consumers marked
        // `handler_built`, and the relay test asserts that set equals this map.
        // Reached anyway it is a real failure and is recorded as one, because
        // acking it would mark an undelivered event delivered — the one lie
        // this table must never tell.
        unhandled += 1
        await recordFailure(claim, `no handler registered for consumer ${claim.consumerName}`)
        continue
      }

      try {
        await deliver(claim, handler)
        delivered += 1
      } catch (err: unknown) {
        // Contained per delivery, never per batch: one tenant's bad row must
        // not stop every other tenant's events. The reason is PRINTED as well
        // as stored, because the first run of the job dispatcher reported "1
        // failed" and nothing else, which is indistinguishable from a worker
        // broken in a way nobody can name.
        const reason = err instanceof Error ? err.message : String(err)
        console.error(
          `[relay] ${claim.consumerName} <- ${claim.eventName} (tenant ${claim.tenantId}):`,
          reason,
        )
        await recordFailure(claim, reason)
        failed += 1
      }
    }
  }

  return { claimed, delivered, failed, unhandled }
}
