# ADR-039 — ADR-01 — Process topology is a deployment variable: one image, ROLES env, dedicated ingress hostname from day zero

**Status:** accepted (Phase 5, pending GATE 5)

## Context

The owner requires the three-process split (web / worker / ingest) to be deployment configuration rather than an architectural assumption, so the pilot can run folded at Tier 1 (USD 0–26) and split at Tier 2 (USD 42.50) with no redesign and no migration. The decision that silently turns the split into a migration is the hostname: if Aloware webhooks and vendor ping-post endpoints are registered against the app hostname, splitting later requires every vendor and the provider to re-register URLs — slow, error-prone, and outside our control.

## Options considered

(a) Separate codebases or separate services per role — rejected, duplicates the domain and doubles the RLS/CI surface. (b) One image, roles selected at runtime, webhooks registered on the app hostname — rejected, the split becomes a vendor-coordination project. (c) One image, ROLES env selects mounted units from a static registry, and webhooks/intake registered on a dedicated `in.<domain>` hostname that in Tier 1 is simply a second custom domain on the single folded service. (d) A path-based reverse proxy in front of both services — rejected, adds a paid component and a failure mode to a design whose whole cost thesis is having neither.

## Decision

Option (c). One container image. `ROLES=web,worker,ingest` folded, or three services each with one role. A static unit registry declares which roles run which unit. Ingress URLs are always issued on `in.<domain>`; splitting is a CNAME repoint plus three env changes. Job weight (`light`/`heavy`) is a NOT NULL registry column so the folded runtime can throttle heavy work at concurrency 1 with a cooperative batch budget.

## Consequences

Splitting requires no code change, no migration and no vendor coordination. Cost: the folded tier shares one event loop, so SSR/API p95, SSE heartbeat jitter and job latency all degrade together under an ingest storm — accepted, because §7.2 makes the degradation visible and computes the split threshold from a measured number. Also costs a permanent CI gate (G5) asserting the folded and split deployments pass the identical acceptance suite, which means the split path is never executed for the first time under pressure.
