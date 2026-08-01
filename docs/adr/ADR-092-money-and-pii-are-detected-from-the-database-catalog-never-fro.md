# ADR-092 — ADR-G14 — Money and PII are detected from the database catalog, never from a column name

**Status:** accepted (Phase 5, pending GATE 5)

## Context

Signed non-negotiable 4 requires four layers of money typing; the shipped lint and gate both key on a Money-typed value OR a *_cents field name, so a new column named premium_annual typed number passes tsc, passes the lint and passes every test. The same name-pattern weakness applies to ARR-PRV-05's requirement that export masking be driven by a machine-readable PII field classification rather than a hand-maintained per-report list.

## Options considered

_(see Context; the rejected alternative is named inline)_

## Decision

Introduce security.column_classification(schema, table, column, pii_class, value_kind, mask_strategy) with security.harden() raising on ANY unclassified column of any relation in app — so a migration that adds a column without classifying it fails the deploy. S15 is rewritten to iterate catalog columns with value_kind='money' and assert the corresponding TypeScript property is Money; S15b asserts the reverse direction. ESLint bans type assertions to Money outside src/money. app.export_build() takes its mask set from the same catalog and cannot select an unclassified column.

## Consequences

Positive: one catalog closes the money-type hole and the export-masking requirement, and the classification cannot go stale because the deploy refuses; the column name becomes irrelevant to both. Negative: every new column now requires a classification row in the same migration, which is real friction on every schema change — accepted, because it is the same friction security.table_registry already imposes at table granularity and that mechanism is the keystone of the isolation design.
