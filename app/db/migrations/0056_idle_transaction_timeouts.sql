-- ===========================================================================
-- GATE 3 (f) — `idle_in_transaction_session_timeout` ON EVERY ROLE.
--
-- §2536: "idle_in_transaction_session_timeout set on every role, and a process
-- killed mid-gate leaves no lock on the opportunity row or the leaderboard
-- watermark."
--
-- Measured before this migration:
--
--   crm_app       15s     ✅
--   crm_migrator  5min    ✅
--   crm           NOT SET 🔴
--   crm_ci        NOT SET 🔴
--
-- WHY THE TWO UNSET ONES MATTER, and it is not symmetry. The close gate takes
-- `FOR UPDATE` on the opportunity row (0019:185) and writes the leaderboard
-- projection in the same transaction. A session that opens a transaction and
-- then stops — a laptop that slept, an editor that crashed, a psql window left
-- open over lunch — holds those locks for as long as the connection survives.
-- Every seller trying to close a deal on that card waits behind it, and the
-- public board stops moving. There is no error anywhere; the product simply
-- stops responding for the rows involved.
--
-- `crm_app` already had the tight one because it is the seller-facing role. The
-- two without it are the ones a HUMAN uses, which is exactly where an idle
-- transaction comes from.
-- ===========================================================================

-- Five minutes rather than fifteen seconds, and the difference is deliberate.
-- `crm` is the role `drizzle-kit migrate` connects as, and a migration that
-- rewrites a partitioned table legitimately takes minutes while holding a
-- transaction open. Fifteen seconds here would abort deploys, which is a
-- self-inflicted outage in the name of preventing one.
ALTER ROLE crm SET idle_in_transaction_session_timeout = '5min';--> statement-breakpoint

-- The CI role runs the suite and nothing else. It gets the application's own
-- fifteen seconds: a test that parks a transaction longer than that has hung,
-- and killing it is the correct outcome rather than letting it wedge the run.
ALTER ROLE crm_ci SET idle_in_transaction_session_timeout = '15s';--> statement-breakpoint

-- ⚠️ `ALTER ROLE ... SET` APPLIES AT LOGIN, NOT TO OPEN SESSIONS. Every session
-- already connected keeps the old setting until it reconnects, so this takes
-- effect on the next deploy's connections rather than instantly. Said here
-- because "the setting is in the catalog" and "the setting is in force" are two
-- different claims and only the first one is true the moment this runs.
SELECT 1;
