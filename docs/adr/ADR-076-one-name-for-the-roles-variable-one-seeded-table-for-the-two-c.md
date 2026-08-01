# ADR-076 — ADR-R13 — One name for the roles variable, one seeded table for the two contractual URLs

**Status:** accepted (Phase 5, pending GATE 5)

## Context

The API section names the fold variable PROCESS_ROLES and the Aloware section names it ROLES; the failure mode of reading the wrong one is a process that mounts its default set, silently. The two externally-called surfaces appear in three incompatible spellings across three sections (/webhooks/aloware/v1, /hooks/aloware/{endpoint_token}, /webhooks/aloware/{path_secret}), and the CI grep gate keys on the literals /hooks/ and /intake/, so it does not fire on /webhooks/. These are the URLs handed to lead vendors and registered in Aloware, and ARR-MVP-18 and ARR-INT-12 make them contractual.

## Options considered

_(see Context; the rejected alternative is named inline)_

## Decision

PROCESS_ROLES is canonical, read by exactly one generated config module, with NO default: missing exits non-zero, the legacy name ROLES present at all exits non-zero naming the correct variable, and any unknown APP_-prefixed variable exits non-zero. The canonical URLs are POST https://in.<domain>/webhooks/aloware/v1/{endpoint_token} and POST https://in.<domain>/intake/v1/{source_token}, with one credential vocabulary (endpoint_token, source_token; path_secret struck), published once in the seeded, sealed ref.external_surface table from which the URL builder, the registry's ingress rows and the grep gate's pattern are all generated. The gate matches the PATTERN /\/(webhooks?|hooks|intake)\// outside the generated module.

## Consequences

A dashboard misconfiguration becomes a failed deploy, which is the loudest and cheapest available signal, instead of a process quietly mounting the wrong families. The grep gate fires on every spelling including ones nobody has invented yet, and an L2 test plus a production synthetic assert table, builder and deployed route table agree. Cost: introducing the version segment into the Aloware webhook path is a one-time registration change with the provider, which must happen before any vendor or provider URL is issued — cheaper now than after.
