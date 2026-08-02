-- The search index, the live view, and classification.

-- ---------------------------------------------------------------------------
-- 1 · Global search, with the ownership predicate INSIDE the index
-- ---------------------------------------------------------------------------
-- Sprint-0 gate G1e proved btree_gin ships a GIN opclass for uuid, and proved
-- it with a planner check rather than a catalog lookup: all three conditions
-- land in Index Cond, not in a post-retrieval filter.
--
-- That distinction is the whole point. A tenant-wide trigram index filtered
-- AFTER retrieval is the silo leak that rules out a separate search service:
-- the rows are fetched first and discarded second, and every layer above has
-- to be trusted to do the discarding. Here the seller's own rows are the only
-- ones the index scan ever produces.
CREATE INDEX IF NOT EXISTS contact_name_trgm_idx
  ON app.contact USING gin (tenant_id, owner_user_id, full_name gin_trgm_ops);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS contact_email_idx
  ON app.contact (tenant_id, owner_user_id, email_norm)
  WHERE email_norm IS NOT NULL AND deleted_at IS NULL;
--> statement-breakpoint

-- Deliberately WITHOUT owner_user_id. This is the second, tenant-wide scope on
-- the same number: suppression matching, the non-attributive recent-contact
-- signal, and inbound webhook attribution. Reachable only through SECURITY
-- DEFINER functions that return a verdict and a reason code, never a row.
CREATE INDEX IF NOT EXISTS contact_phone_tenant_idx
  ON app.contact_phone (tenant_id, phone_e164);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2 · contact_live — the only relation the app reads
-- ---------------------------------------------------------------------------
-- security_invoker so the view does NOT become a way around RLS: the policies
-- on app.contact still evaluate as the calling role. Without that keyword a
-- view owned by the migrator would read with the migrator's policy, which is
-- USING (true) — a total silo bypass wearing the word "view".
CREATE OR REPLACE VIEW app.contact_live
  WITH (security_invoker = true) AS
  SELECT * FROM app.contact WHERE deleted_at IS NULL;
--> statement-breakpoint

GRANT SELECT ON app.contact_live TO crm_app;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3 · Classify, then harden
-- ---------------------------------------------------------------------------
INSERT INTO security.table_registry
  (schema_name, table_name, policy_class, owner_column, immutable, app_can_insert, registered_in_migration)
VALUES
  ('app', 'contact',       'owner_scoped', 'owner_user_id', false, true, '0011_contacts_hardening'),
  ('app', 'contact_phone', 'owner_scoped', 'owner_user_id', false, true, '0011_contacts_hardening')
ON CONFLICT (schema_name, table_name) DO UPDATE
  SET policy_class            = EXCLUDED.policy_class,
      owner_column            = EXCLUDED.owner_column,
      immutable               = EXCLUDED.immutable,
      app_can_insert          = EXCLUDED.app_can_insert,
      registered_in_migration = EXCLUDED.registered_in_migration;
--> statement-breakpoint

SELECT security.harden();
