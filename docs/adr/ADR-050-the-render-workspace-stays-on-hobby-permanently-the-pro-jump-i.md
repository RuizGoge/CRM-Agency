# ADR-050 — ADR-S2: The Render workspace stays on Hobby permanently — the Pro jump is prohibited by arithmetic

**Status:** accepted (Phase 5, pending GATE 5)

## Context

The hard ceiling is USD 100/month (ARR-OPS-01, already a build-breaking DoD check that has vetoed features). The 12-month projection is USD 76.50, leaving USD 23.50 of headroom. Render's Hobby workspace is USD 0; Pro is USD 25/month flat and buys unlimited members, 25 GB egress, 1,000 build minutes, SOC 2/ISO reports and 7-day PITR instead of 3.

## Options considered

(a) Budget for Pro as an expected future step. (b) Treat Pro as available headroom to be spent on demand. (c) Prohibit it outright and buy each of its benefits elsewhere or declare it unneeded.

## Decision

(c). USD 76.50 + USD 25 = USD 101.50, which breaks the ceiling with a single line item. Every Pro benefit is either unneeded (one human, no enterprise customer requiring compliance reports, the product has its own audit_log) or bought at USD 0 elsewhere: the 7-day PITR is replaced by an hourly R2 dump of the three immutable tables whose restorability is VERIFIED monthly by a CI job, which is strictly better evidence than a longer window nobody has restored. A second human account on the Render workspace is prohibited as the same jump under a different name.

## Consequences

The budget contains exactly ONE instance escalation (Starter to Standard on one service, +USD 18, landing at USD 94.50) and ZERO workspace escalations. Two instance bumps break the ceiling. Build minutes (500/month on Hobby) become a real constraint that must be alarmed, because exhausting them stops deploys. Tenant #2 is also the moment this prohibition is challenged, since a customer eventually implies a second dashboard user.
