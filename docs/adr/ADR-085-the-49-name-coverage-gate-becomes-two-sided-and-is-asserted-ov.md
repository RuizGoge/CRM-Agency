# ADR-085 — ADR-G7 — The 49-name coverage gate becomes two-sided and is asserted over the production bundle, not over table contents

**Status:** accepted (Phase 5, pending GATE 5)

## Context

The gate as written asserts that all 49 names appear in event_log at the end of the integration suite. Several names have no MVP emitter by approved scope decision (the sequence family, automation.executed, calendar.sync_failed, lead.import_completed), so the gate is red on day one and the predictable response is that somebody deletes it. It is also satisfiable by a test helper that emits the missing name, so it measures table contents rather than reachable code.

## Options considered

_(see Context; the rejected alternative is named inline)_

## Decision

ref.event_schema gains mvp_emitter ∈ {app, operator_tool, deferred_v1_1} with a CHECK requiring deferred_reason and deferred_by_requirement on any deferral. The gate becomes two-sided: 'app' names must appear in event_log, and 'deferred_v1_1' names must NOT appear and must not appear as an emitter call site. Coverage is asserted by scanning the built production bundle's module graph from the declared entrypoints for emitted name literals (emit() takes a literal, enforced by ESLint), so a test helper cannot satisfy it. The deferred set is generated into docs/generated/event-catalog.md and is the V1.1 backlog.

## Consequences

Positive: flipping a name to deferred to green the build turns the other side red the moment any code emits it; the scope decisions that cut features become queryable data rather than prose; and 'a name nothing can emit' is still caught. Negative: the bundle scan is a new build-time tool whose correctness matters, and it must be taught about the operator-tool entrypoints (the CSV import script).
