# ADR-083 — ADR-G5 — Admin void writes the negation of a named row; the function has no amount parameter

**Status:** accepted (Phase 5, pending GATE 5)

## Context

US-9.13 makes admin void/adjust-with-reason 'the only sanctioned way to change a number that is already public', and today it is unimplementable: crm_app has no DML on the money tables, there is no definer, no typed reason, no admin re-assertion and no obligation to show the reason to the affected seller. A naive implementation would take an amount, which turns the single sanctioned correction surface into a general-purpose money-writing endpoint.

## Options considered

_(see Context; the rejected alternative is named inline)_

## Decision

app.ledger_adjust(entry_id, reason_code, reason_text) SECURITY DEFINER, with no amount parameter: the delta is computed as the negation of the named row and all period keys and stage snapshots are copied from it, so a void of a January credit leaves January. Four-label app.adjustment_reason enum; CHECK constraints requiring reason_code, adjusts_entry_id, actor_user_id and a >=10-character reason on every manual_adjustment; FK to the adjusted row; deterministic uuidv5 source_event_id so the existing UNIQUE makes a repeat void a no-op. My Earnings renders a discriminated union whose manual_adjustment member requires reason_code and reason_text, so a row that renders without its reason does not compile.

## Consequences

Positive: an admin can correct a public number and cannot invent one; a double-submit is safe by reusing the exactly-once machinery; and the seller whose number moved sees why. Negative: correcting a partially wrong amount requires void-then-recredit rather than an edit, which is more ledger rows and is the intended shape of an immutable ledger.
