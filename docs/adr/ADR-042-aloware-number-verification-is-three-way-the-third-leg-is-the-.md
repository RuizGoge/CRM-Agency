# ADR-042 — ADR-04 — Aloware number verification is three-way; the third leg is the seller's own authenticated session

**Status:** accepted (Phase 5, pending GATE 5)

## Context

04-ux-flows.md Flow 4 narrates the exact defect and the corpus never resolves it: an admin types the wrong outbound number against a seller, presses Verify, the two-legged test dial goes out, the webhook returns the agent_id that was typed, and the mapping flips to verified. Verification proved that the number and the Aloware user agree with each other; it cannot prove that the human behind that Aloware user is the CRM user on the row. A lead's callback then lands in a stranger's book and nothing is wrong on any screen for seven days.

## Options considered

(a) Keep webhook agent_id matching only — rejected, it is the documented defect. (b) Require the admin to stand next to the seller during verification — a procedure, not a mechanism, and therefore worth nothing under this project's validation model. (c) Require, in addition to the agent_id match, that the seller on the mapping confirm from their own authenticated session within a bounded challenge window. (d) Require a spoken challenge code delivered on the phone leg — rejected, depends on an unverified provider capability (spoken prompts on the two-legged path).

## Decision

Option (c). A `mapping_verification` challenge row is created with an expiry; the mapping flips only when both the inbound webhook's agent_id matches AND the seller named on the mapping presses 'I answered this call' from their own session. The acting user is read from `app.current_user_id()` inside a SECURITY DEFINER function and never accepted from the payload; the confirm endpoint is owner-scoped, so RLS itself blocks a cross-seller confirmation. `CHECK (status <> 'verified' OR (verified_by_call_id IS NOT NULL AND verified_by_user_id = user_id))` makes the proof a stored fact. Additive columns only: `verification_challenge_id`, `verified_by_user_id`, `verification_expires_at`.

## Consequences

In the documented scenario the mapping never flips, Call and Text stay disabled for the mis-mapped seller, and the defect is visible in the room rather than inferred from a log a week later. Cost: verification now needs the seller present and logged in, so a bulk rollout of 50 mappings cannot be completed by an admin alone. That cost is the point — it is exactly the coupling that makes attribution provable.
