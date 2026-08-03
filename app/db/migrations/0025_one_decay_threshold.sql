-- The two-tier decay is deleted from the schema, seventeen migrations late.
--
-- `app.tenant` shipped in migration 0001 carrying `rotting_threshold_days`
-- (default 7), `cold_threshold_days` (default 14) and a CHECK forcing the
-- first below the second. That is the PRE-R6 DESIGN, encoded exactly:
-- a 7-day amber tier and a 14-day red one.
--
-- `04-ux-flows.md` Part I, R1.7 — normative, rank 1:
--
--     One threshold: cold_threshold_days, default 7, configurable.
--     There is no separate "rot" threshold.
--
-- and `04b` §1 records the same ruling with its consequence: "the 14-day red
-- tier is deleted from the system, which also frees red on the card face to
-- mean one thing only: you may not contact this person."
--
-- FOUND WHILE BUILDING THE HEALTH RAIL, which reads this column. Nothing had
-- ever read it before, so nothing could notice. The two defects it would have
-- produced are both silent:
--
--   * the going-cold rail would fire at 14 days instead of 7, so a card sat
--     un-flagged for a week longer than the ruling allows — on the signal that
--     exists to stop a lead being quietly abandoned;
--   * red would keep a second meaning, which is precisely what R6 deletes it
--     to prevent. On this card face red means "you may not contact this
--     person", and a colour with two meanings has none.
--
-- Also live, and unenforced until now: CI check R2-6 in `04b` §9 fails the
-- build on "any string, setting or code path that references a rot_threshold".
-- The setting was in the database the whole time. The check now exists as a
-- test rather than as a row in a table of checks nobody runs.

ALTER TABLE app.tenant DROP CONSTRAINT IF EXISTS tenant_rotting_before_cold;
--> statement-breakpoint

ALTER TABLE app.tenant DROP COLUMN IF EXISTS rotting_threshold_days;
--> statement-breakpoint

ALTER TABLE app.tenant ALTER COLUMN cold_threshold_days SET DEFAULT 7;
--> statement-breakpoint

-- Existing rows, and the scoping is deliberate. `= 14` matches only tenants
-- still holding the struck default; a tenant that had deliberately configured
-- 14 would be indistinguishable from one that never chose, so this is written
-- narrowly and stated rather than applied to everything.
--
-- In this tree the distinction is theoretical: there is one seeded tenant and
-- no surface through which anybody could have configured anything. When the
-- admin settings screen exists, an operator's 14 is a decision and this
-- statement would be wrong — which is why it lives in a migration that ran
-- once, before that screen existed, and not in a job.
UPDATE app.tenant SET cold_threshold_days = 7 WHERE cold_threshold_days = 14;
