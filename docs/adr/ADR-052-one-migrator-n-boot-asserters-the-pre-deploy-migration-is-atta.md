# ADR-052 — ADR-S4: One migrator, N boot-asserters — the pre-deploy migration is attached to exactly one service

**Status:** accepted (Phase 5, pending GATE 5)

## Context

security.harden() must be the LAST statement of the one-shot pre-deploy migration job, and it RAISES on any unclassified relation so that a migration creating a table without classifying it fails the deploy. In the folded topology there is one service and this is unambiguous. In the split topology, attaching a pre-deploy command to all three services would run three concurrent migrations and three concurrent harden() calls on every deploy.

## Options considered

(a) Attach the pre-deploy command to all three services and rely on idempotency. (b) Attach it to one service and let the others start against whatever schema exists. (c) Attach it to exactly one service (web); every other role boot-asserts that the deployed schema version equals the version its code was built against and exits non-zero on mismatch; harden() additionally takes a pg_advisory_lock so even a misconfiguration serialises rather than races.

## Decision

(c).

## Consequences

A partial deploy — a new worker started against an old schema, or an old ingest surviving a schema change — fails loudly at boot instead of running against a schema it does not understand. This is a failure mode that only exists in the split topology and that folding hides completely, so it must be designed in while folded rather than discovered at separation. It also means the migration is a deploy-time fact in both topologies with no configuration difference beyond which service carries the command.
