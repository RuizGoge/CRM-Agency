# ADR-044 — ADR-06 — The ingest edge never returns 4xx for a payload it holds, and admission control bounds concurrency rather than admission

**Status:** accepted (Phase 5, pending GATE 5)

## Context

ARR-INT-04 requires write-first, respond-fast, process-async. ARR-INT-02 says we cannot assume the provider retries. The retry-storm threat is 20 000 webhooks in 60 seconds (333/s) — what a provider does when recovering from our outage. The naive protections (rate limiting with 429, rejecting malformed bodies with 400, returning 500 on internal error) all convert a storm into permanent data loss when the provider does not retry.

## Options considered

(a) Standard rate limiter returning 429 above N rps — rejected as the primary control: at 333/s from a possibly-non-retrying provider, a 429 is a lost webhook and the only recovery is the reconciliation backfill, whose API may not exist. (b) Unbounded acceptance — rejected, an unbounded in-flight set exhausts the pool and takes the web role down with it in the folded topology. (c) A bounded FIFO with a fixed in-flight limit against a single-round-trip SQL function, shedding with 429+Retry-After only at the queue-depth cap, and returning 401 only for an unknown endpoint token where nothing was stored.

## Decision

Option (c). `app.webhook_ingest()` performs the vault write, the transport-dedupe insert and the pg-boss enqueue in ONE transaction and ONE round trip. Responses: 204 once bytes are durable (accepted or duplicate), 202 for signature-invalid (stored and dead-lettered), 429 only at the queue-depth cap, 401 only for an unknown token. 5xx is never returned deliberately. Signature-invalid payloads are stored and dead-lettered, never rejected — `signature_valid` is nullable on purpose because the provider may not sign at all.

## Consequences

A replayed delivery is a sub-millisecond 204 via the transport unique index, so a 20k recovery storm never touches the domain. Load is shed at the last possible point instead of the first. Cost: we accept and store payloads we may never be able to authenticate, so `raw_payload_vault` carries adversarial content — bounded by a hard 256 KiB body cap, a pure never-throwing shallow extractor with a property test, and the vault's own short retention clock.
