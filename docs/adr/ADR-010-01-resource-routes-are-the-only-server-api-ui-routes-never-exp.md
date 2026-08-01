# ADR-010 — ADR-API-01 — Resource routes are the only server API; UI routes never export loader or action

**Status:** accepted (Phase 5, pending GATE 5)

## Context

React Router 8 framework mode is the signed stack. The ARR warns that using a framework against its idiom produces permanent architectural erosion under vibecoding, because every public example points the other way. Earlier drafts resolved this by forbidding `loader`/`action` outright, which is fighting the framework and will lose over many sessions. Meanwhile four register requirements are incompatible with loader/action data flow: ARR-UX-01 (a Class-O move must produce zero network requests for 5000 ms, asserted at the network layer by D3-01), ARR-UX-20 (per-block independent fetches with per-block error and retry; page-level loaders are forbidden), ARR-UX-09 (one shared scheduler doing conditional GETs, skip-if-in-flight, backoff and per-route teardown; useRevalidator revalidates the whole route tree), ARR-UX-02 (sendBeacon posts a Blob to a URL and cannot participate in a fetcher submission).

## Options considered

(a) Use loaders/actions as the primary data path and layer the four bespoke client subsystems on top. (b) Forbid loader/action entirely and hand-roll an HTTP layer outside the router. (c) Partition the route tree: UI route modules export a component only; API route modules are resource routes exporting loader/action only, produced by one defineEndpoint factory. (d) Adopt Next.js App Router with server actions.

## Decision

(c). A route module that exports loader/action and no default component IS a resource route — the framework's own documented mechanism for JSON responses — so this is with the idiom, not against it. One structural rule: a route module exports a component or a loader/action, never both. Exactly one whitelisted exception: the pipeline UI route's SSR hydration loader, whose body is a single call to the same boardRead handler the /api/board resource route calls. The whitelist is a single-entry versioned file. (d) was already eliminated in Phase 5A on the same four grounds.

## Consequences

The prohibition becomes checkable and non-adversarial: loader examples remain legal, they just live under routes/api/**. The ESLint rule is one AST check on export names per directory. Cost: the SSR hydration path and the JSON path must share a handler, so handlers are pure functions of (ctx, input) and cannot touch Request/Response — which is also what makes §1.3's read-only GET handle possible. Risk retained: a model may still create a route file in the wrong directory; the lint rule catches it, and the generated route registry will not contain it, so its silo test will not exist — mitigated by a registry check that fails if any file under routes/** is not represented.
