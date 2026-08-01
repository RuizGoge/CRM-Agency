# ADR-081 — ADR-G3 — The public leaderboard read is a SECURITY DEFINER function; the projection is not readable by the application role

**Status:** accepted (Phase 5, pending GATE 5)

## Context

R1.3 requires the public board to exclude ledger entries younger than the undo window. The correction CTE scans earnings_ledger, whose policy is append_only_owner, so it is computed under the READER's scope: the winner's board hides the row correctly and all other sellers see it instantly and watch it correct itself. The ETag's pending_watermark component is computed the same way, so 49 of 50 sellers compute a frozen ETag and their board silently stops updating. The two obvious exits are both bad — widening earnings_ledger to tenant-wide read leaks opportunity_id, contact_id, stage_name_snapshot, product_type, delta_cents and reason across the silo inside a CTE no screen renders.

## Options considered

_(see Context; the rejected alternative is named inline)_

## Decision

app.leaderboard_read(period_type, period_key) SECURITY DEFINER computes the projection, the pending correction and the ETag tenant-wide inside the function and returns (user_id, display_name, avatar_ref, total_cents, rank, is_active, tenant_total_cents, etag) and nothing else. earnings_ledger RLS is NOT widened. leaderboard_projection is demoted from tenant_scoped_read to definer_only, so SELECT is revoked from crm_app and the sanctioned cross-silo exception list shrinks from two entries to one. Protected assertions: byte-identical ETags and bodies across three readers, and an ETag transition after sleeping past the window with zero intervening writes.

## Consequences

Positive: one mechanism closes the wrong-public-number defect, the frozen-ETag defect and ARR-EVT-23's 'a payload type that cannot express lead data', because the containment is the function's return type. Negative: the board can no longer be queried directly by a handler, which is the point but also means every future board feature goes through a migration to widen the function's return set.
