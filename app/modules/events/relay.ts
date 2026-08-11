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
  /**
   * WHO DID IT, or null when a machine did.
   *
   * 🔴 ADDED IN 0060, AND IT CORRECTS AN EXISTING DEFECT rather than only
   * enabling a new one. `app.outbox_payload` did not return this column, so the
   * projector passed `ownerUserId` as the timeline's actor — which is right for
   * a seller's own drag and wrong for everything an admin or a scheduler does to
   * her lead. `app.timeline_read` answers `timeline.actor.you` when the actor is
   * the reader, so her own history said "You" about a text nobody attempted.
   */
  readonly actorUserId: string | null
  readonly subjectType: string
  readonly subjectId: string
  readonly correlationId: string
  /**
   * When the thing HAPPENED, not when the relay ran.
   *
   * 🔴 ADDED FOR THE TIMELINE, and it is load-bearing there rather than
   * informational: `timeline_entry.occurred_at` is what the seller's history is
   * ordered by, so a projector that stamped `clock_timestamp()` would rebuild a
   * replayed timeline in the order we happened to replay it. The event carries
   * the real instant; nothing else does.
   */
  readonly occurredAt: string
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
  // 🔴 `compliance.send_blocked` WAS HERE AND HAD TO GO IN 0060. The gate now
  // writes its own `compliance.gate_checked` row synchronously, at the point of
  // refusal, with the verdict, the override and the input snapshot on it. Left
  // in this map the relay would write a SECOND row per refusal on delivery —
  // same action, NULL verdict, NULL override, `actor_type = 'system'` — and
  // "one row per ATTEMPT" would quietly become two, the second one worse.
  //
  // ⚠️ IT WOULD HAVE GONE GREEN: `dial-gate.test.ts` counted with
  // `toBeGreaterThanOrEqual(3)`, and the allow path emits nothing so its
  // `toHaveLength(1)` was untouched. The doubling is caught by one test and
  // only one — see `compliance-emit.test.ts`.
  //
  // The delivery still ARRIVES here (the `audit` consumer subscribes to all 49
  // and is marked built); `auditHandler` returns above and the row is acked as
  // a delivered no-op.
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
 * How each event becomes a timeline entry.
 *
 * `kind` is the enum the seller's screen groups on. `ref` decides what MERGES:
 * two events sharing a ref land in ONE entry, which is the whole reason
 * `timeline_ref_uidx` exists.
 *
 * 🔴 `opportunity.stage_changed` AND `opportunity.won` SHARE A REF ON PURPOSE,
 * and the ref is the CORRELATION id. Migration 0054 gives both emissions the
 * same correlation — it exists so a consumer can tie "the card moved" to "the
 * sale happened" without inferring it from timestamps — so the projector lands
 * one entry that says the card reached Closed Won AND carries the premium,
 * rather than two rows a second apart saying half of it each.
 *
 * ⚠️ THE REF IS THE CORRELATION AND NOT THE OPPORTUNITY. Using the opportunity
 * would merge EVERY stage move that card ever made into a single row, and the
 * timeline would show one line for a lead that moved five times.
 *
 * 🔴 `compliance.send_blocked` NEEDS A THIRD MODE, and neither existing one
 * works. `subject` writes `('contact', contactId)` — which collides with that
 * contact's own `lead_created` entry on the FIRST refusal, because
 * `timeline_ref_uidx` is `UNIQUE (tenant_id, ref_type, ref_id)` with no `WHERE`
 * while the `send_blocked` branch of `timeline_upsert` arbitrates only the
 * blocked index. `correlation` would stamp the literal `'stage_move'` on a
 * compliance row. So the ref is the EVENT: every refusal is its own row, and
 * the 60-second collapse is done by the blocked arbiter, which is where it
 * belongs.
 */
const PROJECTED: ReadonlyMap<string, { kind: string; ref: 'correlation' | 'subject' | 'event' }> =
  new Map([
    ['opportunity.stage_changed', { kind: 'stage_move', ref: 'correlation' }],
    ['opportunity.won', { kind: 'stage_move', ref: 'correlation' }],
    ['opportunity.created', { kind: 'lead_created', ref: 'subject' }],
    ['lead.created', { kind: 'lead_created', ref: 'subject' }],
    ['lead.reposted', { kind: 'repost', ref: 'subject' }],
    ['call.completed', { kind: 'call', ref: 'subject' }],
    ['call.enriched', { kind: 'call', ref: 'subject' }],
    ['message.received', { kind: 'message', ref: 'subject' }],
    ['message.sent', { kind: 'message', ref: 'subject' }],
    ['appointment.scheduled', { kind: 'meeting', ref: 'subject' }],
    ['appointment.completed', { kind: 'meeting', ref: 'subject' }],
    ['appointment.no_showed', { kind: 'meeting', ref: 'subject' }],
    ['activity.completed', { kind: 'note', ref: 'subject' }],
    ['consent.updated', { kind: 'consent', ref: 'subject' }],
    ['compliance.send_blocked', { kind: 'send_blocked', ref: 'event' }],
  ])

/** Keys §10.8 forbids inside `render_payload`, enforced by a CHECK as well. */
const IDENTITY_KEYS = [
  'actor_name',
  'actor_display_name',
  'actor_initials',
  'actor_avatar_url',
  'actor_user_id',
]

/**
 * 🔴 THE PROJECTOR. MVP item 20, and the root of the daily loop.
 *
 * The timeline is a DERIVED PROJECTION and this is the only thing that derives
 * it in production. `crm_app` holds no privilege on `app.timeline_entry` AT ALL,
 * so no query can write a row — that part is a fact about permissions.
 *
 * ⚠️ THE CLAIM STOPS AT THE TABLE. `app.timeline_upsert` is granted to
 * `crm_app`, so a request path could call the function; the tests do exactly
 * that. Narrowed here on purpose rather than repeated, because a guarantee
 * restated one notch wider than it holds is how the next person stops checking.
 *
 * It is also rebuildable. 05b: "fully rebuildable from event_log by the replay
 * job; a corrupt projection is repaired by rebuilding, never by patching" — and
 * what makes that safe is that the upsert is idempotent on the natural key, so
 * replaying the whole log twice produces zero new rows.
 */
const timelineHandler: ConsumerHandler = async (d) => {
  const mapping = PROJECTED.get(d.eventName)
  if (mapping === undefined) return

  // The timeline is per CONTACT. An event with no contact in its payload has
  // nowhere to land — and guessing one would put a stranger's history on
  // somebody's card.
  const contactId = d.payload['contact_id']
  if (typeof contactId !== 'string') return

  // Identity never travels in the payload. The CHECK refuses it too; stripping
  // here means the refusal is never reached rather than reached and survived.
  const render: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(d.payload)) {
    if (!IDENTITY_KEYS.includes(key)) render[key] = value
  }

  const refId =
    mapping.ref === 'correlation'
      ? d.correlationId
      : mapping.ref === 'event'
        ? d.eventId
        : d.subjectId

  const refType =
    mapping.ref === 'correlation'
      ? 'stage_move'
      : mapping.ref === 'event'
        ? 'compliance_block'
        : d.subjectType

  // 🔴 THE VERDICT REACHES THE ROW, and this argument used to be a hard-coded
  // NULL — which is why `send_blocked` was unreachable from the projector even
  // after the kind existed. `timeline_upsert` refuses a blocked row with no
  // verdict (TL002), because NULLs are distinct in a unique index and the
  // 60-second window would silently stop deduplicating.
  //
  // The event carries the CATALOG's vocabulary (`stop`, `outside_window`, …)
  // and the column takes the DATABASE's enum (`blocked_suppressed`, …). The
  // inversion happens in `app.gate_verdict_of`, in SQL, once — a second map in
  // TypeScript is exactly the drift this project keeps paying for.
  const rawVerdict = d.payload['verdict']
  if (mapping.kind === 'send_blocked' && typeof rawVerdict !== 'string') {
    // LOUD, not the silent `return` two guards above. TL002 would refuse this
    // anyway; throwing here names the cause instead of the symptom, and the
    // delivery climbs the ladder into a dead letter with a readable reason.
    throw new Error(`compliance.send_blocked ${d.eventId} carries no verdict`)
  }

  await d.tx.execute(sql`
    SELECT app.timeline_upsert(
      ${contactId}::uuid,
      ${d.ownerUserId}::uuid,
      ${d.occurredAt}::timestamptz,
      ${mapping.kind}::app.timeline_kind,
      ${refType},
      ${refId}::uuid,
      ${JSON.stringify(render)}::jsonb,
      ${d.eventId}::uuid,
      -- The ACTOR, not the owner. See Delivery.actorUserId: passing the owner
      -- made every machine decision read as "You" on the seller's own history.
      ${d.actorUserId}::uuid,
      ${
        mapping.kind === 'send_blocked'
          ? sql`app.gate_verdict_of(${rawVerdict as string})`
          : sql`NULL`
      })`)
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
export const CONSUMERS: ReadonlyMap<string, ConsumerHandler> = new Map([
  ['audit', auditHandler],
  ['contacts', timelineHandler],
])

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
    actor_user_id: string | null
    subject_type: string
    subject_id: string
    payload: Record<string, unknown>
    correlation_id: string
    occurred_at: string
  }>(sql`SELECT event_name::text AS event_name, owner_user_id, actor_user_id,
                subject_type, subject_id, payload, correlation_id,
                -- Explicit UTC ISO-8601 rather than left to ::text, whose output
                -- is a local-format string the Date constructor parses by engine
                -- goodwill rather than by specification. The job dispatcher
                -- already paid for that once.
                --
                -- MICROSECONDS, not milliseconds: this value becomes
                -- timeline_entry.occurred_at, which is what the seller's
                -- history is ordered by and what the keyset cursor pages over.
                -- Truncating here would discard precision the projection can
                -- never get back.
                to_char(occurred_at AT TIME ZONE 'UTC',
                        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS occurred_at
           FROM app.outbox_payload(${eventId}::uuid)`)

  const row = rows[0]
  if (row === undefined) return null

  return {
    eventName: row.event_name,
    eventId,
    ownerUserId: row.owner_user_id,
    actorUserId: row.actor_user_id,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    correlationId: row.correlation_id,
    occurredAt: row.occurred_at,
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
