import { sql } from 'drizzle-orm'
import { bigint, check, integer, primaryKey, text, timestamp } from 'drizzle-orm/pg-core'

import { ratchetDirection, ref } from './_shared'

/**
 * `ref.ci_ratchet` — the anchor that stops a budget from being loosened by
 * editing a file. Created by migration 0022 and DECLARED HERE ONLY NOW.
 *
 * 🔴 This is the reconciliation that mattered. Two tables existed in the
 * database and in no schema file, so `drizzle-kit generate` — which diffs the
 * schema files against the newest snapshot — would have emitted **`DROP TABLE
 * ref.ci_ratchet`**. Against a database whose rule is that there are no down
 * migrations and rollback is the previous image, that is not a diff anybody
 * gets to undo: it would delete the ledger of every measurement the project
 * has ever ratcheted, and the guard that refuses to loosen them.
 *
 * `DBGEN003` stopped the command from running while the chain was behind,
 * which is why this was a debt and not a wound. This file is what pays it.
 *
 * WHAT DRIZZLE DOES NOT SEE, and why that is fine: the arm is enforced by
 * `ref.ci_ratchet_enforce()`, a trigger with six SQLSTATEs, and the append-only
 * refusal by another. Drizzle models tables and columns, not triggers, so
 * those live in migration 0022 and nowhere else. Declaring the tables is what
 * keeps the generator from proposing to remove the things the triggers hang
 * off.
 */

/**
 * The NAME registry. The direction is a property of the name and never of a
 * row — §11.3's finding, because a direction chosen by whoever writes the
 * newest row is a direction chosen by the attacker.
 */
export const ciRatchetName = ref.table(
  'ci_ratchet_name',
  {
    name: text('name').primaryKey(),

    /**
     * No default, deliberately: an unclassified ratchet is impossible rather
     * than merely discouraged. The five arms are `monotonic_down`,
     * `monotonic_up`, `pinned`, `shrink_only` and `sealed_set`.
     */
    direction: ratchetDirection('direction').notNull(),

    registeredInMigration: text('registered_in_migration').notNull(),

    /** A budget nobody could explain is a budget nobody will defend. */
    rationale: text('rationale').notNull(),
  },
  (t) => [check('ci_ratchet_rationale_len', sql`length(btrim(${t.rationale})) >= 20`)],
)

/**
 * The value ledger. Append-only by trigger, to the owner and to a superuser —
 * not only to `crm_app`.
 */
export const ciRatchet = ref.table(
  'ci_ratchet',
  {
    name: text('name')
      .notNull()
      .references(() => ciRatchetName.name),

    /** Numeric arms. Exactly one of the two value columns is ever set. */
    valueNum: bigint('value_num', { mode: 'bigint' }),
    /** Set arms. */
    valueSet: text('value_set').array(),

    /** NOT NULL: a measurement with no run behind it is an assertion. */
    setByRun: text('set_by_run').notNull(),

    setAt: timestamp('set_at', { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (t) => [
    primaryKey({ columns: [t.name, t.setAt] }),
    check('ci_ratchet_set_by_run_len', sql`length(btrim(${t.setByRun})) > 0`),
    // Exactly one shape per row. A row carrying both is a row whose arm is
    // ambiguous, and the trigger would have to guess.
    check('ci_ratchet_one_shape', sql`(${t.valueNum} IS NULL) <> (${t.valueSet} IS NULL)`),
  ],
)

/**
 * `ref.timing_constant` — the SQL representation of the undo window.
 *
 * Created by migration 0009 and, like the ratchet tables, never declared. It
 * holds `undo_deadline_ms` (5000) and `projection_reveal_delay_ms` (5500):
 * two of the four representations Gate 10 keeps in agreement, and the two the
 * constitution says are NEVER given one name. Confusing them either kills
 * every celebration or reveals an undoable win on a public board.
 *
 * Declared here for the same reason as the tables above — a relation Postgres
 * has and the schema files do not is a relation outside the generator's
 * management. It shares this file rather than getting its own because both are
 * `ref` tables that exist to hold ONE number each under a guarantee, which is
 * the only thing they have in common and is enough.
 *
 * The VALUES are not Drizzle's business and stay in 0009: they are seeded with
 * `ON CONFLICT DO UPDATE`, and the drift test compares them against TypeScript
 * and CSS by value.
 */
export const timingConstant = ref.table('timing_constant', {
  key: text('key').primaryKey(),
  valueMs: integer('value_ms').notNull(),
  purpose: text('purpose').notNull(),
})
