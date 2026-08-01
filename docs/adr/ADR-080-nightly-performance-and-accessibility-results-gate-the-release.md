# ADR-080 — ADR-G2 — Nightly performance and accessibility results gate the release, not the merge

**Status:** accepted (Phase 5, pending GATE 5)

## Context

R6 says the budgets 'fail the build, not a dashboard' and ARR-UX-16 is gate-blocking. The 2,000-minute CI budget cannot run Lighthouse, k6, axe over ten screens x four states and rAF sampling on every pull request. The design's answer is 'nightly', and a nightly failure blocks nothing, so both requirements are unsatisfied in practice.

## Options considered

_(see Context; the rejected alternative is named inline)_

## Decision

Merge-time gates stay in the pre-merge tier. Perf and accessibility become RELEASE gates: the nightly records its green commit in ref.ci_ratchet, and the pre-deploy migration job's first statement asserts that the commit being deployed has an ancestor in that set younger than 48 hours, exiting non-zero otherwise so harden() never runs and the old image stays live. The single break-out (PERF_GATE_OVERRIDE) writes an admin_alert that cannot be acknowledged until a green nightly lands.

## Consequences

Positive: 'fails the build' becomes true in the only sense that matters — the regression cannot reach production — without spending minutes the budget does not have; and a deploy that will not proceed cannot be amended, unlike a CI check. Negative: a hotfix during a red nightly requires the override, which leaves a visible red line on the admin health page until the nightly is fixed. That is the intended cost.
