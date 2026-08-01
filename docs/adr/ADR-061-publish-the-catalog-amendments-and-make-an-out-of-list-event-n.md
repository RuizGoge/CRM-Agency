# ADR-061 — ADR-P6: Publish the catalog amendments and make an out-of-list event name a build failure in five places

**Status:** accepted (Phase 5, pending GATE 5)

## Context

moved_via has seven values in the architecture and four in the catalog, and the catalog's four cannot express the five paths R1.5 requires validating. opportunity.stage_changed is missing from the win transaction although 02b requires it on every move and names consumers that exist nowhere else. pipeline.stage_config_changed is silently absent from the ledger consumer set. contact.became_client was described as scheduling a V1.1 automation. Roughly twenty event names used in 03-mvp-stories Notes do not exist in the 49. The 49-name coverage gate as written is red on day one and is satisfiable by a test helper.

## Options considered

_(see Context; the rejected alternative is named inline)_

## Decision

Publish six amendments as binding. (1) app.moved_via becomes a seven-value Postgres enum with mobile deleted, payload types generated from it, enum_range asserted against a literal, and the human-only CHECK sharpened to exclude automation. (2) Every move emits stage_changed, with won/lost from the gates in the same transaction in that order, enforced by a DEFERRABLE constraint trigger on stage_transition that raises at COMMIT if the events — and, for earning moves, the ledger row — are absent; refusals get a durable path via SAVEPOINT so one implementation of the gate rules survives. (3) The ledger input set is four events plus one command, with membership and non-membership both asserted by name, and the double-credit guard is a state column plus a partial unique index rather than only a source_event_id key. (4) contact.became_client has zero consumers, asserted. (5) The remap table is published. (6) The rule is mechanised in typecheck, the drift gate, the enum migration, three-way equality, and a docs-level gate against a generated exception list; ref.event_schema gains mvp_emitter so the coverage gate is green on day one, requires a non-test emitter call site, and turns red if a V1.1 name is emitted by a helper.

## Consequences

The generator, not prose, becomes the place where 02b's contradictions are settled, so 02b cannot drift from the code. The deferred constraint trigger closes the previously unguarded failure of crediting a sale zero times, which the fan-out WHERE clause would otherwise have made silent. Adversary Scenario D and finding 1.12 are closed without a second copy of the gate logic. US-9.2's acceptance criterion is corrected in writing.
