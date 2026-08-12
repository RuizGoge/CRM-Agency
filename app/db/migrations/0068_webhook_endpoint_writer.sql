-- ===========================================================================
-- THE INGEST EDGE GETS A CREDENTIAL IT CAN ACTUALLY BE GIVEN.
--
-- 🔴 THE SYMPTOM, AND IT IS THE WORST CLASS THIS PRODUCT HAS. `app.webhook_endpoint`
-- is `definer_only` and has had NO WRITER ANYWHERE — not in `app/`, not in the
-- seed, not in a migration. Gate 6 found it the only way it could be found: the
-- storm harness tried to seed a row as `crm_app`, got permission denied, and had
-- to insert AS THE OWNER to run at all (`scripts/gate-6-storm.ts:85`).
--
-- So in production there is no endpoint row, `app.webhook_ingest` resolves NO
-- tenant for any token, and the edge answers 401 to every real delivery. And G2
-- measured that **Aloware never retries** — six deliveries answered 500, three
-- hours, zero came back. This is not "the feature is off". It is a live,
-- silent, permanent-loss path: every call and every SMS the provider ever sends
-- is discarded at the door, and nothing anywhere goes red.
--
-- The route, the vault, the dedupe, the two merge queues and the storm numbers
-- all exist and all work. This is the one missing link that makes them
-- unreachable — the same "engine with no wiring" shape the 2026-08-10 audit
-- found at table scale, here at credential scale.
--
-- ⚠️ WHAT THIS DOES NOT DO, said plainly because the value of the change depends
-- on saying it:
--   · It does not make a delivery LEGAL. The compliance gate is elsewhere and
--     unchanged.
--   · It does not close G6/P24 — there is still no STOP sniff at ingress, so
--     `message.received` remains unreachable and the protected assertion still
--     has no subject.
--   · It does not verify the token against Aloware's panel. Nothing here can
--     know whether the operator actually pasted it; the first real delivery is
--     the only proof, and `/admin/integration-health` is where that shows up.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1 · THE VOCABULARY
-- ---------------------------------------------------------------------------
-- Issuing and revoking a bearer credential that resolves a tenant is exactly
-- what `audit_log` is for, and the vocabulary is a CHECK against this list, so
-- the actions have to exist before the functions can write them.
--
-- 🔴 NEITHER NAME MAY COLLIDE WITH AN EVENT NAME, LIVE OR GHOST. `integration.`
-- is already a live event domain (`integration.mapping_verified`), so the
-- prefix alone is not enough — the full strings were checked against
-- `contracts/events/catalog.json` and `catalog.generated.ts` before being
-- written here, and `audit-vocabulary.test.ts` asserts it in both directions
-- from now on. The first draft of this list collided seven times; that is why
-- the check is a test and not a habit.
CREATE OR REPLACE FUNCTION app.audit_action_list()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
AS $fn$
  SELECT ARRAY[
    -- Ratified by name in the corpus.
    'user.credential_reset',
    'vault.body_viewed',
    'tenant.business_tz_changed',
    'book.viewed',
    'ownership.transferred',
    -- Derived from US-9.13's categories.
    'compliance.gate_checked',
    'compliance.break_glass_engaged',
    'compliance.break_glass_ended',
    'consent.ledger_appended',
    'suppression.ledger_appended',
    'data.exported',
    'ledger.adjusted',
    'stage.config_changed',
    'user.role_assigned',
    'user.access_revoked',
    'close.gate_refused',
    -- 0068. The ingest credential. Both are admin acts on a secret that
    -- resolves a tenant, which puts them in the same class as
    -- `user.credential_reset` rather than in any integration-health counter.
    'integration.credential_issued',
    'integration.credential_revoked'
  ]
$fn$;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2 · ISSUE
-- ---------------------------------------------------------------------------
-- Returns the plaintext token EXACTLY ONCE. There is no second read: only
-- `sha256(token)` is stored, so a database backup, a support query or a leaked
-- dump yields nothing that can be replayed at the edge. An operator who loses
-- it issues another and revokes this one — which is also the rotation path, and
-- why two live endpoints for one provider is allowed rather than refused.
--
-- 🔴 THE DIGEST FORM IS COPIED FROM THE READER, NOT RE-DERIVED. `webhook_ingest`
-- resolves with `pg_catalog.sha256(pg_catalog.convert_to(p_endpoint_token,
-- 'UTF8'))` (0047:125). Any other spelling here — `digest()`, a different
-- encoding, a trimmed input — produces a row that is structurally valid, passes
-- every CHECK, and resolves for nothing. The failure would be a token that the
-- operator pastes correctly and that answers 401 forever, with no error
-- anywhere to read. So the two call sites must stay byte-identical, and
-- `webhook-endpoint-writer.test.ts` asserts a round trip through the real
-- `webhook_ingest` rather than comparing the two strings.
CREATE OR REPLACE FUNCTION app.webhook_endpoint_issue(
  p_provider text,
  p_label    text
)
RETURNS TABLE (endpoint_id uuid, token text)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = app, ref, pg_catalog
AS $fn$
DECLARE
  v_tenant   uuid;
  v_label    text;
  v_provider text;
  v_token    text;
  v_id       uuid;
BEGIN
  v_tenant := app.current_tenant();
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'WE001: webhook_endpoint_issue called outside a tenant session';
  END IF;

  -- 🔴 ADMIN IS CHECKED HERE, NOT IN THE ROUTE. `app.scope_is_admin()` re-reads
  -- `app_user.role` from the table for the sealed (tenant, user) pair — it is
  -- not a claim the caller makes. A definer switches RLS off inside its own
  -- body, so if this line is absent, ANY seller session that can reach the
  -- function mints a credential that resolves her whole agency to whoever holds
  -- it. That is the cross-tenant hole `definer-tenancy` exists to catch, one
  -- step removed.
  IF NOT app.scope_is_admin() THEN
    RAISE EXCEPTION 'WE002: issuing an ingest credential is an admin act';
  END IF;

  -- Exhaustive, never a pattern — the same reasoning `webhook_ingest` gives for
  -- its event map. A free-text provider is copied verbatim onto every vault row
  -- and every inbound event the token ever produces, so a typo here is a silent
  -- mislabelling of real data that nothing downstream would reject.
  v_provider := btrim(coalesce(p_provider, ''));
  IF v_provider NOT IN ('aloware') THEN
    RAISE EXCEPTION 'WE003: % is not a provider this product ingests', v_provider;
  END IF;

  -- The label is what an admin reads instead of the secret. Without it,
  -- revoking the right endpoint means comparing digests, which nobody does
  -- correctly under pressure. The CHECK refuses blank; this refuses it with a
  -- sentence the surface can show.
  v_label := btrim(coalesce(p_label, ''));
  IF v_label = '' THEN
    RAISE EXCEPTION 'WE004: an endpoint with no label cannot be revoked by a human later';
  END IF;
  IF length(v_label) > 80 THEN
    RAISE EXCEPTION 'WE005: label is longer than 80 characters';
  END IF;

  -- Four v4 uuids with the hyphens stripped: 128 hex characters, ~488 bits from
  -- the same CSPRNG. `gen_random_bytes` lives in pgcrypto and PGCRYPTO IS NOT
  -- INSTALLED HERE — measured in 0067, not assumed. Adding an extension for a
  -- shorter string would be a deploy-time dependency bought for nothing, and
  -- this value goes in a URL where length costs nothing.
  v_token := replace(gen_random_uuid()::text, '-', '')
          || replace(gen_random_uuid()::text, '-', '')
          || replace(gen_random_uuid()::text, '-', '')
          || replace(gen_random_uuid()::text, '-', '');

  INSERT INTO app.webhook_endpoint (tenant_id, provider, token_sha256, label)
  VALUES (v_tenant, v_provider,
          pg_catalog.sha256(pg_catalog.convert_to(v_token, 'UTF8')),
          v_label)
  RETURNING id INTO v_id;

  -- ⚠️ THE TOKEN IS NOT IN THE AUDIT ROW, and that is the point of writing this
  -- comment rather than trusting the next reader. `audit_log` is append-only and
  -- readable by every admin in the tenant; a secret written there is a secret
  -- with no expiry and no delete. What is recorded is which credential was
  -- created, by whom and when — enough to answer "who let that in" without
  -- being a second copy of the thing itself.
  PERFORM app.audit_write(
    'integration.credential_issued',
    'webhook_endpoint',
    v_id,
    NULL,
    jsonb_build_object('provider', v_provider, 'label', v_label),
    NULL);

  RETURN QUERY SELECT v_id, v_token;
END;
$fn$;--> statement-breakpoint

REVOKE ALL ON FUNCTION app.webhook_endpoint_issue(text, text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.webhook_endpoint_issue(text, text) TO crm_app;--> statement-breakpoint

COMMENT ON FUNCTION app.webhook_endpoint_issue(text, text) IS
  'Mints one ingest credential for the calling admin''s tenant and returns the plaintext token ONCE. Only sha256(token) is stored.';--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3 · REVOKE
-- ---------------------------------------------------------------------------
-- Soft, because `revoked_at` is what the resolution predicate reads
-- (0047:126) and a hard DELETE would take the provenance of every vault row
-- that token ever produced with it.
--
-- ⚠️ REVOKING IS INSTANT AND UNRECOVERABLE IN THE ONLY SENSE THAT MATTERS: from
-- the next delivery onward the edge answers 401, and Aloware does not retry, so
-- everything sent between the revoke and the operator pasting a new token is
-- gone. That is a property of the provider, not of this function, and it is why
-- the surface issues the replacement BEFORE offering to revoke.
CREATE OR REPLACE FUNCTION app.webhook_endpoint_revoke(p_endpoint_id uuid)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = app, ref, pg_catalog
AS $fn$
DECLARE
  v_tenant uuid;
  v_at     timestamptz;
  v_label  text;
BEGIN
  v_tenant := app.current_tenant();
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'WE006: webhook_endpoint_revoke called outside a tenant session';
  END IF;

  IF NOT app.scope_is_admin() THEN
    RAISE EXCEPTION 'WE007: revoking an ingest credential is an admin act';
  END IF;

  v_at := clock_timestamp();

  -- ONE ANSWER FOR THREE CASES: unknown id, another tenant's endpoint, and one
  -- already revoked all return false. The first two must be indistinguishable —
  -- that is the not-found rule, and a message that separated them would be the
  -- 403 this project forbids in softer words. The third joins them because the
  -- end state is identical and an admin acting twice is not an error.
  UPDATE app.webhook_endpoint
     SET revoked_at = v_at
   WHERE tenant_id  = v_tenant
     AND id         = p_endpoint_id
     AND revoked_at IS NULL
  RETURNING label INTO v_label;

  IF v_label IS NULL THEN
    RETURN false;
  END IF;

  PERFORM app.audit_write(
    'integration.credential_revoked',
    'webhook_endpoint',
    p_endpoint_id,
    jsonb_build_object('revoked_at', NULL),
    jsonb_build_object('revoked_at', to_char(v_at AT TIME ZONE 'UTC',
                                             'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
                       'label', v_label),
    NULL);

  RETURN true;
END;
$fn$;--> statement-breakpoint

REVOKE ALL ON FUNCTION app.webhook_endpoint_revoke(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.webhook_endpoint_revoke(uuid) TO crm_app;--> statement-breakpoint

COMMENT ON FUNCTION app.webhook_endpoint_revoke(uuid) IS
  'Soft-revokes one ingest credential in the calling admin''s tenant. False means nothing changed: unknown, foreign, or already revoked.';--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4 · LIST
-- ---------------------------------------------------------------------------
-- 🔴 THE DIGEST IS NOT IN THE RESULT AND MUST NEVER BE. It is 32 bytes of a
-- 128-character hex token, so publishing it to a screen turns a credential with
-- no second factor into an offline guessing target. The label is what a human
-- picks a row by; the digest is what the edge matches on, and no surface needs
-- both.
CREATE OR REPLACE FUNCTION app.webhook_endpoint_list()
RETURNS TABLE (
  endpoint_id uuid,
  provider    text,
  label       text,
  created_at  timestamptz,
  revoked_at  timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = app, ref, pg_catalog
AS $fn$
DECLARE
  v_tenant uuid;
BEGIN
  v_tenant := app.current_tenant();
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'WE008: webhook_endpoint_list called outside a tenant session';
  END IF;

  IF NOT app.scope_is_admin() THEN
    RAISE EXCEPTION 'WE009: listing ingest credentials is an admin act';
  END IF;

  RETURN QUERY
    SELECT e.id, e.provider, e.label, e.created_at, e.revoked_at
      FROM app.webhook_endpoint e
     WHERE e.tenant_id = v_tenant
     ORDER BY e.revoked_at IS NOT NULL, e.created_at DESC;
END;
$fn$;--> statement-breakpoint

REVOKE ALL ON FUNCTION app.webhook_endpoint_list() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.webhook_endpoint_list() TO crm_app;--> statement-breakpoint

COMMENT ON FUNCTION app.webhook_endpoint_list() IS
  'Lists the calling admin''s tenant ingest credentials, live first. Never returns token_sha256.';--> statement-breakpoint

-- No `SELECT security.harden()`: no relation created, no registry row changed,
-- no privilege harden() manages. `webhook_endpoint` stays `definer_only` and
-- `crm_app` still holds zero privileges on the table itself — all three
-- functions above reach it as the owner, which is the whole point.
