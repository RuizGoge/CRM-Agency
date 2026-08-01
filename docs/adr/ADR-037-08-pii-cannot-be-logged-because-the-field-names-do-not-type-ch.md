# ADR-037 — ADR-SEC-08 · PII cannot be logged because the field names do not type-check

**Status:** accepted (Phase 5, pending GATE 5)

## Context

Sentry, Axiom and Better Stack are third-party systems with their own retention, outside our CCPA erasure controls. A phone number captured in a Sentry breadcrumb is a copy of PII we cannot delete on request. Jorge cannot review diffs, and console.log(req.body) while debugging a webhook is the single most natural thing for a code generator to write.

## Options considered

(a) A documented convention plus code review. (b) A regex-based redaction layer in the log transport. (c) A single logger module whose accepted field-name keys are a generated union type, plus a transport-level scrubber, plus typed job payloads.

## Decision

Option (c), all three layers. src/log is the only permitted logging entry point; ESLint bans console.* and dependency-cruiser fails the build if anything else imports the transport. The logger accepts a LogFields record whose KEY type is a generated union of allowed names (correlation_id, tenant_id, owner_user_id, actor_user_id, event_id, event_name, subject_type, subject_id, verdict, reason_code, moved_via, latency_ms, sqlstate, outcome) and whose value type is string | number | boolean | Uuid | Iso8601. Sentry beforeSend and beforeBreadcrumb strip request bodies, cookies and auth headers and drop E.164 and email patterns from extra, with a unit test that plants a phone number in five nesting positions and asserts none survives. pg-boss payload types are generated from the consumer registry and a CI test asserts none contains a denylisted field name. Postgres log_statement is 'none' and no slow-query log captures bound parameters.

## Consequences

POSITIVE: log.info({ phone: x }) does not compile, so the guarantee holds without anyone remembering it — which is the only kind of guarantee that survives a project with no code review; every incident stays fully reconstructible from uuids plus the vault plus audit_log, and that reconstruction requires an admin-scoped audited read rather than a log search, which is the access boundary working as intended. NEGATIVE: debugging is measurably harder — a support question that would be answered by grepping a log line for a phone number now requires an audited admin lookup, and reading a raw vault body itself writes an audit row. Adding a legitimate new log field requires editing the generated union, which is friction by design.
