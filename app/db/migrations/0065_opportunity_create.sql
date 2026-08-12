-- ===========================================================================
-- A SELLER CAN START A DEAL. THE FIRST WRITER THE PRODUCT NEVER HAD.
--
-- 🔴 THE STATE THIS FIXES. `app.opportunity` has had a schema, two gates, an
-- atomic `stage_move`, a board that drags it and a ledger that pays it — and
-- NO WRITER ANYWHERE IN `app/`. Verified by grep: the only table a route
-- creates today is `app.contact`, from quick-add. So the product could move a
-- deal it could not create, and `contact-drawer.tsx` and `contact.tsx` both
-- tell the seller "No open deal. Start one from your board" — a sentence
-- pointing at an affordance that does not exist.
--
-- That is why only five of the 49 events have an emitter and why the timeline
-- opens showing stage moves and nothing else: there is engine and no wiring.
--
-- 🔴 WHY THIS IS A DEFINER RATHER THAN A DRIZZLE INSERT, and it is not a
-- preference. `crm_app` holds INSERT on `app.opportunity`, so a route could
-- write the row — but 0061 revoked EXECUTE on `app.event_emit`, so it could
-- not EMIT. §2535(b) requires the row and its event in ONE transaction, so the
-- two have to live in the same function. That is exactly the architectural
-- commitment 0061's honesty list named: "emission is now a SQL-ONLY
-- capability… the fifth emitter costs a definer and a migration instead of a
-- line of TypeScript." This is that bill, arriving.
--
-- The compensation is real, though, and it is the `compliance_record` shape: a
-- caller that can create a deal CANNOT create one without emitting, because
-- there is one door and the emit is inside it.
--
-- ⚠️ TWO VOCABULARIES, AGAIN, AND THE DOOR TAKES NEITHER AS A PARAMETER.
-- `app.opportunity_created_from` is (lead_intake, manual, inbound_call,
-- import, cross_sell); the catalog's `created_from` is (cross_sell, recycle,
-- manual, lead_intake). `recycle` exists only in the contract, `inbound_call`
-- and `import` only in the database. This door hardcodes `manual` — the one
-- label both vocabularies share and the only one a seller pressing a button
-- can truthfully produce. A parameter would be a way to lie about where a deal
-- came from, which is the rule 0060 states twice; the other origins arrive
-- with the paths that produce them, and whoever builds those owns the mapping.
-- ===========================================================================

CREATE OR REPLACE FUNCTION app.opportunity_create(p_contact_id uuid)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = app, ref, pg_catalog
AS $fn$
DECLARE
  v_tenant   uuid;
  v_owner    uuid;
  v_pipeline uuid;
  v_stage    uuid;
  v_opp      uuid;
BEGIN
  v_tenant := app.current_tenant();
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'OP001: opportunity_create called outside a tenant session';
  END IF;

  -- OWNERSHIP, re-asserted here because a definer has no RLS — the same
  -- predicate and the same reason as `compliance_check`.
  --
  -- 🔴 RETURNS NULL RATHER THAN RAISING, and that is the silo rule rather than
  -- leniency. A contact in another book and a contact that never existed must
  -- be indistinguishable; the route turns this NULL into the same 404 it
  -- returns for a bad id. A raise would carry a message, and a message that
  -- differs between the two cases is the 403 this project forbids, written in
  -- softer words.
  SELECT c.owner_user_id INTO v_owner
    FROM app.contact c
   WHERE c.tenant_id = v_tenant
     AND c.id = p_contact_id
     AND c.deleted_at IS NULL
     AND (c.owner_user_id = app.current_user_id() OR app.scope_is_global());

  IF v_owner IS NULL THEN
    RETURN NULL;
  END IF;

  -- The deal belongs to the CONTACT's owner, never to whoever is looking. An
  -- admin starting a deal on a seller's lead starts it in the SELLER's book —
  -- the same choice `event_emit`'s owner column makes, and the reason the
  -- board and Earnings agree about whose deal it is.
  SELECT p.id INTO v_pipeline
    FROM app.pipeline p
   WHERE p.tenant_id = v_tenant AND p.owner_user_id = v_owner
   ORDER BY p.created_at ASC
   LIMIT 1;

  IF v_pipeline IS NULL THEN
    RAISE EXCEPTION 'OP002: % has no pipeline, so a deal has nowhere to start', v_owner
      USING HINT = 'Every seller gets a pipeline at onboarding; this one did not.';
  END IF;

  -- 🔴 `stage_type = 'open'` AND NOT A STAGE NAME. The whole product binds to
  -- the type: renaming a column must change nothing. A first stage chosen by
  -- name is a first stage that moves when somebody edits their board.
  SELECT s.id INTO v_stage
    FROM app.stage s
   WHERE s.tenant_id = v_tenant
     AND s.pipeline_id = v_pipeline
     AND s.stage_type = 'open'
   ORDER BY s.sort_order ASC
   LIMIT 1;

  IF v_stage IS NULL THEN
    RAISE EXCEPTION 'OP003: pipeline % has no open stage to start a deal in', v_pipeline;
  END IF;

  -- NO GUARD AGAINST A SECOND OPEN DEAL, deliberately. One contact
  -- legitimately buys twice — the contact screen says so in its own empty
  -- state — so "already has a deal" is not a refusal this product gets to
  -- make. ⚠️ The cost, stated rather than discovered: a double submit creates
  -- two deals. The button disables itself in flight, which is UI and therefore
  -- documentation; there is no mechanism here.
  INSERT INTO app.opportunity
    (tenant_id, owner_user_id, contact_id, pipeline_id, stage_id,
     current_stage_type, created_from)
  VALUES
    (v_tenant, v_owner, p_contact_id, v_pipeline, v_stage, 'open', 'manual')
  RETURNING id INTO v_opp;

  -- 🔴 THE EMIT IS INSIDE THE DOOR, which is the whole reason the door exists.
  -- The idempotency key is derived from the row this transaction just created,
  -- the shape 0054 and 0060 both use. A retry is therefore a NEW deal with a
  -- new key — correct, because a second deal on the same contact is a real
  -- thing rather than a duplicate.
  --
  -- `product_type` and `deal_value_annual_premium` are NULL at creation: a deal
  -- has no product and no premium until it is worked. The generated payload
  -- type declares `product_type` non-nullable and the column is nullable with
  -- no writer anywhere — a contract violation `app.stage_move` already carries
  -- and nothing validates. Named here rather than quietly repeated.
  PERFORM app.event_emit(
    uuidv7(), v_owner, 'opportunity.created',
    'opportunity', v_opp,
    'opportunity_create:' || v_opp::text,
    jsonb_build_object(
      'opportunity_id',            v_opp,
      'contact_id',                p_contact_id,
      'pipeline_id',               v_pipeline,
      'stage_id',                  v_stage,
      'product_type',              NULL,
      'deal_value_annual_premium', NULL,
      'created_from',              'manual',
      'parent_opportunity_id',     NULL));

  RETURN v_opp;
END;
$fn$;--> statement-breakpoint

REVOKE ALL ON FUNCTION app.opportunity_create(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.opportunity_create(uuid) TO crm_app;--> statement-breakpoint

-- No `SELECT security.harden()`: this migration creates no relation, changes no
-- registry row and touches no privilege harden() manages. Calling it would take
-- ACCESS EXCLUSIVE on every table in app and ref for nothing.
