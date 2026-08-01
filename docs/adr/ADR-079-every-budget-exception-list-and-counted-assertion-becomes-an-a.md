# ADR-079 — ADR-G1 — Every budget, exception list and counted assertion becomes an append-only row in Postgres, not a literal in a file

**Status:** accepted (Phase 5, pending GATE 5)

## Context

The adversarial review's systemic finding is that roughly a third of the declared mechanisms reduce to 'the model edits the literal and the build goes green'. The phrase 'a PR that touches that file and nothing else' is used as enforcement at least three times and presumes a human reviewer that this project does not have. perf-budgets.json, the inline-consumer count, the RLS exception list, the destructive-migration allowlist and the v1 fixture set are all in this shape.

## Options considered

_(see Context; the rejected alternative is named inline)_

## Decision

Introduce ref.ci_ratchet(name, direction ∈ {monotonic_down, monotonic_up, frozen_set}, value_num, value_set, set_by_run, set_at), immutable by the same statement-level AP001 trigger and REVOKEs that protect earnings_ledger, with a BEFORE INSERT trigger that refuses a loosening write (a larger value on a monotonic_down name, a set that is not a superset on a frozen_set name). CI connects as crm_ci holding INSERT and SELECT only and compares the repository's committed values to the ratchet BEFORE running any test. Loosening requires crm_migrator and a migration.

## Consequences

Positive: the enforcement of every budget and every exception list is moved from a diff a nobody reads to an engine that refuses. The failure message names the loosened value explicitly. Negative: a legitimate budget change now requires a migration, which is friction on purpose. The ratchet is only as strong as the separation of crm_migrator credentials, which ADR-S4 and SEC-3 already establish.
