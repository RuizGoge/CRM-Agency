# ADR-049 — ADR-S1: Deployment topology is a runtime role set on a single image, not a code-level or build-level split

**Status:** accepted (Phase 5, pending GATE 5)

## Context

The owner requires that the three processes (web, worker, ingest) be deployment configuration rather than an architectural assumption: the system must run folded into one process for the cheap rung (USD 26) and separate later (USD 42.50) with no redesign and no migration. The naive alternatives are three separate applications sharing a library (which drifts), or one application with an internal `if (folded)` switch (which means folded and split are two different systems, only one of which is ever tested).

## Options considered

(a) Three deployable applications from a monorepo, sharing a domain package. (b) One application with a runtime `isFolded` flag branching the wiring. (c) One image, one digest, a `ROLES` environment variable parsed at the composition root against a closed union, mounting role modules — with the roles communicating exclusively through Postgres (event_outbox, pg-boss, LISTEN/NOTIFY, channel_watermark) so that folding co-locates processes without changing any message path.

## Decision

(c). The composition root is the only place that knows the role set; nothing downstream can observe co-location. The three roles already communicate only through durable transactional channels in Postgres, so folding is co-location and separation is starting two more copies of the same binary with a different environment variable. Cross-role imports are forbidden by dependency-cruiser, and the full integration suite runs in BOTH topologies pre-merge.

## Consequences

Separation becomes: create two services from the same image, repoint one CNAME, change one env var. No migration, no data movement, no consumer re-registration, no code. The cost is that no in-process shortcut may ever be taken between roles — which is enforced by the build rather than by discipline. It also forces the intake hostname to be a CNAME from day one even while folded, so the split changes DNS and never a vendor's configuration.
