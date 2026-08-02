-- Three corrections to the hardening loop, all found by reading 05b §674-712
-- against what 0000 actually generated. Each one is a hole that has no symptom.

-- ---------------------------------------------------------------------------
-- 1 · The immutability trigger must be STATEMENT-level, and cover TRUNCATE
-- ---------------------------------------------------------------------------
-- 0000 attached a FOR EACH ROW trigger on UPDATE OR DELETE. Two things get
-- through that:
--
--   * `DELETE FROM earnings_ledger WHERE false` — a row trigger never fires
--     when no rows match, so the statement succeeds silently. It deleted
--     nothing today; the point is that the guard did not object, and the next
--     predicate might match.
--   * `TRUNCATE earnings_ledger` — TRUNCATE bypasses row triggers AND the
--     DELETE privilege entirely. The one statement that can erase the whole
--     append-only record was the one statement nothing stopped.
--
-- Statement-level BEFORE UPDATE OR DELETE OR TRUNCATE closes both. It raises
-- unconditionally, so it also binds the provider's SQL console — where a
-- REVOKE against crm_app means nothing, because that console is not crm_app.
CREATE OR REPLACE FUNCTION security.refuse_mutation()
RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION
    'AP001: % is append-only. Corrections are compensating appends, never edits.',
    TG_TABLE_NAME
    USING HINT = 'There is no recompute job by design. Use the admin void/adjust surface.',
          ERRCODE = 'AP001';
END
$fn$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2 · harden(), corrected
-- ---------------------------------------------------------------------------
-- The two other corrections:
--
--   * append_only_* must generate WITH CHECK (FALSE), not an owner predicate.
--     `false` is non-null, so the every-policy-declares-both gate is satisfied
--     honestly while the write path becomes structurally impossible for the
--     app role. The only writer is a SECURITY DEFINER function, which reaches
--     the table through the crm_migrator policy.
--   * append_only_* gets NO DML grant whatsoever — not INSERT, not UPDATE, not
--     DELETE, not TRUNCATE. 0000 granted INSERT when app_can_insert was true,
--     which for an append-only table is exactly the wrong default.
CREATE OR REPLACE FUNCTION security.harden()
RETURNS void
LANGUAGE plpgsql AS $fn$
DECLARE
  r           record;
  reg         security.table_registry%ROWTYPE;
  qual        text;
  with_check  text;
  ident       text;
  trg         text;
  append_only boolean;
  tenant_pred constant text := 'tenant_id = app.current_tenant()';
BEGIN
  FOR r IN SELECT * FROM security.managed_relations() LOOP
    ident := format('%I.%I', r.schema_name, r.table_name);
    trg   := left('t_immutable_' || r.table_name, 63);

    SELECT * INTO reg FROM security.table_registry tr
     WHERE tr.schema_name = r.schema_name AND tr.table_name = r.table_name;

    IF NOT FOUND THEN
      RAISE EXCEPTION
        'HR001: relation % has no security.table_registry row. Classify it in the migration that creates it.',
        ident
        USING HINT = 'Every relation is classified or the deploy fails. This is the keystone, not a formality.';
    END IF;

    append_only := reg.policy_class IN
      ('append_only_owner', 'append_only_tenant', 'append_only_tenant_admin');

    CASE reg.policy_class
      WHEN 'owner_scoped' THEN
        qual := format('%s AND (%I = app.current_user_id() OR app.scope_is_global())',
                       tenant_pred, reg.owner_column);
        with_check := format('%s AND %I = app.current_user_id()',
                             tenant_pred, reg.owner_column);

      WHEN 'append_only_owner' THEN
        -- Reads follow the silo; writes are impossible through this role.
        qual := format('%s AND (%I = app.current_user_id() OR app.scope_is_global())',
                       tenant_pred, reg.owner_column);
        with_check := 'false';

      WHEN 'tenant_scoped' THEN
        qual := tenant_pred;
        with_check := format('%s AND app.scope_is_admin()', tenant_pred);

      WHEN 'tenant_scoped_read' THEN
        -- Sanctioned cross-silo read. Nobody writes.
        qual := tenant_pred;
        with_check := 'false';

      WHEN 'append_only_tenant' THEN
        qual := tenant_pred;
        with_check := 'false';

      WHEN 'tenant_admin_only' THEN
        qual := format('%s AND app.scope_is_admin()', tenant_pred);
        with_check := format('%s AND app.scope_is_admin()', tenant_pred);

      WHEN 'append_only_tenant_admin' THEN
        qual := format('%s AND app.scope_is_admin()', tenant_pred);
        with_check := 'false';

      WHEN 'definer_only', 'system_cross_tenant' THEN
        -- An EXPLICIT deny, not the absence of a policy, so the catalog gate's
        -- "at least one policy" rule is met honestly rather than by omission.
        qual := 'false';
        with_check := 'false';

      WHEN 'reference' THEN
        qual := 'true';
        with_check := 'false';

      ELSE
        RAISE EXCEPTION 'HR002: policy_class % has no generator', reg.policy_class;
    END CASE;

    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', ident);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', ident);

    EXECUTE format('DROP POLICY IF EXISTS p_app ON %s', ident);
    EXECUTE format('CREATE POLICY p_app ON %s FOR ALL TO crm_app USING (%s) WITH CHECK (%s)',
                   ident, qual, with_check);

    EXECUTE format('DROP POLICY IF EXISTS p_sys ON %s', ident);
    EXECUTE format('CREATE POLICY p_sys ON %s FOR ALL TO crm_migrator USING (true) WITH CHECK (true)',
                   ident);

    EXECUTE format('REVOKE ALL ON %s FROM crm_app', ident);
    EXECUTE format('GRANT SELECT ON %s TO crm_app', ident);

    -- An append-only table gets no DML at all. Its writer is a definer.
    IF NOT append_only THEN
      IF reg.app_can_insert
         AND reg.policy_class NOT IN ('definer_only', 'system_cross_tenant', 'reference',
                                      'tenant_scoped_read') THEN
        EXECUTE format('GRANT INSERT ON %s TO crm_app', ident);
      END IF;

      IF NOT reg.immutable
         AND reg.policy_class NOT IN ('definer_only', 'system_cross_tenant', 'reference',
                                      'tenant_scoped_read') THEN
        EXECUTE format('GRANT UPDATE ON %s TO crm_app', ident);
      END IF;
    END IF;

    -- Immutability is a trigger AND a revoked privilege. The trigger is the
    -- half that binds a superuser at the provider's SQL console.
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %s', trg, ident);
    IF reg.immutable OR append_only THEN
      EXECUTE format(
        'CREATE TRIGGER %I BEFORE UPDATE OR DELETE OR TRUNCATE ON %s '
        'FOR EACH STATEMENT EXECUTE FUNCTION security.refuse_mutation()',
        trg, ident);
    END IF;
  END LOOP;

  EXECUTE 'REVOKE ALL ON SCHEMA public FROM crm_app';
  EXECUTE 'REVOKE ALL ON SCHEMA security FROM crm_app';
  EXECUTE 'GRANT USAGE ON SCHEMA app TO crm_app';
  EXECUTE 'GRANT USAGE ON SCHEMA ref TO crm_app';
END
$fn$;
--> statement-breakpoint

SELECT security.harden();
