# ADR-070 — ADR-R7 — Jobs carry a latency-criticality lane with reserved capacity, and the enqueuer cannot choose it

**Status:** accepted (Phase 5, pending GATE 5)

## Context

Job classification was weight in {light, heavy}, a CPU axis with no latency axis. During a 20,000-message provider replay a TCPA STOP sits at position 14,000 of a FIFO drain while the T-1h reminder fires and the compliance gate reads a suppression list that does not yet contain the row. ARR-EVT-13 states that loss OR DELAY of that hop is a legal failure, and ARR-MVP-18 puts a 5-second SLA on lead.created, the number the entire lead spend is measured against. The ingest bulkhead isolates ingest CPU from web CPU and does nothing for the worker queue; singletonKey serialises and does not prioritise.

## Options considered

_(see Context; the rejected alternative is named inline)_

## Decision

ref.job_registry gains priority app.job_priority NOT NULL (compliance | interactive | bulk), seeded from the same generated file as event_consumer, with harden() raising on any unclassified row and on any queue name present in the built bundle with no registry row. Lanes are separate fetch loops with their own connections and reserved concurrency, derived from the registry; a worker process whose lane set omits compliance exits non-zero at boot; the generator emits one typed enqueue helper per job so the lane is looked up rather than chosen. The ingest edge selects the lane for inbound messages with one pure, total domain function over the first 320 bytes of the body, and the merge job's inline consent+suppression append recovers any mis-classification.

## Consequences

A bulk backlog cannot starve the STOP chain or the ping-post lead, and the property is a reserved fetch loop rather than an integer priority column. T3 splits into per-lane thresholds (compliance 15 s pages, interactive 60 s pages, bulk 30 min informational), all computed from our own tables. Test L2-P prices the storm as a build-breaking assertion. Costs: three fetch loops mean three connections per worker process, which must be included in the pool arithmetic against the measured connection ceiling; and lane selection at the edge is a byte-level keyword sniff, so an encrypted or renamed provider body field degrades a STOP to interactive latency — recorded as a residual risk rather than claimed closed.
