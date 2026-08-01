# ADR-019 — ADR-API-10 — Keyset-only pagination with unsigned position cursors; no OFFSET, no filter grammar

**Status:** accepted (Phase 5, pending GATE 5)

## Context

ARR-MVP-25 forbids unbounded queries and N+1, and requires every list path to be paginated or hard-capped, verified by query log. ARR-UX-13's contact timeline is the deepest scroll in the product. Cursors are user input, which invites either signing them or embedding scope in them — both of which turn a position into a capability.

## Options considered

(a) OFFSET/LIMIT. (b) Signed cursors carrying scope and filters. (c) Unsigned cursors carrying only a codec version, the sort tuple and a hash of the normalized filter set; caps declared per endpoint in the registry and required by the endpoint type whenever the output is an array.

## Decision

(c). decodeCursor() returns a branded SortTuple and the repository's `after` parameter is typed SortTuple, so there is nowhere to put a tenant id, an owner id or a predicate. `.offset(` is banned across src/** by lint with no exception list. Filters are an enumerated per-endpoint set of enums, ids and date ranges; there is no generic filter grammar and no `where` parameter; free text goes only to /api/search.

## Consequences

A cursor grants nothing — asserted by a CI test that mints a cursor as Seller A, replays it as Seller B, and requires B to get exactly the rows B would have got without it. The codec version prevents a shipped sort-order change from making old cursors silently skip or repeat rows. The filter fingerprint turns 'client changed the filter and kept the cursor' from an incoherent page into a 400. Cost: two extra 400 codes the client must handle by restarting the list, and the absence of a generic filter DSL means each new filter is a schema change — deliberate, since a generic DSL is how an ownership predicate ends up outside the query plan.
