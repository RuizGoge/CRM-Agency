import { sql } from 'drizzle-orm'
import { check, text } from 'drizzle-orm/pg-core'

import { app, ref } from './_shared'

/**
 * The latency axis. `05c` §11.7.
 *
 * 🔴 WHY IT EXISTS, in §2367's own words: `weight ∈ {light, heavy}` is a **CPU**
 * axis with no latency axis, so during the 20,000-message replay the
 * architecture itself sizes, **a TCPA STOP is job 14,000 in a FIFO drain**.
 * `ARR-EVT-13` is explicit that delay here is a LEGAL failure and not a UX
 * degradation. 0069 made a STOP suppress; this is what makes it suppress in
 * time.
 */
export const jobPriority = app.enum('job_priority', ['compliance', 'interactive', 'bulk'])

/**
 * One row per queue. The worker DERIVES its lanes from this table and from
 * nothing else (§2394).
 *
 * A constant in `worker.ts` would be a second table of truth, and its
 * disagreement with the first is silent in the worst way: a queue classified
 * `compliance` here and drained by the bulk loop in the file looks perfectly
 * healthy and is merely late.
 *
 * `reference`, no tenant dimension, and **immutable** — §2407 requires that
 * moving a queue between lanes cost a migration that drops a protected trigger,
 * rather than being a row edit nobody sees.
 */
export const jobRegistry = ref.table(
  'job_registry',
  {
    queueName: text('queue_name').primaryKey(),

    /**
     * NOT NULL with NO DEFAULT, which is the mechanic §2382 asks for in the same
     * words `weight` already uses: unclassified must be impossible to express
     * rather than possible and discouraged. Any default would make "somebody
     * forgot" a silent `bulk`, and the one job where that is fatal is the STOP.
     */
    priority: jobPriority('priority').notNull(),

    /**
     * Generated, so the lane and the priority cannot drift apart.
     *
     * ⚠️ Spelled as a CASE rather than `'lane_' || priority::text`, which is
     * what §11.7.1 prints and what Postgres refuses — the enum-to-text cast is
     * STABLE, not IMMUTABLE, and a generation expression must be immutable.
     */
    lane: text('lane').generatedAlwaysAs(
      sql`CASE priority WHEN 'compliance' THEN 'lane_compliance' WHEN 'interactive' THEN 'lane_interactive' WHEN 'bulk' THEN 'lane_bulk' END`,
    ),

    /** Why this queue sits in this lane. Read the day somebody reclassifies one. */
    rationale: text('rationale').notNull(),
    registeredInMigration: text('registered_in_migration').notNull(),
  },
  (t) => [
    check('job_registry_queue_present', sql`length(btrim(${t.queueName})) > 0`),
    check('job_registry_rationale_present', sql`length(btrim(${t.rationale})) > 20`),
  ],
)
