-- P20 GETS A NUMBER, AND GATE 11 CLOSES.
--
-- The name has been registered since 0022 with NO VALUE, on purpose: errata E6
-- makes an unmeasured budget a declared hole rather than a silent one, and
-- `ci-ratchet.test.ts` asserted the hole was still visible by asserting this
-- name had zero value rows. That assertion changes with this migration, which
-- is the whole point of having written it — the hole closes deliberately, in a
-- diff, rather than by nobody noticing it was still open.
--
-- MEASURED: 2251 ms, the median of five runs (2227 2248 2251 2265 2276, a
-- spread of 49 ms) by Lighthouse's `interactive` audit against the PRODUCTION
-- build, on the perf-500 fixture, signed in as the fixture seller, under
-- Lighthouse's unmodified mobile preset — 4x CPU slowdown and a simulated slow
-- 4G link. §8.1 rounds the measurement up to the next 100 ms, so the budget is
-- 2300, inside the 3000 ms ceiling that same section sets. The gate compares
-- the MEDIAN of three runs.
--
-- WHAT WAS ACTUALLY MISSING WAS THE TIER. The row's own `blocked_on` list named
-- the perf-500 fixture, and Gate 12 built that. What did not exist was anything
-- that ran Lighthouse. It now runs inside the e2e suite, on the production
-- server that suite already starts for the drag budget, rather than in the
-- nightly Actions job the row used to promise: §9.4.1 makes the absence of a
-- payment method this project's cost control, so a scheduled job is a gate that
-- gets switched off before it catches anything.
--
-- ⚠️ THIS ONE IS MACHINE-DEPENDENT, and the ratchet makes that sharp. P12 and
-- P13 count bytes and report the same total anywhere; this multiplies observed
-- task durations by four, so a slower runner measures a larger TTI. If this is
-- ever run somewhere slower than where 2300 was measured it goes red, and
-- `monotonic_down` refuses to loosen it. That is the arm working rather than
-- failing: moving a budget onto different hardware should cost a decision.

INSERT INTO ref.ci_ratchet (name, value_num, set_by_run)
SELECT 'perf.P20_mobile_tti_pipeline', 2300, '0028_tti_budget'
WHERE NOT EXISTS (
  SELECT 1 FROM ref.ci_ratchet WHERE name = 'perf.P20_mobile_tti_pipeline'
);
