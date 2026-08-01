# ADR-068 — ADR-R5 — A move into an earning stage that credits nothing cannot commit

**Status:** accepted (Phase 5, pending GATE 5)

## Context

All three double-credit nets guard against crediting twice; nothing guarded against crediting zero times. Because the inline registry is declarative and the outbox fan-out excludes inline consumers, dropping app.ledger_append from the close path writes no outbox row either: the sale is credited nowhere, by design, with a correct-looking card and a green build. Separately, D-4 and R1.6 require one credit per opportunity with re-credit after reversal, and UNIQUE (tenant_id, source_event_id) permits a second credit from a genuinely distinct event (the earning-to-earning move).

## Options considered

_(see Context; the rejected alternative is named inline)_

## Decision

A DEFERRABLE INITIALLY DEFERRED constraint trigger on stage_transition raises MN001 at COMMIT when a row with to_stage_type='earning' has no live earnings_ledger sale row for its opportunity. opportunity.earnings_credited boolean is flipped true by ledger_append on a sale and false on a reversal, and ledger_append refuses a second sale while it is true, returning already_credited as a success path.

## Consequences

The refactor that 'simplifies' the close path turns the drag red the first time it runs, on a seller's screen, instead of publishing a leaderboard quietly missing a sale. One credit per opportunity becomes a state fact rather than an event-key coincidence, and re-entry after a reversal still credits. Cost: one deferred trigger evaluation per earning transition at COMMIT, and the trigger's predicate must be kept aligned with the definition of 'live' (not superseded by a reversal), which is a single SQL expression in one function.
