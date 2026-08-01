# ADR-002 — ADR-E2 — The consumer classification is a database table with a counted inline tier, not a convention

**Status:** accepted (Phase 5, pending GATE 5)

## Context

The brief requires the two-tier classification to be an enumerable code artifact. The ARR's own reconciliation found 66 ghost consumers — subscribers to events nobody emits — because the emitter/consumer relation lived only in prose across twelve module specs. Jorge validates by behaviour, not by reading code, so "only the ledger and the gates run inline" must be queryable.

## Options considered

(a) A documented convention plus code review. (b) A TypeScript constant map. (c) A seeded database table (ref.event_consumer) generated from the contract source, with FKs from event_outbox.

## Decision

(c). ref.event_consumer carries (consumer_name, event_name, delivery, singleton_key_expr, max_attempts, backoff_seconds, external_effect). event_outbox FKs to it. The inline tier is admissible only when eventual consistency would be a monetary or legal error, which admits exactly six rows: earnings.ledger, earnings.leaderboard_projection, realtime.watermark, pipeline.gate_verdict, compliance.block_recorder, consent.stop_recorder. A CI test asserts the inline count equals a literal.

## Consequences

Adding an inline consumer turns the build red until a human edits a number — a review gate expressed as a visible diff. The post-commit fan-out set is computed by the database at emission time, so an emitter cannot forget a consumer and adding a consumer touches zero emitters. Absences become assertable: the tests that prove contact.owner_changed and pipeline.stage_config_changed are not ledger inputs are queries over this table. Cost: two mechanisms coexist — inline consumers are explicit call sites in three command paths, post-commit consumers are registry-driven — which must be documented so nobody "unifies" them by adding dynamic dispatch to the money path.
