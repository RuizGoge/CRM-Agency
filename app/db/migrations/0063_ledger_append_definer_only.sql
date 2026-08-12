-- ===========================================================================
-- THE PUBLIC MONEY BOARD HAS NO APPLICATION-ROLE WRITER
--
-- Item 3 of 0061's honesty list (0061:94-99), closed. Until now `crm_app` held
-- EXECUTE on `app.ledger_append` (0009:194), a SECURITY DEFINER whose body
-- validates TENANCY AND NOTHING ELSE. Reproduced as an ordinary seller session
-- inside BEGIN … ROLLBACK: one call appended 99999999999999 cents TO ANOTHER
-- SELLER'S NAME, citing an event that does not exist and a deal that does not
-- exist. A direct INSERT in the same session was refused. The table door held;
-- the function door was open.
--
-- THREE FACTS, THREE JOBS, AND NONE IS ANOTHER'S BACKUP:
--   §1 REACHABILITY   crm_app loses EXECUTE and gets no grant. The only path
--                     into the ledger becomes app.stage_move, as the owner.
--   §2 LEDGER CEILING a CHECK on earnings_ledger, which binds a FUTURE DEFINER
--                     and the provider's SQL console — neither of which §1 can
--                     touch.
--   §3 BOARD CEILING  a CHECK on leaderboard_projection. 🔴 WITHOUT §3 THIS
--                     MIGRATION'S OWN PROSE IS FALSE. Measured with §1 and §2
--                     applied, as the owner:
--                       UPDATE app.leaderboard_projection SET total_cents = 1e14
--                       → app.leaderboard_read reads 99999999999999
--                       → app.earnings_ledger row count unchanged at 67
--                     The projection is `tenant_scoped_read`, immutable = false:
--                     no AP001 trigger, no bound. The number fifty people watch
--                     is CHEAPER and QUIETER to forge than the record behind it,
--                     because nothing anywhere disagrees afterwards.
--
-- ⚠️ THE HEADLINE IS PER ENTRY, NOT IN AGGREGATE. crm_app holds INSERT on
-- app.contact and app.opportunity (verified). INSERT contact → INSERT
-- opportunity → stage_move(…, 10000000, 'annual'), in a loop, adds $100,000 a
-- turn with the loop count as the only limit — measured, 25 turns moved a board
-- from 808800 to 250808800. §2 is a blast-radius cap on ONE ROW. Nothing here
-- bounds a seller's total, and saying otherwise would be the sentence this
-- constitution exists to prevent.
--
-- WHY IT COSTS NOTHING TODAY. Not one production TypeScript caller: every
-- mention under `app/` is a comment (app/db/schema/earnings.ts:224). The only
-- caller in the whole database is `app.stage_move` (0054:275 sale, :322
-- reversal), confirmed by a comment-stripped scan of every prosrc in app, ref,
-- security and public. A definer's nested calls are checked against the OWNER.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1 · REACHABILITY
-- ---------------------------------------------------------------------------
-- BOTH FORMS, AND THEY DO DIFFERENT WORK — the same reasoning as 0061:33-46.
-- FROM PUBLIC strips PostgreSQL's default: redundant TODAY, and not boilerplate,
-- because the day somebody DROPs and recreates this function to change its
-- return type (0060:114 is that pattern, live in this tree) the ACL resets to
-- EXECUTE TO PUBLIC — WIDER than before this migration. FROM crm_app is the one
-- doing the work, because 0009:194 granted it BY NAME.
--
-- ⚠️ THE FULL 15-TYPE LIST IS MANDATORY. A shorter list does not resolve and the
-- migration fails, which is the good outcome; a list resolving a DIFFERENT
-- overload would be the bad one. There is exactly one overload today, and
-- BOOT013 refuses to boot if a second ever appears.
REVOKE ALL ON FUNCTION app.ledger_append(uuid, uuid, text, app.ledger_entry_type, bigint,
  timestamptz, uuid, uuid, uuid, text, bigint, app.product_type, text, uuid, uuid)
  FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION app.ledger_append(uuid, uuid, text, app.ledger_entry_type, bigint,
  timestamptz, uuid, uuid, uuid, text, bigint, app.product_type, text, uuid, uuid)
  FROM crm_app;--> statement-breakpoint

-- 🔴 AND NO GRANT. THIS ABSENCE IS THE DESIGN. `security.harden()` cannot undo
-- it: its body issues table GRANTs, policies, immutability triggers and GRANT
-- USAGE ON SCHEMA — no ON FUNCTION, no ON ALL FUNCTIONS, no ALTER DEFAULT
-- PRIVILEGES. Schema USAGE is the prerequisite for CALLING a function; it is not
-- EXECUTE. So this survives every deploy — and NOTHING RE-ASSERTS IT, which is
-- why BOOT012/013 exist.

-- ---------------------------------------------------------------------------
-- 2 · THE LEDGER CEILING — a table constraint, not a body guard
-- ---------------------------------------------------------------------------
-- 🔴 THE BOUND IS NOT INVENTED. `opportunity_premium_in_range` (0012:47-48)
-- already caps a policy at $1..$100,000 a year — verified live as
-- `premium_annual_cents >= 100 AND <= 10000000` — and app.stage_move writes that
-- column (0054:156-166) BEFORE it appends (0054:275), in the same transaction,
-- so the real path aborts inside stage_move at the UPDATE, line 106, before
-- ledger_append is reached. app.ledger_append is the one path with NO per-entry
-- ceiling at all.
--
-- WHY THE TABLE AND NOT THE BODY. A predicate inside ledger_append binds
-- ledger_append. This binds stage_move, binds any FUTURE SECURITY DEFINER —
-- which needs no grant and trips nothing in §1 — and binds the owner in the
-- provider's SQL console, where a REVOKE means nothing. Same argument the AP001
-- trigger already won (money-path.test.ts:112-118).
--
-- WHY IT RAISES RATHER THAN SKIPS. 05c §250: all three double-credit nets guard
-- against crediting TWICE and nothing guards against crediting ZERO times. A
-- CHECK aborts the whole stage_move transaction — card, transition, event and
-- credit roll back together. `IF … THEN RETURN; END IF` in the body would leave
-- a card in a won stage with no money and no error.
--
-- 100x the opportunity ceiling on purpose: `manual_adjustment` carries the D8
-- initial-balance path (app/db/schema/earnings.ts:236-244), many policies in one
-- row, and a cap that foreclosed a documented path is a gate built to be
-- weakened. ⚠️ IT HAS NO SYMPTOM ON ANY SCREEN, stated rather than discovered
-- later: max delta in the dev tenant is 900000, four orders of magnitude below.
-- VALIDATED, not NOT VALID: it scans all 67 existing rows. ADD CONSTRAINT is
-- DDL, so the AP001 statement trigger does not fire.
ALTER TABLE app.earnings_ledger
  ADD CONSTRAINT earnings_delta_in_range
  CHECK (delta_cents BETWEEN (-1000000000)::bigint AND 1000000000::bigint);--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3 · THE BOARD CEILING — the one §2 does not reach
-- ---------------------------------------------------------------------------
-- 🔴 DERIVED, NOT CHOSEN, and that is the whole difference from §2's number.
-- The projection is maintained by ledger_append: `entry_count` counts the rows
-- that produced `total_cents`, and §2 caps each of those rows at 1e9. So the
-- largest total the LEDGER could ever have produced is entry_count x 1e9, and
-- any value past it is arithmetic the ledger did not do. A hand-written UPDATE
-- can still move the board — it just cannot move it anywhere the record could
-- not have put it. Verified against all 27 live projection rows: holds, with the
-- largest at entry_count=58 and abs(total)=14906988.
--
-- ⚠️ THIS IS NOT AN IMMUTABILITY TRIGGER AND MUST NOT BE READ AS ONE. The owner
-- can still UPDATE this table — it HAS to, that is how ledger_append maintains
-- it. What is now impossible is a total the ledger cannot account for.
ALTER TABLE app.leaderboard_projection
  ADD CONSTRAINT leaderboard_total_within_ledger_reach
  CHECK (entry_count >= 0
         AND abs(total_cents) <= entry_count::bigint * 1000000000::bigint);--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4 · THE PUBLIC STRIP, DERIVED FROM THE CATALOG
-- ---------------------------------------------------------------------------
-- ⚠️ THE FIRST DRAFT OF THIS SECTION NAMED FOUR FUNCTIONS AND SAID THAT WAS ALL
-- OF THEM. There are TWENTY with an explicit `=X/` PUBLIC grant, including
-- app.leaderboard_read, app.leaderboard_board, app.annualize and
-- app.contact_edit — every one of which fits the stated rationale at least as
-- well as app.schedule_job did. A hand-picked list presented as a census is the
-- shape of defect this project keeps finding, so this is a loop over pg_proc.
--
-- 🔴 THE `crm_app` PRECONDITION IS WHAT MAKES IT PROVABLY FREE. Only a function
-- crm_app already reaches BY NAME is stripped, so no caller can lose anything.
-- Verified: all 20 carry crm_app=X/crm today. It is not a revoke of anything
-- reachable — it is removing the day a fifth role (a read replica, a reporting
-- connection) inherits the whole surface by default.
--
-- ⚠️ TWELVE FUNCTIONS WITH proacl IS NULL ARE DELIBERATELY LEFT ALONE, and NULL
-- is the untouched default, which IS EXECUTE TO PUBLIC. They are trigger
-- functions and internal helpers with no named crm_app grant
-- (app.audit_action_list, app.override_expiry, app.touch_from_row,
-- app.refuse_stage_type_change, ref.ci_ratchet_enforce, …). Revoking PUBLIC from
-- them could break a path nothing in the tree names, and none of them takes
-- caller-supplied money. Named so the omission is a decision.
DO $strip$
DECLARE r record; n int := 0;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS ident
      FROM pg_proc p JOIN pg_namespace nsp ON nsp.oid = p.pronamespace
     WHERE nsp.nspname IN ('app','ref')
       AND p.proacl IS NOT NULL
       AND EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0)
       AND EXISTS (SELECT 1 FROM aclexplode(p.proacl) a
                    WHERE a.grantee = 'crm_app'::regrole AND a.privilege_type = 'EXECUTE')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', r.ident);
    n := n + 1;
  END LOOP;
  RAISE NOTICE 'PUBLIC EXECUTE stripped from % function(s); crm_app keeps its named grant.', n;
END
$strip$;--> statement-breakpoint

-- NO `SELECT security.harden()`. 0057 moved hardening to CREATION: this
-- migration creates no relation, changes no security.table_registry row and
-- touches no privilege harden() manages. Calling it would take ACCESS EXCLUSIVE
-- on every table in app and ref for nothing.

-- ---------------------------------------------------------------------------
-- WHAT THIS DOES NOT CLOSE — read this before quoting §1.
-- ---------------------------------------------------------------------------
-- 1. `app.stage_move` IS STILL GRANTED (0054:354) and it is now the whole money
--    surface. It is bounded per deal — SM404 confines it to the caller's own
--    opportunity (0054:100-107), v_actor is engine-stamped (0054:75), and
--    opportunity_premium_in_range caps the amount — but UNBOUNDED IN AGGREGATE,
--    because crm_app can create the contacts and opportunities to close.
-- 2. `p_owner_user_id` IS STILL NOT CHECKED IN THE BODY, on purpose. The only
--    caller establishes ownership harder than a predicate here could; a second
--    copy of that decision is what 0060:445-448 forbids; the ratified admin
--    void/adjust surface REQUIRES owner <> actor; and it would break
--    tests/integration/fixtures/perf-floor.ts:144, which appends under
--    begin_system_work where current_user_id() is NULL.
-- 3. `source_event_id` HAS NO FK AND MUST NOT GET ONE. It holds
--    stage_transition.id (0054:183 → :275); every other caller passes
--    gen_random_uuid(). NO CALLER HAS EVER PASSED AN event_log.event_id, so an
--    FK to event_log would go red on the first sale. It is an idempotency key
--    with a misleading name; renaming it is a separate migration.
-- 4. `opportunity_id` and `contact_id` have no FK, deliberately
--    (tests/e2e/fixtures/board-data.ts:165-170: "the record of what happened
--    outlives the row it happened to"). A forged row can still name a deal that
--    does not exist.
-- 5. A THIRD CALLER NEEDS NO GRANT. Every SECURITY DEFINER the owner owns
--    reaches this function and trips nothing above. The prosrc scan in
--    money-path.test.ts is what covers it, with comments stripped first —
--    definer-tenancy.test.ts:98-104 records that gate being defeated by the
--    comment explaining its own rule.
-- 6. A FORGED ROW HAS NO REMEDIATION PATH. The ledger is append-only with no
--    recompute job, stage_move's reversal branch finds its target by opportunity
--    (0054:326-333), and earnings_reversal_names_its_target refuses a reversal
--    with no target. The admin void/adjust surface CLAUDE.md names does not
--    exist in the tree. That is why this is prevention, not detection.
--
-- RE-ASSERTION AT BOOT is app/db/boot-assert.ts
-- (`assertLedgerAppendIsDefinerOnly`, BOOT012/013/014). This change has (c) a
-- refusal to boot and a gate in the catalog. It has NO (a): NOTHING ON ANY
-- SCREEN CHANGES, before or after.
