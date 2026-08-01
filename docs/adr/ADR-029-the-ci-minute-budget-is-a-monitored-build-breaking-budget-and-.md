# ADR-029 — ADR-T8 — The CI minute budget is a monitored, build-breaking budget, and the matrix is split from the first commit

**Status:** accepted (Phase 5, pending GATE 5)

## Context

GitHub Actions Free provides 2,000 minutes/month on a private repository, with no payment method on file so that exhausting the quota blocks usage rather than generating an invoice. The full ARR-UX-24 matrix runs 25–35 minutes; at a merge frequency that vibecoding makes high by definition, an unsplit matrix consumes 2,400–2,800 minutes. The failure mode is not a bill — it is that on the day the quota runs out, every build-breaking gate in this specification turns off simultaneously, silently, with nobody deciding it.

## Options considered

(a) Unsplit matrix, accept the overage by loading a payment method. (b) Unsplit matrix gated behind a PR label. (c) Split matrix: a fast pre-merge tier and heavy nightly/weekly/monthly tiers, with the minute budget itself monitored.

## Decision

Option (c). Pre-merge is two jobs (fast ≈3 min: types, lints, unit, property, size-limit, contrast, ICU; db ≈5 min: Testcontainers, migrations, harden, schema gates S1–S15, silo/ledger/dedupe/gate suites), billed ≈9 min per run at ≈120 runs/month. Nightly (≈25 min, gated on 'main moved') carries Lighthouse, full Playwright over both topologies, k6, axe, keyboard, rAF and heap. Weekly (≈12 min) carries replay-twice, v1 payload replay, pg-boss DLQ stress and the three rehearsals. Monthly (≈20 min) carries the restore drill. Committed total ≈1,648 minutes with ≈352 in reserve. A quota watchdog in the nightly reads the billing API and fails the nightly at 120 % of straight-line pace. timeout-minutes is set on every job; concurrency cancel-in-progress is set on PR branches; push-to-main does not re-run the matrix. macOS and Windows runners are lint-banned, as is any scheduled workflow outside the literal allowlist.

## Consequences

The gates stay on. Feedback on a PR is ≈5 minutes rather than ≈30. The cost is that a performance regression is caught nightly rather than pre-merge, which is acceptable because performance regressions are cumulative while correctness regressions are not — and the pre-merge tier carries every correctness gate. Two parallel pre-merge jobs rather than four is a deliberate trade: private-repo billing is per job-minute, so every extra parallel job pays its own checkout and install.
