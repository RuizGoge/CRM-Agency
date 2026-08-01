# ADR-020 — ADR-API-11 — Session lifetime 16 h absolute / 12 h idle, renewed at most hourly

**Status:** accepted (Phase 5, pending GATE 5)

## Context

Sliding sessions are the default in most auth libraries and renew on every request. This product issues roughly 0.5 M authenticated requests per day, almost all of them 5–15 second polls. A session that renews per request produces 0.5 M UPDATEs/day against a small hot table, turning the cheapest endpoint in the system into a write endpoint and producing p95 drift with no visible cause.

## Options considered

(a) Library default sliding renewal. (b) No sliding renewal (fixed expiry; sellers get logged out mid-shift). (c) Absolute 16 h, idle 12 h, updateAge 3600 s.

## Decision

(c). Additionally, no in-process session cache: the 304 path is two index-only lookups inside one transaction (session by token hash, watermark by primary key), which is why 304 p95 <= 80 ms is reachable without a cache tier — and it keeps revocation and user.deactivated instant.

## Consequences

~8 session writes per seller per day instead of ~10 000. Sessions cannot outlive the business day they were created in, which matches the US-business-hours availability target. Mechanism: the value is pinned in one config file and an integration test issues 200 polls and asserts at most one session UPDATE. Cost: two index probes per request instead of a cached lookup — accepted, because both tables live permanently in shared buffers and cache invalidation would be a new correctness surface on the revocation path.
