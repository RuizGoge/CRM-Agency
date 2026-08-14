-- ===========================================================================
-- THE PRIMARY ENFORCEMENT POINT, WHICH I BUILT SECOND.
--
-- 🔴 WHAT THIS CORRECTS, AND IT IS MY OWN INVERSION OF THE CORPUS. `05c`
-- §11.11.3 is titled "Platform reality, and it is why this cannot be the
-- primary" — event triggers need superuser, and the approved corpus records in
-- four places that the design must not depend on that grant. §11.11.4 is titled
-- "the digest chain, WHICH NEEDS NO SUPERUSER AND IS THE PRIMARY."
--
-- `scripts/ddl-guard.sql` (2026-08-14) built §11.11.3. It is real and it is
-- measured, and it is the half that R2 may delete from production entirely: if
-- Render grants no superuser, none of it installs. This migration builds the
-- half that works everywhere.
--
-- 🎯 THE SURFACE IS COMPUTED BY CLASS, NOT TYPED OUT. `05c` §2563 lists ~30
-- objects by name. Five of the names on that list DO NOT EXIST in this tree
-- (`app.leaderboard_rebuild`, `app.my_standing_read`,
-- `app.opportunity_set_premium`, `app.projection_reveal_delay`,
-- `app.undo_deadline` — measured, not assumed), so transcribing it would have
-- produced a gate that was red on its first run and deleted by the second.
-- Worse, a hand-typed list does not grow: the definer added next month joins
-- the protected set only if somebody remembers, which is the failure mode
-- `security.table_registry` exists to replace. So the classes are named and the
-- members are read from the catalog:
--
--   policy   — every RLS policy. Dropping or widening one IS the breach.
--   trigger  — every `t_immutable_*`. These are the append-only enforcement on
--              the ledger, the audit log and consent.
--   definer  — every SECURITY DEFINER in app/ref/security. These are the doors:
--              a definer's body decides what a caller may do with the owner's
--              privileges, and `ref.sealed_signature` seals result types and
--              NOT bodies (R10), so nothing else watches them.
--   rls      — enabled and forced, per relation, plus its owner.
--
-- ⚠️ PARTITIONS ARE EXCLUDED FROM ALL FOUR, and this is load-bearing rather
-- than tidy. `event_outbox` gains a partition every day and drops one every
-- fourteen; each carries policies and `t_immutable_*` triggers that `harden()`
-- generated. Included, the surface would change every single night and PO001
-- would fire on a schedule until somebody switched it off — the exact way a
-- gate becomes a comment. A partition's protection is its parent's, which is
-- also why no partition carries a `table_registry` row.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1 · THE SURFACE, AS ONE READING THAT BOTH ENDS SHARE
-- ---------------------------------------------------------------------------
-- 🔴 IT LIVES IN `ref` SO THERE IS EXACTLY ONE COPY. The deploy checks this as
-- `crm_migrator`; every booting process re-checks it as `crm_app`, which has no
-- USAGE on `security` (measured: false). Putting it in `security` would have
-- meant the boot assertion reimplementing the same four SELECTs in TypeScript —
-- a second definition of "what is protected", drifting from the first, with the
-- drift invisible because both sides would still agree with themselves.
--
-- Nothing here is a secret: it is `pg_catalog`, which every role can read
-- already. What the function adds is the AGREEMENT about which rows matter.
CREATE OR REPLACE FUNCTION ref.protected_surface()
RETURNS TABLE (identity text, kind text, definition text)
LANGUAGE sql
STABLE
AS $fn$
  -- Policies. `polpermissive` is included because turning a RESTRICTIVE policy
  -- permissive changes what the whole set means without touching an expression.
  SELECT format('policy:%s.%s.%s', n.nspname, c.relname, p.polname),
         'policy',
         concat_ws('|', p.polcmd, p.polpermissive,
                   (SELECT string_agg(pg_get_userbyid(r), ',' ORDER BY r)
                      FROM unnest(p.polroles) AS r),
                   coalesce(pg_get_expr(p.polqual, p.polrelid), ''),
                   coalesce(pg_get_expr(p.polwithcheck, p.polrelid), ''))
    FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname IN ('app', 'ref', 'security', 'authz')
     AND NOT c.relispartition

  UNION ALL

  -- Append-only triggers. `tgenabled` is part of the definition because
  -- `ALTER TABLE ... DISABLE TRIGGER` leaves the trigger in place, reports the
  -- TABLE as the object identity, and turns the ledger writable in silence.
  SELECT format('trigger:%s.%s.%s', n.nspname, c.relname, t.tgname),
         'trigger',
         concat_ws('|', pg_get_triggerdef(t.oid), t.tgenabled)
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE NOT t.tgisinternal
     AND t.tgname LIKE 't\_immutable%'
     AND n.nspname IN ('app', 'ref', 'security', 'authz')
     AND NOT c.relispartition

  UNION ALL

  -- SECURITY DEFINER functions. The body is hashed rather than stored: these
  -- are long, and what matters is that it is the same body, not what it says.
  -- `proowner` matters as much as the body — the same source running as a
  -- different owner is a different privilege.
  SELECT format('definer:%s.%s(%s)', n.nspname, p.proname,
                pg_get_function_identity_arguments(p.oid)),
         'definer',
         concat_ws('|', encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex'),
                   pg_get_userbyid(p.proowner),
                   coalesce(array_to_string(p.proconfig, ','), ''))
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE p.prosecdef
     AND n.nspname IN ('app', 'ref', 'security', 'authz')

  UNION ALL

  -- Row level security, per relation. Owner included: FORCE binds the owner, so
  -- a change of owner changes who the policies apply to.
  SELECT format('rls:%s.%s', n.nspname, c.relname),
         'rls',
         concat_ws('|', c.relrowsecurity, c.relforcerowsecurity,
                   pg_get_userbyid(c.relowner))
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE c.relkind IN ('r', 'p')
     AND c.relrowsecurity
     AND n.nspname IN ('app', 'ref', 'security', 'authz')
     AND NOT c.relispartition;
$fn$;--> statement-breakpoint

COMMENT ON FUNCTION ref.protected_surface() IS
  '05c §11.11.4. The protected set, computed by class from the catalog rather than transcribed. One reading shared by the deploy check and every process at boot.';--> statement-breakpoint

GRANT EXECUTE ON FUNCTION ref.protected_surface() TO crm_app;--> statement-breakpoint

-- One number for the whole surface, so a booting process can compare a single
-- value instead of shipping 289 rows through a boot assertion.
CREATE OR REPLACE FUNCTION ref.protected_surface_digest()
RETURNS text
LANGUAGE sql
STABLE
AS $fn$
  SELECT encode(sha256(convert_to(
           coalesce(string_agg(s.identity || '=' || s.definition, E'\n' ORDER BY s.identity), ''),
           'UTF8')), 'hex')
    FROM ref.protected_surface() s;
$fn$;--> statement-breakpoint

GRANT EXECUTE ON FUNCTION ref.protected_surface_digest() TO crm_app;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2 · WHAT WAS RECORDED
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS security.protected_object (
  identity          text PRIMARY KEY,
  kind              text NOT NULL,
  definition_sha256 text NOT NULL,
  first_seen_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_changed_at   timestamptz
);--> statement-breakpoint

-- 🔴 APPEND-ONLY, AND IT IS THE HALF JORGE CAN READ. A refusal that happens and
-- leaves no record is a refusal nobody can audit afterwards; §11.11.4 puts
-- "protected objects changed since go-live: N" on `/admin/system` for exactly
-- that reason. The count has to come from somewhere that cannot be walked back.
CREATE TABLE IF NOT EXISTS security.protected_object_history (
  id               uuid PRIMARY KEY DEFAULT uuidv7(),
  identity         text NOT NULL,
  change           text NOT NULL,
  old_sha256       text,
  new_sha256       text,
  changed_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  changed_by       text NOT NULL DEFAULT current_user,
  authorization_id uuid,
  CONSTRAINT protected_history_change_known
    CHECK (change IN ('added', 'changed', 'removed')),
  -- An addition is free and needs no authorisation; the other two never are.
  CONSTRAINT protected_history_weakening_is_authorised
    CHECK (change = 'added' OR authorization_id IS NOT NULL)
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS protected_object_history_at_idx
  ON security.protected_object_history (changed_at DESC);--> statement-breakpoint

-- 🔴 OWNERSHIP STATED RATHER THAN INHERITED, because the two environments do not
-- agree by default and the disagreement is invisible until it is not. In
-- production the deploy runs as `crm_migrator`, so it owns what it creates; the
-- integration harness builds `crm_test` as `crm`, so `crm` owns it and the
-- deploy role gets "permission denied for table protected_object" — a failure
-- that appears only in the suite, on a mechanism that was working perfectly in
-- development. `own_to_migrator()` covers `security`, but 0076 calls no
-- `harden()`, so nothing would have reconciled it.
ALTER TABLE security.protected_object OWNER TO crm_migrator;--> statement-breakpoint
ALTER TABLE security.protected_object_history OWNER TO crm_migrator;--> statement-breakpoint

-- ⚠️ AND THAT OWNERSHIP IS A STATED LIMIT, NOT AN OVERSIGHT — §11.11.4 calls it
-- "the circular attack": the deploy role owns the baseline it is measured
-- against, so a migration that weakens something AND rewrites
-- `security.protected_object` to match produces a self-consistent digest and
-- passes. The corpus closes that with the seal chain of §7.6.2 —
-- `ci/seal-manifest.jsonl`, `security.seal`, boot comparing manifest heads —
-- and NONE of that exists in this tree (measured 2026-08-14: no `security.seal`,
-- no `harden_run`, no manifest).
--
-- What holds today, said exactly: PO001 catches every weakening that does not
-- also rewrite its own baseline in the same deploy — which is every accidental
-- one, and every deliberate one written by somebody who did not know this
-- paragraph exists. WHERE the event-trigger guard is installed it is much
-- stronger than that, because dropping or altering a policy is refused there
-- regardless of what the baseline says. The two halves are not redundant; on a
-- platform that grants superuser they compose, and on one that does not, this
-- is what there is.


CREATE OR REPLACE FUNCTION security.protected_history_is_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  RAISE EXCEPTION
    'PO003: security.protected_object_history is append-only. % is not available.', TG_OP
    USING HINT = 'This is the count rendered on /admin/system. A change that can be '
                 'walked back is a change nobody can audit.';
END;
$fn$;--> statement-breakpoint

DROP TRIGGER IF EXISTS t_immutable_protected_object_history
  ON security.protected_object_history;--> statement-breakpoint
CREATE TRIGGER t_immutable_protected_object_history
  BEFORE UPDATE OR DELETE OR TRUNCATE ON security.protected_object_history
  FOR EACH STATEMENT EXECUTE FUNCTION security.protected_history_is_append_only();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3 · PO001 — THE REFUSAL
-- ---------------------------------------------------------------------------
-- 🎯 ADDITIONS ARE FREE. REMOVALS AND CHANGES ARE NOT. That asymmetry is the
-- whole ergonomics of this gate and it is the same rule migration 0075's
-- registry trigger follows: a policy that appears describes a table that did
-- not exist a moment ago and cannot weaken isolation that was never there,
-- while a policy that VANISHES or whose expression MOVED is precisely the
-- breach. Gate additions too and every migration that adds a table needs a
-- hand-typed authorisation — a rule that would be automated away inside a week,
-- and an automated authorisation is R3, the defect E1b is named after.
--
-- ⚠️ IT CONSUMES `authz.ddl_authorization` DIRECTLY rather than calling
-- `authz.consume_authorization()`. That function belongs to the OUT-OF-BAND
-- guard, which may not exist: on a platform that grants no superuser,
-- `scripts/ddl-guard.sql` never installs and this migration is the only
-- enforcement there is. A primary that imports the belt-and-braces would fail
-- exactly where it is the only thing left.
CREATE OR REPLACE FUNCTION security.assert_protected_objects()
RETURNS TABLE (added integer, changed integer, removed integer)
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_added    integer := 0;
  v_changed  integer := 0;
  v_removed  integer := 0;
  v_weak     text;
  v_auth     uuid;
  v_seeding  boolean;
BEGIN
  -- ⚠️ DROPPED FIRST, BECAUSE `ON COMMIT DROP` COLLIDES WITH A SECOND CALL IN
  -- THE SAME TRANSACTION. A deploy calls this once, so the defect is invisible
  -- there and shows up the moment anything checks the before-and-after of a
  -- change without committing between them — which is exactly what a test that
  -- must not leave a dropped policy behind has to do.
  DROP TABLE IF EXISTS _live;

  CREATE TEMP TABLE _live ON COMMIT DROP AS
    SELECT s.identity, s.kind,
           encode(sha256(convert_to(s.definition, 'UTF8')), 'hex') AS sha
      FROM ref.protected_surface() s;

  SELECT NOT EXISTS (SELECT 1 FROM security.protected_object) INTO v_seeding;

  -- 🔴 THE FIRST RUN RECORDS AND REFUSES NOTHING, and it has to say so out
  -- loud. Seeding cannot distinguish "this is the surface" from "this is the
  -- surface somebody already weakened" — it has nothing to compare against.
  -- What it establishes is the baseline every later run is measured from.
  IF v_seeding THEN
    INSERT INTO security.protected_object (identity, kind, definition_sha256)
      SELECT l.identity, l.kind, l.sha FROM _live l;
    GET DIAGNOSTICS v_added = ROW_COUNT;
    INSERT INTO security.protected_object_history (identity, change, new_sha256)
      SELECT l.identity, 'added', l.sha FROM _live l;
    RAISE NOTICE 'PO000: baseline recorded — % protected objects. Nothing was checked; there was nothing to check against.', v_added;
    RETURN QUERY SELECT v_added, 0, 0;
    RETURN;
  END IF;

  SELECT string_agg(x.line, E'\n' ORDER BY x.line) INTO v_weak
    FROM (
      SELECT format('  REMOVED  %s', o.identity) AS line
        FROM security.protected_object o
        LEFT JOIN _live l ON l.identity = o.identity
       WHERE l.identity IS NULL
      UNION ALL
      SELECT format('  CHANGED  %s', o.identity)
        FROM security.protected_object o
        JOIN _live l ON l.identity = o.identity
       WHERE l.sha <> o.definition_sha256
    ) x;

  IF v_weak IS NOT NULL THEN
    UPDATE authz.ddl_authorization
       SET consumed_at = clock_timestamp(), consumed_by = current_user
     WHERE id = (SELECT a.id FROM authz.ddl_authorization a
                  WHERE a.consumed_at IS NULL
                  ORDER BY a.created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
    RETURNING id INTO v_auth;

    IF v_auth IS NULL THEN
      RAISE EXCEPTION
        E'PO001: the protected surface changed and no authorisation exists.\n%', v_weak
        USING HINT =
          'A protected object was removed or its definition moved. E1b requires an '
          'authorisation created OUT OF BAND by the owner before the deploy that '
          'spends it. Locally: npm run db:authorize -- "why". In production: one '
          'INSERT into authz.ddl_authorization from the provider''s SQL console. '
          'If this change was NOT intended, the previous image is still serving.';
    END IF;
  END IF;

  -- Recorded first, so the history names the authorisation that paid for it.
  INSERT INTO security.protected_object_history
         (identity, change, old_sha256, new_sha256, authorization_id)
    SELECT o.identity, 'removed', o.definition_sha256, NULL, v_auth
      FROM security.protected_object o
      LEFT JOIN _live l ON l.identity = o.identity
     WHERE l.identity IS NULL;
  GET DIAGNOSTICS v_removed = ROW_COUNT;

  INSERT INTO security.protected_object_history
         (identity, change, old_sha256, new_sha256, authorization_id)
    SELECT o.identity, 'changed', o.definition_sha256, l.sha, v_auth
      FROM security.protected_object o
      JOIN _live l ON l.identity = o.identity
     WHERE l.sha <> o.definition_sha256;
  GET DIAGNOSTICS v_changed = ROW_COUNT;

  INSERT INTO security.protected_object_history (identity, change, new_sha256)
    SELECT l.identity, 'added', l.sha
      FROM _live l
      LEFT JOIN security.protected_object o ON o.identity = l.identity
     WHERE o.identity IS NULL;
  GET DIAGNOSTICS v_added = ROW_COUNT;

  DELETE FROM security.protected_object o
   WHERE NOT EXISTS (SELECT 1 FROM _live l WHERE l.identity = o.identity);

  INSERT INTO security.protected_object (identity, kind, definition_sha256, last_changed_at)
    SELECT l.identity, l.kind, l.sha, clock_timestamp() FROM _live l
  ON CONFLICT (identity) DO UPDATE
    SET definition_sha256 = EXCLUDED.definition_sha256,
        kind              = EXCLUDED.kind,
        last_changed_at   = CASE
          WHEN security.protected_object.definition_sha256 <> EXCLUDED.definition_sha256
          THEN clock_timestamp() ELSE security.protected_object.last_changed_at END;

  RETURN QUERY SELECT v_added, v_changed, v_removed;
END;
$fn$;--> statement-breakpoint

COMMENT ON FUNCTION security.assert_protected_objects() IS
  '05c §11.11.4 PO001, at deploy. Additions are free; a removed or changed protected object costs an authz.ddl_authorization row the deploy role cannot create.';--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4 · WHAT THE BOOT COMPARES AGAINST
-- ---------------------------------------------------------------------------
-- 🔴 `ref.system_constant` RATHER THAN A NEW GRANT. Every booting process must
-- read the recorded value, and processes boot as `crm_app`, which has no USAGE
-- on `security` — measured. Widening the application role's reach into the
-- schema that holds `identity_secret` to publish one hash would be paying for a
-- boot check with a piece of the silo. `crm_app` already reads
-- `ref.system_constant`; the digest is a fact about the environment, which is
-- what that table is for.
CREATE OR REPLACE FUNCTION security.record_protected_digest()
RETURNS text
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_digest text;
BEGIN
  SELECT ref.protected_surface_digest() INTO v_digest;
  INSERT INTO ref.system_constant (key, value, reason)
  VALUES ('protected_surface_digest', v_digest,
          'sha256 over every RLS policy, t_immutable_ trigger, SECURITY DEFINER body and RLS flag outside partitions, recorded by the deploy after security.assert_protected_objects() passed. Every process recomputes it at boot and refuses to start on a mismatch (BOOT017).')
  ON CONFLICT (key) DO UPDATE
    SET value = EXCLUDED.value, reason = EXCLUDED.reason;
  RETURN v_digest;
END;
$fn$;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 5 · SEED THE BASELINE IN THIS TRANSACTION
-- ---------------------------------------------------------------------------
-- Deliberately here rather than left to the first deploy: a gate whose baseline
-- arrives "on the next run" is a gate that is off between now and then, and
-- nothing would report that it was.
SELECT security.assert_protected_objects();--> statement-breakpoint
SELECT security.record_protected_digest();--> statement-breakpoint

-- No `security.harden()` call: `security` is exempt from the hardening pass and
-- the one new function in `ref` is a function, not a relation, so the registry
-- has nothing to classify.
