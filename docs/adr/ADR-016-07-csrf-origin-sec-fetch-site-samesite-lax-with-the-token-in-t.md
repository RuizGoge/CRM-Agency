# ADR-016 — ADR-API-07 — CSRF: Origin/Sec-Fetch-Site + SameSite=Lax, with the token in the body on the one beacon-capable endpoint

**Status:** accepted (Phase 5, pending GATE 5)

## Context

ARR-UX-02 requires the pending Class-O stage move to be flushed on pagehide via navigator.sendBeacon, which cannot set headers. A conventional header-based double-submit CSRF token therefore cannot travel on that request. The predictable resolution under time pressure is to exempt the endpoint from CSRF — on the endpoint that moves money.

## Options considered

(a) Exempt POST /api/opportunities/:id/move from CSRF. (b) Put the CSRF token in a query parameter (leaks into logs, proxies and Referer). (c) Accept the token in the request body for endpoints declared beaconCapable, and in the X-CSRF-Token header everywhere else. (d) Rely on SameSite=Strict alone.

## Decision

(c), on top of three other layers: safe methods are safe by type (a GET handler receives a read-only DB handle, so a state-changing GET cannot compile), an Origin/Sec-Fetch-Site check on every unsafe method that fails closed before any record is resolved, and SameSite=Lax. Lax rather than Strict because Strict withholds the cookie on top-level cross-site GETs and breaks the notification deep-link path ARR-UX-04 requires. A CI test asserts that every beaconCapable endpoint declares csrf:'body' and carries a csrf key in its input schema, and that no other endpoint accepts a body token.

## Consequences

CSRF holds on the beacon path without an exemption. Recorded trap: the beacon posts application/json, which is not CORS-safelisted; same-origin requests are not subject to CORS so this is fine in production, but a dev setup with Vite on :5173 and the API on :3000 makes it cross-origin, the preflight fails, sendBeacon cannot preflight, and the flush silently does nothing — which a model would then 'fix' by changing the content type or dropping the token. Mitigation: the dev server proxies /api and /auth so dev and prod are one origin, plus a startup assertion on origin equality.
