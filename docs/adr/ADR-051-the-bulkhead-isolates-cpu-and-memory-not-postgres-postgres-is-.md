# ADR-051 — ADR-S3: The bulkhead isolates CPU and memory, not Postgres — Postgres is protected by a read-free ingest path plus per-source metering

**Status:** accepted (Phase 5, pending GATE 5)

## Context

The dedicated ingest service exists so a 333 req/s webhook recovery storm cannot starve the 50-seller polling floor. But all three roles share one managed Postgres, so process isolation does not by itself isolate the database, and a naive reading of the bulkhead would assume it does.

## Options considered

(a) Accept the shared-database contention and hope the burst is short. (b) Add a second database or a read replica for the board (breaks the budget and ARR-OPS-04's single-region single-instance permission). (c) Make the ingest path structurally incapable of contending: read-free, join-free, three INSERTs into append-mostly partitioned tables plus one pg-boss send, touching no index the board reads, plus a per-source rate meter incremented inside the same SECURITY DEFINER function that resolves the token.

## Decision

(c), and state the limitation explicitly rather than let 'bulkhead' imply more than it delivers. The ingest handler never merges (the merge has exactly one home: the pg-boss queue call-merge with singletonKey = aloware_call_id), never parses business meaning and never touches the domain. Its index footprint (webhook_provider_uidx, vault_intake_uidx) does not intersect the board's (opportunity_board_idx).

## Consequences

A storm consumes ingest CPU and roughly 1,000 INSERT/s of Postgres write throughput on partitioned tables, but holds no long locks and evicts nothing the board depends on. There is no way to perform the intake token lookup without metering it, because there is no other way to perform the lookup. The residual risk — shared Postgres CPU during a storm — is what Gate 2 measures, and it is measured with the polling floor running concurrently, not in isolation.
