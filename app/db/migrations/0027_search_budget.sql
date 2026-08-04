-- N13 joins the engine, and SIX INDEXES join the snapshot.
--
-- TWO THINGS IN ONE MIGRATION, and the second is only here because the first
-- uncovered it.
--
-- 1 · THE BUDGET. Global search is measured at **59.7 ms** across 25,000
--     contacts in fifty books and registered at **120** — the same deliberate
--     headroom P12 was given, because a budget exists to catch a regression
--     rather than to break the build the next time a result row gains a
--     column. `monotonic_down`, like every other: tightening is free,
--     loosening is an INSERT the engine has to accept.
--
--     🔴 The first measurement was **1,053 ms**, and NOTHING ABOUT THE SCHEMA
--     CHANGED TO FIX IT. Migration 0011 had already created exactly the right
--     index — a composite GIN over (tenant_id, owner_user_id,
--     full_name gin_trgm_ops), proven by a planner check at gate G1e. The
--     query was written so it could not be used: it scoped the book in a CTE
--     and matched in a LATERAL, forcing a sequential scan of the tenant on
--     every keystroke. 0011's own comment names the deeper reason that shape
--     matters, and it is not speed — "a tenant-wide trigram index filtered
--     AFTER retrieval is the silo leak that rules out a separate search
--     service". Writing the query the slow way was writing it in the shape
--     that leak has.
--
-- 2 · THE INDEX STATEMENTS THE GENERATOR PRODUCED ARE DROPPED, and the
--     snapshot is the payload — the same shape as 0026, for a gap 0026 missed.
--     0026 reconciled the missing TABLES and never looked at indexes. Six
--     existed in migrations 0011, 0019 and 0020 and in no schema file:
--
--       contact_name_trgm_idx · contact_email_idx · contact_phone_tenant_idx
--       earnings_reverses_uidx · earnings_recorded_at_idx
--       scheduled_job_claimable_idx
--
--     🔴 FOUND BY WALKING INTO IT. Adding an index through the generator
--     produced a migration that re-created `contact_name_trgm_idx`, which
--     failed on a fresh database with "already exists" — and because drizzle's
--     migrator is ONE TRANSACTION, that rolled back every migration with it.
--     `crm_test` came back with zero tables. An unmanaged TABLE is merely
--     unaccounted for; an unmanaged INDEX is a migration that cannot be
--     applied to a new database at all.
--
--     The declarations regenerate byte-identical SQL to what 0011, 0019 and
--     0020 wrote by hand, which is what proves they are faithful rather than
--     approximate. `snapshot-chain.test.ts` now fails on an undeclared index,
--     not only an undeclared table.

INSERT INTO ref.ci_ratchet_name (name, direction, registered_in_migration, rationale)
VALUES (
  'perf.N13_search_server_p95',
  'monotonic_down',
  '0027_search_budget',
  'Global search server p95 at fifty books of five hundred leads, P5.3 N13. Measured at 59.7ms and registered at 120ms. The 500ms end-to-end of US-LCP-08 is a consequence and is deliberately not ratcheted.'
)
ON CONFLICT (name) DO NOTHING;
--> statement-breakpoint

INSERT INTO ref.ci_ratchet (name, value_num, set_by_run)
SELECT 'perf.N13_search_server_p95', 120, '0027_search_budget'
WHERE NOT EXISTS (SELECT 1 FROM ref.ci_ratchet WHERE name = 'perf.N13_search_server_p95');
