# ADR-046 — ADR-08 — Speed-to-lead stops on call.completed with a connected or voicemail outcome, not on the tap

**Status:** accepted (Phase 5, pending GATE 5)

## Context

Four separate specs bound first-touch latency to the dial tap. 02b §4b correction 2 and 04-ux-flows R1.1 (normative) both rule that it stops on call.completed with a connected or voicemail outcome. verdict-v1.md Puerta 12 carries a line binding it to dial initiation (the 2xx). R1–R7 are normative and win over everything else, but the writer was still undecided in the data model: `first_touch_latency_seconds` was specified write-once so the column is safe under either reading, which left the actual decision open.

## Options considered

(a) Stop on the tap / on the 2xx — makes every no-answer dial report a fabricated ~21-second first touch on the one number that justifies the entire lead spend. (b) Stop on call.completed with connected|voicemail. (c) Persist both and let reporting choose — rejected, two numbers under one name is the drift the event catalog exists to prevent.

## Decision

Option (b), per R1.1. The writer is the `call-merge` job, and only when `disposition_canonical IN ('connected','voicemail')`. `opportunity.first_touch_latency_seconds` stays write-once by trigger, so a later webhook or a backfill cannot overwrite it. The verdict-v1 Puerta-12 line is superseded by the normative ruling and this document says so.

## Consequences

Speed-to-lead becomes a real number that can look bad, which is the point — a metric that cannot look bad is not a metric. Cost: the number is only available after the call ends, so the card cannot show a final first-touch value during the dial; it shows the live 'time since arrival' counter until then, which is what the board already renders.
