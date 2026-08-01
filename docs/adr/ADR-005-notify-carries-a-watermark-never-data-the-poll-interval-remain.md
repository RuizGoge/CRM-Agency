# ADR-005 — ADR-E5 — NOTIFY carries a watermark, never data; the poll interval remains a floor

**Status:** accepted (Phase 5, pending GATE 5)

## Context

The adversarial review found the failure this stack does not see: NOTIFY delivers only to sessions listening at that instant, with no buffer, replay or cursor. If the dedicated LISTEN connection drops and reconnects — rolling redeploy, node recycle, database maintenance, idle timeout, OOM at 512 MB — every NOTIFY in that window is lost permanently, while the browser's SSE connection stays alive with heartbeats, no reconnection fires, and the transport-in-use metric truthfully reports SSE while delivering nothing. ARR-EVT-23 separately requires the tenant-wide channel's payload to be incapable of carrying lead data.

## Options considered

(a) NOTIFY carries the event payload; SSE forwards it; polling is a fallback only. (b) NOTIFY carries {channel, seq}; the client reacts with a conditional GET; the poll interval runs regardless as a floor.

## Decision

(b), applied universally — including internally, where app.event_emit sends NOTIFY outbox_ready and the relay also polls on a 1 s floor. The SSE frame type is {channel, seq} with additionalProperties:false and a CI test asserting no PII-typed field.

## Consequences

A lost NOTIFY costs latency, not data; the board converges on the next tick. ARR-EVT-23 stops being a payload-review rule and becomes a type that cannot express a lead row. The 8 000-byte NOTIFY payload limit stops being a design constraint. ARR-EVT-24 is restated per channel: p95 < 2 s applies to call state; the leaderboard's honest number is undo_window + guard + delivery ≈ 5.6 s p95 to the floor, imposed by ARR-MVP-10 and unbeatable by any transport, with the seller's own private view updating immediately. The two-legged synthetic check remains mandatory, because a one-legged ETag check passes green while push is dead.
