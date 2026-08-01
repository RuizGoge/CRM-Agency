# ADR-057 — ADR-P2: The celebration is client-timed and owner-scoped; delete the delayed job

**Status:** accepted (Phase 5, pending GATE 5)

## Context

04b deleted the --time-celebration-delay token on purpose ('one timer, one event, no race, no drift'), D3-05 requires the confetti to render between T+4,900 ms and T+5,100 ms exactly once, US-9.8 requires once per opportunity forever and no replay if the tab closed, and 04b 1.3 scopes the celebration to the closer's own screen. The architecture modelled it as a pg-boss delayed job with at-least-once delivery and a tenant-wide broadcast, which re-introduced the deleted second timer, could not hold plus/minus 100 ms in a folded process, and had no way to know the tab was gone. The signed thesis Puerta 10 speaks of a tenant-wide server broadcast, which collides with 04b 1.3.

## Options considered

_(see Context; the rejected alternative is named inline)_

## Decision

One timer, owned by the client: the undo window's own, started when the win gate's 200 is painted. Everything the celebration renders arrives in that 200, so no network is on the D3-05 render path. The pgboss consumer celebration.broadcast is deleted and its absence is asserted by name; celebration.triggered carries the payload literal broadcast_scope='owner_only'. What the floor sees is the leaderboard re-rank on its own 5 s channel, which is a different fact with a different budget. 'Once forever' and 'no replay' are enforced by app.celebrate_once(), a SECURITY DEFINER conditional UPDATE whose predicate refuses a claim before the window closes, after a 30 s grace, or when a reversal exists for that source_event_id; and by a celebration_token type that is not assignable to Jsonable, so persisting it does not compile. Puerta 10 is answered with two named keys from one source: undo_window_ms=5000 (client timer, projection predicate, celebrate_once) and undo_projection_guard_ms=500 (public projection predicate only).

## Consequences

Adversary finding 1.8 (relay crash producing a second celebration enqueue) evaporates because no enqueue exists. The celebration no longer depends on the worker role, shrinking the missing-worker blast radius. The only possible failure mode is no confetti, never late confetti. Puerta 10's assertion changes shape: the fourth SQL representation of 5,000 ms is now the predicate inside app.celebrate_once() rather than a pg-boss delay, and the drift test covers two named keys.
