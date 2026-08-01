# ADR-077 — ADR-R14 — Job payloads cannot express a tenant; the handler re-derives it from the subject

**Status:** accepted (Phase 5, pending GATE 5)

## Context

The Security section asserts that all five execution contexts are covered and that authorization is generated rather than authored; the data model records the pg-boss context as an OPEN ruling, stating plainly that a job payload with a wrong tenant_id would be scoped to the wrong tenant, with options (a) HMAC-signed payloads or (b) re-derivation from subject_id via a definer. Under a replay or DLQ-retry path an attacker-influenced or corrupted id is a cross-tenant write with RLS fully enabled and perfectly happy.

## Options considered

_(see Context; the rejected alternative is named inline)_

## Decision

Option (b), enforced at the type level. defineJob's payload type is { subjectType, subjectId, ...scalars } and has no tenant_id field, so a payload carrying one does not compile. The handler wrapper calls app.begin_job(kind, subject_type, subject_id), a SECURITY DEFINER that re-derives tenant_id and owner_user_id from the subject row and sets the three GUCs; it is registered in security.function_registry as the only granted entry point for handlers, and S8 already asserts its body re-asserts tenancy.

## Consequences

A corrupted or attacker-influenced id resolves to that subject's own tenant or to nothing; it cannot select a tenant. The pg-boss RLS exception keeps its written reason but its compensating control is now a mechanism instead of a discipline. Costs: it changes every handler signature (which the data model already priced as the reason a ruling was needed), and a job whose subject row has been archived must resolve through the *_live view's base table inside the definer rather than failing silently — specified as part of begin_job.
