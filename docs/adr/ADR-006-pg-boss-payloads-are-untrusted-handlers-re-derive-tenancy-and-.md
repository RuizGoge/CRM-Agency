# ADR-006 — ADR-E6 — pg-boss payloads are untrusted; handlers re-derive tenancy and cannot receive a tenant_id

**Status:** accepted (Phase 5, pending GATE 5)

## Context

Schema pgboss is on the versioned RLS exception list: pg-boss owns its own DDL and knows nothing about our session context. That means a job payload carrying a wrong tenant_id would scope every subsequent RLS-protected query to the wrong tenant, and every screen would render perfectly with the wrong rows. The data model left the mitigation open between (a) HMAC-signing payloads and (b) re-deriving tenancy from subject_id via a definer function.

## Options considered

(a) HMAC-sign job payloads, verified by the handler wrapper. (b) Handlers re-derive tenant_id and owner_user_id from subject_id via a SECURITY DEFINER function, ignoring the payload. (c) Both.

## Decision

(b), made unrepresentable rather than merely detectable: the JobPayload<T> type admits ids and scalars only and resolves to never if it contains a tenantId key, so the field does not exist to be trusted. The handler wrapper calls app.resolve_owner(subject_type, subject_id) and sets the three GUCs from that result.

## Consequences

The one way this design could become a cross-tenant hole is closed by a type rather than by a signature check that could be skipped. It changes every handler signature, which is why it is decided here rather than discovered later. The corollary is that job payloads carrying bodies are also impossible — which is exactly what makes the call-merge singleton safe (see ADR-E7). The contrast is documented: event_outbox rows are trusted transport (same transaction, FK-constrained, never leave our schema); pg-boss jobs are not.
