# ADR-043 — ADR-05 — Circuit-breaker staleness is itself the degraded condition; the banner is computed at read time

**Status:** accepted (Phase 5, pending GATE 5)

## Context

ARR-INT-09 requires a tenant-wide degraded flag readable by every signed-in user across every app instance, and explicitly states that if the health probe itself cannot run, the banner must stay red. A breaker in per-process memory cannot satisfy the first requirement; a breaker whose state is only written by the probe cannot satisfy the second, because a dead probe leaves the last written state — which is usually 'closed' — showing green while Aloware is down.

## Options considered

(a) In-memory breaker per process — rejected outright, three processes would disagree and 50 browsers would see different banners. (b) A shared row updated by the probe job, banner reads the stored state — fails the 'probe cannot run' clause silently. (c) A shared row plus a read-time predicate that treats probe staleness as degraded. (d) A watchdog job that monitors the probe — rejected, the watchdog can die too and it adds a second thing to monitor.

## Decision

Option (c). `app.integration_health` is a row; any process may OPEN the circuit on 3 consecutive 5xx/timeouts within 60 s, but only the probe job may CLOSE it on 2 consecutive successes. The banner state is computed as `state='open' OR last_probe_at < clock_timestamp() - interval '5 minutes'`. State changes bump `channel_watermark(tenant_id, ZERO_UUID, 'degraded_banner')`, so delivery to ~50 browsers reuses the existing poll/SSE path with no new channel. Same read-time-expiry shape as break_glass.

## Consequences

A dead worker cannot present a green banner — the failure mode is fail-safe rather than fail-silent, matching the gate's own fail-closed posture. A lucky success on one seller's request cannot close a circuit for the floor. Cost: during a genuine worker restart the banner may show red for up to five minutes with Aloware healthy; that is a false red, which is the correct direction to be wrong, and the copy already tells the seller exactly what to do instead.
