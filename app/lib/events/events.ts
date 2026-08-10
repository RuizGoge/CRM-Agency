/**
 * The public surface of the 49-event contract.
 *
 * The catalog itself is generated — see `catalog.generated.ts` and
 * `contracts/events/catalog.json`. This file adds the two things a generator
 * cannot: the runtime refusal for a name that arrives as data, and the error
 * that names the remap instead of just saying no.
 *
 * WHY A RUNTIME CHECK WHEN THE TYPE ALREADY EXISTS. `EventName` makes an
 * invented name a compile error, which covers every event we emit ourselves.
 * It covers nothing that arrives from outside: an Aloware webhook body, a
 * vendor ping-post, a stored job payload replayed after a deploy. Those are
 * `string` until something narrows them, and the whole point of §2's
 * reconciliation is that a name nobody recognises must be loud rather than
 * quietly dropped.
 *
 * No server imports here on purpose — `scripts/client-server-boundary.test.ts`
 * lets a component import this, and a component reading an event name from an
 * SSE frame is exactly the case that needs the narrowing.
 */

import { EVENT_NAMES, GHOSTS } from './catalog.generated'
import type { EventName, Ghost } from './catalog.generated'

export type {
  CanonicalEvent,
  EventEnvelope,
  EventName,
  EventPayloads,
  Ghost,
  JsonValue,
} from './catalog.generated'
export {
  EVENT_CONSUMERS,
  EVENT_EMITTERS,
  EVENT_NAMES,
  GHOSTS,
  MONEY_FIELDS,
} from './catalog.generated'

const CANONICAL: ReadonlySet<string> = new Set(EVENT_NAMES)

/** Narrows an untrusted string to the catalog. */
export function isEventName(value: string): value is EventName {
  return CANONICAL.has(value)
}

/**
 * The ruling against a name, when there is one.
 *
 * A ghost is not merely unknown — it is a name some module was observed waiting
 * for, judged, and ruled out with a reason. `null` means the name was never
 * proposed at all, which is a different and less interesting failure.
 */
export function ghostFor(name: string): Ghost | null {
  return GHOSTS[name] ?? null
}

/**
 * Thrown when a name that is not in the catalog reaches an ingestion path.
 *
 * Carries the remap when the name is a known ghost, because "unknown event
 * `opportunity.closed_won`" and "use `opportunity.won`, or the sale is never
 * celebrated and its tasks are never closed" are very different messages to
 * find in a log at 9pm.
 */
export class UnknownEventError extends Error {
  readonly eventName: string
  readonly ghost: Ghost | null

  constructor(eventName: string) {
    const ghost = ghostFor(eventName)
    const detail =
      ghost === null
        ? 'it is not in the canonical 49'
        : ghost.use === null
          ? `it was deleted from the catalog — ${ghost.consequence}`
          : `use \`${ghost.use}\` — ${ghost.consequence}`
    super(`Unknown event \`${eventName}\`: ${detail}`)
    this.name = 'UnknownEventError'
    this.eventName = eventName
    this.ghost = ghost
  }
}

/** Narrows or throws. The ingestion-path form of `isEventName`. */
export function assertEventName(value: string): asserts value is EventName {
  if (!CANONICAL.has(value)) {
    throw new UnknownEventError(value)
  }
}
