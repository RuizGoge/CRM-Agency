# ADR-090 — ADR-G12 — The premium columns are revoked and routed through a definer, with a deferred trigger as the counter-net

**Status:** accepted (Phase 5, pending GATE 5)

## Context

The design's proudest privilege fact is column-level REVOKE UPDATE on the three stage columns, so a generic PATCH that grows a stage_id key gets permission denied from the engine. The same revoke was not applied to premium_annual_cents, premium_monthly_cents or premium_mode. A seller edits the premium on a closed-won opportunity, every CHECK passes, the screens show the new number, no opportunity.value_changed is emitted and no ledger row is appended — and the public all-time board keeps the old number forever, because there is no recompute job by design and the ledger is never replayed. ARR-EVT-07 calls this 'the single most-forgotten link in the money chain'. US-9.3's Edit deal value command also has no named surface.

## Options considered

_(see Context; the rejected alternative is named inline)_

## Decision

REVOKE UPDATE (premium_monthly_cents, premium_annual_cents, premium_mode) ON app.opportunity FROM crm_app, with app.opportunity_set_premium() writing the columns and appending the value_correction delta in-transaction, the delta derived from the row's prior value and never taken as a parameter, and a CHECK requiring a >=10-character reason on value_correction. Add a DEFERRABLE constraint trigger refusing COMMIT of a premium change on a closed-won opportunity with no matching ledger row. The command is POST /api/opportunities/:id/value, reachable from the opportunity header and the My Earnings row, asserted keyboard-only at L3.

## Consequences

Positive: the symmetric fix to the stage columns, one migration, and it survives a future definer that forgets the append. Negative: any legitimate bulk premium correction must go through the definer one row at a time, which is the intended shape for public money.
