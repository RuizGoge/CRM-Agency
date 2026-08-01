# ADR-060 — ADR-P5: One table of numbers, and a SECURITY DEFINER public leaderboard read to make it achievable

**Status:** accepted (Phase 5, pending GATE 5)

## Context

Three approved arithmetics are mutually inconsistent: R6's 'board re-rank < 5 s' against R1.3's 5 s exclusion plus a 5 s poll (with R4.4 in the same Part I already narrating '~10 seconds'); ARR-UX-08's 250 KB bundle against ARR-MVP-25's 2.0 s TTI (which needs ~120-150 KB); and ARR-EVT-24's p95 < 2 s to every client, which no transport can meet under ARR-MVP-10. Separately, the adversary found that the pending-exclusion CTE and the leaderboard ETag are computed under the reader's own RLS scope, so the public board is correct only for the seller who made the sale, fifty sellers compute fifty ETags, and for forty-nine of them the ETag does not change when the row ages out.

## Options considered

_(see Context; the rejected alternative is named inline)_

## Decision

Publish one table (N1-N20) that is the only set of numbers going to CI or alerting, with a companion list of superseded texts by document and locator. Move the public read into app.leaderboard_read(period), SECURITY DEFINER, returning only (user_id, display_name, avatar_ref, total_cents, rank, is_inactive, etag), computing the exclusion and the ETag tenant-wide; crm_app loses SELECT on leaderboard_projection and on the public path to earnings_ledger. The ETag is hash(max_seq, roster_seq, next_eligibility_epoch), so it changes exactly twice per win and once when a roster change occurs, and never freezes. For the bundle/TTI pair, publish a rule rather than a number: perf-budgets.json ships null, the build fails on a null budget, Gate 8's measurement fixes both entries, and from then on they may only decrease (enforced by a VCS-layer comparison against main, not by a reviewer), under hard ceilings of 250 KB gzip and 3,000 ms.

## Consequences

N1 publishes 11,000 ms hard / 10,500 ms p95 for public leaderboard visibility and marks R6 superseded by R1.3+R4.4 — the honest number was already in the approved Part I. ARR-EVT-24 survives only on call_state at p95 <= 2,000 ms, which forces the call-state poll to 2,000 ms and corrects sec-3's assertion of 5,000 ms. ARR-MVP-25 and ARR-UX-08 are both marked superseded-by-measurement so neither can be cited as satisfied. ARR-EVT-23's restricted-payload requirement is obtained as a function return type. Two named rebuild paths replace the ambiguous 'one job': app.replay() (raising on inline consumers) and app.leaderboard_rebuild(period).
