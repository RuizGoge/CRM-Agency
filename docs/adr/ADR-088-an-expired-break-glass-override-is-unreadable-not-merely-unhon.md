# ADR-088 — ADR-G10 — An expired break-glass override is unreadable, not merely unhonoured

**Status:** accepted (Phase 5, pending GATE 5)

## Context

ARR-CMP-03 requires 60-minute auto-expiry 'with no further action'. The schema computes expires_at as a stored generated column and the sections say expiry is checked on read — correct, but it relies on every present and future reader remembering to write the predicate. The two override events also have no registered emitter, and the UX flow emits admin.setting_changed for the same act, so the registry carries two answers.

## Options considered

_(see Context; the rejected alternative is named inline)_

## Decision

Create app.active_override_v (ended_at IS NULL AND clock_timestamp() < expires_at) with security_invoker, REVOKE SELECT on break_glass_override from crm_app, and add gate S18 requiring app.compliance_check to reference the view and no other definer to reference the base table. Register compliance.override_started/ended as the emitters and rule that admin.setting_changed is NOT emitted for break-glass, asserted by the named absence of the (admin.setting_changed -> realtime.banner_broadcast) registry pair. override_ended is a startAfter=expires_at pgboss job that is telemetry only, with a production alarm on started-minus-ended.

## Consequences

Positive: the expired row cannot be read by the code path that would honour it; the banner disappears at 60 minutes with no job, no event and no client timer, so a dead worker cannot leave the override apparently live. Negative: the audit event for auto-expiry depends on a job, so a dead worker produces a late event — alarmed rather than assumed, and it has no effect on the safety property.
