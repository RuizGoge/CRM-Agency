-- Every seller is on the board, including the ones at zero.
--
-- Found by signing in as the demo seller with no closes and looking: he was
-- absent from the board entirely. Not shown at $0 — absent. The board joined
-- FROM leaderboard_projection, and a seller with no ledger row has no
-- projection row, so the person with the least to celebrate was the only one
-- who could not find themselves at all.
--
-- On a board whose entire purpose is motivation, that is the worst possible
-- seller to make invisible. It is also the one case a test written from the
-- specification would not have caught, because the specification describes
-- ranking and says nothing about who is missing.
--
-- The fix inverts the join: start from the roster, LEFT JOIN the totals.
CREATE OR REPLACE FUNCTION app.leaderboard_board(p_period_type app.period_type)
RETURNS TABLE (
  rank         bigint,
  user_id      uuid,
  display_name text,
  avatar_url   text,
  total_cents  bigint,
  entry_count  integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = app, pg_catalog
AS $fn$
  SELECT rank() OVER (ORDER BY coalesce(r.total_cents, 0) DESC, u.id) AS rank,
         u.id,
         u.display_name,
         u.avatar_url,
         coalesce(r.total_cents, 0)::bigint,
         coalesce(r.entry_count, 0)::integer
  FROM app.app_user u
  LEFT JOIN app.leaderboard_read(p_period_type, app.current_period_key(p_period_type)) AS r
    ON r.user_id = u.id
  WHERE u.tenant_id = app.current_tenant()
    -- Sellers only. Supervisors and admins cannot write into a seller's book,
    -- so they have nothing to rank; putting them on at $0 forever would read
    -- as last place rather than as not competing.
    AND u.role = 'seller'
    AND (u.deactivated_at IS NULL OR u.earnings_disposition = 'keep_in_history')
  ORDER BY coalesce(r.total_cents, 0) DESC, u.id
$fn$;
