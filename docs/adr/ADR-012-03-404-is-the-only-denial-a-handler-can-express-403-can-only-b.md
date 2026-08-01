# ADR-012 — ADR-API-03 — 404 is the only denial a handler can express; 403 can only be produced by SQLSTATE 42501 or by a pre-record request rejection

**Status:** accepted (Phase 5, pending GATE 5)

## Context

ARR-UX-04 and ARR-PRV-04 require cross-silo access to return an owner-scoped not-found byte-identical to a genuine 404, on routes, search and deep links, including admin-only routes. Distinctly, a supervisor with legitimate read access who attempts a write gets 403 'Supervisors have read-only access'. The ARR records that five stories apply 403 where 404 is required and that this inconsistency 'will open an enumeration oracle' if an implementer picks the wrong one. A rule stating which to use is not a mechanism.

## Options considered

(a) Document the rule and test each endpoint by hand. (b) A middleware that rewrites 403 to 404 unless the caller is a supervisor (fragile; the rewrite needs to know what the handler knew). (c) Remove the ability to express 403 from handler code entirely: handlers throw from a union whose Forbidden constructors are module-private, and 403 is produced only by translating SQLSTATE 42501 from the RLS WITH CHECK failure.

## Decision

(c). `SupervisorReadOnly` and `AdminCannotWriteSellerRecords` are constructed only in src/db/translate-sqlstate.ts, which dependency-cruiser confines to src/db/**. Handlers can express exactly one denial: NotFound(), whose body is a frozen constant with no id echo, no timestamp and no trace id. Refinement recorded: 403 also covers request-level rejections that fire before any record is resolved (CSRF origin, missing admin MFA) — no record was looked at, so nothing can be inferred.

## Consequences

A 403 in this system can only originate from an actual policy violation on a row the caller was already permitted to read; it is structurally impossible for a handler to hand-write a 403 and thereby confirm a record's existence. The timing side channel closes for free, because a genuine 404 and an owner-scoped not-found are the same query returning zero rows against the same index. Cost: every write path must attempt the write and translate the error rather than pre-checking permission — which is correct anyway (a pre-check is a TOCTOU race), but it means the SQLSTATE translation layer is load-bearing and must be covered by the restore-drill suite.
