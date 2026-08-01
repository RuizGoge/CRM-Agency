# ADR-075 — ADR-R12 — A provider capability is verified only by a digest-linked probe row

**Status:** accepted (Phase 5, pending GATE 5)

## Context

ref.provider_capability's CHECK requires verified_at IS NOT NULL AND evidence_ref IS NOT NULL, and evidence_ref is free text. A migration seeding status='verified', evidence_ref='spike' satisfies the boot assertion for every mvp_required capability. The discriminated-union type is excellent and the state that unlocks it was writable by the same actor that wants it unlocked — which matters because two capabilities being absent means the MVP is not shippable and one means ARR-INT-08 has no implementation.

## Options considered

_(see Context; the rejected alternative is named inline)_

## Decision

evidence_ref is replaced by evidence_probe_id, a FK to ref.capability_probe(probe_id, provider, capability, http_status, response_digest bytea NOT NULL, raw_payload_id FK to raw_payload_vault, observed_at). CHECK (status <> 'verified' OR evidence_probe_id IS NOT NULL); a trigger requires verified_at = probe.observed_at and a 2xx status; and the production boot assertion recomputes, for every mvp_required capability, that the probe exists and its response_digest equals raw_payload_vault.body_sha256 for the linked body. /admin/integration-health renders each capability with its probe timestamp and HTTP status.

## Consequences

A fabricated verification has no probe row, no stored provider body and no matching digest, so the process exits non-zero in production. 'Verified' becomes a rendered fact with provenance rather than a word in a column. Costs: the Gate-7 spike must persist its raw responses into the vault (which the vault already exists to do), and a capability whose evidence body is later purged by retention needs its probe row's digest to remain valid — resolved by classifying capability-probe bodies as permanent rather than short-clock.
