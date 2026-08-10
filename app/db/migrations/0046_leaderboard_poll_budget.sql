-- P11 GETS ITS ANCHOR OUTSIDE THE WORKING TREE.
--
-- `04b` §3.2 has published this row since Phase 4 — *"Leaderboard poll cost ·
-- p95 server time for a `304`"*, warn over 40 ms, red over 80 — and nothing in
-- this repository read it. The number lived in a document, which under this
-- project's own rule is documentation and not a mechanism: a test that carries
-- its own ceiling as a constant is a ceiling anybody can raise in the same
-- commit that breaches it.
--
-- 80, NOT THE MEASUREMENT. This is the opposite case to P12, P20 and N13, and
-- the difference is worth stating because the three of them set a precedent
-- that does not apply here. Those numbers did not exist until Sprint 0 measured
-- them, so §8.1 had to derive a budget from the measurement. This one was
-- ratified in Phase 4 and the measurement's job was to find out whether the
-- product was inside it. Registering 14.6 instead would be inventing a stricter
-- rule than the one that was signed, on the strength of one machine.
--
-- MEASURED at **p95 14.6 ms, median 12.6 ms** on `perf-floor` — fifty sellers,
-- 6 400 ledger rows across all four periods — by
-- `tests/integration/leaderboard-poll-perf.test.ts`. That is inside the 40 ms
-- warn, not merely inside the 80 ms red.
--
-- IT WAS 238 ms AN HOUR AGO. Migration 0029 is why: `clock_timestamp()` is
-- VOLATILE, so the reveal-delay predicate was re-evaluated per row and dragged
-- a `ref.timing_constant` lookup with it, six thousand four hundred times per
-- board read. This budget existing is what would have caught that had it been
-- wired first, and it is now wired so the next one does not need a session of
-- someone's curiosity to find.
--
-- `monotonic_down`, like every other row: tighten freely, loosen deliberately.

INSERT INTO ref.ci_ratchet_name (name, direction, registered_in_migration, rationale)
VALUES (
  'perf.P11_leaderboard_304_p95',
  'monotonic_down',
  '0046_leaderboard_poll_budget',
  'Server p95 for a leaderboard 304 on perf-floor (50 sellers, 6400 ledger rows), 04b 3.2 P11. Registered at the RATIFIED 80ms rather than at the 14.6ms measured, because unlike P12/P20/N13 this number was signed in Phase 4 and the measurement was checking compliance, not setting the bar. 1183 assumed 2ms per 304 and built the USD 7/month cost model on it; 14.6ms is the first real figure that assumption has ever been checked against.'
)
ON CONFLICT (name) DO NOTHING;
--> statement-breakpoint

INSERT INTO ref.ci_ratchet (name, value_num, set_by_run)
SELECT 'perf.P11_leaderboard_304_p95', 80, '0046_leaderboard_poll_budget'
WHERE NOT EXISTS (SELECT 1 FROM ref.ci_ratchet WHERE name = 'perf.P11_leaderboard_304_p95');
