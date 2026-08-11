/**
 * Queue names, in one place because two of them must agree across a process
 * boundary: the deploy step that creates the queue and the worker that binds to
 * it. A typo in either produces a worker that starts cleanly, reports healthy,
 * and consumes nothing.
 */

/** The recurring dispatcher tick. Cron, so pg-boss keeps it singleton across a folded topology. */
export const DISPATCH_QUEUE = 'scheduled-job-dispatch'

/**
 * Every minute — cron's floor, and comfortably enough.
 *
 * The tightest promise in this area is a T-1h reminder, and what actually
 * bounds lateness is the fifteen-minute rule that DROPS a reminder rather than
 * sending it late. A minute of scheduling jitter sits well inside that, and
 * chasing seconds here would buy nothing while making the tick the thing that
 * has to be reliable instead of the terminal row.
 */
export const DISPATCH_CRON = '* * * * *'

/**
 * The merge queue. §4.5: **one job, one queue, one key** — `aloware_call_id`.
 *
 * Enqueued by `app.webhook_ingest()` with a raw INSERT into `pgboss.job`,
 * because pg-boss 12 ships NO `send()` SQL function: it installs exactly
 * `create_queue`, `job_table_format`, `job_table_run` and
 * `job_table_run_async`. The `pgboss.send(...)` in §4.2's diagram is the
 * JavaScript API, and the ruling it illustrates — one round trip, one
 * transaction — is the reason the enqueue cannot be a second call from Node.
 */
export const CALL_MERGE_QUEUE = 'call-merge'

/**
 * 🔴 `key_strict_fifo`, AND THE OBVIOUS CHOICES SILENTLY LOSE WEBHOOKS.
 *
 * §4.5 asks for two deliveries about one call to be **serialized**, not
 * deduplicated. pg-boss expresses both, and the difference is one partial
 * unique index — read off `pgboss.job_common` rather than off the docs:
 *
 *   exclusive        UNIQUE (name, key) WHERE state <= 'active'
 *   key_strict_fifo  UNIQUE (name, key) WHERE state IN (active, retry, failed)
 *
 * Under `exclusive`, a second delivery arriving while the first job is still
 * active is REFUSED — the insert is discarded and its merge never happens.
 * That is not hypothetical here: G2 measured `Call-Disposed` restating a
 * disposition **6.6 s** after the event it restates, and `Recording-Saved` and
 * `transcription.*` land later still. Under `key_strict_fifo` the second job
 * queues behind the first and one runs at a time, which is the property §4.5
 * actually names.
 *
 * ⚠️ IT ALSO CARRIES A CHECK: `singleton_key` may not be NULL under this
 * policy. That is not an obstacle, it is the design forcing a decision the edge
 * has to make anyway — a delivery with no `aloware_call_id` (the provider's own
 * `{"test_payload":true}`, anything unparsed, any event name we do not map) has
 * no call to merge and is stored without a job.
 */
export const CALL_MERGE_POLICY = 'key_strict_fifo'

/**
 * The SMS merger. §4.3 routes `message.received` and `message.delivery_failed`
 * here, keyed on `provider_message_id`.
 *
 * ⚠️ A SEPARATE QUEUE RATHER THAN A SECOND HANDLER ON `call-merge`, and the
 * reason is the singleton key. `key_strict_fifo` serializes on
 * `(name, singleton_key)` — and G2 established that Aloware numbers calls and
 * texts from ONE communication id sequence. Sharing the queue would therefore
 * be safe by accident today and wrong the moment either side changes, because
 * what serialization is FOR here is "one merger touching one row at a time",
 * and the two mergers touch different tables.
 */
export const MESSAGE_MERGE_QUEUE = 'message-merge'

/** Same policy, same reason: serialize per subject, never discard the second. */
export const MESSAGE_MERGE_POLICY = 'key_strict_fifo'

/**
 * Where a job goes after it has exhausted its retries.
 *
 * 🔴 GATE 8 EXISTS FOR THIS EXACT ABSENCE. §2559: "the failure is by ABSENCE —
 * a webhook retried zero times and discarded, or a DLQ that never receives
 * anything — and nobody notices for a long time."
 *
 * Measured before this existed: `pgboss.queue.dead_letter` was NULL on all
 * three queues. A call-merge that threw three times was marked `failed`, sat in
 * `pgboss.job` until the deletion window, and `app.dead_letter` never heard
 * about it — so the raw body was unreachable and the admin counter never rose.
 * Every part of that is silent.
 */
export const DEAD_LETTER_QUEUE = 'dead-letter'

/**
 * Everything `pgboss.create_queue` accepts that this product has an opinion
 * about, named the way pg-boss names it.
 *
 * DECLARED RATHER THAN DEFAULTED, and that is §2558's "job-table
 * retention/archival explicitly configured". Every one of these had a default
 * that happened to be survivable; a default that happens to be survivable is
 * not a decision, and the day it changes in a minor version nobody finds out.
 */
export interface QueueSpec {
  readonly name: string
  readonly policy: 'standard' | 'key_strict_fifo'
  readonly retryLimit: number
  readonly retryDelay: number
  readonly retryBackoff: boolean
  readonly expireInSeconds: number
  readonly retentionSeconds: number
  readonly deleteAfterSeconds: number
  readonly deadLetter: string | null
}

const DAYS = 24 * 60 * 60

export const QUEUE_SPECS: readonly QueueSpec[] = [
  {
    name: DISPATCH_QUEUE,
    policy: 'standard',
    // A cron tick. Retrying it is nearly pointless — the next tick is a minute
    // away and does the same work — so it gets ONE retry for a transient blip
    // and no dead letter: a tick that failed carries no payload anybody could
    // replay, and dead-lettering it would fill the operator's screen with rows
    // whose remedy is "wait sixty seconds".
    retryLimit: 1,
    retryDelay: 5,
    retryBackoff: false,
    expireInSeconds: 120,
    retentionSeconds: 2 * DAYS,
    deleteAfterSeconds: 1 * DAYS,
    deadLetter: null,
  },
  {
    name: CALL_MERGE_QUEUE,
    policy: CALL_MERGE_POLICY,
    // 🔴 THREE RETRIES WITH BACKOFF, AND THE BACKOFF IS THE POINT. The measured
    // default was `retry_delay = 0` with `retry_backoff = false`: three attempts
    // in the same millisecond, which is not a retry policy, it is one failure
    // reported three times. A merge fails on a transient lock or a pool
    // exhaustion, and both need TIME rather than immediacy.
    retryLimit: 3,
    retryDelay: 5,
    retryBackoff: true,
    expireInSeconds: 300,
    retentionSeconds: 14 * DAYS,
    deleteAfterSeconds: 7 * DAYS,
    deadLetter: DEAD_LETTER_QUEUE,
  },
  {
    name: MESSAGE_MERGE_QUEUE,
    policy: MESSAGE_MERGE_POLICY,
    retryLimit: 3,
    retryDelay: 5,
    retryBackoff: true,
    expireInSeconds: 300,
    retentionSeconds: 14 * DAYS,
    deleteAfterSeconds: 7 * DAYS,
    deadLetter: DEAD_LETTER_QUEUE,
  },
  {
    name: DEAD_LETTER_QUEUE,
    policy: 'standard',
    // NO DEAD LETTER OF ITS OWN, and no retries either. A dead letter for the
    // dead-letter queue is a loop, and a handler whose whole job is to record a
    // failure has nothing useful to do on its second attempt.
    //
    // Held THIRTY DAYS rather than fourteen: this is the row an operator reads
    // weeks later when somebody asks what happened to a call, and it outlives
    // the job it describes on purpose.
    retryLimit: 0,
    retryDelay: 0,
    retryBackoff: false,
    expireInSeconds: 120,
    retentionSeconds: 30 * DAYS,
    deleteAfterSeconds: 30 * DAYS,
    deadLetter: null,
  },
]
