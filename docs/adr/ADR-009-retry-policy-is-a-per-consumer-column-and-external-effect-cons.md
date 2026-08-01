# ADR-009 — ADR-E9 — Retry policy is a per-consumer column, and external-effect consumers must declare an idempotency key or max_attempts = 1

**Status:** accepted (Phase 5, pending GATE 5)

## Context

The outbox is at-least-once with respect to external effects and effectively exactly-once for DB-only handlers, because the delivery mark commits in the same transaction as the handler's writes. A single global retry default is therefore wrong in both directions: ARR-EVT-14 requires sequence.paused to drive an Aloware disenroll retried until acknowledged, because the alternative is a robot texting someone who opted out; ARR-EVT-18 requires call.initiated to survive an Aloware 5xx, but retrying the dial itself rings a real human a second time.

## Options considered

(a) One global max_attempts and backoff ladder for all consumers. (b) Per-consumer max_attempts, backoff_seconds[] and external_effect declared in ref.event_consumer, with a CI rule tying them together.

## Decision

(b). Every consumer row carries max_attempts, backoff_seconds[] and external_effect. CI asserts that every external_effect = true consumer either declares a provider idempotency key expression or sets max_attempts = 1. comms.aloware_dial is max_attempts = 1 with dead-letter plus the degraded banner; comms.aloware_disenroll is max_attempts = 20 with a long ladder, idempotent on enrollment_id.

## Consequences

The distinction a global default erases — retryable versus not-retryable side effects — becomes a queryable property. The outbox's own retry and dead-letter columns are ours, so the pg-boss version-drift hazard (retries silently zero, DLQ silently empty) governs only the pgboss-delivery consumers, which are enumerable with one query. Cost: three extra columns and one CI rule, plus the requirement that whoever adds an external-effect consumer must think about which of the two shapes it is — enforced, not requested.
