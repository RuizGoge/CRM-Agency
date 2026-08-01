# ADR-011 — ADR-API-02 — Pollable GETs are 'private, max-age=0, must-revalidate', never 'no-store'

**Status:** accepted (Phase 5, pending GATE 5)

## Context

The cost model of the whole product rests on ~0.5 M conditional GETs/day answering 304 in p95 <= 80 ms (ARR-UX-09, ARR-OPS-02). The instinctive header for a private API is `Cache-Control: private, no-store`, and thesis non-negotiable 14 permits it. But no-store forbids the browser from storing the response, and an unstored response cannot be revalidated — so If-None-Match is never sent, every poll is a full 200, and the failure is silent: no error, no red badge, just a worse p95 that reads as normal growth.

## Options considered

(a) `private, no-store` everywhere (safest-sounding, destroys the 304 steady state). (b) `private, max-age=<n>` (browser serves stale without revalidating; breaks the 5 s freshness promise). (c) `private, max-age=0, must-revalidate` + ETag on pollable GETs, `private, no-store` on everything else. (d) `no-cache` (equivalent to (c) in practice but ambiguous to readers and to some intermediaries).

## Decision

(c), with exactly two permitted values enumerated in one module: `private, max-age=0, must-revalidate` + ETag + `Vary: Cookie` for every GET /api/**, and `private, no-store` for UI HTML, /auth/**, SSE, ingress and export links. `private` is the directive that keeps shared caches out; `Vary: Cookie` is belt-and-braces and is explicitly not the mechanism.

## Consequences

The 304 steady state is preserved and the shared-cache prohibition is unaffected (both values carry `private`). Thesis non-negotiable 14's test is refined from 'no-store OR private+ETag' to 'exactly one of two enumerated values, chosen by the endpoint's declared audience'. Anyone reading the code sees why no-store is wrong here, which is the point: the next model to 'harden the headers' would otherwise reintroduce the bug as a security improvement.
