# ADR-087 — ADR-G9 — Jobs carry a latency-criticality class with reserved worker concurrency, and the ingest edge byte-scans for STOP

**Status:** accepted (Phase 5, pending GATE 5)

## Context

ARR-EVT-13 says loss OR DELAY of the message.received -> consent.updated hop is a legal failure. The bulkhead isolates ingest CPU from web CPU and does nothing for the worker queue: during the 20,000-message recovery storm the design itself sizes, a STOP is job number 14,000 in a FIFO drain while the T-1h reminder fires against a suppression_list that does not yet contain the row. Job classification is weight ∈ {light, heavy}, a CPU axis with no latency axis. singletonKey serializes; it does not prioritize.

## Options considered

_(see Context; the rejected alternative is named inline)_

## Decision

Add job_registry.priority NOT NULL ∈ {compliance, interactive, bulk}, seeded from the same generated file as weight, with security.harden() raising on an unclassified row. The worker runs separate fetch loops with a RESERVED slot for compliance that bulk may never occupy. At the ingest edge, a parse-free byte scan of the raw body for the carrier-mandated STOP keyword set sets the merge job's class to compliance; the scanner is pure, property-tested, and forbidden by dependency-cruiser from importing src/domain or src/db so it cannot grow into a parser. G6/P24 gains a protected assertion that a STOP injected during the 333/s replay reaches suppression_list within 5 seconds and blocks a dial at T+5s.

## Consequences

Positive: the ARR-MVP-18 5-second lead SLA gets the same axis for free; the enforcement mechanism (harden() on an unclassified registry row) is already proven by weight. Negative: a STOP arriving base64-encoded or in a field not present in the raw bytes misses the sniff and merges at interactive priority — declared as a bounded residual, not hidden.
