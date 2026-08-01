# ADR-059 — ADR-P4: Strike recompute; replace it with stage-configuration identity columns on every ledger row

**Status:** accepted (Phase 5, pending GATE 5)

## Context

02b section 4 (twice), 02b section 8 item 1 and 03-mvp-definition item 61 all say a stage-flag change recomputes the ledger. 03-mvp-stories D-2 — newer and more specific — says the ledger is immutable and forward-only and that no recompute job exists, and US-9.4 makes it testable ('verify: job queue is empty after the change'). The signed data model makes stage.stage_type immutable by trigger, so the flag toggle those texts describe is structurally impossible. A recompute job over an append-only, all-time, never-resetting public money board is the one code path that can rewrite history fifty people have already seen.

## Options considered

_(see Context; the rejected alternative is named inline)_

## Decision

D-2 wins. A stage-configuration change writes zero ledger rows, enqueues zero jobs and changes no public total; ARR-EVT-09 is void. Retroactivity is replaced by columns: every earnings_ledger row carries stage_config_version, stage_id, stage_name_snapshot and stage_type_snapshot, all NOT NULL, all written only by app.ledger_append(), with CHECK (stage_type_snapshot = 'earning') on sale rows. pipeline.stage_config_changed loses closed_flags_changed[] from its payload (additionalProperties:false makes an emitter that reports one fail typecheck) and has no ledger consumer, asserted by name. contact.merged corrections are compensating append pairs written by app.contact_merge(). The only sanctioned way to change a public number is app.ledger_adjust() with entry_type='manual_adjustment', typed reason, MFA. Symmetrically, REVOKE UPDATE on the three premium columns with app.set_premium() appending the value_correction delta in-transaction.

## Consequences

US-9.4's story text changes from 'I un-flag a stage' to 'I archive an Earnings stage'; the approved confirmation copy is unchanged and now describes what actually happens. US-9.4's acceptance becomes two literally-true L2 assertions (job queue unchanged, ledger row count unchanged). 02b section 8 item 1's real requirement — that the ledger record which configuration produced each delta — is satisfied more strongly by a column than it would have been by a job. Adversary Scenario B is closed by the same mechanism.
