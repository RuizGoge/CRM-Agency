# ADR-003 — ADR-E3 — The event contract is generated from JSON Schema, and hand-editing a generated file breaks the build

**Status:** accepted (Phase 5, pending GATE 5)

## Context

ARR-EVT-01 (9-field envelope at every ingress), ARR-EVT-02 (closed enum of 49 enforced at write time) and ARR-EVT-27 (schema_version implies a registry replay must honor) are three requirements with one implementation. 02b itself is internally inconsistent: lead.created re-lists seven envelope fields inside its payload column and omits two, §2 names a ghost event lead.owner_changed, and the nine Amendment-1 events have no payload or consumer specification at all.

## Options considered

(a) Hand-written TypeScript types plus a hand-written Postgres enum. (b) TypeScript as the source, generating SQL. (c) JSON Schema as the source, generating TypeScript types, precompiled validators, the Postgres enum, the ref.event_schema and ref.event_consumer seeds, and the published catalog document.

## Decision

(c). contracts/events/ holds envelope.schema.json, one schema per (event_name, schema_version), consumers.yaml, and frozen payload fixtures. Everything downstream is generated. Subscribing to a name outside the 49 fails through four independent doors: typecheck against the generated union; a `gen && git diff --exit-code` drift gate; the migration, because ref.event_consumer.event_name is enum-typed; and a three-way equality test across enum, schema files and exported handlers. A new relation ref.event_schema is added with an FK from event_log so schema_version is a foreign key.

## Consequences

A version bump requires a previous-version fixture and an upcast function, both CI-asserted, which is what makes an unbounded retention window survivable. The published catalog document is generated, so 02b cannot drift from the code. The generator refuses any payload schema declaring an envelope property name, which deletes the duplication class. Cost: a generator step in the build, and the discipline that the drift gate is non-negotiable — without it "single source" is a claim, because the cheapest way to green a red build is to edit the generated file.
