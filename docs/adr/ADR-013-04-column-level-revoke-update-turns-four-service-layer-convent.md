# ADR-013 — ADR-API-04 — Column-level REVOKE UPDATE turns four service-layer conventions into privilege facts

**Status:** accepted (Phase 5, pending GATE 5)

## Context

Four rulings are currently enforced only by 'the service layer is the only writer': (1) exactly one server-side stage-transition service (ARR-MVP-09, ARR-UX-03); (2) a premium edited after close must append a value_correction ledger row — named in the source material as the single most-forgotten link in the money chain (ARR-EVT-07); (3) ownership transfer is one transaction with an audit row and never moves money (ARR-MVP-22); (4) role changes are audited (ARR-MVP-21). Each is a convention a new endpoint can bypass, and each failure is silent.

## Options considered

(a) Leave as service-layer discipline plus code review — impossible here, Jorge does not read code. (b) BEFORE UPDATE triggers per column, raising unless a session flag is set — works but adds per-row trigger cost on hot tables and the flag is forgeable. (c) Postgres column-level privileges: REVOKE UPDATE (cols) ON table FROM crm_app, with the write path confined to SECURITY DEFINER functions.

## Decision

(c). Registered as `immutable_columns text[]` in security.table_registry; applied by security.harden() on every deploy and every new partition; asserted by a CI query over information_schema.column_privileges. Revocations: opportunity(stage_id, current_stage_type, stage_entered_at); opportunity(premium_monthly_cents, premium_annual_cents, premium_mode); owner_user_id on the nine owner-bearing tables; app_user(role).

## Consequences

A generic PATCH that grows a stage_id key, an UPDATE that changes a premium without touching the ledger, an ownership move implemented as a plain UPDATE, and a role change without an audit row all become `permission denied` — surfaced as a 500 with the specified copy where money is involved. Cost: Drizzle cannot model those column writes, so the money and ownership paths become visually distinct in the codebase (a feature). Second cost: partial UPDATE statements that happen to include a revoked column in their SET list fail even when the value is unchanged, so update helpers must build SET lists from changed fields only — one shared helper, covered by test.
