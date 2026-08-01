# ADR-040 — ADR-02 — Push is a hint, poll is the truth: SSE frames carry (channel, seq) only, and the call-state poller always runs during a live call

**Status:** accepted (Phase 5, pending GATE 5)

## Context

ARR-UX-11 records that no channel in the Phase-4 polling contract delivers leg-A answer, leg-B answer or call.completed to the client, and forces Phase 5 to decide the transport. The dangerous failure mode is specific: LISTEN/NOTIFY delivers only to sessions listening at that instant — no buffer, no replay, no cursor — so if the dedicated LISTEN connection drops and reconnects (rolling redeploy, node recycle, DB maintenance, idle timeout, OOM), every NOTIFY in that window is lost while the browser's SSE connection stays alive with heartbeats. No reconnection fires, the fallback never arms, and the `transport-in-use` metric reports SSE and reports the truth: the transport is SSE, it simply delivers nothing.

## Options considered

(a) SSE as sole authority for call state, with polling as an incident-only fallback — rejected: fallback code that only runs during incidents is code first executed in production, under pressure. (b) Polling only at 1–2 s during a live call — meets correctness, misses ARR-EVT-24's sub-2s feel on the highest-visibility surface. (c) Poll as the correctness floor, SSE as an accelerator, with SSE frames carrying no domain payload.

## Decision

Option (c). SSE frames are a closed union of (channel enum, seq bigint, optional uuid) — the client receives 'channel X moved to seq N' and revalidates with a conditional GET under RLS. The call-state poller runs at 2 s for the entire duration of a live call regardless of SSE health: a single-row PK lookup on `channel_watermark`, ~25 rps tenant-wide at 50 concurrent callers. ARR-EVT-24 is restated per channel: p95 < 2 s applies to call state; the leaderboard's honest number is the undo window plus latency.

## Consequences

The incident path is the path that runs every day, so it cannot rot. A fan-out bug cannot leak another seller's data because the frame contains no row — the tenant-wide leaderboard channel included. Cost: a small permanent poll floor (~25 rps of index-only lookups) and a ~50 ms revalidate hop on top of each push. Gate G7 must still prove SSE survives the platform proxy, and the two-legged synthetic check must detect a killed LISTEN connection while browser SSE stays open.
