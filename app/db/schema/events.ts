import { boolean, integer, primaryKey, smallint, text } from 'drizzle-orm/pg-core'

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
 * How a consumer is reached, and the reason a sale is credited once.
 *
 * `inline` ran INSIDE the emitting transaction and must never receive a fan-out
 * row — `app.stage_move` already appends to the ledger itself, so an outbox row
 * for `earnings` would ask the relay to credit the same sale a second time. The
 * ledger is append-only with no recompute job, so that second credit would be
 * permanent and the first symptom would be a public leaderboard reading double.
 *
 * Migration 0051 adds the column and `app.event_emit` filters the fan-out on it.
 */
export const deliveryTier = app.enum('delivery_tier', ['inline', 'outbox', 'pgboss'])

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

    /**
     * NO DEFAULT, on purpose — 0051 drops the one it used to backfill. A
     * migration that seeds a consumer has to NAME the tier, because the value
     * decides whether a delivery happens twice.
     */
    delivery: deliveryTier('delivery').notNull(),

    /**
     * The retry ladder is a PER-CONSUMER column and never a global constant
     * (ADR-009): a projection update and a text message to a lead cannot share
     * one, because retrying the second is a second message to a real person.
     */
    maxAttempts: smallint('max_attempts').notNull(),
    backoffSeconds: integer('backoff_seconds').array().notNull(),

    /**
     * True when delivery touches the world outside this database. A CHECK ties
     * it to `max_attempts = 1` until a provider idempotency key exists to make
     * a retry safe.
     */
    externalEffect: boolean('external_effect').notNull(),

    /**
     * Whether a handler for this consumer exists in the tree.
     *
     * `05-architecture.md`:826 rules that a registry row with no exported
     * handler fails the build. Nineteen consumers are declared and three
     * modules exist, so applying that literally today reddens the build in
     * seventeen places. 0052 keeps the rule and makes the timing honest: the
     * gap is a COLUMN, the fan-out reads it, and `outbox-relay.test.ts` asserts
     * in both directions that it agrees with the relay's handler registry.
     *
     * The event is still written to `event_log` in full — only the delivery is
     * withheld — so a consumer built later can be backfilled from the store.
     */
    handlerBuilt: boolean('handler_built').notNull(),
  },
  (t) => [primaryKey({ columns: [t.consumerName, t.eventName] })],
)
