import { sql } from 'drizzle-orm'
import { char, check, index, primaryKey, text } from 'drizzle-orm/pg-core'

import { ref } from './_shared'

/**
 * The lead-local timezone data, in Postgres rather than in a file in the image.
 *
 * §SEC-9 gives the reason and it is not convenience: the gate is a SQL function
 * evaluated inside the request transaction, and `AT TIME ZONE` against the
 * database's live `tzdata` is the evaluator. A JavaScript offset computation
 * over a bundled JSON file would be a SECOND implementation of the same rule,
 * and drift between them is invisible — the board is right almost always and
 * wrong for a handful of leads on the two DST transition days a year.
 *
 * ONE ROW PER (key, tz) PAIR, and that is the sharp part of the design. A ZIP
 * or a state that spans two zones cannot be collapsed to one answer, because
 * the intuitive collapse is wrong in one direction of the day: for a ZIP
 * straddling Eastern and Central, choosing Eastern closes the window early in
 * the evening (conservative) and opens it before 9:00 AM Central (permissive).
 * Choosing Central inverts both errors. No single zone is conservative at both
 * ends, so the resolver returns a CANDIDATE SET and the window is the
 * INTERSECTION — legal in every member or not at all.
 */

/**
 * ZIP → IANA zone. ~41k rows when seeded.
 *
 * EMPTY IN THIS MIGRATION, deliberately. §SEC-9 rules that only redistributable
 * public-domain sources may be used — Census ZCTA relationship files joined to
 * IANA `tzdata` — with a generator that emits its source URLs and checksums and
 * a CI check that the committed file's header matches them. Writing 41,000 rows
 * from memory would be a plausible-but-wrong dataset feeding a HARD BLOCK, which
 * is the exact failure this project is built to refuse.
 *
 * Empty is safe rather than broken: a miss falls through to the area code and
 * then to the state, and an unresolved chain fails CLOSED.
 */
export const zipTimezone = ref.table(
  'zip_timezone',
  {
    zip5: char('zip5', { length: 5 }).notNull(),
    tz: text('tz').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.zip5, t.tz] }),
    check('zip_timezone_zip5_is_digits', sql`${t.zip5} ~ '^[0-9]{5}$'`),
    index('zip_timezone_zip5_idx').on(t.zip5),
  ],
)

/**
 * NANPA area code → IANA zone. ~340 rows when seeded.
 *
 * ALSO EMPTY, and for a second reason on top of provenance: this layer is
 * **wrong for ported mobiles**, which are common in the final-expense lead
 * market — a consumer who moved New York to Florida keeps their 718 number.
 * §SEC-9 therefore fixes its confidence at `low`, ALWAYS, never `high` under
 * any circumstance.
 *
 * A partially-seeded table here would be worse than an empty one: a miss falls
 * through to the state and stays conservative, while a wrong hit produces a
 * confident wrong answer that shortens nobody's window and lengthens somebody's.
 */
export const areaCodeTimezone = ref.table(
  'area_code_timezone',
  {
    npa: char('npa', { length: 3 }).notNull(),
    tz: text('tz').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.npa, t.tz] }),
    check('area_code_timezone_npa_is_digits', sql`${t.npa} ~ '^[2-9][0-9]{2}$'`),
  ],
)

/**
 * State → IANA zone. 51 rows plus one per straddle. SEEDED.
 *
 * The one layer that can be written correctly without a generated dataset:
 * it is small, stable, and the multi-zone states are a named list rather than a
 * boundary computation.
 */
export const stateTimezone = ref.table(
  'state_timezone',
  {
    stateCode: char('state_code', { length: 2 }).notNull(),
    tz: text('tz').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.stateCode, t.tz] }),
    check('state_timezone_code_is_alpha', sql`${t.stateCode} ~ '^[A-Z]{2}$'`),
  ],
)
