# ADR-007 — ADR-E7 — The call-merge job payload is an id, and the handler folds every unmerged row for that key

**Status:** accepted (Phase 5, pending GATE 5)

## Context

Two Aloware webhooks for the same aloware_call_id arriving 50 ms apart produce a lost update if the merge is SELECT-then-UPDATE. The symptom is a timeline entry that looks perfectly fine and is missing the transcript — invisible, and it corrupts last_activity_at, the 7-day cold rule and the rot badges. ARR-INT-06 requires the final state to equal the in-order state. The obvious fix — put the webhook body in a pg-boss job with singletonKey = aloware_call_id — is also wrong: pg-boss collapses the second job, and the second job's body is the data the first one lacks.

## Options considered

(a) Application-level locking around a SELECT-then-UPDATE merge. (b) pg-boss singletonKey with the webhook body in the payload. (c) pg-boss singletonKey with only the id in the payload, the handler re-reading and folding all unmerged inbound_webhook_event rows for that key under FOR UPDATE.

## Decision

(c). The ingest handler inserts verbatim into raw_payload_vault and inbound_webhook_event and returns 204 — it never merges, never parses business meaning, never touches the domain. singletonKey is a required property of the pgboss delivery variant in the discriminated union, so omitting it does not compile, backed by CHECK (delivery <> 'pgboss' OR singleton_key_expr IS NOT NULL). timeline_entry's UNIQUE (tenant_id, ref_type, ref_id) makes late enrichment update in place.

## Consequences

A collapsed duplicate job is harmless because the surviving job does the work of both — the property that makes the singleton safe rather than lossy. The same pattern is reused once for message-merge on provider_message_id, so calls and messages share one idempotency shape. Puerta 2 asserts zero lost updates under 20 000 webhooks in 60 s; Puerta 11 asserts the key serializes two webhooks 50 ms apart. The design depends on one unmeasured external fact — whether Aloware demands a sub-second synchronous response — which Puerta 7 must answer.
