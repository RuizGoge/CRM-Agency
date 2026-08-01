# ADR-017 — ADR-API-08 — A generated route registry, and five CI suites that iterate it

**Status:** accepted (Phase 5, pending GATE 5)

## Context

ARR-MVP-02 makes it a build gate that for every endpoint a feature adds there is at least one automated test calling it as Seller B with Seller A's record id asserting the owner-scoped not-found. A hand-maintained test list satisfies this on the day it is written and decays immediately; it is the same class of artifact as the RLS exception list, which thesis non-negotiable 2 identifies as 'the exact place where an application table gets added in silence in month four'.

## Options considered

(a) A checklist in the DoD. (b) A hand-maintained array of endpoint descriptors. (c) route-registry.generated.ts, produced at build time from the metadata each defineEndpoint declares, with CI regenerating and failing on any diff.

## Decision

(c). Five suites iterate the registry rather than a list: silo (Seller B against Seller A's id → byte-identical 404 on every endpoint), cache (exactly one of two permitted Cache-Control values, no access-control-* header, and the two-seller byte-identical-body test), etag (304 on unchanged, 200 after watermark bump, every etag:'none' on a versioned exception list), pagination (no limit → defaultLimit, absurd limit → maxLimit), topology (the union of declared process roles covers every route).

## Consequences

Adding an endpoint automatically adds five tests; forgetting to register an endpoint means it does not exist, because the server mounts from the registry. This is the HTTP-layer mirror of security.harden() failing the deploy on an unclassified relation, and it deliberately fails the build rather than the deploy because a route is a build artifact. Corollary decision: there is no OpenAPI document — the registry is the contract, it is TypeScript, and the single client imports the input/output types directly, so drift is a type error. Recorded limitation: that only holds while there is exactly one client.
