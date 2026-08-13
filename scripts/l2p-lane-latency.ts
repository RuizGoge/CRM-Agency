/**
 * L2-P — the lane assertion. `05c` §2405.
 *
 * *"Enqueue 20,000 `bulk` jobs, then one `compliance` job; assert it starts
 * within 5 s with the full backlog present."*
 *
 * 🔴 THIS IS THE ONE ASSERTION IN THIS AREA THAT DEPENDS ON NOTHING EXTERNAL.
 * G6/P24 is blocked on capturing a real inbound SMS from Aloware; L2-P is purely
 * about whether `ref.job_registry`'s lanes do what 0070 claims. It measures the
 * property directly: with the bulk lane buried, does the compliance lane still
 * pick a job up promptly.
 *
 * WHAT "STARTS" MEANS, and it is the register's own word rather than a softer
 * one chosen here. pg-boss stamps `started_on` when a worker FETCHES a job, so
 * that column is the arrival time of the thing being asserted. Completion is a
 * different question and would fold the handler's own work into a number about
 * scheduling.
 *
 * ⚠️ THE FAILURE THIS EXISTS TO CATCH IS SILENT. Before 0070 all four queues
 * drew from ONE pg-boss pool, so a 20,000-job drain starved everything else and
 * a TCPA STOP was §2367's "job 14,000 in a FIFO drain" — with every screen, every
 * counter and every test green while it happened.
 */

import { performance } from 'node:perf_hooks'

import postgres from 'postgres'

import { startWorker, stopWorker, workerEnabled } from '../app/jobs/worker'

/** Overridable so the harness can be smoke-run before the real 20 000. */
const BULK = Number(process.env['L2P_BULK'] ?? 20_000)
/** §2405's deadline, in ms. Not a tuning knob. */
const DEADLINE_MS = 5_000

/** The seeded demo tenant. The bulk jobs carry it so their handler does real work. */
const TENANT = '00000000-0000-7000-8000-00000000de01'

/** The lanes, read from the registry rather than named here. */
async function lanesOf(sql: postgres.Sql): Promise<Map<string, string>> {
  const rows = await sql<{ queue_name: string; lane: string }[]>`
    SELECT queue_name, lane FROM ref.job_registry`
  return new Map(rows.map((r) => [r.queue_name, r.lane]))
}

async function main(): Promise<void> {
  const ownerUrl = process.env['MIGRATION_DATABASE_URL']
  if (ownerUrl === undefined || ownerUrl === '') {
    throw new Error('MIGRATION_DATABASE_URL is required: the harness enqueues as the owner')
  }
  const owner = postgres(ownerUrl, { max: 2, onnotice: () => {} })

  try {
    const lanes = await lanesOf(owner)
    // Picked FROM THE REGISTRY, never hard-coded: if somebody reclassifies a
    // queue, this harness must measure the new arrangement rather than the one
    // it was written against.
    const bulkQueue = [...lanes].find(([, lane]) => lane === 'lane_bulk')?.[0]
    const complianceQueue = [...lanes].find(([, lane]) => lane === 'lane_compliance')?.[0]
    if (bulkQueue === undefined || complianceQueue === undefined) {
      const seen = [...lanes].map(([q, l]) => `${q}=${l}`).join(', ')
      throw new Error(`L2P001: registry has no bulk and/or compliance lane. Saw: ${seen}`)
    }

    console.log(`L2-P — ${BULK} bulk jobs on '${bulkQueue}', then one on '${complianceQueue}'.`)
    console.log(`Lanes read from ref.job_registry. Deadline ${DEADLINE_MS} ms.\n`)

    await owner`DELETE FROM pgboss.job WHERE data->>'l2p' IS NOT NULL`

    // The whole backlog BEFORE the compliance job, because "with the full
    // backlog present" is the condition being asserted. Enqueued as one
    // statement: 20,000 round trips would take longer than the drain.
    // 🔴 THE BULK JOBS CARRY A TENANT, AND THAT IS WHAT MAKES THEM COST
    // ANYTHING. Without it the dead-letter handler short-circuits on a
    // console.error and touches no database at all — so the first version of
    // this harness enqueued 20,000 jobs that were FREE, and measured a lane
    // against a backlog that occupied nothing. That is why the mutation could
    // not tell the legs apart. With a tenant the handler runs
    // `recordJobDeadLetter`, which goes through `app/db/pool.ts` — the pool
    // every OTHER handler shares, and the one 0070 did not separate.
    const t0 = performance.now()
    await owner`
      INSERT INTO pgboss.job (name, data, policy, retry_limit, expire_seconds, deletion_seconds, keep_until)
      SELECT ${bulkQueue},
             jsonb_build_object('l2p', 'bulk', 'n', g, 'tenantId', ${TENANT}::text,
                                'alowareCallId', 'l2p-' || g),
             'standard', 0, 120, 3600,
             now() + interval '1 hour'
        FROM generate_series(1, ${BULK}) g`
    console.log(`  backlog enqueued in ${((performance.now() - t0) / 1000).toFixed(1)}s`)

    const [depth] = await owner<{ n: string }[]>`
      SELECT count(*) AS n FROM pgboss.job WHERE name = ${bulkQueue} AND state = 'created'`
    console.log(`  bulk queue depth   ${depth?.n ?? '?'}`)

    if (!workerEnabled()) {
      throw new Error(
        'L2P002: PROCESS_ROLES must include "worker" — this harness folds one in so the ' +
          'measurement is of the lanes rather than of whether somebody started a process.',
      )
    }
    await startWorker()

    // 🔴 THE COMPLIANCE JOB GOES IN AFTER THE WORKER IS UP, so the number is the
    // lane's latency and not the worker's boot time. Enqueuing it before would
    // measure how long `startWorker` takes and report it as a lane result.
    const enqueuedAt = performance.now()
    const [job] = await owner<{ id: string }[]>`
      INSERT INTO pgboss.job (name, data, policy, retry_limit, expire_seconds, deletion_seconds, keep_until)
      VALUES (${complianceQueue}, jsonb_build_object('l2p', 'compliance'), 'standard', 0, 120, 3600,
              now() + interval '1 hour')
      RETURNING id`
    if (job === undefined) throw new Error('L2P003: the compliance job was not enqueued')

    let startedInMs: number | null = null
    for (;;) {
      const elapsed = performance.now() - enqueuedAt
      const [row] = await owner<{ started: boolean }[]>`
        SELECT started_on IS NOT NULL AS started FROM pgboss.job WHERE id = ${job.id}::uuid`
      if (row?.started === true) {
        startedInMs = performance.now() - enqueuedAt
        break
      }
      // Watched past the deadline on purpose: "how late" is more useful than
      // "late", and stopping at 5 s would report null for a 5.2 s arrival.
      if (elapsed > DEADLINE_MS * 4) break
      await new Promise((r) => setTimeout(r, 10))
    }

    const [remaining] = await owner<{ n: string }[]>`
      SELECT count(*) AS n FROM pgboss.job WHERE name = ${bulkQueue} AND state = 'created'`

    console.log('\n— L2-P —')
    console.log(
      `  compliance started   ${
        startedInMs === null ? 'NEVER' : `${startedInMs.toFixed(0)}ms  (deadline ${DEADLINE_MS}ms)`
      }`,
    )
    // 🔴 THE BACKLOG MUST STILL BE THERE. If the bulk lane had drained by the
    // time the compliance job was picked up, this would be a measurement of an
    // idle system wearing the name of a contention test — the same class of
    // false pass as the storm harness's first run, which put a sequence number
    // in every body and deduped nothing.
    console.log(`  backlog still queued ${remaining?.n ?? '?'} / ${BULK}`)

    const stillBuried = Number.parseInt(remaining?.n ?? '0', 10) > BULK / 2
    const inTime = startedInMs !== null && startedInMs <= DEADLINE_MS
    console.log(
      `  VERDICT              ${
        !stillBuried
          ? 'UNRUN — the backlog drained before the compliance job was picked up'
          : inTime
            ? 'PASS'
            : 'FAIL'
      }`,
    )

    await stopWorker()
    process.exit(stillBuried && inTime ? 0 : 1)
  } finally {
    await owner.end()
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
