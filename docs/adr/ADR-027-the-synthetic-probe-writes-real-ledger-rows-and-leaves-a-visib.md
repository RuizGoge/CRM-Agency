# ADR-027 — ADR-T6 — The synthetic probe writes real ledger rows and leaves a visible System Probe seller, rather than building a leaderboard-hiding mechanism

**Status:** accepted (Phase 5, pending GATE 5)

## Context

The two-legged synthetic check must exercise the real money path — app.ledger_append, projection maintenance, watermark bump, ETag derivation, LISTEN/NOTIFY, SSE fan-out — because a probe that writes to a fake table proves nothing about the path that matters. Writing real ledger rows every five minutes into the demo tenant puts a probe seller on the demo leaderboard. The obvious fix is a mechanism that hides a seller from the board.

## Options considered

(a) Probe writes to a synthetic non-ledger table. (b) Probe writes to the ledger and a new projection filter hides the probe user from the leaderboard. (c) Probe writes a +1 cent row and an immediately reversing −1 cent row, and the probe user stays visible on the demo board at $0.00. (d) Probe writes into its own non-demo tenant.

## Decision

Option (c). The probe appends a +1 cent entry and then a reversing −1 cent entry against a permanently seeded probe contact and opportunity in the demo tenant, attributed to a seeded seller named 'System Probe'. Net total stays zero; the seller sits at the bottom of the demo board, visible and labelled. Option (b) is rejected outright: a mechanism that hides a seller from a leaderboard, once it exists in the codebase, is the mechanism that later hides a real seller by accident on a public money board — and this product's entire thesis is that the public number is trustworthy.

## Consequences

Every five minutes, in production, the full money-and-realtime chain is exercised end to end, including exactly-once append, the reversal path, and the pending_watermark term of the ETag that a naive max(seq) ETag would break. The cost is a visible zero-dollar row on the demo board, which is honest, and a seeded probe contact and opportunity that the demo seed must include deterministically. Open sub-item: the probe must use an entry_type and source_event_name already in the canonical 49 — it may not force a fiftieth event name into existence.
