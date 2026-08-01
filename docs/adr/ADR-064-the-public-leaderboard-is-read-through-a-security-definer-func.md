# ADR-064 — ADR-R1 — The public leaderboard is read through a SECURITY DEFINER function, and crm_app loses SELECT on the projection

**Status:** accepted (Phase 5, pending GATE 5)

## Context

The public board is the projection minus a correction CTE over earnings_ledger for rows younger than the undo window. earnings_ledger carries the append_only_owner policy, so under a seller's owner-scoped session the CTE sees only that seller's own pending rows. The winner's board hides the sale correctly; the other forty-nine see it instantly and see it reverse on undo — the exact outcome ARR-MVP-10 and R1.3 forbid. The ETag, being hash(max(seq), pending_watermark), is likewise computed under the reader's scope: fifty readers compute fifty ETags for one public resource, and for forty-nine of them the watermark component is 0, so the ETag never moves when the pending row ages out. The natural test (win as A, poll as A) passes. The two available exits are widening earnings_ledger to tenant-wide read, or moving the read into a definer.

## Options considered

_(see Context; the rejected alternative is named inline)_

## Decision

The public read becomes app.leaderboard_read(period) SECURITY DEFINER, returning exactly (user_id, display_name, avatar_ref, total_cents, rank, is_active, etag) and computing both the pending correction and the ETag tenant-wide inside the function. crm_app loses SELECT on app.leaderboard_projection entirely; the relation is reclassified definer_only in security.table_registry so harden() re-applies the revoke on every deploy and every partition, and schema gate S6 asserts it. Widening earnings_ledger's RLS is ruled out permanently and mechanised as ruled out by S16, which asserts the policy qual still contains owner_user_id = app.current_user_id(). The ETag's sequence component is the single leaderboard channel_watermark row, bumped both by ledger_append and by an AFTER trigger on app_user, so roster changes move the cache key too.

## Consequences

The pending exclusion is genuinely public and the ETag is byte-identical across readers, which also makes the time-dependent ETag transitions real for everyone (a pending row ageing out, and business-midnight period rollover) rather than for one reader in fifty. The function's RETURNS TABLE becomes the payload contract, so ARR-EVT-23's 'a payload type that literally cannot express lead data' is a catalog fact and the SSE payload type is generated from pg_get_function_result rather than hand-written. Reading the projection directly returns permission denied — a 500 and the specified copy on the seller's screen, the same minute. The sanctioned cross-silo exception list drops from two entries to one. Costs: one extra function on the hottest read path (a single index-only watermark probe plus a 0-2 row correction scan, unchanged in shape); the wrapper must map a zero-row result to 500 context_missing rather than rendering a blank board; and the alternative — a cross-silo PII leak inside a CTE with no UI symptom and no route to test — is refused explicitly.
