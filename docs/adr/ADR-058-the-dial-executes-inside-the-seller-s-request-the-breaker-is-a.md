# ADR-058 — ADR-P3: The dial executes inside the seller's request; the breaker is a row

**Status:** accepted (Phase 5, pending GATE 5)

## Context

The architecture's own text says the 5-15 second two-legged silence is a UI state problem and 'must never be modelled as an async job the seller waits on', and its sequence diagram then dispatched the outbound POST from the outbox relay on the worker. That breaks ARR-INT-03 (synchronous return within budget or fall to degraded mode), ARR-MVP-26 (10-second client-visible timeout opening the pre-filled Log-a-call form), ARR-INT-09 (breaker opens on 3 consecutive failures inside 60 s and reaches every signed-in browser) and Flow 5 D1/D2, because the browser already holds its 200 and the failure is observed by a process that renders nothing.

## Options considered

_(see Context; the rejected alternative is named inline)_

## Decision

POST /api/calls executes the two-legged dial inside the request, returning when the provider call resolves or the 10 s timeout fires. The dial POST happens after COMMIT and outside any database transaction, so a provider hang holds a socket and never a Postgres connection. call.initiated is still emitted before confirmation from inside the recording transaction (ARR-EVT-18, 02b 4b correction 1) and aloware_call_id is still backfilled. The registry row comms.aloware_dial is deleted and its absence asserted; alowareDial() requires a RequestScoped capability token that job contexts cannot mint, so calling the dialer from a job does not compile. The breaker is app.integration_health, written by the dialling request via a definer, opened by any process, closed only by the probe job, with read-time probe staleness (last_probe_at older than 5 minutes reads as degraded). Banner, button labels and breaker state come from one read and reach every browser on the tenant_banner channel with a guaranteed 5 s poll floor.

## Consequences

04b 3.4's single '(gate + dial) p95 < 300 ms' row is superseded: the gate verdict keeps its 300 ms budget, and the total is 300 ms plus the Gate-2-measured Aloware ack, capped by ARR-MVP-26's 10 s timeout. The relay's dispatch latency no longer needs a budget for the dial. A worker_heartbeat row plus a worker-absent banner is added on the same channel, converting the fold's highest-impact silent failure into a symptom on every seller's screen.
