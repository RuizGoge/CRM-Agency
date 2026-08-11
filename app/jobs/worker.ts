import { PgBoss } from 'pg-boss'

import { ensurePartitions } from '~/db'
import { dispatchDueJobs } from '~/modules/calendar/dispatch'
import { relayOnce } from '~/modules/events/relay'

import { startSaturationMonitor, stopSaturationMonitor } from './saturation'
import { mergeCallFromEvent, type CallMergeJob } from '~/modules/communications/call-merge'
import { mergeMessageFromEvent, type MessageMergeJob } from '~/modules/communications/message-merge'

import { CALL_MERGE_QUEUE, DISPATCH_CRON, DISPATCH_QUEUE, MESSAGE_MERGE_QUEUE } from './queues'

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

let boss: PgBoss | null = null

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

export async function startWorker(): Promise<PgBoss | null> {
  if (!workerEnabled()) return null
  if (boss) return boss

  const connectionString = process.env['DATABASE_URL']
  if (connectionString === undefined || connectionString === '') {
    throw new Error('JOBS001: the worker needs DATABASE_URL, and it must name crm_app')
  }

  const instance = new PgBoss({
    connectionString,
    schema: 'pgboss',
    migrate: false,
    supervise: true,
  })

  // pg-boss reports operational failures as events rather than rejections, so
  // without this a queue that has stopped working looks exactly like a queue
  // with nothing to do.
  instance.on('error', (err: Error) => {
    console.error('[worker] pg-boss:', err.message)
  })

  await instance.start()

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

  await instance.work(DISPATCH_QUEUE, async () => {
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
  await instance.work<CallMergeJob>(CALL_MERGE_QUEUE, { batchSize: 1 }, async ([job]) => {
    if (job === undefined) return
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

  await instance.work<MessageMergeJob>(MESSAGE_MERGE_QUEUE, { batchSize: 1 }, async ([job]) => {
    if (job === undefined) return
    const result = await mergeMessageFromEvent(job.data)
    if (result.status !== 'resolved') {
      console.log(
        `[worker] message-merge ${job.data.alowareCallId}: ${result.status}` +
          ('reason' in result ? ` (${result.reason})` : ''),
      )
    }
  })

  // Re-asserted on every boot rather than seeded once. A schedule that exists
  // because someone ran a command in a console is not a deploy artifact, and
  // this is the same reason `harden()` runs on every deploy instead of at
  // install.
  await instance.schedule(DISPATCH_QUEUE, DISPATCH_CRON)

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
  const instance = boss
  boss = null
  await instance.stop({ graceful: false })
}
