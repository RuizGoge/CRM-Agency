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
