# ADR-091 — ADR-G13 — SMS-dark is the CI baseline and SMS-live is the variant

**Status:** accepted (Phase 5, pending GATE 5)

## Context

ARR-MVP-27 is non-negotiable: the full acceptance suite must pass a second time with sms_enabled=false with no path erroring. The Testing section declares one matrix axis, TOPOLOGY. Given ARR-CMP-09 (10DLC in flight, launch is SMS-dark), the configuration the product will actually launch in is the one configuration never tested end to end, and adding a full second axis does not fit the 2,000-minute budget.

## Options considered

_(see Context; the rejected alternative is named inline)_

## Decision

Invert the default: sms_dark is the baseline for pre-merge and for both nightly topologies (zero additional minutes), and sms_live becomes a single weekly pass on the split topology (+8 min x 4 = +32 min/month; committed 1,680 of 2,000, reserve 16%). The flag is a tenant column so the suite flips a row and there is nothing to inject; ESLint bans process.env.SMS*, dependency-cruiser bans a flags module, a prosrc gate requires app.compliance_check to reference sms_enabled, and alowareSms.send() requires a GateVerdict token so a route that skips the gate does not compile. 'No path erroring' becomes a global fixture assertion of zero 5xx plus zero failed scheduled jobs plus a non-zero count of 'skipped: sms_disabled' terminals.

## Consequences

Positive: the launch configuration is the tested configuration, and the minute arithmetic is republished so the budget stays falsifiable. Negative: SMS-live regressions are caught weekly rather than nightly, which is the correct trade while the tenant is dark and must be re-evaluated the week 10DLC is approved.
