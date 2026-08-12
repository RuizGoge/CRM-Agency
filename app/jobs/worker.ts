import { ensurePartitions, readJobRegistry, recordJobDeadLetter } from '~/db'
import { dispatchDueJobs } from '~/modules/calendar/dispatch'
import { relayOnce } from '~/modules/events/relay'

import { startJobRunner, type JobHandler, type JobRunner } from './boss'
import { startSaturationMonitor, stopSaturationMonitor } from './saturation'
import { mergeCallFromEvent, type CallMergeJob } from '~/modules/communications/call-merge'
import { mergeMessageFromEvent, type MessageMergeJob } from '~/modules/communications/message-merge'

import {
  CALL_MERGE_QUEUE,
  DEAD_LETTER_QUEUE,
  DISPATCH_CRON,
  DISPATCH_QUEUE,
  MESSAGE_MERGE_QUEUE,
} from './queues'

/** Whatever the original job carried. Every field is optional by construction. */
interface DeadLetterJob {
  readonly tenantId?: string
  readonly alowareCallId?: string
  readonly canonical?: string
}

/**
 * The worker role.
 *
 * The three-process topology is DEPLOYMENT CONFIGURATION, not an architectural
 * assumption — Jorge's ruling. So this starts from `PROCESS_ROLES` and the same
 * image runs folded into one process on the cheap rung and split into three
 * later, with no redesign and no migration. pg-boss's cron is what makes that
 * safe: the tick is a queue entry, so two folded web processes do not both
 * dispatch.
 *
 * `migrate: false` is the load-bearing option. pg-boss will build and migrate
 * its own schema on start if allowed, and a library issuing DDL against
 * production under the application's credential is a change nobody would see.
 * The schema is installed by the migrator at deploy (`npm run db:jobs`) and
 * `crm_app` has no CREATE on it, so this is belt as well as braces.
 */

let boss: JobRunner | null = null

/**
 * One runner per lane, each with its own pool. `05c` §11.7.2.
 *
 * Keyed by lane name so `stopWorker` can close all of them and so a second
 * `startWorker` is still idempotent.
 */
const lanes = new Map<string, JobRunner>()

/**
 * The lane a queue drains in, READ FROM `ref.job_registry` rather than written
 * here (§2394: *"WORKER_LANES is derived from the registry, never configured by
 * hand"*).
 *
 * A constant in this file would be a second table of truth, and the failure it
 * produces is silent in the worst way: a queue classified `compliance` in the
 * database and drained by the bulk loop here looks completely healthy and is
 * simply late — which for the STOP chain is the legal failure the whole object
 * exists to prevent.
 */
async function laneMap(): Promise<ReadonlyMap<string, string>> {
  const rows = await readJobRegistry()
  return new Map(rows.map((r) => [r.queueName, r.lane]))
}

/**
 * 🔴 THE COMPLIANCE LANE CANNOT BE ACCIDENTALLY UNDEPLOYED (§2395).
 *
 * A worker whose lane set omits `lane_compliance` exits non-zero at boot, in
 * either topology. This is the third of the constitution's three surviving
 * properties — re-assertion at boot — applied to the one lane where delay is a
 * legal failure rather than a slow screen. Without it, a change that drops the
 * compliance queues produces a process that starts cleanly, reports healthy, and
 * silently stops honouring STOPs.
 */
const COMPLIANCE_LANE = 'lane_compliance'

/**
 * The relay's poll floor.
 *
 * ADR-005 applies the NOTIFY-carries-a-watermark rule internally too: a wake-up
 * may be missed, and missing one must cost at most a second rather than the
 * event. One second is not a pg-boss cron — its floor is a minute — which is
 * why the relay runs its own timer instead of becoming a queue.
 */
const RELAY_INTERVAL_MS = 1_000

let relayTimer: NodeJS.Timeout | null = null
let relayStopped = false

/**
 * setTimeout that re-arms AFTER the pass, never setInterval.
 *
 * With an interval, a pass that takes longer than the period overlaps itself,
 * and two passes racing means two claims of the same lease window — which the
 * `FOR UPDATE SKIP LOCKED` claim survives but the handler workload does not
 * need to. Re-arming after the pass makes overlap impossible by construction.
 */
function scheduleRelay(): void {
  if (relayStopped) return
  relayTimer = setTimeout(() => {
    void (async () => {
      try {
        const outcome = await relayOnce()
        if (outcome.claimed > 0) {
          console.log(
            `[relay] claimed ${outcome.claimed}: ${outcome.delivered} delivered, ` +
              `${outcome.failed} failed, ${outcome.unhandled} unhandled`,
          )
        }
      } catch (err: unknown) {
        // The loop must survive its own failures. A relay that dies on one bad
        // pass stops delivering everything, and the symptom — an outbox that
        // fills — looks identical to no traffic.
        console.error('[relay] pass failed:', err instanceof Error ? err.message : String(err))
      } finally {
        scheduleRelay()
      }
    })()
  }, RELAY_INTERVAL_MS)

  // Do not hold the process open on this timer alone. A web process folded with
  // the worker should still exit when its server closes.
  relayTimer.unref()
}

export function workerEnabled(): boolean {
  // Default ON when unset, so a deployment that forgets the variable runs the
  // reminders rather than silently not running them. The failure of a missing
  // config should be a noisier process, never a quieter one.
  const roles = process.env['PROCESS_ROLES']
  if (roles === undefined || roles.trim() === '') return true
  return roles
    .split(',')
    .map((r) => r.trim())
    .includes('worker')
}

export async function startWorker(): Promise<JobRunner | null> {
  if (!workerEnabled()) return null
  if (boss) return boss

  const connectionString = process.env['DATABASE_URL']
  if (connectionString === undefined || connectionString === '') {
    throw new Error('JOBS001: the worker needs DATABASE_URL, and it must name crm_app')
  }

  // The lanes, derived from the registry rather than declared here.
  const queueLane = await laneMap()
  const laneNames = [...new Set(queueLane.values())].sort()

  // 🔴 THE BOOT REFUSAL (§2395). A worker without the compliance lane starts
  // cleanly, reports healthy, drains call-merge at full speed and quietly stops
  // honouring STOPs. Exiting is the only notice that failure gets.
  if (!laneNames.includes(COMPLIANCE_LANE)) {
    throw new Error(
      `JOBS004: this worker's lanes are [${laneNames.join(', ')}] and none of them is ` +
        `${COMPLIANCE_LANE}. The compliance lane carries the STOP chain and the reminder ` +
        `dispatch, where delay is a legal failure — it cannot be undeployed by omission.`,
    )
  }

  const runnerFor = new Map<string, JobRunner>()
  for (const lane of laneNames) {
    // Own connections per lane. `max: 4` rather than pg-boss's default 10
    // because three pools at the default would be 30 connections against a
    // Postgres whose real `max_connections` is still a Gate-1 unknown — and the
    // compliance lane needs a few reserved connections, not many.
    const runner = await startJobRunner(
      connectionString,
      (message) => {
        console.error('[worker] job runner:', message)
      },
      { lane, max: 4 },
    )
    runnerFor.set(lane, runner)
    lanes.set(lane, runner)
  }

  /** Registers a handler on the runner that owns that queue's lane. */
  const onQueue = async <T>(queue: string, handler: JobHandler<T>) => {
    const lane = queueLane.get(queue)
    if (lane === undefined) {
      // §2382(b): a queue with no registry row is a queue nothing drains. It
      // fails here rather than starting a worker that silently ignores it.
      throw new Error(
        `JOBS005: queue ${queue} has no ref.job_registry row, so it has no lane and ` +
          `nothing would drain it. Classify it in a migration.`,
      )
    }
    const runner = runnerFor.get(lane)
    if (runner === undefined) throw new Error(`JOBS006: no runner for lane ${lane}`)
    await runner.onQueue<T>(queue, handler)
  }

  // The instance the rest of this function schedules the cron on. The dispatch
  // queue is `compliance`, so this is the compliance runner.
  const dispatchLane = queueLane.get(DISPATCH_QUEUE)
  const instance = (dispatchLane === undefined ? undefined : runnerFor.get(dispatchLane)) ?? null
  if (instance === null) throw new Error(`JOBS006: no runner for lane ${String(dispatchLane)}`)

  console.log(
    `[worker] lanes: ${laneNames
      .map((l) => `${l}(${[...queueLane].filter(([, v]) => v === l).length})`)
      .join(' · ')}`,
  )

  // 🔴 RE-ASSERTED AT BOOT, and this is not defensive tidying.
  //
  // `event_outbox` is partitioned by DAY with no default partition, and
  // `app.event_emit` writes its fan-out rows inside the EMITTING transaction.
  // The first insert past the last partition raises 23514 and takes the whole
  // emitting transaction with it — which, once `app.stage_move` emits, is a
  // seller watching a sale refuse to commit.
  //
  // 0043 called `ensure_event_partitions` ONCE, inside itself, and nothing has
  // called it since: the horizon it created ran to 2026-08-24 and then stopped.
  // The constitution accepts three kinds of guarantee and "a job somebody
  // scheduled once" is none of them, so this runs at boot AND on the tick
  // below.
  await ensurePartitions()

  await onQueue(DISPATCH_QUEUE, async () => {
    // Cheap and idempotent — CREATE TABLE IF NOT EXISTS across a fixed horizon.
    // On the tick as well as at boot because a process that has been up for a
    // month has not re-asserted anything since the month it started in.
    await ensurePartitions()

    const outcome = await dispatchDueJobs()
    if (outcome.claimed > 0) {
      console.log(
        `[worker] dispatched ${outcome.claimed}: ${outcome.fired} fired, ` +
          `${outcome.skipped} skipped, ${outcome.droppedLate} dropped late, ${outcome.failed} failed`,
      )
    }
  })

  // 🔴 ONE AT A TIME, AND THE `1` IS THE WHOLE POINT OF THE QUEUE'S POLICY.
  // `key_strict_fifo` guarantees at most one ACTIVE job per `aloware_call_id`,
  // which is what serializes two webhooks about one call 50 ms apart — §4.5's
  // "not by a SELECT-then-UPDATE that loses one of them". Raising batchSize
  // here would not break that guarantee, but it would let two jobs for
  // DIFFERENT calls interleave in one handler invocation, and the handler is
  // written per job.
  await onQueue<CallMergeJob>(CALL_MERGE_QUEUE, async (job) => {
    const result = await mergeCallFromEvent(job.data)

    // An unmapped call is a PRODUCT SURFACE, not a log line: §5 renders it to
    // the admin as "1 call from a number we do not recognize. Nothing was
    // written to a seller's book." Printing it here is the interim until
    // `admin_alert` exists — said in the console rather than swallowed.
    if (result.status !== 'resolved') {
      console.log(
        `[worker] call-merge ${job.data.alowareCallId}: ${result.status}` +
          ('reason' in result ? ` (${result.reason})` : ''),
      )
    }
  })

  await onQueue<MessageMergeJob>(MESSAGE_MERGE_QUEUE, async (job) => {
    const result = await mergeMessageFromEvent(job.data)
    if (result.status !== 'resolved') {
      console.log(
        `[worker] message-merge ${job.data.alowareCallId}: ${result.status}` +
          ('reason' in result ? ` (${result.reason})` : ''),
      )
    }
  })

  // 🔴 THE DEAD-LETTER HANDLER, AND WITHOUT IT THE QUEUE IS A DRAWER NOBODY
  // OPENS. pg-boss moves an exhausted job here on its own; that only turns into
  // something an operator can see because this reads it and writes
  // `app.dead_letter`. §2559 names both halves of the absence — "a webhook
  // retried zero times and discarded, OR a DLQ that never receives anything".
  //
  // The original job's payload rides along in `job.data`, which is what makes
  // the row replayable rather than merely a count: the tenant, the ingest event
  // and the provider's own call id are all still there.
  await onQueue<DeadLetterJob>(DEAD_LETTER_QUEUE, async (job) => {
    const payload = job.data
    const tenantId = typeof payload?.tenantId === 'string' ? payload.tenantId : null
    const subjectId =
      typeof payload?.alowareCallId === 'string' ? payload.alowareCallId : (job.id ?? 'unknown')

    if (tenantId === null) {
      // A dead letter we cannot attribute is still worth saying out loud. It
      // cannot be written — `app.dead_letter` is tenant-scoped and inventing
      // one would file another agency's failure under this one.
      console.error(`[dead-letter] job ${job.id} carries no tenant; not recorded`)
      return
    }

    await recordJobDeadLetter(
      tenantId,
      'job',
      subjectId,
      `${String(payload?.canonical ?? 'job')} exhausted its retries: ` +
        `${JSON.stringify(payload).slice(0, 500)}`,
    )
    console.error(`[dead-letter] recorded ${subjectId} for tenant ${tenantId}`)
  })

  // Re-asserted on every boot rather than seeded once. A schedule that exists
  // because someone ran a command in a console is not a deploy artifact, and
  // this is the same reason `harden()` runs on every deploy instead of at
  // install.
  await instance.everyTick(DISPATCH_QUEUE, DISPATCH_CRON)

  // The outbox relay is NOT a pg-boss queue, and the reason is the poll floor:
  // ADR-005 wants one second and cron's floor is a minute. The outbox owns
  // fan-out, pg-boss owns scheduling, and giving the relay to pg-boss would put
  // both of them in charge of delivery.
  relayStopped = false
  scheduleRelay()

  // §2444: folded, the ingest surface, SSR and the poll floor share ONE event
  // loop, and loop delay is the only signal in the product that sees the
  // process rather than a request. §2550 allows the folded tier to degrade and
  // forbids it degrading SILENTLY — this is what stops it being silent.
  startSaturationMonitor()

  boss = instance
  return instance
}

export async function stopWorker(): Promise<void> {
  stopSaturationMonitor()
  relayStopped = true
  if (relayTimer !== null) {
    clearTimeout(relayTimer)
    relayTimer = null
  }

  if (!boss) return
  boss = null

  // EVERY lane, not just the one `boss` points at. Before the lanes existed
  // there was one runner and stopping it was the whole shutdown; with three,
  // stopping one leaves two pools open and the next `startWorker` in the same
  // process adds three more.
  const running = [...lanes.values()]
  lanes.clear()
  await Promise.all(running.map((runner) => runner.stop()))
}
