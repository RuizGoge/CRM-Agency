import { PgBoss } from 'pg-boss'

import { dispatchDueJobs } from '~/modules/calendar/dispatch'

import { DISPATCH_CRON, DISPATCH_QUEUE } from './queues'

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
