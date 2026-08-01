# ADR-073 — ADR-R10 — Silo testability is a declared, non-optional property of every endpoint

**Status:** accepted (Phase 5, pending GATE 5)

## Context

The registry silo suite works by calling as Seller B with a Seller A id. Six of the fourteen measured endpoints take no record id (/api/board, /api/my-day, /api/search, /api/leaderboard, /api/notifications, /api/board/since); for these there is nothing to substitute and no not-found shape to assert, and their protection is entirely the RLS policy underneath. GET /api/search is structurally untestable by that harness, while ARR-UX-04 (non-negotiable) requires that search never return, count or hint at another seller's records.

## Options considered

_(see Context; the rejected alternative is named inline)_

## Decision

defineEndpoint gains a non-optional siloProbe discriminant: { kind:'foreign-id', fixture } | { kind:'listing', canary:true } | { kind:'none', reason } where the reason lands on a sealed exception relation. A purpose-built fixture silo-collision seeds sellers A and B with identical full_name, email_norm and phone_e164 — legal because those unique indexes are owner-scoped by design, since ping-post resells the same consumer — and stamps every A-owned free-text and identity field with a canary token. Listing endpoints assert, over the whole serialized response body, that the canary substring is absent; plus numeric count equality; plus that A's cursor presented by B is rejected rather than merely empty. A bounded grep gate forbids app.scope_is_global() under src/db/sql/search/**.

## Consequences

An id-less endpoint that declares nothing does not compile, so the structurally-untestable class stops growing silently. The byte-level canary assertion catches a leak through any field, including fields added later that no test knows about, which is what a registry loop over known ids cannot do. Costs: the collision fixture is more expensive to seed than a generic one and must be maintained alongside the demo seed; and { kind:'none' } is a real escape hatch, bounded only by the sealed reason list and the seal chain.
