# ADR-035 — ADR-SEC-06 · Webhooks are admitted and shed, never rate-limited; intake is metered inside the token resolver

**Status:** accepted (Phase 5, pending GATE 5)

## Context

ARR-OPS-02 puts roughly 288,000 polling requests per day on the read path plus 10,000-20,000 webhooks per day in bursts, and Puerta 2 requires surviving 20,000 webhook replays in 60 seconds (333/s) while fifty simulated sellers sustain the polling floor. ARR-INT-12 requires per-source rate limiting on the public intake endpoint as one of the three real controls alongside hashed tokens and the payload vault.

## Options considered

(a) One global request rate limiter across all surfaces. (b) Per-endpoint limits including the webhook endpoint. (c) No limit on webhooks with bounded in-flight concurrency and shed-to-503, plus a per-token meter on intake enforced inside the token resolver.

## Decision

Option (c). Webhooks: no per-minute limit; a bounded in-flight concurrency semaphore sized against the MEASURED Postgres connection ceiling (Puerta 1), returning 503 with Retry-After when saturated. The handler does exactly one vault INSERT, one inbound_webhook_event row, one pg-boss enqueue with singletonKey, and 204. Intake: intake_source.rate_limit_per_minute (default 120) enforced INSIDE app.resolve_intake_token(), which increments its own meter in the same statement that resolves the token; over-limit returns 429 and deliberately does NOT vault the body. Unknown or malformed tokens: 401 with nothing written, metered 60/min per source IP. Authenticated app surfaces are metered in process for abuse only; the two cross-silo privacy oracles are metered durably in tenant_lookup_meter inside their SECURITY DEFINER functions.

## Consequences

POSITIVE: rate-limiting a webhook endpoint converts a provider's recovery burst into a longer retried burst, so shedding with 503 is strictly better — the provider backs off, retries, and nothing is lost; the intake meter cannot be bypassed because there is no other way to resolve a token; in-process buckets are exact when the topology is folded into one process at Escalon 1 and become effectively N-times the limit when split at Escalon 2, which is acceptable for abuse throttling and explicitly NOT acceptable for the enumeration oracles, which is why exactly those two pay for a durable meter. NEGATIVE: the shed path depends on the semaphore bound being sized against a number that has not yet been measured (Puerta 1); the deliberate non-vaulting of rate-limited intake bodies is an exception to write-first and must be documented at the endpoint, justified by the vault existing to make a mapping bug recoverable rather than to archive a flood.
