/**
 * Search limits, in a module with no server dependencies.
 *
 * 🔴 HERE BECAUSE THE GATE CAUGHT IT — the second time, in the same session.
 * `MIN_QUERY_LENGTH` was first exported from `app/routes/api/search.ts`, next
 * to the query that uses it, and the overlay imported it. That route imports
 * `~/db`, so the browser bundle got postgres again; the symptom this time was
 * `ReferenceError: Buffer is not defined` and a sign-in page that never
 * rendered, on every test in the suite.
 *
 * `scripts/client-server-boundary.test.ts` named the file, the specifier and
 * the fix before the e2e run had finished failing. That is the difference
 * between a gate and a note — the note existed too, in the previous commit's
 * message, and it did not stop me making the same mistake three hours later.
 */

/**
 * Below this many characters the overlay shows `search.idle` and queries
 * nothing.
 *
 * Two, and the reason is the shape of the data rather than taste: a
 * one-character query against a fifty-seller tenant matches most of the book
 * and is a table scan nobody asked for, on the keystroke budget that has to
 * stay under 200 ms.
 */
export const MIN_QUERY_LENGTH = 2
