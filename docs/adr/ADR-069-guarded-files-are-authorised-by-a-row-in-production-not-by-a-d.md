# ADR-069 — ADR-R6 — Guarded files are authorised by a row in production, not by a diff

**Status:** accepted (Phase 5, pending GATE 5)

## Context

The design uses 'a PR that touches that file and nothing else' as an enforcement mechanism at least three times (the UI-loader whitelist, the RLS exception list, the etag:'none' exception list), plus a count literal in a test file for the inline tier and perf-budgets.json for the budgets. Every one presumes a human reviewer reading a diff, and this project's first-order constraint is that there is none. The Testing section already discovered the insight for event fixtures and did not generalise it.

## Options considered

_(see Context; the rejected alternative is named inline)_

## Decision

Two moves. First, eliminate the literal wherever possible: the inline count becomes ref.inline_consumer_allowlist plus a CHECK on ref.event_consumer plus a harden() equality assertion; the three exception lists become seeded relations with NOT NULL reasons; perf budgets are mirrored into system_constant under the existing four-way drift test. Second, for what must remain a file, enforcement is a hash chain (ci/guards.json + ci/seal-manifest.jsonl) whose head is sealed into security.seal by migration: pre-merge CI walks the chain and honours append-only/frozen/ratchet modes; the migrator asserts that the head read from the LIVE production database is a prefix of the manifest in the image, so a rewritten history stops the deploy and the previous image keeps serving; every process boot-asserts the same equality.

## Consequences

The authority for a guard is a row in production, which no file edit can defeat. The honest boundary is stated rather than hidden: a model that writes a new migration can still advance a seal — what is guaranteed is that every loosening becomes permanent (security.seal is in the immutable set), counted, and rendered on /admin/system as 'guards changed since last release: N' with the file list. Jorge's behavioural check collapses to one number on one screen. Costs: loosening a genuine budget now requires a migration; and the seal chain adds a deploy-time comparison that will stop a deploy when the manifest and production disagree, which is exactly the intended failure.
