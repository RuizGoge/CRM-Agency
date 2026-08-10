import { PgBoss } from 'pg-boss'

import { dispatchDueJobs } from '~/modules/calendar/dispatch'
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

  await instance.work(DISPATCH_QUEUE, async () => {
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

  boss = instance
  return instance
}

export async function stopWorker(): Promise<void> {
  if (!boss) return
  const instance = boss
  boss = null
  await instance.stop({ graceful: false })
}
