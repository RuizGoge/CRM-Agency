# ADR-001 — ADR-E1 — Transactional emission with tiered delivery over a Postgres outbox; pg-boss is the timer, not the bus

**Status:** accepted (Phase 5, pending GATE 5)

## Context

02b §8.5 deferred "in-process dispatcher vs. durable queue" to Phase 5, requiring only that replayability and idempotency hold either way. ARR-EVT-06 requires the gate check, stage write and ledger append to commit as one unit exactly-once; ARR-EVT-32 says the hottest events carry 7-9 consumers that cannot sit on the request path; ARR-EVT-14 and ARR-EVT-13 name specific losses (a robot texting a lead who sent STOP) that an in-memory handler produces on a crash; ARR-EVT-21 requires replay from an all-time store, which no broker retention window can provide.

## Options considered

(a) Pure in-process dispatcher over a persisted event table. (b) Durable queue (pg-boss) as the primary event transport, with the ledger as a queue consumer. (c) External broker. (d) Transactional emission in the same transaction as the state change, with delivery tiered across inline / outbox / pg-boss.

## Decision

(d). Emission is always synchronous, in-process, and inside the emitting transaction: one transaction writes the state change, the event_log row, and one event_outbox row per registered post-commit consumer. Delivery is tiered by a per-(consumer, event) declaration. pg-boss receives jobs, never events; the outbox owns fan-out and pg-boss owns time (delays, schedules, singleton serialization). No broker.

## Consequences

The enqueued-but-rolled-back and delivered-twice failure modes are structurally absent from the money path. Fan-out survives process death because the outbox row committed with the event. The API p95 budget on the close gate is spent on ~8 statements rather than 8 handlers. Cost: a relay loop must exist and be sized, event_outbox becomes a high-volume daily-partitioned table, and the claim/deliver protocol must be written correctly once (claim in tx1, handle+mark in tx2 together, stale-claim reaper). Rejecting (b) also means pg-boss's retry semantics — the exact place its 9.x/10.x-to-12.x version drift bites — govern only the small, enumerable set of pgboss-delivery consumers, not the whole system.
