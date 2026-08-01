# ADR-078 — ADR-R15 — Emitter coverage is measured over the shipped bundle, and names with no MVP emitter are declared

**Status:** accepted (Phase 5, pending GATE 5)

## Context

The coverage gate asserted that all 49 event names appear at least once in event_log at the end of the integration suite. That is an assertion about table contents, not about reachable code: the natural green-the-build move is a test helper that emits the missing name. Independently, several canonical names have no MVP emitter by approved scope decision (sequence.*, automation.executed, calendar.sync_failed, lead.import_completed, call.enriched while recording is disabled), so the gate is red on day one and the predictable response is that somebody deletes it.

## Options considered

_(see Context; the rejected alternative is named inline)_

## Decision

Two legs. Static: the generator emits 49 typed emitters and a module-graph analysis over the SHIPPED production bundle asserts each call site is reachable from a role entrypoint — tests/** and tools/** are not in the bundle, so a test helper cannot satisfy it. Declared: ref.event_schema.no_mvp_emitter boolean NOT NULL marks the legitimately unemitted names, and the gate asserts reachable_emitters equals 49 minus that set. Setting the flag requires a migration and advances the seal. The runtime appearance assertion is kept as the second leg.

## Consequences

The gate measures reachable production code rather than table contents, and it is satisfiable on day one, so it survives instead of being deleted. The exemption set becomes the enforceable list of what V1.1 must light up — a positive artifact rather than a silent gap. Costs: the analysis depends on the bundler's metafile, which pins the build tool as a load-bearing dependency of a gate; and dynamic dispatch to an emitter would defeat the reachability analysis, which is why emitters are generated as 49 concrete call sites rather than a lookup.
