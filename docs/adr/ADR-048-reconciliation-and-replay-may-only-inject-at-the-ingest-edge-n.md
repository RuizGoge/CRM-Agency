# ADR-048 — ADR-10 — Reconciliation and replay may only inject at the ingest edge, never into the domain

**Status:** accepted (Phase 5, pending GATE 5)

## Context

ARR-INT-08 requires a scheduled API backfill for calls the webhooks never delivered, and flags that a silent backfill retroactively changes staleness and activity counts with no event emitted. ARR-INT-07 requires DLQ replay. Both are second write paths into the same domain facts, and a second write path is where merge rules, idempotency keys and quarantine behaviour drift apart from the live path — silently, because both paths pass their own tests.

## Options considered

(a) Backfill and replay write the domain directly — fastest to build, and guarantees eventual divergence from the webhook path. (b) Backfill and replay synthesize inbound_webhook_event rows and let the same call-merge job process them. (c) A shared 'ingestion service' both call — better than (a), but still two entry points into it.

## Decision

Option (b). Both the reconciliation backfill and DLQ replay construct an inbound_webhook_event (with provider_event_type='reconciliation' or a replay marker) and enqueue the same merge job. Enforced by dependency-cruiser: `src/jobs/reconciliation/**` may import only `src/ingress/**` and `src/adapters/aloware/**`, never `src/domain/**`. Every recovered timeline entry carries `render_payload.recovered = true` and renders as 'Recovered from Aloware'; each gap increments `admin_alert(kind='reconciliation_gap')`.

## Consequences

A backfill can never write something a webhook could not, so it inherits every idempotency key, merge rule and quarantine path for free, and the merge property test covers all three paths at once. ARR-INT-08's silent-correction hazard is closed: a webhook gap becomes a visible number and a labelled timeline entry. Cost: the backfill is limited to what the webhook schema can express, so a richer list-API payload cannot be exploited without first extending the webhook contract — which is the correct constraint.
