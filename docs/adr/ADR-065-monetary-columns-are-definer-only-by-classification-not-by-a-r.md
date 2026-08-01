# ADR-065 — ADR-R2 — Monetary columns are definer-only by classification, not by a remembered REVOKE

**Status:** accepted (Phase 5, pending GATE 5)

## Context

REVOKE UPDATE was applied to the stage transition columns and not to premium_monthly_cents, premium_annual_cents or premium_mode. A seller editing the premium of a closed-won opportunity passes every CHECK, the card shows the new number, no opportunity.value_changed is emitted and no ledger row is appended. The public all-time board keeps the old number forever, because there is no recompute job by design and the ledger is never replayed. ARR-EVT-07 names this the single most-forgotten link in the money chain. Applying one more REVOKE fixes today's columns and not tomorrow's, and the review separately showed that the money-type gates key on a *_cents name pattern, so a column named premium_annual typed number passes tsc, the lint and every test.

## Options considered

_(see Context; the rejected alternative is named inline)_

## Decision

Money is a Postgres DOMAIN, app.money_cents. security.table_registry gains definer_only_columns text[], re-applied by harden() on every deploy and every partition, and harden() RAISES if any column of domain app.money_cents on any classified relation is absent from that relation's definer_only_columns. Schema gate S17 fails the build on any bigint column in schema app that is neither the domain nor on a sealed per-table non_money_bigints list. Writes go through app.opportunity_set_premium() and app.ledger_adjust(), definers that append the value_correction or manual_adjustment delta, emit the event, update the projection and bump the watermark in the same transaction.

## Consequences

A new money column that nobody routed through a definer fails the DEPLOY, not a review. The fourth layer of signed non-negotiable 4 (the CI test that fails when a monetary field is a plain number) is obtained from the engine instead of from a name regex. Editing a premium outside the definer returns permission denied on screen. Costs: every money write is a function call rather than an ORM update, which is visually distinct in the codebase (a feature, per the existing single-writer doctrine); the domain must be introduced across the schema before the gate can be turned on; and non-money bigints need a per-table sealed list, which is a small, enumerable artifact under the seal chain.
