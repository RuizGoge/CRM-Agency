# ADR-053 — ADR-S5: audit_log is permanent-in-Postgres with no archive tier, and is accepted as the dominant long-run storage line

**Status:** accepted (Phase 5, pending GATE 5)

## Context

ARR-PRV-03 gives audit_log no expiry: every consent, suppression, earnings and ownership write, every gate verdict, every dial attempt, every export, every break-glass action and every supervisor book view writes a row, at 10,000-30,000 rows/day. event_log's high-volume tail leaves Postgres at 13 months via the R2 archive; audit_log's does not. At ~500 bytes all-in that is ~3.7 GB/year that never leaves and, on Render, never shrinks (~USD 0.30/GiB/month, unshrinkable once grown). By year 3 audit_log alone is ~11 GB — larger than the permanent slice of the event store.

## Options considered

(a) Leave it permanent and pay (~USD 1.10/month/year of accumulation). (b) Give audit_log the same two-tier residence as event_log, archiving an 'operational' action set (dial attempts, happy-path gate verdicts) to R2 while compliance-bearing actions stay permanent. (c) Shorten the book.viewed dedupe bucket or drop low-value actions.

## Decision

(a) for the MVP, with the growth explicitly alarmed rather than assumed: a monthly job records pg_total_relation_size per relation and Better Stack alerts when total DB size crosses 60% of the plan's included storage or when the 90-day linear projection crosses 100%. Option (b) is the correct escalation and its trigger is that alert, not a calendar.

## Consequences

The cheapest line to compress later is the one with the strongest legal argument for keeping it, which is exactly why the decision is written down instead of drifting. Splitting audit_log by action class would require a ruling on which actions are 'operational', and making that ruling under storage pressure is worse than making it deliberately. The compensating fact is that audit_log is monthly-partitioned, so option (b) is a DETACH-and-COPY of existing partitions, not a rewrite.
