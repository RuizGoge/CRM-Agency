# ADR-072 — ADR-R9 — Every served route goes through its factory or it is not routed at all

**Status:** accepted (Phase 5, pending GATE 5)

## Context

'Every file under routes/api/** exports the result of one factory' is a convention: React Router will happily serve a hand-written loader in that tree, and the generator that scans and reads declared metadata had no stated behaviour for a module it cannot read. Separately, the five registry-driven suites iterated a registry built by scanning routes/api/** only, which excludes the one HTML response carrying a seller's real board, every routes/ui/** document, /sse/**, /auth/**, /intake/**, /webhooks/**, /healthz and /readyz — so the cache suite did not cover the SSR board and the silo suite did not cover the path ARR-UX-04 names by name.

## Options considered

_(see Context; the rejected alternative is named inline)_

## Decision

The factory returns an object carrying a module-private unique-symbol brand that cannot be constructed elsewhere. The route-registry generator is a build prerequisite (the server bundle imports the generated registry) and THROWS on any module in routes/api/** lacking the brand, any bare loader/action export in that tree, any loader/action in routes/ui/** whose path is not in ref.ui_loader_whitelist, and any module it cannot import. The framework route table is generated from the registry rather than from file conventions, and the registry covers every served tree with a declared surface discriminant (json | document | stream | ingress | health) that the five suites honour per surface.

## Consequences

A hand-written loader is not merely lint-flagged: it is not routed, so it 404s in E2E — a screen symptom, not only a build symptom. The SSR board response is finally covered by the Cache-Control suite (signed non-negotiable 14) and by the silo suite via the listing/canary probe, and /sse/** is covered by all five. Cost: the generator becomes load-bearing for the build, which is intended; and health and auth routes need explicit sealed declarations of why they carry no silo probe.
