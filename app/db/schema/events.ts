import { primaryKey, text } from 'drizzle-orm/pg-core'

import { EVENT_NAMES } from '../../lib/events/catalog.generated'

import { app } from './_shared'

/**
 * The 49 event names, as a Postgres ENUM.
 *
 * THE POINT IS THAT THE DATABASE REFUSES, not that the compiler does. The
 * TypeScript union shipped with the contract already makes an invented name a
 * build error for code we write; it does nothing about a name arriving as data
 * — a webhook body, a replayed job payload, a hand-written INSERT during an
 * incident. An enum column closes that: `event_log.event_name` cannot hold a
 * string the catalog does not contain, at any hour, by any actor.
 *
 * GENERATED FROM THE SAME REGISTRY as the union, so the two cannot drift, and
 * `tests/integration/event-vocabulary.test.ts` asserts `enum_range` matches the
 * registry exactly — in both directions.
 */
/**
 * Taken from the GENERATED module, never re-read from the JSON at runtime.
 *
 * The first version of this file parsed `contracts/events/catalog.json` with
 * `node:fs` at module load, which tied the schema — and therefore the running
 * server — to the process working directory. It happens to work from the repo
 * root and would have failed in the built image, where nothing guarantees the
 * contracts directory is where the process starts.
 *
 * `catalog.generated.ts` is already the artifact the contract gate keeps honest,
 * so importing it means the enum, the TypeScript union and the JSON cannot
 * disagree without `scripts/events-contract.test.ts` going red first.
 */
export const eventName = app.enum('event_name', EVENT_NAMES as unknown as [string, ...string[]])

export const retentionClass = app.enum('retention_class', ['permanent', 'archivable'])

export const outboxStatus = app.enum('outbox_status', ['pending', 'claimed', 'delivered', 'dead'])

/**
 * Which consumer is subscribed to which event.
 *
 * The outbox carries a foreign key to this table, so **a fan-out row for a
 * consumer that does not exist cannot be written**. That is what turns the
 * catalog's `consumers` column from documentation into a constraint: a module
 * that quietly stops consuming an event leaves a row here with nothing behind
 * it, and a module that starts consuming one it never declared cannot receive
 * it at all.
 *
 * `reference` class — it has no tenant dimension, because who listens to what
 * is a property of the system rather than of an agency.
 */
export const eventConsumer = app.table(
  'event_consumer',
  {
    consumerName: text('consumer_name').notNull(),
    eventName: eventName('event_name').notNull(),
  },
  (t) => [primaryKey({ columns: [t.consumerName, t.eventName] })],
)
