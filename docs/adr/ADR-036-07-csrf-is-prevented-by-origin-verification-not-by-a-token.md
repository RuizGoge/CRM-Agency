# ADR-036 — ADR-SEC-07 · CSRF is prevented by origin verification, not by a token

**Status:** accepted (Phase 5, pending GATE 5)

## Context

ARR-UX-02 rules that a pending Class-O board move must be flushed on tab close via navigator.sendBeacon, and that sendBeacon can set neither an Authorization header nor an arbitrary Content-Type — which forces the session onto an httpOnly cookie and therefore makes CSRF a live concern on every state-changing route including the move endpoint.

## Options considered

(a) Synchronizer or double-submit CSRF token, threaded through the beacon body. (b) SameSite=Strict cookie. (c) SameSite=Lax plus mandatory Sec-Fetch-Site / Origin verification on every state-changing request.

## Decision

Option (c). Cookie is __Host- prefixed, Secure, HttpOnly, SameSite=Lax. Every state-changing request is rejected with 403 unless Sec-Fetch-Site is same-origin, falling back to an Origin allowlist check when the header is absent. A cross-origin POST carrying a valid session cookie is asserted to receive 403 by test.

## Consequences

POSITIVE: no second secret to mint, rotate, store or thread through a beacon body — which matters disproportionately here because a token the beacon must carry is one more thing the code generator can get subtly wrong on the one code path that only executes during tab close and is therefore never exercised in normal testing; SameSite=Lax already blocks cross-site form POSTs, and the origin check closes the remainder. NEGATIVE: SameSite=Strict was rejected because it breaks the notification deep-link flow; the control depends on Sec-Fetch-Site or Origin being present, so the fallback allowlist path must exist and must be tested; a non-browser client (there are none in the MVP) would need an explicit exemption, which does not exist and must not be added casually.
