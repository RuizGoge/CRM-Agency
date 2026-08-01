# ADR-047 — ADR-09 — A late webhook merges into a manual degraded-mode call within a bounded window

**Status:** accepted (Phase 5, pending GATE 5)

## Context

04-ux-flows.md states plainly that after a degraded-mode window a manual entry and a late webhook for the same physical call can both land, and no dedupe rule exists anywhere in the corpus. Left unsolved, the duplicate corrupts attempt_count, last_activity_at, the 7-day cold rule and the rot badges — all of which are inputs to a screen the seller reads every day.

## Options considered

(a) Leave both rows — rejected, it corrupts four derived signals and the seller sees a call logged twice. (b) Ask the seller to reconcile — a manual chore in the middle of an outage, exactly when attention is scarcest. (c) Deterministic time-window merge in the existing call-merge job. (d) Fuzzy matching on talk time or disposition — rejected, non-deterministic and unauditable.

## Decision

Option (c). On a webhook call with no matching aloware_call_id, the merge job looks for a `call` row with source='manual_degraded', the same (tenant_id, contact_id, direction), started_at within ± `system_constant['manual_merge_window_seconds']` (default 600), and merged_manual_call_id IS NULL; it merges into that row rather than inserting. Backed by a partial index so the lookup is bounded to the outage window's rows. The window lives in system_constant, one source, same discipline as the undo window.

## Consequences

attempt_count, last_activity_at and the cold/rot signals stay honest through an outage without asking the seller for anything. Residual, documented rather than hidden: two dials to the same lead inside ten minutes during an outage merge into one. The merged timeline entry reads 'Logged manually · matched to an Aloware call', so the false negative is visible on screen rather than silent.
