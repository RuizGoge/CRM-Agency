---
name: story-to-test
description: Turn a Given/When/Then acceptance criterion from docs/03-mvp-stories.md into an executable test at the right level. Use when starting a story and before calling one done. Exists because acceptance criteria that stay prose are how a Definition of Done quietly becomes an opinion.
---

# From story to executable test

There are 43 stories and their acceptance criteria are the Definition of Done. A criterion that is never executed is a claim, not a check.

## 1 · Pick the level, and justify it

- **Unit** — pure domain logic: money, period keys, stage-type rules, timezone resolution. Fast, exhaustive, no database.
- **Integration** — anything involving the database, which is most of it, because in this project the database is the enforcer. Run against a real Postgres, never a mock: a mock cannot refuse a write the way a policy does, so a mocked test of an RLS rule proves nothing.
- **E2E** — only for the flows a seller actually performs end to end, and for the ten protected demo assertions.

Default to integration. The failures this project fears live in the seam between the query and the policy, and that seam does not exist in a unit test.

## 2 · Translate honestly

`Given` becomes fixture state · `When` becomes one action through the **real path** · `Then` becomes the assertions.

Two rules that decide whether the test is worth anything:

- **Assert the observable, not the implementation.** "The board shows the new total" beats "the projection function was called".
- **Assert the negative too.** Most defects in this system are things that should _not_ have happened: no second ledger row, no event emitted, no job enqueued, no row visible to the other seller. A test that only checks the happy path passes on the broken version.

## 3 · The silo assertion belongs in the test, not in a separate suite

Any story touching a record gets a second-session leg: **Seller B attempts the same thing and receives not-found.** If the endpoint takes no record id, build the two-seller fixture with colliding names, phones and emails and assert zero rows.

## 4 · Money assertions are exact

Never approximate, never rounded, never a float comparison. Assert the exact cents. Where annualisation is involved, use a premium that would drift under floating-point arithmetic — that is the test that would have caught the defect.

## 5 · Protected assertions

The ten demo items carry named assertion ids. Those may **never** be skipped, and no story that maps to one is done while its assertion is skipped. If an assertion cannot be written yet, say so explicitly rather than marking the story done.

## Done when

Every acceptance criterion of the story has an executing assertion · the negative cases are asserted · the silo leg exists · `npm run verify` green.
