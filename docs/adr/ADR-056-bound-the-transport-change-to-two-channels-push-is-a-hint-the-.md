# ADR-056 — ADR-P1: Bound the transport change to two channels; push is a hint, the poll is the truth

**Status:** accepted (Phase 5, pending GATE 5)

## Context

ARR-UX-11 (non-negotiable) requires Phase 5 to decide the live call-state channel and to declare whichever transport is chosen as a change. ARR-MVP-11 (non-negotiable), 04b 1.10 ('No SSE, no WebSocket'), 03-mvp-definition item 62 and the 03-mvp-stories cut list all forbid a persistent-connection transport unless Phase 5 declares the change. The architecture had made SSE a signed pillar while simultaneously sizing the system against a 690,000 req/day polling floor as if SSE did not exist; the adversary proved both cannot be true, and no arbitration rule existed anywhere.

## Options considered

_(see Context; the rejected alternative is named inline)_

## Decision

Exactly two channels move to push: call_state (owner-scoped, /sse/me) and tenant_banner (tenant-wide, /sse/tenant). Leaderboard, notifications, My Day, board deltas and the Aloware health probe stay on conditional GET at their approved intervals; no row of 04b 1.10's table moves. Push is an accelerator: on both push channels the poller runs at its declared interval unconditionally, and an SSE frame carries {channel, seq} only and can never advance state. No channel may be push-only: a channel declared push-capable must also declare a poll interval that alone satisfies its published latency budget. The tenant_banner poll floor is obtained free by folding its watermark into the existing 5 s notifications ETag. Enforcement is generated from contracts/realtime/channels.yaml (the generator raises on push without poll), a counted push-channel literal in CI, a dependency-cruiser ban on src/realtime/sse importing src/polling, a Revalidator handle type with no stop member, and an L3 test that blocks /sse/** and runs the whole call banner on the poll floor.

## Consequences

Item 62, the stories cut list and 04b 1.10's opening line are amended in writing, with the amended text published. The request floor rises rather than falls: SSE removes zero requests by construction, so the corrected floor is ~898,000 req/day (~31 req/s, ~21% of a 0.5-vCPU Starter, ~18.5 GB/month egress) once the cut wall board is removed and the ARR-UX-11 call-state channel is added; the recommended USD 42.50 rung is unchanged. The public leaderboard's published latency rises from 6.5 s to 10.5 s p95 — which is the number R4.4 already told the demo presenter to narrate. Signed non-negotiable 5's two-legged synthetic check keeps both legs, with leg B re-pointed at tenant_banner because the leaderboard is no longer on push; the alive-and-mute failure it exists for can no longer freeze the money board at all.
