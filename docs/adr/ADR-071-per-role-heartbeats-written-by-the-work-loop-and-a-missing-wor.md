# ADR-071 — ADR-R8 — Per-role heartbeats written by the work loop, and a missing worker becomes a seller-visible amber bar

**Status:** accepted (Phase 5, pending GATE 5)

## Context

The highest-impact fold failure has no detector. If the worker's env is wrong or the worker service is forgotten on the split, the outbox never drains, reminders never fire, celebrations never broadcast, the Aloware disenroll never happens and the retention purge never runs — and every screen looks perfect, because the inline tier still commits the money and bumps the watermark. The topology test asserts that DECLARED configuration covers every route; nothing checks the running set. ARR-OPS-03 calls scheduler lag a monitored first-class metric and there was no named heartbeat, no outbox-depth alert and no scheduler-lag metric in these sections.

## Options considered

_(see Context; the rejected alternative is named inline)_

## Decision

security.required_role (role_name, max_heartbeat_age_secs) is seeded by migration and sealed, and is topology-independent: a folded process writes heartbeats for every role it mounts, so a missing worker service and a PROCESS_ROLES that omits worker produce the same stale row. security.process_heartbeat is upserted BY THE WORK LOOP — the outbox relay's own claim loop and each pg-boss lane's fetch loop — so a process that is up but wedged still goes stale. Leg 3 of the two-legged production synthetic fails on any role whose heartbeat age exceeds its threshold (120 s for worker and each lane), and the same predicate drives the degraded_banner poll channel so every signed-in browser renders an amber bar. Test L2-W boots with PROCESS_ROLES=web and asserts the status endpoint, the banner, the synthetic and the admin page all break.

## Consequences

The expectation lives where the misconfiguration cannot reach it, and the detector is a query over our own tables (ARR-OPS-05). Fifty sellers seeing an amber bar is a detector that cannot be ignored, which is the correct answer to a failure class whose symptom was 'everything looks fine'. Costs: one small upsert per loop iteration (bounded by writing at most every 15 s per role); a false amber bar during a deploy window is possible and is handled by the threshold being 8x the beat interval; and the required-role set must be updated by migration whenever a new role is introduced, which is the intended friction.
