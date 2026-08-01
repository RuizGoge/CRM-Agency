# ADR-067 — ADR-R4 — The gate's refusal is durable because the gate runs inside a PL/pgSQL subtransaction, and the constraint names its own refusal code

**Status:** accepted (Phase 5, pending GATE 5)

## Context

ARR-EVT-11 (non-negotiable) requires opportunity.gate_blocked on every refusal and states that refusal is the absence of a state change, never a rolled-back one. Both gates are CHECK constraints, and a CHECK violation aborts the transaction, destroying any event_emit, audit_write or admin_alert written before it. The only previously available exit was a service-layer pre-check duplicating the gate logic — the second implementation ARR-MVP-09 and ARR-UX-03 forbid — and the two copies diverge in the direction nobody tests: a permissive pre-check gives a 500 and 'Couldn't record this sale' on a legitimate win, a strict one gives a 422 the database would have accepted, and the gate_blocked counter reads zero either way.

## Options considered

_(see Context; the rejected alternative is named inline)_

## Decision

app.stage_move() performs the writes inside a PL/pgSQL BEGIN...EXCEPTION...END block, which establishes a subtransaction: on SQLSTATE 23514 the block's writes roll back and the enclosing transaction remains valid, so the handler writes opportunity.gate_blocked, the audit row and any admin_alert in the surviving transaction and returns a typed refusal. The refusal code is derived from GET STACKED DIAGNOSTICS CONSTRAINT_NAME through ref.constraint_refusal, whose completeness harden() enforces; the TypeScript refusal union is generated from that table. src/domain/gateDecision survives only as a client-side hint and is asserted to be imported only from src/ui/**. S18 asserts app.stage_move contains exactly one EXCEPTION block and that no definer with an EXCEPTION block also contains LOOP.

## Consequences

One gate, one implementation, a durable refusal, and a gate_blocked counter that is genuinely the proof the guard fires. Refusal copy cannot drift from the constraint, and adding a gate condition without its copy fails the deploy. Costs: one subtransaction per attempted move (free at hundreds of moves per day, and explicitly prohibited inside per-row loops by S18 because of subxid/SLRU pressure); an unmapped constraint re-RAISEs rather than being swallowed, which is deliberate — an unmapped constraint is a bug, and the deploy would already have refused it.
