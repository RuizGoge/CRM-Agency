-- The board the poll actually reads: current period, ranked, with names.

-- The period key is derived from the TENANT BUSINESS timezone and nowhere
-- else. Computing it in the client would put a seller's browser timezone in
-- charge of which month a sale belongs to — so a seller in Phoenix and one in
-- Boston would disagree about the same board on the first of the month.
CREATE OR REPLACE FUNCTION app.current_period_key(p_period_type app.period_type)
RETURNS date
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = app, pg_catalog
AS $fn$
DECLARE
  v_tz    text;
  v_today date;
BEGIN
  SELECT t.business_tz INTO v_tz FROM app.tenant t WHERE t.id = app.current_tenant();
  IF v_tz IS NULL THEN
    RAISE EXCEPTION 'LB001: no tenant context';
  END IF;

  v_today := (clock_timestamp() AT TIME ZONE v_tz)::date;

  RETURN CASE p_period_type
           WHEN 'day'      THEN v_today
           WHEN 'week'     THEN date_trunc('week',  v_today)::date
           WHEN 'month'    THEN date_trunc('month', v_today)::date
           ELSE DATE '1970-01-01'
         END;
END
$fn$;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION app.current_period_key(app.period_type) TO crm_app;
--> statement-breakpoint

-- Ranked, named, and already excluding anything still inside the undo window.
--
-- Sanctioned cross-silo read #1 of exactly two: every seller sees every
-- seller's name and total. It is safe because of what is NOT in the column
-- set — no lead, no contact, no opportunity. The thing that cannot leak is the
-- thing that is not there.
--
-- The ordering expression lives here, once. `my_standing_read` will share it
-- rather than compute rank a second time: two functions ranking independently
-- disagree on ties, and a board that disagrees with the seller's own screen is
-- worse than either being wrong alone (errata E2).
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
  SELECT rank() OVER (ORDER BY r.total_cents DESC, u.id) AS rank,
         r.user_id,
         u.display_name,
         u.avatar_url,
         r.total_cents,
         r.entry_count
  FROM app.leaderboard_read(p_period_type, app.current_period_key(p_period_type)) AS r
  JOIN app.app_user u
    ON u.tenant_id = app.current_tenant() AND u.id = r.user_id
  WHERE u.deactivated_at IS NULL
     OR u.earnings_disposition = 'keep_in_history'
  ORDER BY r.total_cents DESC, u.id
$fn$;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION app.leaderboard_board(app.period_type) TO crm_app;
