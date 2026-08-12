-- ===========================================================================
-- THE DEFINER OWNER STOPS BEING A SUPERUSER, AND p_sys STARTS CARRYING TRAFFIC
--
-- 0061's honesty list named the premise the whole definer architecture rests on
-- and left it standing: `crm_migrator` is NOLOGIN, owns nothing and has no
-- USAGE on schema `app`; migrations run as `crm`, a SUPERUSER; so every
-- SECURITY DEFINER body runs as a role matching NEITHER `p_app` (TO crm_app)
-- NOR `p_sys` (TO crm_migrator) on tables with FORCE ROW LEVEL SECURITY, and
-- works only because the owner bypasses RLS. The 66 `p_sys` policies have never
-- executed once.
--
-- WHAT PRODUCTION DOES WITHOUT THIS. With a non-bypassing owner that no policy
-- names, `app.stage_move` raises `new row violates row-level security policy
-- for table "event_log"` at the FIRST CLOSE — after a green deploy, inside the
-- money path. And if the provider role DOES carry `rolbypassrls`, production
-- silently reproduces today's posture and nothing looks wrong. Both branches
-- are bad and the tree cannot tell which one it is in. After this migration the
-- branch stops existing: the owner is admitted BY POLICY, so whether it can
-- bypass is irrelevant to correctness.
--
-- ⚠️ WHAT THIS IS NOT, and a later reader must not quote it the second way.
-- `p_sys` is `USING (true) WITH CHECK (true)`. This adds ZERO tenant isolation
-- inside a definer body — `app.current_tenant()` in the body is still the only
-- boundary, and `definer-tenancy.test.ts` is still a grep over `prosrc`. And
-- the owner is NOT "bounded by policy": as `crm_migrator` you can DROP the
-- policy, `ALTER TABLE … NO FORCE ROW LEVEL SECURITY`, or GRANT ALL to
-- `crm_app`. What this buys is exactly two things: the definers become
-- DETERMINISTIC across environments, and they stop executing as a SUPERUSER.
--
-- VERIFIED RATHER THAN REASONED. Applied against the running database inside a
-- rolled-back transaction, with no grant of any kind to `crm_migrator`:
--   security.own_to_migrator()  -> 189 objects moved, 0 leftovers of any relkind
--   security.harden()           -> OK, 0 relations left without p_sys
--   as crm_app: stage_move      -> credited; sale | 150000 (12500 x 12);
--                                  opportunity.won + opportunity.stage_changed
--   ensure_event_partitions     -> 30 partitions, all owned by crm_migrator
--   DROP POLICY p_sys ON app.event_log -> stage_move now RAISES. The policy is
--                                  load-bearing for the first time in the
--                                  project's life.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1 · The migration role must be able to BECOME the owner
-- ---------------------------------------------------------------------------
-- `ALTER … OWNER TO crm_migrator` fails with `must be able to SET ROLE
-- "crm_migrator"` unless the current role is a member of it.
--
-- 🔴 THE `IF NOT` IS NOT DEFENSIVE — IT IS WHAT KEEPS THIS OUT OF THE
-- DEVELOPER'S CLUSTER. `GRANT <role> TO <role>` writes a row in
-- `pg_auth_members`, which is CLUSTER-GLOBAL and outlives `crm_test`. Measured:
-- `pg_has_role('crm','crm_migrator','USAGE')` is already TRUE, because a
-- superuser holds every role. So locally and in CI this block does nothing at
-- all. On a managed provider the role that CREATEd `crm_migrator` in 0000 holds
-- ADMIN OPTION on it; if it cannot grant itself membership, THE DEPLOY FAILS
-- HERE, loudly, before anything is half-transferred.
DO $membership$
BEGIN
  IF NOT pg_catalog.pg_has_role(current_user, 'crm_migrator', 'USAGE') THEN
    EXECUTE format('GRANT crm_migrator TO %I', current_user);
  END IF;

  IF NOT pg_catalog.pg_has_role(current_user, 'crm_migrator', 'USAGE') THEN
    RAISE EXCEPTION
      'OWN001: % cannot SET ROLE crm_migrator, so it cannot hand the schema over.',
      current_user
      USING HINT = 'GRANT crm_migrator TO the migration role, out of band, with '
                || 'a credential that holds ADMIN OPTION on it.';
  END IF;
END
$membership$;--> statement-breakpoint

-- 🔴 AND crm_app MUST NEVER BE A MEMBER. Today `GRANT crm_migrator TO crm_app`
-- is INERT — crm_migrator owns nothing and has no USAGE on app. After this
-- migration it is one `SET ROLE` away from every row in every tenant. `crm_app`
-- is NOINHERIT, so the leak is NOT automatic — which is worse rather than
-- better: `pg_has_role('crm_app','crm_migrator','USAGE')` stays FALSE while
-- `'MEMBER'` is TRUE. Measured. That is why the boot check asks BOTH questions.
DO $never$
BEGIN
  IF pg_catalog.pg_has_role('crm_app', 'crm_migrator', 'MEMBER') THEN
    RAISE EXCEPTION
      'OWN002: crm_app is a member of crm_migrator. One SET ROLE reaches every '
      'p_sys policy, which is USING (true) on every managed relation.'
      USING HINT = 'REVOKE crm_migrator FROM crm_app.';
  END IF;
END
$never$;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2 · CREATE on the database, which ALTER SCHEMA … OWNER TO requires
-- ---------------------------------------------------------------------------
-- The NEW owner is the role that needs CREATE on the database, not the caller.
-- `current_database()` rather than a literal: this runs against crm_dev,
-- crm_test and whatever the provider names production.
DO $dbcreate$
BEGIN
  EXECUTE format('GRANT CREATE ON DATABASE %I TO crm_migrator', current_database());
END
$dbcreate$;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3 · THE HANDOVER
-- ---------------------------------------------------------------------------
-- ⚠️ EVERY LOOP SKIPS WHAT THE CALLER CANNOT TAKE, and that is deliberate
-- rather than defensive. This runs INSIDE THE EVENT STORE'S WRITE PATH at
-- runtime, as `crm_migrator`, which is not a member of the migration role. A
-- raise here would turn one foreign-owned table into "no partition can ever be
-- created again" — strictly worse than the failure being fixed. So a foreign
-- object is skipped silently at runtime and the BOOT check refuses the NEXT
-- BOOT with its name. An EXCEPTION handler swallowing `insufficient_privilege`
-- would be the `catch {}` this project forbids, and would hide the same fact.
--
-- ORDER IS LOAD-BEARING: schema before its contents, because
-- `ALTER TABLE/FUNCTION … OWNER TO x` requires x to hold CREATE on the SCHEMA.
-- Reversed, a non-superuser migration role gets `permission denied for schema`.
--
-- 🔴 EXTENSION MEMBERS ARE EXCLUDED (`pg_depend.deptype = 'e'`). citext, pg_trgm
-- and btree_gin install into `public`, which is `managed`; re-owning ~90
-- extension functions is a large change nobody asked for.
--
-- 🔴 `public` IS EXCLUDED FROM THE TRANSFER AND INCLUDED IN THE CHECK. It is
-- Postgres's own schema and taking it is a provider-visible act. But the
-- verification below looks at RLS relations in EVERY schema, so a table created
-- in `public` by a future migration refuses the boot BY NAME instead of failing
-- at runtime inside a definer. The check's scope is a SUPERSET of what the
-- function moves, never narrower.
CREATE OR REPLACE FUNCTION security.own_to_migrator()
RETURNS integer
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $fn$
DECLARE
  r         record;
  moved     integer := 0;
  v_schemas text[];
BEGIN
  IF NOT pg_has_role(current_user, 'crm_migrator', 'USAGE') THEN
    RETURN 0;
  END IF;

  -- The list harden() already trusts, minus `public`, plus `security` — which
  -- is 'exempt' from harden but holds table_registry, harden() and this
  -- function, and crm_migrator must own them to run harden() at runtime.
  SELECT array_agg(s) INTO v_schemas
    FROM (SELECT sp.schema_name AS s
            FROM security.schema_policy sp
           WHERE sp.posture = 'managed' AND sp.schema_name <> 'public'
          UNION SELECT 'security') q;

  FOR r IN
    SELECT n.nspname
      FROM pg_namespace n
     WHERE n.nspname = ANY(v_schemas)
       AND pg_get_userbyid(n.nspowner) <> 'crm_migrator'
       AND pg_has_role(current_user, n.nspowner, 'USAGE')
     ORDER BY n.nspname
  LOOP
    EXECUTE format('ALTER SCHEMA %I OWNER TO crm_migrator', r.nspname);
    moved := moved + 1;
  END LOOP;

  -- Indexes and constraints follow their table; sequences, views and partitions
  -- do not, so they are enumerated. `relkind` drives the object keyword because
  -- PostgreSQL rejects `ALTER TABLE` on a sequence.
  FOR r IN
    SELECT c.oid::regclass AS ident, c.relkind
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = ANY(v_schemas)
       AND c.relkind IN ('r', 'p', 'S', 'v', 'm')
       AND pg_get_userbyid(c.relowner) <> 'crm_migrator'
       AND pg_has_role(current_user, c.relowner, 'USAGE')
       AND NOT EXISTS (SELECT 1 FROM pg_depend d
                        WHERE d.classid = 'pg_class'::regclass
                          AND d.objid = c.oid AND d.deptype = 'e')
  LOOP
    EXECUTE format('ALTER %s %s OWNER TO crm_migrator',
                   CASE r.relkind
                     WHEN 'S' THEN 'SEQUENCE'
                     WHEN 'v' THEN 'VIEW'
                     WHEN 'm' THEN 'MATERIALIZED VIEW'
                     ELSE 'TABLE'
                   END, r.ident);
    moved := moved + 1;
  END LOOP;

  FOR r IN
    SELECT p.oid::regprocedure AS ident, p.prokind
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = ANY(v_schemas)
       AND pg_get_userbyid(p.proowner) <> 'crm_migrator'
       AND pg_has_role(current_user, p.proowner, 'USAGE')
       AND NOT EXISTS (SELECT 1 FROM pg_depend d
                        WHERE d.classid = 'pg_proc'::regclass
                          AND d.objid = p.oid AND d.deptype = 'e')
  LOOP
    EXECUTE format('ALTER %s %s OWNER TO crm_migrator',
                   CASE r.prokind WHEN 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END,
                   r.ident);
    moved := moved + 1;
  END LOOP;

  -- Enums and domains only. A table's composite type follows its table, and
  -- asking for it separately raises. This matters because `ALTER TYPE … ADD
  -- VALUE` in a later migration requires ownership, and `app.event_name` grows.
  FOR r IN
    SELECT t.oid::regtype AS ident
      FROM pg_type t
      JOIN pg_namespace n ON n.oid = t.typnamespace
     WHERE n.nspname = ANY(v_schemas)
       AND t.typtype IN ('e', 'd')
       AND pg_get_userbyid(t.typowner) <> 'crm_migrator'
       AND pg_has_role(current_user, t.typowner, 'USAGE')
       AND NOT EXISTS (SELECT 1 FROM pg_depend d
                        WHERE d.classid = 'pg_type'::regclass
                          AND d.objid = t.oid AND d.deptype = 'e')
  LOOP
    EXECUTE format('ALTER TYPE %s OWNER TO crm_migrator', r.ident);
    moved := moved + 1;
  END LOOP;

  RETURN moved;
END
$fn$;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4 · THE HOOK. security.harden() IS NOT COPIED, AND THAT IS THE POINT.
-- ---------------------------------------------------------------------------
-- 🔴 THE OBVIOUS SHAPE — `CREATE OR REPLACE FUNCTION security.harden()` with
-- 0048's 185-line body carried verbatim plus one inserted line — IS THE ONE TO
-- REFUSE. 0048's own comments record that body being staled TWICE by a branch
-- that copied it early and landed late. A third copy is a third chance, and
-- "remember to keep the copy current" is documentation.
--
-- `security.managed_relations()` is the SINGLE catalog scan harden() reads. It
-- is eight lines and has never been copied. Putting the re-assertion HERE means
-- harden() needs no edit, this migration carries no copy of it, and a future
-- branch cannot drop the call by copying the wrong version of a function it
-- never touches.
--
-- STABLE -> VOLATILE is required and is the honest declaration: this function
-- now has an effect. It runs once per harden(), and harden() runs at the end of
-- every table-adding migration and inside `ensure_event_partitions` /
-- `ensure_audit_partitions` when a partition is created in flight.
--
-- The body below is the 0000 definition verbatim, in plpgsql, with one PERFORM
-- in front of it.
CREATE OR REPLACE FUNCTION security.managed_relations()
RETURNS TABLE (schema_name text, table_name text, relkind "char")
LANGUAGE plpgsql
VOLATILE
AS $fn$
BEGIN
  -- OWNERSHIP BEFORE POLICY. A relation created by the migration role is owned
  -- by the migration role, and FORCE RLS on a table whose owner no policy names
  -- is a definer that cannot write it. Taking ownership first means the policies
  -- harden() builds are created by the role that will be subject to them.
  --
  -- At RUNTIME this is a catalog read and nothing else: the partition that
  -- triggered the call was created BY crm_migrator, so every loop matches
  -- nothing and takes no lock.
  PERFORM security.own_to_migrator();

  RETURN QUERY
  SELECT n.nspname::text, c.relname::text, c.relkind
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN security.schema_policy sp ON sp.schema_name = n.nspname
   WHERE c.relkind IN ('r', 'p')          -- ordinary and partitioned tables
     AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
     AND n.nspname NOT LIKE 'pg_temp%'
     AND n.nspname NOT LIKE 'pg_toast_temp%'
     AND coalesce(sp.posture, 'managed') = 'managed';
END
$fn$;--> statement-breakpoint

-- Does the handover AND re-issues every crm_app grant and every policy under
-- the new ownership, in this transaction.
SELECT security.harden();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 5 · pgboss, which app.webhook_ingest reaches and harden() does not manage
-- ---------------------------------------------------------------------------
-- `app.webhook_ingest` inserts into `pgboss.job`. `pgboss` is classified exempt
-- and is owned by the migration role, so the handover does not reach it —
-- measured: `has_schema_privilege('crm_migrator','pgboss','USAGE')` is FALSE
-- right now. Without this grant every inbound Aloware webhook raises and calls
-- stop appearing in sellers' histories.
--
-- 🔴 NOT IN harden(), ON PURPOSE. harden() runs at RUNTIME as crm_migrator,
-- which does not own pgboss and cannot GRANT on it. Putting these lines there
-- would add a new way for partition creation to fail. `scripts/jobs-schema.ts`
-- is the other half and is required rather than redundant: on a fresh database
-- `db:jobs` runs AFTER the migrations, so at this point pgboss does not exist.
DO $pgboss$
BEGIN
  IF to_regnamespace('pgboss') IS NOT NULL THEN
    EXECUTE 'GRANT USAGE ON SCHEMA pgboss TO crm_migrator';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pgboss TO crm_migrator';
    EXECUTE 'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA pgboss TO crm_migrator';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss '
         || 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO crm_migrator';
  END IF;
END
$pgboss$;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 6 · Refuse to finish if the handover did not actually happen
-- ---------------------------------------------------------------------------
-- The migration's own copy of the boot checks. It exists because a migration
-- that half-succeeds and commits is how this becomes a runtime failure again.
-- The scope is the SUPERSET of what `own_to_migrator` moves — every relkind,
-- every routine, every enum and domain — because a check narrower than the
-- function it guards is a check that reports success about what it did not
-- look at.
DO $verify$
DECLARE
  v_schemas   text[];
  bad_obj     int;
  bad_rls     int;
  no_p_sys    int;
  open_to_app int;
  can_bypass  boolean;
BEGIN
  SELECT array_agg(s) INTO v_schemas
    FROM (SELECT sp.schema_name AS s FROM security.schema_policy sp
           WHERE sp.posture = 'managed' AND sp.schema_name <> 'public'
          UNION SELECT 'security') q;

  SELECT (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
           WHERE n.nspname = ANY(v_schemas) AND c.relkind IN ('r','p','S','v','m')
             AND pg_get_userbyid(c.relowner) <> 'crm_migrator'
             AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid='pg_class'::regclass
                              AND d.objid=c.oid AND d.deptype='e'))
       + (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
           WHERE n.nspname = ANY(v_schemas)
             AND pg_get_userbyid(p.proowner) <> 'crm_migrator'
             AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid='pg_proc'::regclass
                              AND d.objid=p.oid AND d.deptype='e'))
       + (SELECT count(*) FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
           WHERE n.nspname = ANY(v_schemas) AND t.typtype IN ('e','d')
             AND pg_get_userbyid(t.typowner) <> 'crm_migrator'
             AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid='pg_type'::regclass
                              AND d.objid=t.oid AND d.deptype='e'))
    INTO bad_obj;

  SELECT count(*) INTO bad_rls
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE c.relkind IN ('r','p') AND c.relrowsecurity
     AND pg_get_userbyid(c.relowner) <> 'crm_migrator';

  SELECT count(*) INTO no_p_sys
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE c.relkind IN ('r','p') AND c.relrowsecurity
     AND NOT EXISTS (
       SELECT 1 FROM pg_policy pol
        WHERE pol.polrelid = c.oid AND pol.polname = 'p_sys'
          AND pol.polpermissive AND pol.polcmd = '*'
          -- `polroles` is oid[], not regrole[]. The cast is not decoration:
          -- without it this raises "operator does not exist: oid[] = regrole[]".
          AND pol.polroles = ARRAY['crm_migrator'::regrole::oid]
          AND pg_get_expr(pol.polqual, c.oid) = 'true'
          AND pg_get_expr(pol.polwithcheck, c.oid) = 'true');

  -- 🔴 THE SHAPE, NOT THE NAME. A `DROP POLICY p_sys` followed by
  -- `CREATE POLICY p_sys … TO crm_app USING (true) WITH CHECK (true)` passes a
  -- name check and is a total cross-tenant read. There is no legitimate policy
  -- of that shape today, so the symmetric refusal is safe.
  SELECT count(*) INTO open_to_app
    FROM pg_policy pol JOIN pg_class c ON c.oid = pol.polrelid
   WHERE c.relrowsecurity AND pol.polpermissive
     AND 'crm_app'::regrole::oid = ANY(pol.polroles)
     AND pg_get_expr(pol.polqual, c.oid) = 'true'
     AND pg_get_expr(pol.polwithcheck, c.oid) = 'true';

  SELECT rolsuper OR rolbypassrls INTO can_bypass FROM pg_roles WHERE rolname='crm_migrator';

  IF bad_obj > 0 OR bad_rls > 0 OR no_p_sys > 0 OR open_to_app > 0 OR can_bypass THEN
    RAISE EXCEPTION
      'OWN003: handover incomplete — % foreign objects, % foreign RLS relations, '
      '% relations without a well-formed p_sys, % policies opening a managed '
      'relation to crm_app, owner_can_bypass=%',
      bad_obj, bad_rls, no_p_sys, open_to_app, can_bypass;
  END IF;
END
$verify$;
