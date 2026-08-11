/**
 * The ingest bulkhead: a concurrency limiter that QUEUES, and never sheds.
 *
 * 🔴 THE COMPENDIUM SAYS "429/503" IN FOUR PLACES AND A MEASUREMENT OVERRULES
 * ALL OF THEM. §885 ("returns 429/503 to the provider, which retries — a
 * correct outcome"), §1702, §2434 and ADR-035 all describe shedding load. Every
 * one of them rests on the same premise: that a rejected delivery comes back.
 *
 * Gate 2 measured that it does not. `docs/sprint-0/g2-aloware.md:45` — six
 * deliveries answered `500`, three hours, ZERO redeliveries. Delivery is "at
 * most once, no recovery". And `:53` — the provider tolerates at least
 * **110,023 ms** of silence without hanging up.
 *
 * So the two halves invert. `g2-aloware.md:300` states the corrected rule
 * outright: *"when the edge is under pressure, the right behaviour is queue,
 * block, and take the time — never shed load, never return non-2xx, never
 * rate-limit."* Being slow is nearly free; failing fast is permanent loss
 * delivered promptly. A 429 here is a lost webhook with a status code on it,
 * and Gate 6's own failure criterion is "any webhook lost".
 *
 * `05c`:905 says the same thing from the other side: Gate 2 asserts ZERO 429 on
 * the webhook surface. So Gate 6's "429 count" assertion is not unbuildable —
 * it has a subject, and the correct value is zero.
 *
 * WHAT THIS ACTUALLY BUYS, MEASURED RATHER THAN ARGUED. Gate 6 was run twice
 * minutes apart, same machine, same storm, with only the bound changed:
 *
 *              bound 8      bound 64 (effectively off)
 *   ingest p95   220 ms        603 ms
 *   FLOOR p95     59 ms        576 ms   <- the 304 budget is 80 ms
 *   wall          82 s         119 s
 *   throughput   244/s         168/s
 *
 * So bounding concurrency is not a cost paid for observability — it is the only
 * thing keeping the seller's board inside its budget while the provider
 * retries. Unbounded, the floor misses the 80 ms line by seven times and the
 * storm takes LONGER to absorb, because 20 000 deliveries contending for eight
 * pool connections spend their time queueing invisibly instead of queueing
 * where somebody can see it.
 *
 * The secondary benefit is the one that reads like the point and is not: the
 * pool's own queue is invisible — you cannot ask it how deep it is or how long
 * anything waited. This one has a number attached, and the number is what the
 * saturation alert reports.
 */

/** How many deliveries may be in the database at once. */
const DEFAULT_PERMITS = 8

/**
 * How long a delivery may wait before it is reported as throttling.
 *
 * NOT A REJECTION DEADLINE — nothing is ever rejected. Crossing it means the
 * edge is saturated and an operator should be told; the delivery still waits,
 * still gets written, and still answers 2xx.
 *
 * Well under the 110 s the provider was measured to tolerate, and well under
 * it on purpose: this is the point where we want a human to know, not the point
 * where the provider gives up.
 */
const DEFAULT_SLOW_WAIT_MS = 5_000

function positiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback
  // `Number.parseInt` rather than `Number(`, which the money guard bans outside
  // `app/lib/money/**` — an environment variable is exactly the untrusted
  // string it exists to keep away from arithmetic.
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

export interface IngestSaturation {
  /** Deliveries currently inside the database call. */
  readonly inFlight: number
  /** Deliveries waiting for a permit right now. */
  readonly queued: number
  /** The deepest the queue has been since the last read. */
  readonly peakQueued: number
  /** How many waited longer than the slow threshold since the last read. */
  readonly slowWaits: number
  /** The longest any delivery waited, in ms, since the last read. */
  readonly maxWaitMs: number
  /**
   * Deliveries REFUSED for capacity. Structurally always zero — there is no
   * code path that refuses one — and reported anyway, because Gate 6 asks for
   * the number and "the number is zero" is an answer while silence is not.
   */
  readonly shed: number
}

class IngestSemaphore {
  private readonly permits: number
  private readonly slowWaitMs: number

  private inFlight = 0
  private readonly waiting: (() => void)[] = []

  private peakQueued = 0
  private slowWaits = 0
  private maxWaitMs = 0

  constructor(permits: number, slowWaitMs: number) {
    this.permits = permits
    this.slowWaitMs = slowWaitMs
  }

  /**
   * Runs `fn` with a permit held, waiting FIFO for one.
   *
   * FIFO and not a set, because order is the difference between a queue and a
   * lottery: under sustained pressure a non-ordered wait starves whichever
   * delivery is unlucky, and starvation past 110 s is the one way this design
   * could still lose a webhook.
   */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    const queuedAt = performance.now()

    if (this.inFlight >= this.permits) {
      this.peakQueued = Math.max(this.peakQueued, this.waiting.length + 1)
      await new Promise<void>((resolve) => this.waiting.push(resolve))
    }

    const waited = performance.now() - queuedAt
    if (waited > this.maxWaitMs) this.maxWaitMs = waited
    if (waited > this.slowWaitMs) this.slowWaits += 1

    this.inFlight += 1
    try {
      return await fn()
    } finally {
      this.inFlight -= 1
      // Hand the permit to the next waiter rather than letting everyone race
      // for it. `shift()` is what makes the queue FIFO.
      const next = this.waiting.shift()
      if (next !== undefined) next()
    }
  }

  /** Reads the counters and resets the windowed ones. */
  drain(): IngestSaturation {
    const snapshot: IngestSaturation = {
      inFlight: this.inFlight,
      queued: this.waiting.length,
      peakQueued: this.peakQueued,
      slowWaits: this.slowWaits,
      maxWaitMs: this.maxWaitMs,
      shed: 0,
    }
    this.peakQueued = this.waiting.length
    this.slowWaits = 0
    this.maxWaitMs = 0
    return snapshot
  }
}

const semaphore = new IngestSemaphore(
  positiveInt(process.env['INGEST_MAX_CONCURRENT'], DEFAULT_PERMITS),
  positiveInt(process.env['INGEST_SLOW_WAIT_MS'], DEFAULT_SLOW_WAIT_MS),
)

/**
 * Admits one delivery through the bulkhead.
 *
 * There is no second argument and no options object, deliberately: a caller
 * that could ask for "don't wait" would be a caller that can shed, and the one
 * thing this module exists to guarantee is that nobody can.
 */
export async function admitDelivery<T>(fn: () => Promise<T>): Promise<T> {
  return semaphore.run(fn)
}

/** Reads and resets the saturation counters. Called by the monitor. */
export function drainSaturation(): IngestSaturation {
  return semaphore.drain()
}
