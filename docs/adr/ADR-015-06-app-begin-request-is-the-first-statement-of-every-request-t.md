# ADR-015 — ADR-API-06 — app.begin_request() is the first statement of every request transaction and derives the context itself

**Status:** accepted (Phase 5, pending GATE 5)

## Context

Non-negotiable 10 requires every unit of work to be an explicit transaction whose first statement sets app.tenant_id / app.user_id / app.scope_mode with set_config(..., true), because that is what makes PgBouncer transaction mode safe. But the session must be resolved before the tenant is known, which is precisely why schema `auth` is on the RLS exception list. Doing the session lookup first violates 'first statement'; doing two transactions costs an extra round trip on the hottest path in the product.

## Options considered

(a) Two transactions per request: read-only session lookup, then the work transaction. (b) Resolve the session in the app and then SET LOCAL the values the app computed. (c) app.begin_request(session_token_hash) as a SECURITY DEFINER function that resolves the session, calls set_config itself, and returns the identity — invoked as the first statement of the work transaction.

## Decision

(c). One round trip; the invariant is preserved and strengthened, because the application no longer computes the context it declares — the database derives it from a valid session or returns null. app.scope_mode is derived from app_user.role inside the function, never from a header or query parameter. app.actor_type is hard-coded to 'human'; jobs use app.begin_job(actor_type) whose TypeScript signature is Exclude<ActorType,'human'>, so a job claiming to be human does not compile.

## Consequences

Requires the auth schema exception to stay on the versioned list with its reason, and requires the definer function to contain app.current_tenant() so it passes the pg_proc.prosrc CI gate. Honest limitation recorded rather than papered over: EXECUTE on set_config() is revoked from PUBLIC, but Postgres does not gate the SET LOCAL utility statement on custom placeholder GUCs, so a hand-written SET LOCAL app.user_id remains syntactically possible for crm_app. Nets: src/db/ exports only withTenant(); an ESLint/grep gate bans the three GUC literals outside src/db/context/**. A signed-context GUC would close it in the engine and is specified as a Sprint-0 measured option, not adopted blind, because those functions are evaluated by RLS.
