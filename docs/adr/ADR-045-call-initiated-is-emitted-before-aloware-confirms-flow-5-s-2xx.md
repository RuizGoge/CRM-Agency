# ADR-045 — ADR-07 — call.initiated is emitted before Aloware confirms; Flow 5's 2xx-only rule is superseded

**Status:** accepted (Phase 5, pending GATE 5)

## Context

02b-integration-map.md §4 and §4b state that call.initiated is emitted by us before Aloware confirms and reconciled by call.completed on aloware_call_id (ARR-EVT-18). 04-ux-flows.md Flow 5 step D1 states the opposite — emitted only on a 2xx, 'so no phantom attempt is written'. Both are in approved documents and they cannot both be implemented.

## Options considered

(a) Emit only on 2xx — an Aloware 5xx arriving after the seller's handset already rang leaves a lead whose phone rang with no record, corrupting attempt_count, last_activity_at, the 7-day cold rule and the rot badges. (b) Emit before confirmation, inside the transaction that records the attempt, with the external POST dispatched after commit through the outbox, and aloware_call_id nullable and backfilled.

## Decision

Option (b). The 2xx-only line in Flow 5 D1 is superseded and this document records the supersession explicitly rather than leaving two live readings. The Aloware POST sits outside the emitting transaction; a 5xx from Aloware does not erase the attempt record. The partial unique index `call_aloware_uidx ... WHERE aloware_call_id IS NOT NULL` exists precisely so a NOT NULL unique would not forbid the case the design requires.

## Consequences

Every dial that reached a handset is recorded, which is what attempt_count exists for. Cost: a 5xx that occurs before Aloware ever rang anything also produces a call row — a genuine phantom, bounded and visible because the row's state stays `initiated`/`failed` with a null aloware_call_id and the degraded-mode banner explains it. That is a far cheaper error than a silent missing attempt.
