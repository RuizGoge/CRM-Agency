# ADR-063 — ADR-P8: One name for the fold variable, one spelling for the two contractual URLs, one registry for every served route, one predicate for the keystone

**Status:** accepted (Phase 5, pending GATE 5)

## Context

The sections name the fold variable PROCESS_ROLES and ROLES; they spell the two externally-called URLs three different ways with three credential names, while the CI grep gate that guards them keys on the literal '/hooks/'; the route registry scans only routes/api/**, excluding the one SSR route that serves real board data, /sse/**, /auth/** and both ingress families from all five registry-driven suites; and security.harden() loops only schemas app and ref while Drizzle's default schema is public.

## Options considered

_(see Context; the rejected alternative is named inline)_

## Decision

ROLES is the only name, with a boot failure on unknown tokens and a grep gate on the literal PROCESS_ROLES. The two external URLs are https://in.<domain>/webhooks/aloware/v1/{endpoint_token} and https://in.<domain>/intake/v1/{source_token}, both on in.<domain> from day zero, both versioned, published in one generated table consumed by both the URL builder and the grep gate; the Aloware credential is endpoint_token, hashed at rest. The route registry covers every served route and the build fails on any module in either tree whose default export lacks the factory brand. security.harden() raises on any relation in any schema not on the versioned exception list, the pre-deploy job runs REVOKE ALL ON SCHEMA public FROM crm_app, and the boot assertion verifies relforcerowsecurity on a canary relation set. A pg-boss payload cannot contain a tenant id; the handler derives context from app.resolve_owner(), closing the data model's open ruling in favour of re-derivation. The unauthenticated surface is five routes and /readyz is rate-limited because it executes a query.

## Consequences

The grep gate and the thing it guards are finally written in the same dialect, so the bulkhead's hostname property is enforceable. The cache suite (signed non-negotiable 14) finally covers the one HTML response carrying a seller's board, and the silo suite covers the SSR route reached by URL, which is the path ARR-UX-04 names. Adversary Scenario C is closed at the keystone rather than compensated. The Security section's five-execution-context claim becomes true rather than aspirational.
