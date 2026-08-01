# ADR-028 — ADR-T7 — Coverage is 100 % branch on a tiny pure-domain surface plus a generated named-assertion registry, never a global percentage

**Status:** accepted (Phase 5, pending GATE 5)

## Context

Jorge validates by behaviour and cannot read tests. A global line- or branch-coverage threshold is the conventional answer and is actively harmful here: it measures execution rather than assertion, a model optimising for a red-to-green transition reaches any threshold by executing code without asserting anything, and the resulting number reassures precisely the person who cannot check it. Meanwhile the brief demands enforced coverage of stage transitions, gates, dedupe, ledger and silo isolation — all of which need a real Postgres and none of which a percentage can express.

## Options considered

(a) A global coverage threshold, e.g. 80 %. (b) Mutation testing over the domain modules. (c) 100 % branch coverage over a deliberately small pure module plus a registry of named required assertions generated from the route table and the ledger-input table.

## Decision

Option (c). src/domain/** contains only pure total functions (annualize, periodKeys, normalizeE164, intakeDedupeKey, complianceVerdictOrder, gateDecision, stageMoveDecision, coldEpisodeKey, healthEnum) and carries a 100 % branch requirement — the only percentage enforced anywhere in the project. Everything else is covered by required-assertions.json, which lists the named behaviours per domain area with their test ids and is generated from the route table and the ledger-input table rather than maintained by hand; a CI test asserts every entry resolves to exactly one non-skipped test. Mutation testing is rejected on the CI minute budget, not on principle.

## Consequences

Adding an endpoint without its cross-silo foreign-id assertion, or a ledger input without its append assertion, fails the build — because the registry regenerates. The percentage that exists is small enough to be real. The cost is that the domain module must be kept genuinely pure; anything that reaches for the database must move to the Testcontainers tier, which is a healthy pressure. Mutation testing should be revisited if the minute budget ever loosens.
