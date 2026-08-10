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
