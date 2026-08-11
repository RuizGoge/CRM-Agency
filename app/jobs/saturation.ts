import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks'

import { raiseProcessAlert } from '~/db'
import { drainSaturation } from '~/lib/ingest/semaphore'

/**
 * The event-loop monitor, and the third of Gate 6's four missing subjects.
 *
 * §2444's table is the specification and it is exact:
 *
 *   | SSR + API p95 (shared event loop) | `perf_hooks.monitorEventLoopDelay`
 *     histogram sampled per process; **p99 > 200 ms sustained 60 s** ->
 *     `admin_alert(kind='folded_topology_saturated')` |
 *     `/admin/integration-health`, with the literal remediation:
 *     "Split the processes." |
 *
 * WHY THIS IS THE MEASUREMENT THAT MATTERS. Folded, the ingest surface, the SSR
 * render and the poll floor share ONE event loop (§882). Every other signal
 * this product has is per-request and per-tenant; loop delay is the only one
 * that sees the process itself. Gate 6 measured the folded leg holding at
 * p95 12.25 ms under a 333/s storm — this is what notices the day it stops.
 *
 * §2550's failure criterion is what makes it load-bearing rather than nice:
 * in the folded tier "degradation is ALLOWED; degradation that is SILENT is
 * not." Without this the process degrades and nothing anywhere says so.
 */

/** §2444, literally. Not a number chosen here. */
const P99_THRESHOLD_MS = 200

/** §2444's "sustained", literally. One spike is not saturation. */
const SUSTAINED_MS = 60_000

/**
 * How often the histogram is read and folded into the sustained window.
 *
 * Five seconds, so "sustained 60 s" is twelve consecutive observations rather
 * than an interpolation between two.
 */
const SAMPLE_INTERVAL_MS = 5_000

/**
 * The histogram's sampling floor, in milliseconds.
 *
 * 10 ms is Node's default and it is the right one here: the threshold is
 * 200 ms, so a resolution twenty times finer than the thing being detected
 * costs nothing and leaves no ambiguity about which side of the line a sample
 * fell on. The sampling runs in C++ on a libuv timer, so it does NOT enqueue
 * work on the loop it measures.
 */
const RESOLUTION_MS = 10

let histogram: IntervalHistogram | null = null
let timer: NodeJS.Timeout | null = null
let breachedSinceMs: number | null = null
let stopped = false

/** Exposed so the gate harness and the tests can read the same numbers. */
export interface SaturationSample {
  readonly loopP99Ms: number
  readonly loopMaxMs: number
  readonly breachedForMs: number
  readonly alerted: boolean
}

let last: SaturationSample = {
  loopP99Ms: 0,
  loopMaxMs: 0,
  breachedForMs: 0,
  alerted: false,
}

export function lastSaturationSample(): SaturationSample {
  return last
}

/**
 * Reads one sample and decides whether the sustained condition has been met.
 *
 * Exported for the test: driving this directly is what lets the sustained
 * window be asserted in milliseconds instead of by waiting a real minute.
 */
export async function sampleOnce(nowMs: number): Promise<SaturationSample> {
  if (histogram === null) return last

  // ⚠️ EVERY VALUE OUT OF THIS API IS IN NANOSECONDS. Reading `percentile(99)`
  // as milliseconds gives a number a million times too large, which would fire
  // the alert on the first sample of an idle process — an alert that is always
  // on is the same as no alert, and harder to notice.
  const p99 = histogram.percentile(99) / 1e6
  const max = histogram.max / 1e6
  histogram.reset()

  const ingest = drainSaturation()

  if (p99 > P99_THRESHOLD_MS) {
    breachedSinceMs ??= nowMs
  } else {
    // ANY sample under the line clears the window. "Sustained" means without
    // interruption; a design that kept a running average would let a process
    // that is fine most of the time accumulate its way to an alert.
    breachedSinceMs = null
  }

  const breachedForMs = breachedSinceMs === null ? 0 : nowMs - breachedSinceMs
  let alerted = false

  if (breachedSinceMs !== null && breachedForMs >= SUSTAINED_MS) {
    // The remediation string is §2444's, verbatim, and it is the whole point of
    // the row: an operator reading "the event loop is slow" learns nothing they
    // can act on. "Split the processes" is an action.
    await raiseProcessAlert(
      'folded_topology_saturated',
      `Event-loop p99 ${p99.toFixed(0)} ms (max ${max.toFixed(0)} ms) sustained ` +
        `${Math.round(breachedForMs / 1000)} s, over the ${P99_THRESHOLD_MS} ms budget. ` +
        `Ingest queue peaked at ${ingest.peakQueued} with ${ingest.slowWaits} slow waits ` +
        `(longest ${ingest.maxWaitMs.toFixed(0)} ms) and shed ${ingest.shed}. ` +
        `Split the processes.`,
    )
    alerted = true

    // The window restarts after firing. Without this the alert re-raises on
    // every sample for as long as the condition holds, and `occurrence_count`
    // stops meaning "how many times this happened" and starts meaning "how long
    // it lasted, divided by five seconds".
    breachedSinceMs = nowMs
  }

  last = { loopP99Ms: p99, loopMaxMs: max, breachedForMs, alerted }
  return last
}

function schedule(): void {
  if (stopped) return
  timer = setTimeout(() => {
    void (async () => {
      try {
        await sampleOnce(Date.now())
      } catch (err: unknown) {
        // The monitor must survive its own failures. A monitor that dies on one
        // bad sample leaves a process that looks healthy because nothing is
        // watching — which is worse than the degradation it exists to report.
        console.error(
          '[saturation] sample failed:',
          err instanceof Error ? err.message : String(err),
        )
      } finally {
        schedule()
      }
    })()
  }, SAMPLE_INTERVAL_MS)

  // Never hold the process open on the monitor alone.
  timer.unref()
}

export function startSaturationMonitor(): void {
  if (histogram !== null) return
  stopped = false
  histogram = monitorEventLoopDelay({ resolution: RESOLUTION_MS })
  histogram.enable()
  schedule()
}

export function stopSaturationMonitor(): void {
  stopped = true
  if (timer !== null) {
    clearTimeout(timer)
    timer = null
  }
  if (histogram !== null) {
    histogram.disable()
    histogram = null
  }
  breachedSinceMs = null
}

/** Test seam: drives the sustained window without waiting a real minute. */
export function __forceBreachWindow(startedMs: number): void {
  breachedSinceMs = startedMs
}

/** Test seam: installs a histogram whose percentile is fixed. */
export function __installFakeHistogram(p99Ms: number, maxMs = p99Ms): void {
  histogram = {
    percentile: () => p99Ms * 1e6,
    max: maxMs * 1e6,
    reset: () => undefined,
    enable: () => true,
    disable: () => true,
  } as unknown as IntervalHistogram
}
