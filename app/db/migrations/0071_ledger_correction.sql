-- ===========================================================================
-- A WRONG EARNINGS NUMBER CAN BE CORRECTED. The surface the constitution
-- always named and nobody ever built.
--
-- 🔴 THE SYMPTOM, AND IT IS WORSE THAN THE RULE IT LOOKS LIKE. CLAUDE.md says
-- corrections are "compensating appends through the admin void/adjust surface".
-- That surface does not exist: `grep` finds no `ledger_void`, no
-- `ledger_adjust`, no `leaderboard_rebuild`, no route, no screen. And
-- `app.ledger_append` has carried NO GRANT since 0063 — deliberately.
--
-- So the state before this migration is not "correcting is ceremonious". It is:
-- **a wrong number on the public board cannot be corrected by anyone, by any
-- path.** Not by editing (the append-only trigger refuses, correctly), and not
-- by a compensating append (nothing can write one). The enum has known about
-- `reversal`, `value_correction` and `manual_adjustment` since 0008 and the
-- CHECKs have accepted them the whole time; there was simply no writer. The
-- same engine-with-no-wiring shape the 2026-08-10 audit found at table scale.
--
-- ⚠️ THIS DOES NOT WEAKEN APPEND-ONLY, AND THAT IS THE POINT OF DOING IT THIS
-- WAY. The trigger stays, the revoked privileges stay, `ledger_append` stays
-- ungranted. A correction is a NEW ROW that names what it corrects, so the
-- board reads right while the history of how it got there survives. Jorge chose
-- this over removing the rule (2026-08-12).
--
-- ⚠️ AND IT IS DELIBERATELY NOT A RECOMPUTE. Nothing here re-derives the
-- projection by summing the ledger. `leaderboard_rebuild()` remains unbuilt and
-- E3 remains the reason: two steps that both move the number double-count it.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- THE CORRECTION
-- ---------------------------------------------------------------------------
-- `manual_adjustment` is the entry type, and it is not a fallback choice — it is
-- the one the schema already carved out for exactly this. E5's ruling and the
-- `earnings_source_is_a_declared_input` CHECK both exempt it (and
-- `projection_repair`) from needing a `source_event_name`, because an admin
-- correcting a number is not sourced from any of the four declared events.
--
-- 🔴 A `reversal` WOULD BE WRONG HERE and the schema says so in an index.
-- `earnings_reverses_uidx` allows ONE reversal per entry, and 0019 added it so
-- that an undo NAMES the credit it cancels — *"without the link a reversal is
-- indistinguishable from a correction, takes the correction path, and lands on
-- the public board."* A reversal is what the 5-second undo writes. This is the
-- other thing, and conflating them would let an admin consume a seller's undo
-- slot.
CREATE OR REPLACE FUNCTION app.ledger_adjust(
  p_owner_user_id   uuid,
  p_delta_cents     bigint,
  p_reason          text,
  p_idempotency_key uuid,
  p_opportunity_id  uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = app, ref, pg_catalog
AS $fn$
DECLARE
  v_tenant uuid;
  v_actor  uuid;
  v_reason   text;
  v_id       uuid;
  v_duplicate boolean;
BEGIN
  v_tenant := app.current_tenant();
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'LA001: ledger_adjust called outside a tenant session';
  END IF;

  -- 🔴 ADMIN, CHECKED HERE AND NOT IN THE ROUTE. `app.scope_is_admin()` re-reads
  -- `app_user.role` for the (tenant, user) pair sealed by 0067, so it is not a
  -- claim the caller makes. A definer switches RLS off inside its own body: if
  -- this line is absent, any seller session that can reach the function writes
  -- the public money board for anybody in the agency. That is precisely the hole
  -- 0063 closed on `ledger_append`, and re-opening it through a new door would
  -- be the same hole with a different name.
  IF NOT app.scope_is_admin() THEN
    RAISE EXCEPTION 'LA002: correcting the earnings board is an admin act';
  END IF;

  IF p_delta_cents IS NULL OR p_delta_cents = 0 THEN
    -- `earnings_delta_nonzero_unless_repair` would refuse it anyway; this says
    -- why in a sentence the screen can show.
    RAISE EXCEPTION 'LA003: a correction of zero changes nothing and cannot be recorded';
  END IF;

  -- 🔴 THE REASON IS MANDATORY, and this is the whole difference between "an
  -- admin can fix the number" and "an admin can change the number". `reason` is
  -- NULLABLE on the table because a sale does not need one; a correction does,
  -- because the row IS the record of why the board moved without a deal.
  v_reason := btrim(coalesce(p_reason, ''));
  IF length(v_reason) < 10 THEN
    RAISE EXCEPTION 'LA004: say why the number is being corrected — this row is the only record of it';
  END IF;

  -- The subject must be a live seller in THIS tenant. A definer has no RLS, so
  -- without this an admin could name a uuid from another agency and move a
  -- number on a board they cannot see.
  IF NOT EXISTS (
    SELECT 1 FROM app.app_user u
     WHERE u.tenant_id = v_tenant AND u.id = p_owner_user_id
  ) THEN
    RETURN NULL;
  END IF;

  v_actor := app.current_user_id();

  -- 🔴 THE IDEMPOTENCY KEY RIDES IN AS `source_event_id`, WHICH REUSES THE
  -- MECHANISM RATHER THAN INVENTING ONE. `earnings_source_event_uidx` is
  -- described on the table as *"THE correctness mechanism, not a performance
  -- index. A double-tap, a retry or a replay hits this and the writer treats the
  -- violation as a SUCCESS path."* A manual adjustment has no event to key on,
  -- so the surface generates one key per open form and a double submit lands on
  -- the same index the sale path already relies on. Money is the one place where
  -- "two identical submissions are two real facts" is the wrong default.
  --
  -- ⚠️ IT RETURNS A ROW, NOT A uuid — `RETURNS TABLE (entry_id uuid,
  -- was_duplicate boolean)`. Assigning the call straight into a uuid compiles
  -- and fails at runtime with *"invalid input syntax for type uuid:
  -- (019ff920-…,f)"*, which is the whole composite stringified. Caught by the
  -- suite on its first run.
  SELECT la.entry_id, la.was_duplicate
    INTO v_id, v_duplicate
    FROM app.ledger_append(
      p_owner_user_id,
      p_idempotency_key,
      NULL,                    -- no source_event_name: E5 exempts manual_adjustment
      'manual_adjustment',
      p_delta_cents,
      clock_timestamp(),
      p_opportunity_id,
      NULL, NULL, NULL, NULL, NULL,
      v_reason,
      v_actor,
      NULL) la;                -- never reverses_entry_id: that slot belongs to undo

  -- 🔴 A RESUBMIT WRITES NO SECOND AUDIT ROW EITHER, and `was_duplicate` is how
  -- the writer says so. Without this the ledger would be correctly idempotent
  -- while the audit log counted double-clicks as separate admin decisions — and
  -- the audit log is the record somebody reads when asking who moved a number.
  IF v_duplicate THEN
    RETURN v_id;
  END IF;

  -- The audit row is a SECOND record with a different reader. The ledger row is
  -- what the seller sees on My Earnings; this is what an admin reads when
  -- somebody asks who moved a number last quarter. `ledger.adjusted` has been in
  -- `app.audit_action_list()` since 0053 with nothing writing it.
  PERFORM app.audit_write(
    'ledger.adjusted',
    'earnings_ledger',
    v_id,
    NULL,
    jsonb_build_object(
      'owner_user_id', p_owner_user_id,
      -- Cents as TEXT. Money crosses every boundary as a string of whole cents,
      -- and jsonb numbers are IEEE doubles.
      'delta_cents',   p_delta_cents::text,
      'opportunity_id', p_opportunity_id),
    v_reason);

  RETURN v_id;
END;
$fn$;--> statement-breakpoint

REVOKE ALL ON FUNCTION app.ledger_adjust(uuid, bigint, text, uuid, uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.ledger_adjust(uuid, bigint, text, uuid, uuid) TO crm_app;--> statement-breakpoint

COMMENT ON FUNCTION app.ledger_adjust(uuid, bigint, text, uuid, uuid) IS
  'The admin correction surface. Appends a manual_adjustment with a mandatory reason. The ledger stays append-only; ledger_append stays ungranted.';--> statement-breakpoint

-- 🔴 `ledger_append` IS STILL NOT GRANTED, and this migration must not change
-- that. `app.ledger_adjust` reaches it as the OWNER, which is the same shape
-- `stage_move` uses. A grant here would re-open 0063's hole: that function
-- validates the tenant and nothing else, so any route could append any amount
-- to any seller.
SELECT security.own_to_migrator();
