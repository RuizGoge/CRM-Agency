# ADR-024 — ADR-T3 — Latency budgets are enforced relatively in CI and absolutely in production

**Status:** accepted (Phase 5, pending GATE 5)

## Context

ARR-UX-24 requires nineteen budgets to fail the build against fixed profiles. Shared GitHub Actions runners have variable CPU, so absolute millisecond thresholds for CPU-sensitive budgets (P5 interaction feedback, P6 drag frames, P7 API p95, P14 win gate, P15 dial verdict) flake. Self-hosted runners would give determinism but a self-hosted runner is a server to administer, which the platform decision forbids. The worst possible outcome of a flaky budget is that the gate gets disabled, which removes the protection entirely.

## Options considered

(a) Absolute thresholds on shared runners, accepting flakiness. (b) A self-hosted runner. (c) A fixed-size preview service on the platform, created and destroyed per run, as the k6 target. (d) Calibration-relative thresholds in CI plus absolute enforcement from production telemetry.

## Decision

Option (d). A fixed CPU-bound plus Postgres-bound micro-benchmark is committed to the repo and run at the start of each performance job; CPU-sensitive budgets are enforced as measured × (reference_calibration / this_run_calibration) ≤ budget. Separately, the same fourteen endpoints are measured absolutely in production from Axiom over a rolling window, with a Better Stack alert on breach. CI's job is to catch regression; production's job is to prove the budget. The published table in §8 carries the absolute product contract; both surfaces read the same perf-budgets.json.

## Consequences

CI stops flaking, so the gates survive. The absolute numbers become true statements about the product rather than about a runner. The cost is that a regression which is uniform across both calibration and measurement could pass CI — mitigated by the production alert and by the trend check that fires on five consecutive in-budget regressions. Option (c) is not adopted because it needs a Postgres the ladder does not fund at Escalón 1.
