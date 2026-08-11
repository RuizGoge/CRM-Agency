import { sql } from 'drizzle-orm'

import { claimDueJobs, withSystemWork, type ClaimedJob } from '~/db'

/**
 * The process that consumes the scheduling layer.
 *
 * Sprint 1.6 built the intent — episode idempotency, terminal states,
 * per-tenant fairness — and nothing consumed it. This is the consumer.
 *
 * Two rules here have a legal edge rather than an operational one, and both are
 * terminal ROWS rather than log lines, because "the reminder did not go out"
 * has to be answerable months later:
 *
 *   TOO LATE  A reminder more than fifteen minutes past its fire time is
 *             DROPPED, not sent. A late reminder can land outside the lead's
 *             legal calling window, and a message that is merely useless is a
 *             better outcome than one that is unlawful.
 *   SMS DARK  With `tenant.sms_enabled` false there is nothing to send, so the
 *             job is SKIPPED. Skipped is a first-class terminal state, not an
 *             error — it is what lets the launch configuration run with no path
 *             failing, and it is the evidence that a reminder was skipped
 *             rather than lost.
 *
 * Every job is handled inside `withSystemWork(tenantId)`, one tenant at a time.
 * The claim is cross-tenant; nothing after it is.
 */

/** §9.6 / US-9.x: past this, a reminder is dropped rather than sent. */
export const DROP_AFTER_MINUTES = 15

export interface DispatchOutcome {
  readonly claimed: number
  readonly fired: number
  readonly skipped: number
  readonly droppedLate: number
  readonly failed: number
}

type Terminal = 'fired' | 'skipped' | 'dropped_late'

async function resolve(
  tenantId: string,
  jobId: string,
  status: Terminal,
  reason: string,
): Promise<void> {
  await withSystemWork(tenantId, (tx) =>
    tx.execute(
      sql`SELECT app.scheduled_job_resolve(${jobId}::uuid, ${status}::app.job_status, ${reason})`,
    ),
  )
}

/**
 * Decides one job and writes its terminal row.
 *
 * The lateness check uses the job's own `fire_at` against now, NOT the moment
 * the tick started. A batch that takes a minute to work through must not let
 * its own duration decide whether the last job in it was too late.
 */
async function handle(job: ClaimedJob, now: Date): Promise<Terminal> {
  const lateMinutes = (now.getTime() - job.fireAt.getTime()) / 60_000

  if (lateMinutes > DROP_AFTER_MINUTES) {
    await resolve(
      job.tenantId,
      job.jobId,
      'dropped_late',
      `dropped: ${Math.round(lateMinutes)}m late`,
    )
    return 'dropped_late'
  }

  if (job.kind === 'meeting_reminder') {
    // 🔴 THE ONE COMPLIANCE GATE, AND THIS BLOCK USED TO BE A SECOND COPY OF IT.
    //
    // What stood here read `tenant.sms_enabled` directly and resolved the job as
    // `skipped: sms_disabled` — which is step 1 of `app.compliance_check`'s
    // chain (0038:246-252), reimplemented in TypeScript. The gate's whole claim
    // is that every outbound contact passes through ONE choke point, and a
    // second implementation of its first link is how that claim stops being
    // true without anything going red.
    //
    // It also meant the other four verdicts were unreachable on this path: a
    // reminder to a suppressed number, or one due at 2am in the lead's own
    // timezone, went out — or would have, once a transport existed.
    //
    // `app.reminder_gate` derives the job's OWNER from the row and asks the gate
    // on their behalf, because under `withSystemWork` there is no user and the
    // gate's visibility predicate would refuse every contact in the book.
    const gate = await withSystemWork(job.tenantId, async (tx) => {
      const rows = await tx.execute<{ verdict: string; event_verdict: string | null }>(
        sql`SELECT verdict::text AS verdict, event_verdict
              FROM app.reminder_gate(${job.jobId}::uuid)`,
      )
      return rows[0]
    })

    // Fails CLOSED. A gate that answered nothing did not answer, and the correct
    // reading of no answer is refusal.
    if (gate === undefined) {
      await resolve(job.tenantId, job.jobId, 'skipped', 'skipped: blocked_timezone_unknown')
      return 'skipped'
    }

    if (gate.verdict !== 'allow') {
      // ⚠️ `sms_disabled` KEEPS ITS EXACT OLD STRING. It is the terminal row the
      // SMS-dark launch produces on every reminder, `job-dispatch.test.ts` and
      // `scheduling.test.ts` both assert it by value, and CONTEXT records it as
      // one of the two rows Gate 5 compared across topologies. Changing the
      // wording would have rewritten history that other things read.
      const reason =
        gate.verdict === 'blocked_sms_disabled'
          ? 'skipped: sms_disabled'
          : `skipped: ${gate.verdict}`

      await resolve(job.tenantId, job.jobId, 'skipped', reason)
      return 'skipped'
    }

    // The send itself belongs to the Communications module, which is blocked on
    // the Aloware account (Sprint 1.9). Reaching here today means the gate said
    // yes and there is no transport behind it, so it resolves as skipped with a
    // reason that says exactly that instead of pretending to have sent.
    await resolve(job.tenantId, job.jobId, 'skipped', 'skipped: no sms transport configured')
    return 'skipped'
  }

  // Every other kind is scheduled by modules that do not exist yet. Resolving
  // them as skipped with the reason recorded keeps the queue draining and keeps
  // the row honest — a job that stays pending forever is indistinguishable from
  // a dispatcher that is not running.
  await resolve(job.tenantId, job.jobId, 'skipped', `skipped: no handler for ${job.kind}`)
  return 'skipped'
}

/**
 * One tick. Claims a fair batch and resolves each job to a terminal row.
 *
 * A job that throws is left claimed and pending on purpose: its lease expires
 * and a later tick retries it, and if it keeps failing past fifteen minutes it
 * reaches `dropped_late` rather than being retried into the night.
 */
export async function dispatchDueJobs(limit = 50, maxRounds = 20): Promise<DispatchOutcome> {
  const now = new Date()

  let claimed = 0
  let fired = 0
  let skipped = 0
  let droppedLate = 0
  let failed = 0

  // ROUNDS, because the claim is fair per CALL: it hands each tenant its oldest
  // due job before any tenant gets a second. One call per tick would therefore
  // mean one reminder per tenant per minute, and a tenant with forty due
  // reminders would take forty minutes to work through them — long past the
  // fifteen after which each one is dropped as too late.
  //
  // Fairness survives intact because it is preserved BETWEEN rounds: a storm
  // tenant still never gets a second job before a quiet tenant gets its first.
  // Throughput comes from the rounds; the ordering comes from the claim.
  //
  // Bounded rather than "until empty": a tick that never returns is a worker
  // that has stopped ticking, and the next round is a minute away regardless.
  for (let round = 0; round < maxRounds; round += 1) {
    const jobs = await claimDueJobs(limit)
    if (jobs.length === 0) break
    claimed += jobs.length

    for (const job of jobs) {
      try {
        const outcome = await handle(job, now)
        if (outcome === 'fired') fired += 1
        else if (outcome === 'skipped') skipped += 1
        else droppedLate += 1
      } catch (err: unknown) {
        // Contained per job, never per batch: one tenant's bad row must not stop
        // every other tenant's reminders, which is the same starvation the fair
        // claim exists to prevent.
        //
        // The reason is PRINTED, not swallowed. The first run of this dispatcher
        // reported `1 failed` and nothing else, which is indistinguishable from a
        // dispatcher that is broken in a way nobody can name. The job itself
        // stays pending and claimed: its lease expires, a later tick retries it,
        // and if it keeps failing past the fifteen minutes it reaches its
        // `dropped_late` row rather than being retried into the night.
        console.error(
          `[dispatch] job ${job.jobId} (${job.kind}, tenant ${job.tenantId}):`,
          err instanceof Error ? err.message : String(err),
        )
        failed += 1
      }
    }
  }

  return { claimed, fired, skipped, droppedLate, failed }
}
