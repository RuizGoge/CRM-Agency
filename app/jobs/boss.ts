import { getConstructionPlans, PgBoss } from 'pg-boss'

/**
 * The ONLY module in this repository that imports pg-boss.
 *
 * §2558 asks for "100 % of its surface wrapped in `src/jobs/` behind our own
 * types", and this is that. It was the last assertion of Gate 8 left open after
 * the queues, their policies and their retention became declarations: the
 * client's LIFECYCLE was still pg-boss's own vocabulary, called directly from
 * `worker.ts`.
 *
 * WHY IT MATTERS, and it is the gate's own subject rather than tidiness. G8 is
 * the VERSION-STRESS gate: the question is what happens when this dependency
 * moves under us. With `instance.work(...)`, `instance.schedule(...)` and
 * `{ graceful: false }` spread across the worker, a signature change in a minor
 * is a diff in as many places as we happened to call it, each one needing its
 * own decision. Behind this file it is one place, and the type error points at
 * it.
 *
 * ⚠️ THE GUARD IS IN `eslint.config.js`, NOT IN THIS COMMENT. A rule that says
 * "only this file may import pg-boss" is documentation; the `no-restricted-imports`
 * entry that fails the build is the mechanism, and `gate-8-jobs.test.ts` pins
 * the exception list so that widening it is an edit somebody makes on purpose.
 *
 * WHAT IS DELIBERATELY NOT EXPOSED: `send`, `fetch`, `complete`, `fail`,
 * `cancel`, `getQueue`, and the whole scheduling surface beyond one cron. Jobs
 * are enqueued by `app.webhook_ingest()` with a raw INSERT inside the emitting
 * transaction — §4.2's one round trip — so a `send` here would be a second way
 * to enqueue that skips the transaction the first one exists to share.
 */

/** What a handler receives. One job, never a batch. */
export interface Job<T> {
  readonly id: string
  readonly data: T
}

/**
 * A queue handler. Receives ONE job.
 *
 * The batch is not a parameter, and that is the invariant rather than a
 * convenience: `key_strict_fifo` guarantees at most one ACTIVE job per key, and
 * a handler written against a batch would let two jobs for DIFFERENT calls
 * interleave in one invocation while every handler in this tree is written per
 * job.
 */
export type JobHandler<T> = (job: Job<T>) => Promise<void>

/** Everything this product does with a job runner. */
export interface JobRunner {
  /** Registers a handler. One job at a time, always. */
  onQueue<T>(queue: string, handler: JobHandler<T>): Promise<void>
  /** Re-asserts a cron schedule. Idempotent, and run on every boot. */
  everyTick(queue: string, cron: string): Promise<void>
  /** Stops without waiting for in-flight work. Leases cover the rest. */
  stop(): Promise<void>
}

class BossRunner implements JobRunner {
  readonly #boss: PgBoss

  constructor(boss: PgBoss) {
    this.#boss = boss
  }

  async onQueue<T>(queue: string, handler: JobHandler<T>): Promise<void> {
    await this.#boss.work<T>(queue, { batchSize: 1 }, async (jobs) => {
      const job = jobs[0]
      if (job === undefined) return
      await handler({ id: job.id, data: job.data })
    })
  }

  async everyTick(queue: string, cron: string): Promise<void> {
    // Re-asserted on every boot rather than seeded once. A schedule that exists
    // because somebody ran a command in a console is not a deploy artifact —
    // the same reason `harden()` runs on every deploy instead of at install.
    await this.#boss.schedule(queue, cron)
  }

  async stop(): Promise<void> {
    await this.#boss.stop({ graceful: false })
  }
}

/**
 * Connects and starts the runner.
 *
 * `migrate: false` is the load-bearing option and it lives here now. pg-boss
 * will build and migrate its own schema on start if allowed, and a library
 * issuing DDL against production under the application's credential is a change
 * nobody would see. The schema is installed by the migrator at deploy
 * (`npm run db:jobs`) and `crm_app` has no CREATE on it, so this is belt as
 * well as braces — and `gate-8-jobs.test.ts` asserts both halves.
 */
export async function startJobRunner(
  connectionString: string,
  onError: (message: string) => void,
  options: { readonly lane?: string; readonly max?: number } = {},
): Promise<JobRunner> {
  const boss = new PgBoss({
    connectionString,
    schema: 'pgboss',
    migrate: false,
    supervise: true,
    // 🔴 ONE RUNNER PER LANE, EACH WITH ITS OWN POOL, AND THE POOL IS THE WHOLE
    // POINT (`05c` §11.7.2). pg-boss's per-queue priority orders a fetch WITHIN
    // a queue; it does nothing about a shared pool. Until this parameter existed
    // there was ONE `PgBoss` here and all four `work()` loops drew from its
    // single pool, so a 20,000-job bulk drain starved every other queue — which
    // is precisely how a TCPA STOP becomes "job 14,000 in a FIFO drain" (§2367).
    //
    // Separate instances give separate pools, so the compliance lane holds
    // connections no bulk drain can take. `supervise` stays on per instance: each
    // one maintains only the queues it works.
    ...(options.max === undefined ? {} : { max: options.max }),
  })

  // pg-boss reports operational failures as EVENTS rather than rejections, so
  // without this a queue that has stopped working looks exactly like a queue
  // with nothing to do. The lane is in the message because with three runners
  // "the job runner failed" no longer says which one — and a wedged
  // `lane_compliance` is a different incident from a wedged `lane_bulk`.
  boss.on('error', (err: Error) => {
    onError(options.lane === undefined ? err.message : `${options.lane}: ${err.message}`)
  })

  await boss.start()
  return new BossRunner(boss)
}

/**
 * The schema DDL, for the migrator's deploy step.
 *
 * Re-exported through this module rather than imported where it is used, so
 * that the "only this file imports pg-boss" rule has no exceptions to argue
 * about. `scripts/jobs-schema.ts` runs as the OWNER and is the one place
 * allowed to execute this.
 */
export function jobSchemaPlans(schema: string): string {
  return getConstructionPlans(schema)
}
