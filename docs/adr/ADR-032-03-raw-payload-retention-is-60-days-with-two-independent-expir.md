# ADR-032 — ADR-SEC-03 · Raw payload retention is 60 days, with two independent expiry mechanisms and an inverse liveness check

**Status:** accepted (Phase 5, pending GATE 5)

## Context

ARR-PRV-02 requires PII-bearing raw bodies on a short clock separate from the long clock of the derived record, and records 30-90 days as unresolved. raw_payload_vault.purge_after is NOT NULL and the table is monthly-partitioned with a two-stage residence (Postgres first for write-first durability, then R2). Raw bodies are the dominant storage-cost line and provider storage cannot be shrunk once grown.

## Options considered

(a) 30 days — cheapest, most aggressive minimization. (b) 60 days. (c) 90 days — maximum replay headroom. Orthogonally: purge by scheduled job only, or by job plus an independent R2 lifecycle rule.

## Decision

60 days, written into purge_after at INSERT, with expiry implemented BOTH by app.retention_purge() dropping monthly partitions AND by an independent R2 lifecycle rule on the offloaded objects. Plus an inverse assertion: a scheduled check that the oldest live vault partition is younger than 60 days plus one partition width, raising a critical admin_alert otherwise. Legal hold in the MVP is system_constant['retention_purge_paused'], a global pause honoured by the purge function that raises a daily admin_alert while set; a per-subject legal_hold table is V1.1.

## Consequences

POSITIVE: 60 days survives the specific bug class ARR-INT-08 names as silent — a bad field map or a silent reconciliation gap presents as 'the cold badges are sometimes wrong', which takes time to become a diagnosis, and 30 days routinely expires the evidence first. It avoids doubling the only monotonic cost line for recovery value that does not exist, since a mapping bug undiscovered at 60 days is fixed forward, not by replay. Redundant expiry is correct here specifically because the failure mode is keeping PII too long. NEGATIVE: a mapping bug discovered past 60 days is unrecoverable from raw bodies. The global legal hold is coarse — it pauses all purging, not one subject — and is stated as a limitation rather than dressed up. Retention silently stopping produces no error, no user complaint and no metric movement, which is why the inverse check exists and why it is the only thing that would catch it.
