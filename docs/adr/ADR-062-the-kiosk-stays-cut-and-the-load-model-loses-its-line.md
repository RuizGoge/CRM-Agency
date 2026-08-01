# ADR-062 — ADR-P7: The kiosk stays cut, and the load model loses its line

**Status:** accepted (Phase 5, pending GATE 5)

## Context

The kiosk/TV route and TV takeover were cut in 03-mvp-stories section 0; ARR-PRV-06 killed the kiosk token, which 02-functional-map called the highest-risk artifact in the product. But 02b section 4 still names 'Kiosk/TV full-screen view' as a consumer of leaderboard.rank_changed and celebration.triggered, ARR-EVT-24 still says 'including the kiosk', and the capacity model still budgets 17,280 req/day for a wall board. With no transactional email and 16-hour sessions there is no credential story for an unattended display.

## Options considered

_(see Context; the rejected alternative is named inline)_

## Decision

Out, completely: no kiosk, no wall board, no TV route, no unauthenticated data surface. Remove the 17,280 req/day line from the load model; strike the kiosk consumer text from 02b section 4 and 'including the kiosk' from ARR-EVT-24; remove kiosk_only from celebration.triggered's broadcast_scope and carry the literal owner_only instead. Enforce with an asserted count of zero kiosk% consumers, a defineEndpoint audience union with no public member, and a route-registry assertion restricting audience 'public-ingress' to exactly the two ingest paths.

## Consequences

The corrected request floor drops by 17,280 req/day before the call-state channel adds 225,000. A cut feature can no longer grow back through a load model or a catalog consumer column. Re-entry is a named V1.1 decision requiring a credential design for an unattended display, not a drift.
