# ADR-021 — ADR-API-12 — ARR-EVT-24's 'p95 < 2 s realtime' is restated per channel; the leaderboard's honest number is the undo window plus transport

**Status:** accepted (Phase 5, pending GATE 5)

## Context

ARR-EVT-24 requires p95 < 2 s from the Closed-Won drop to every client. ARR-MVP-10 requires the public leaderboard projection to exclude ledger entries younger than the undo window (5000 ms plus a 500 ms projection guard). These cannot both hold: no transport can beat an exclusion window. The ARR flags this as a contradiction Phase 5 must close before it reaches CI.

## Options considered

(a) Keep 2 s and let the leaderboard budget be permanently red. (b) Drop the undo-window exclusion so the 2 s number holds. (c) Restate the budget per channel and publish the honest end-to-end number.

## Decision

(c). Live call state keeps p95 < 2 s and SSE meets it — that is the channel the number was really about. The leaderboard's honest figure is undo window + guard + transport: ~5.5–6 s p95 on SSE, up to ~10.5 s on the polling fallback. (b) is rejected outright because the exclusion is what guarantees no viewer ever sees a number that later corrects itself.

## Consequences

The demo claim 'the board moves while the call is still warm' survives at ~6 s and must be stated at that number rather than at 2 s. Phase 5 publishes this in the single numbers table alongside the DoD-9 amendments (API p95 300 ms not 400 ms; the 5 s poll as the one sanctioned exception to 'no loop faster than 30 s'). Anyone later measuring the leaderboard against 2 s will otherwise conclude the system is broken and 'fix' it by removing the exclusion — which is exactly the failure this ADR exists to prevent.
