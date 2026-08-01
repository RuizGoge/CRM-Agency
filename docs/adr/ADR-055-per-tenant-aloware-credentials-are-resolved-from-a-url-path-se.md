# ADR-055 — ADR-S7: Per-tenant Aloware credentials are resolved from a URL path segment, decided now and built at tenant #2

**Status:** accepted (Phase 5, pending GATE 5)

## Context

Aloware credentials (signing key, API token, base URL) are today a single process-level environment variable. At tenant #2 this inverts the authentication ordering: app.webhook_ingest() cannot verify a signature without knowing which tenant sent the webhook, and the only thing that identifies the tenant on an Aloware webhook is the destination number — which requires reading aloware_number_mapping BEFORE signature verification. Identify-then-authenticate is a worse posture than authenticate-then-identify and it puts an unauthenticated read in front of the trust boundary.

## Options considered

(a) Resolve the tenant from the destination number before verifying, accepting the inversion. (b) Give every tenant a distinct webhook secret and try each in turn (an oracle and an O(N) cost on the hot path). (c) Put the tenant in the URL: /webhooks/aloware/{tenant_slug}, backed by a tenant_integration_credential table keyed (tenant_id, provider) — the exact pattern intake_source already uses with its token, where the token is what resolves the tenant.

## Decision

(c). Not built now — single-tenant today, and building it now adds a table and a route shape with zero MVP payoff — but the SHAPE is decided now and recorded, because the alternative is discovering the ordering inversion under delivery pressure with a customer waiting.

## Consequences

When tenant #2 arrives, the change is additive (a new table, a path segment, a credential lookup before verification) rather than a rework of the ingest trust boundary. It also means the single-tenant webhook route should be written as /webhooks/aloware/{tenant_slug} from day one with a constant slug, so the split is a configuration change rather than a route change — the same trick as the intake CNAME.
