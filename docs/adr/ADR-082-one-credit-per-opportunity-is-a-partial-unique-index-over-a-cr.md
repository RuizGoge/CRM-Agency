# ADR-082 — ADR-G4 — One credit per opportunity is a partial unique index over a credit epoch, not an event key; and an earning stage cannot commit without its ledger row

**Status:** accepted (Phase 5, pending GATE 5)

## Context

The entire exactly-once story is UNIQUE (tenant_id, source_event_id), which by construction permits a second credit from a second, genuinely distinct event — exactly the earning->earning move D-4 forbids and exactly R1.6's wrap-up-'Sold'-plus-drag double path. Symmetrically, all three double-credit nets guard against crediting twice and nothing guards against crediting zero times: if ledger_append is dropped from the close-gate path, the fan-out WHERE clause excludes inline consumers so no outbox row is written either, and the sale is credited nowhere with every test green.

## Options considered

_(see Context; the rejected alternative is named inline)_

## Decision

Add earnings_ledger.credit_epoch and two partial unique indexes on (tenant_id, opportunity_id, credit_epoch) for entry_type='sale' and for entry_type='reversal'. The epoch is the count of prior reversals, computed in-transaction; the index arbitrates under concurrency and ON CONFLICT DO NOTHING makes the second credit a logged success path per R1.6. Add a DEFERRABLE INITIALLY DEFERRED constraint trigger on opportunity that refuses COMMIT when current_stage_type='earning' and no sale row exists at the current epoch.

## Consequences

Positive: the guard is a database object no code path can route around — raw SQL, a second definer, a replay and a webhook consumer all collide with it; and the zero-credit failure class stops being unguarded. Negative: credit_epoch is a derived value maintained by the definer, so a manual ledger repair performed by crm_migrator must maintain it or the next re-credit collides.
