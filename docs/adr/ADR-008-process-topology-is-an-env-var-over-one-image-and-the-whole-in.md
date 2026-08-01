# ADR-008 — ADR-E8 — Process topology is an env var over one image, and the whole integration suite runs in both shapes

**Status:** accepted (Phase 5, pending GATE 5)

## Context

The owner requires the three-process split (web / worker / ingest) to be deployment configuration rather than an architectural assumption: launch folded and cheap at USD 0-26, separate later at USD 42.50 without redesign or migration. A folded shape that silently accumulates same-process assumptions turns the eventual split into a rewrite, and the accumulation is invisible until the day it matters.

## Options considered

(a) Build folded now, split later as a refactor. (b) Build split now and run three services from day one, paying escalón-2 cost during the pilot. (c) One image, one entrypoint, ROLES env var selecting which loops start, with CI proving both shapes.

## Decision

(c). ROLES=web,worker,ingest is the folded shape and the local Docker Compose default; three services each with one role is the split shape. The route manifest tags each route surface: app | ingest and CI asserts the two mounted sets union to the full manifest and intersect empty. A dependency-cruiser rule forbids anything outside src/events/dispatch/** from importing src/consumers/**, so no emitter can call a consumer directly. Above all: the entire integration suite runs twice in CI, folded and split, and both legs must produce identical outcomes.

## Consequences

The claim "the split is configuration" becomes a build-breaking assertion instead of a design intention, at the cost of one test-matrix dimension. Folding is only semantically free because every hand-off is already a Postgres row — outbox, pg-boss job, or NOTIFY — with no in-memory bus anywhere. The honest loss when folded is the ingest bulkhead: a webhook storm shares the event loop with the board, mitigated by a per-role pool, a per-role rate limiter and a concurrency semaphore that sheds load with 429/503 (which the provider retries) rather than freezing the board. Puerta 2 is run against both shapes; the folded shape failing its ingest leg at production volume IS the trigger to split, and the split is an env var plus a second service.
