-- ===========================================================================
-- THE APPLICATION ROLE CAN NO LONGER CLAIM TO BE SOMEBODY ELSE
--
-- 🔴 THE FINDING THIS CLOSES, MEASURED RATHER THAN REASONED. Inside a real
-- seller's session, as `crm_app`:
--
--     SELECT count(*) FROM app.contact;                       -->  42
--     SELECT set_config('app.user_id', <a colleague>, true);
--     SELECT count(*) FROM app.contact;                       -->   3
--
-- Every RLS policy in this schema, `app.timeline_read`'s ownership predicate
-- and `app.stage_move`'s SM404 all rest on `app.current_user_id()`, which read
-- a GUC the application role could simply overwrite. The silo was a convention
-- the application observed, not a rule the database enforced — which is the
-- exact category this project's constitution says to name plainly instead of
-- presenting as a mechanism.
--
-- ⚠️ WHAT WAS TRIED FIRST AND DOES NOT WORK, so nobody tries it again.
-- PostgreSQL 15 added `GRANT SET ON PARAMETER`, and
-- `REVOKE SET ON PARAMETER app.user_id FROM PUBLIC` is ACCEPTED WITHOUT ERROR
-- — and does nothing. `app.user_id` is a placeholder GUC (a custom name no
-- extension has defined), so no ACL row is stored: `pg_parameter_acl` is empty
-- afterwards and `set_config` still succeeds, verified as a real `crm_app`
-- connection. A revoke that reports success and changes nothing is worse than
-- no revoke at all.
--
-- THE SHAPE THAT WORKS IS THE ONE `app.scope_is_global()` ALREADY USED: do not
-- trust the claim, verify it. That function re-checks the claimed scope against
-- `app_user.role`, so forging `app.scope_mode` alone buys nothing. This does
-- the same for identity — the claim now has to come with a seal the
-- application role cannot compute, because computing it needs a secret it
-- cannot read and a function it cannot execute.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1 · THE SECRET
-- ---------------------------------------------------------------------------
-- In `security`, which is `exempt` in `security.schema_policy` for the reason
-- that matters here: "Readable only by crm_migrator; crm_app has no grants on
-- this schema at all." Not even USAGE — so this table is not merely unreadable,
-- it is unnameable.
--
-- 🔴 GENERATED AT INSTALL, NEVER WRITTEN DOWN. A constant in the migration file
-- is a secret in the repository, in the image and in every clone. Each database
-- gets its own, which also means a seal minted against development is
-- meaningless in production.
CREATE TABLE IF NOT EXISTS security.identity_secret (
  only_row boolean PRIMARY KEY DEFAULT true CONSTRAINT identity_secret_is_one_row
    CHECK (only_row),
  secret   text    NOT NULL
);--> statement-breakpoint

-- Four v4 uuids rather than `gen_random_bytes`, which lives in pgcrypto and
-- pgcrypto is not installed here — measured, not assumed. `gen_random_uuid()`
-- is core and each one carries 122 random bits, so this is ~488 bits from the
-- same CSPRNG. Adding an extension for a shorter string would be a deploy-time
-- dependency bought for nothing.
INSERT INTO security.identity_secret (only_row, secret)
VALUES (true, gen_random_uuid()::text || gen_random_uuid()::text
           || gen_random_uuid()::text || gen_random_uuid()::text)
ON CONFLICT (only_row) DO NOTHING;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2 · THE SEAL
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER and GRANTED TO NOBODY. Only the three context functions
-- below reach it, running as the owner. `crm_app` cannot execute it and cannot
-- read what it reads, so it cannot produce a value that satisfies §3 for any
-- identity — including its own.
--
-- ⚠️ md5 IS NOT A SECURITY CLAIM HERE AND MUST NOT BE READ AS ONE. This is not
-- resisting an offline attacker with the digest in hand; it is resisting a
-- caller that cannot see the input at all. The secret is 256 bits from
-- `gen_random_bytes` and never leaves the database. If the threat model ever
-- includes something that can read `security.identity_secret`, this whole file
-- is already moot — that role can set any GUC it likes.
CREATE OR REPLACE FUNCTION app.identity_seal(p_tenant_id uuid, p_user_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = app, security, pg_catalog
AS $fn$
  SELECT md5(s.secret || ':' || p_tenant_id::text || ':' || p_user_id::text)
    FROM security.identity_secret s
$fn$;--> statement-breakpoint

REVOKE ALL ON FUNCTION app.identity_seal(uuid, uuid) FROM PUBLIC;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3 · THE VERIFICATION
-- ---------------------------------------------------------------------------
-- 🔴 THE SINGLE HIGHEST-BLAST-RADIUS FUNCTION IN THE TREE. Every RLS policy
-- calls it, every definer's ownership predicate calls it, and it is the reason
-- a seller sees her own book. It stays STABLE and zero-argument so the planner
-- folds it once per statement rather than once per row.
--
-- AN UNSEALED CLAIM IS NOT AN ERROR, IT IS AN ABSENCE. Returning NULL rather
-- than raising is deliberate and it is the fail-CLOSED direction: NULL makes
-- `owner_user_id = app.current_user_id()` false for every row, so a forged
-- identity sees NOTHING rather than seeing somebody else's book. A raise would
-- be louder and would also turn a forged GUC into a denial-of-service on the
-- whole request.
--
-- THE EMPTY USER IS EXEMPT ON PURPOSE. `app.begin_system_work` sets
-- `app.user_id` to '' — system work has no user — and this returns NULL for
-- that with no seal required, exactly as it always did.
CREATE OR REPLACE FUNCTION app.current_user_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = app, security, pg_catalog
AS $fn$
  -- ⚠️ THE SEAL IS RECOMPUTED HERE RATHER THAN BY CALLING app.identity_seal,
  -- AND THAT IS A MEASUREMENT, NOT A STYLE CHOICE. The first version nested one
  -- SECURITY DEFINER inside another; a definer can never be inlined by the
  -- planner, so every statement paid two un-inlinable calls plus a heap read.
  -- N13 measured p95 = 121.7 ms against a 120 ms budget — over, and a budget is
  -- not something this project weakens to make a build pass. Folding the two
  -- into one call brought it back under. `app.identity_seal` stays because the
  -- three minting sites need it; this is the read path and it is hotter than
  -- all of them combined.
  SELECT c.id
    FROM (SELECT nullif(current_setting('app.user_id', true), '')::uuid    AS id,
                 nullif(current_setting('app.tenant_id', true), '')::uuid  AS tenant,
                 nullif(current_setting('app.identity_seal', true), '')    AS seal) c
   WHERE c.id IS NOT NULL
     AND c.seal IS NOT NULL
     AND c.seal = (SELECT md5(s.secret || ':' || c.tenant::text || ':' || c.id::text)
                     FROM security.identity_secret s)
$fn$;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4 · THE THREE PLACES THAT MINT A SEAL, AND THERE ARE ONLY THREE
-- ---------------------------------------------------------------------------
-- `app.begin_request` — the door every request opens. Body transcribed from
-- 0003 with ONE added statement; the leak detector, the identity verification
-- and the scope derivation are unchanged and are the reason this function is
-- the only place a seller identity can enter.
CREATE OR REPLACE FUNCTION app.begin_request(p_tenant_id uuid, p_user_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = app, pg_catalog
AS $fn$
DECLARE
  v_role  app.user_role;
  v_scope text;
  v_stale text;
BEGIN
  -- 1 · The pooled-context leak detector. Unchanged from 0003.
  v_stale := nullif(current_setting('app.tenant_id', true), '');
  IF v_stale IS NOT NULL THEN
    RAISE EXCEPTION
      'CTX001: session context was already set (tenant %) when this unit of work began', v_stale
      USING HINT = 'A bare SET leaked across a transaction, or the pooler is in session mode. '
                   'Transaction mode plus set_config(..., true) is the only supported configuration.';
  END IF;

  -- 2 · Identity is verified, never asserted. Unchanged from 0003.
  SELECT u.role INTO v_role
  FROM app.app_user u
  WHERE u.tenant_id = p_tenant_id
    AND u.id = p_user_id
    AND u.deactivated_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'CTX002: no active user for the supplied session'
      USING HINT = 'A deactivated seller must not be able to open a unit of work.';
  END IF;

  -- 3 · Scope is DERIVED from the role. It is never an input. Unchanged.
  v_scope := CASE v_role
               WHEN 'seller'     THEN 'owner'
               WHEN 'supervisor' THEN 'tenant_read'
               WHEN 'admin'      THEN 'tenant_admin'
             END;

  PERFORM set_config('app.tenant_id',  p_tenant_id::text, true);
  PERFORM set_config('app.user_id',    p_user_id::text,   true);
  PERFORM set_config('app.scope_mode', v_scope,           true);

  -- 🔴 THE NEW LINE, AND THE WHOLE MIGRATION. Everything above already refused
  -- to take the seller's word for who they are; this makes the ANSWER
  -- unforgeable too. Without it, the three set_config calls above are three
  -- statements `crm_app` can issue for itself.
  PERFORM set_config('app.identity_seal',
                     app.identity_seal(p_tenant_id, p_user_id), true);

  RETURN v_scope;
END;
$fn$;--> statement-breakpoint

-- `app.begin_system_work` — the worker's door. It sets no user, so it mints no
-- seal; it CLEARS one instead. Without the clear, a unit of work that opened as
-- a seller and then entered system work would leave a valid seal behind next to
-- an empty user id — harmless today, and exactly the kind of residue that stops
-- being harmless when somebody later reads the seal without the user.
CREATE OR REPLACE FUNCTION app.begin_system_work(p_tenant_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = app, pg_catalog
AS $fn$
DECLARE
  v_stale text;
BEGIN
  v_stale := nullif(current_setting('app.tenant_id', true), '');
  IF v_stale IS NOT NULL THEN
    RAISE EXCEPTION
      'CTX001: session context was already set (tenant %) when this unit of work began', v_stale
      USING HINT = 'A bare SET leaked across a transaction, or the pooler is in session mode.';
  END IF;

  PERFORM set_config('app.tenant_id',      p_tenant_id::text, true);
  PERFORM set_config('app.user_id',        '',                true);
  PERFORM set_config('app.scope_mode',     'system',          true);
  PERFORM set_config('app.identity_seal',  '',                true);

  RETURN 'system';
END;
$fn$;--> statement-breakpoint

-- `app.reminder_gate` — the one legitimate ELEVATION in the tree, and the
-- reason this migration cannot simply forbid writing `app.user_id`. The
-- dispatcher runs under system work, derives the job's owner from the job row,
-- and asks the compliance gate on that seller's behalf. It is a definer, so it
-- can mint the matching seal; a route cannot.
--
-- Body transcribed from 0060 with the seal set beside the identity and cleared
-- beside the restore, in all three paths including the exception handler.
CREATE OR REPLACE FUNCTION app.reminder_gate(p_job_id uuid)
RETURNS TABLE (verdict app.gate_verdict, event_verdict text, override_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = app, ref, pg_catalog
AS $fn$
DECLARE
  v_tenant   uuid;
  v_owner    uuid;
  v_subject  uuid;
  v_kind     app.scheduled_kind;
  v_contact  uuid;
  v_prev     text;
  v_prevseal text;
  v_verdict  app.gate_verdict;
  v_event    text;
  v_override uuid;
  v_zones    text[];
  v_phone_id uuid;
BEGIN
  v_tenant := app.current_tenant();
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'RG001: reminder_gate called with no tenant context'
      USING HINT = 'The dispatcher opens withSystemWork(tenant) per job before asking.';
  END IF;

  SELECT j.owner_user_id, j.subject_id, j.kind
    INTO v_owner, v_subject, v_kind
    FROM app.scheduled_job j
   WHERE j.tenant_id = v_tenant AND j.id = p_job_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'RG002: no such scheduled job in this tenant';
  END IF;

  IF v_kind <> 'meeting_reminder' THEN
    RAISE EXCEPTION 'RG003: % is not a reminder, and only reminders contact anybody', v_kind;
  END IF;

  SELECT m.contact_id INTO v_contact
    FROM app.meeting m
   WHERE m.tenant_id = v_tenant AND m.id = v_subject;

  IF v_owner IS NULL OR v_contact IS NULL THEN
    RETURN QUERY SELECT 'blocked_timezone_unknown'::app.gate_verdict,
                        'unknown_timezone'::text, NULL::uuid;
    RETURN;
  END IF;

  -- 🔴 THE ELEVATION NOW CARRIES ITS OWN SEAL. Setting `app.user_id` alone no
  -- longer produces an identity — that is the entire point of this migration —
  -- so an elevation that forgot the seal would silently evaluate the gate with
  -- NO user, which resolves to the closed answer for every contact. Wiring it
  -- naively would have blocked every reminder in the fleet and passed the
  -- tests, which is precisely the trap 0058 records one gate earlier.
  v_prev     := coalesce(current_setting('app.user_id', true), '');
  v_prevseal := coalesce(current_setting('app.identity_seal', true), '');
  PERFORM set_config('app.user_id', v_owner::text, true);
  PERFORM set_config('app.identity_seal', app.identity_seal(v_tenant, v_owner), true);

  BEGIN
    SELECT c.verdict, c.event_verdict, c.override_id, c.zones, c.contact_phone_id
      INTO v_verdict, v_event, v_override, v_zones, v_phone_id
      FROM app.compliance_check(v_contact, 'sms'::app.channel) c;
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('app.user_id', v_prev, true);
    PERFORM set_config('app.identity_seal', v_prevseal, true);
    RAISE;
  END;

  PERFORM set_config('app.user_id', v_prev, true);
  PERFORM set_config('app.identity_seal', v_prevseal, true);

  -- RECORDED AFTER THE RESTORE. See 0060: recording while still elevated puts
  -- the seller's uuid on a decision a scheduler made, and her own history then
  -- reads "You" about a text nobody attempted.
  PERFORM app.compliance_record(
    v_owner, v_contact, 'sms'::app.channel, 'reminder_dispatch'::app.attempt_origin,
    v_verdict, v_event, v_override, v_zones, v_phone_id, clock_timestamp(),
    'scheduler'::app.actor_type, 'scheduler'::app.source_system);

  RETURN QUERY SELECT v_verdict, v_event, v_override;
END;
$fn$;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 5 · THE NEW OBJECTS JOIN THE OWNERSHIP THE DEFINERS RUN UNDER
-- ---------------------------------------------------------------------------
-- 🔴 WITHOUT THIS THE MIGRATION APPLIES AND EVERY REQUEST FAILS — measured, on
-- the first run: `permission denied for function identity_seal`, raised from
-- inside `begin_request`.
--
-- 0062 handed every definer to `crm_migrator`, so `begin_request` executes as
-- that role. A function created by THIS migration is owned by the migration
-- credential instead, and `identity_seal` is granted to nobody — so the owner
-- of the caller was not the owner of the callee and the implicit
-- owner-privilege did not apply.
--
-- `own_to_migrator()` rather than `harden()`: the same handover, without taking
-- ACCESS EXCLUSIVE on every table in `app` and `ref` to move four functions and
-- one table.
SELECT security.own_to_migrator();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- WHAT THIS DOES NOT CLOSE
-- ---------------------------------------------------------------------------
-- 1. `app.tenant_id` IS STILL A BARE CLAIM. This seals the USER against the
--    tenant, so a caller cannot become a colleague — but a caller that rewrites
--    BOTH `app.tenant_id` and `app.user_id` to a matching pair in another
--    agency still has no seal for it, so `current_user_id()` returns NULL and
--    every owner-scoped policy closes. What it would reach is the
--    `tenant_scoped_read` classes, which scope on `current_tenant()` alone.
--    Sealing the tenant on its own needs a value minted before any user is
--    known, and `begin_request` takes both together — so this is a real
--    remaining gap and it is named rather than papered over.
-- 2. THE SEAL IS PER (tenant, user) AND NOT PER TRANSACTION. A caller that
--    captures its OWN seal can replay it later in the same session. That is not
--    an escalation — it is its own identity — but it means the seal is an
--    identity proof, not a session token.
-- 3. ANYTHING THAT CAN READ `security.identity_secret` DEFEATS THIS ENTIRELY.
--    `crm_app` has no USAGE on the schema, so it cannot name the table. The
--    owner can, and the owner can already set any GUC it likes.
-- 4. IT IS NOT A DEFENCE AGAINST THE APPLICATION ITSELF. Application code that
--    calls `app.begin_request` with a user id it made up gets a real seal for a
--    real identity — verification happens at the door, and the door checks
--    `app_user`, not intent. What this closes is a caller REWRITING the
--    identity after the door has answered, which is the shape SQL injection and
--    a stray `set_config` both take.
