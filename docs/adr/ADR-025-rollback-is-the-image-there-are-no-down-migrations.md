# ADR-025 — ADR-T4 — Rollback is the image; there are no down migrations

**Status:** accepted (Phase 5, pending GATE 5)

## Context

DoD-12 and ARR-MVP-03 already require schema changes to be additive and forward-compatible, and require that a change be revertible without leaving orphaned rows or half-credited ledger entries. Down migrations are the conventional answer, but a down migration over an append-only ledger, monthly partitions and generated RLS policies is the single most dangerous script in the system, it is written under incident pressure, and nobody reviews it. Meanwhile additive-only schema is exactly the property that makes rolling back code safe without touching schema at all.

## Options considered

(a) Paired up/down migrations. (b) Forward-only migrations with a compensating forward fix. (c) Forward-only, additive-only migrations, with the container image as the unit of rollback.

## Decision

Option (c). No down migrations exist. A CI gate parses every migration and fails on DROP TABLE, DROP COLUMN, ALTER COLUMN … TYPE, ALTER COLUMN … SET NOT NULL on an existing column, or RENAME. Exceptions require an entry in migrations/destructive-allowlist.json carrying a written reason and the migration id of the earlier release in which code stopped reading that object — expand/contract expressed as data. That file follows the same PR rule as perf-budgets.json and the RLS exception list: that file and nothing else.

## Consequences

Rollback becomes a one-click image swap with no schema risk, which is the only rollback story that works without a human operator. The cost is discipline at write time: a column rename becomes add-new + backfill + stop-reading + drop-later across releases, and the allowlist makes that sequence auditable. A migration author who wants a quick destructive change now hits a red build instead of a silent irreversible one.
