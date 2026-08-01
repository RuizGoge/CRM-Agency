# ADR-054 — ADR-S6: The split trigger is a measured tripwire, never a headcount

**Status:** accepted (Phase 5, pending GATE 5)

## Context

'Split when you have more users' is not a mechanism — it has no threshold, no owner and no alarm. The folded rung is a legitimate steady state and may remain so for a long time; the split must be triggered by evidence that the shared 0.5 CPU is actually the constraint.

## Options considered

(a) Split at a seller count. (b) Split on a calendar. (c) Split when one of four named alerts fires, each a query over tables the system already owns and each rendered on /admin/integration-health per ARR-OPS-05.

## Decision

(c). T1: 304 p95 > 80 ms for 5 consecutive minutes in the US window, or Node event-loop lag p95 > 50 ms — split ingest. T2: webhook 204 p99 > 250 ms, or any dead_letter row with origin='inbound_webhook' in a 5-minute window — split ingest. T3: max(clock_timestamp() - fire_at) over pending scheduled_job > 60 s — split worker. T4: RSS > 400 MB of 512 MB for 10 minutes — split by memory. Recommended order is ingest first, worker second, because T1 fires first in practice and ingest is the densest CPU event and the cheapest to peel off.

## Consequences

T3 is a compliance alert wearing a performance costume: scheduler lag means the T-1h appointment reminder fires late, and a late reminder can fire outside the legal calling window. Each tripwire consumes one of the ten Better Stack monitors the free tier allows, so the monitor budget is allocated explicitly and an eleventh signal requires retiring one.
