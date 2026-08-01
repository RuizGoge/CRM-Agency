# ADR-004 — ADR-E4 — stage_type immutability makes pipeline.stage_config_changed a non-money event and deletes ARR-EVT-09's recompute job

**Status:** accepted (Phase 5, pending GATE 5)

## Context

02b calls a per-seller stage tweak silently moving a public leaderboard "the nastiest hidden dependency in the system". ARR-EVT-09 requires an asynchronous, atomic, idempotent bulk recompute keyed on the triggering event. Simultaneously, Area-3 D-2 and US-9.4 state flatly that no recompute job exists and make it testable — "verify the job queue is empty after the change". Item 61 of 03-mvp-definition says the opposite. The signed data model resolves the tension upstream by making stage.stage_type immutable via a BEFORE UPDATE trigger.

## Options considered

(a) Keep the recompute job: composite FK gains ON UPDATE CASCADE, plus a bounded, idempotent, all-or-nothing bulk correction with compensating ledger appends keyed by (source_event_id, opportunity_id). (b) Immutable stage_type: a seller wanting a different type creates a new stage and moves cards through the normal gated path; no recompute exists.

## Decision

(b). pipeline.stage_config_changed has no registry row binding it to earnings.ledger, and a CI test asserts that specific pair's absence by name. ARR-EVT-07's five ledger inputs become four (opportunity.won, opportunity.value_changed where closed-won, opportunity.reopened, contact.merged) plus manual_adjustment from the admin command path. ARR-EVT-09 is declared void in this document.

## Consequences

US-9.4's assertion becomes literally true and mechanically testable. An entire class of catastrophe — a config change moving a public all-time board — becomes structurally impossible rather than correctly handled. The cost is real and Jorge must ratify it: a seller who mis-typed a stage at setup creates a replacement and moves cards. The alternative reintroduces every risk the documents attribute to the recompute job, on the one artifact with no rebuild path.
