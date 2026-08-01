# ADR-026 — ADR-T5 — The demo tenant is permitted in production; the seeder is constrained by a database role, not by an environment check

**Status:** accepted (Phase 5, pending GATE 5)

## Context

ARR-UX-25 requires the demo seed to refuse to run in a live account. The signed data model implements that as a trigger refusing INSERT of is_demo = true when system_constant['environment'] = 'production'. But the ten-minute demo is given from the real production system — that is why the Demo chip and the board footnote exist — and ARR-UX-23 requires DEMO-01..10 to run against the seeded demo tenant. Read literally, the trigger makes the demo impossible to give and the protected assertions impossible to run in a production-shaped configuration. The two requirements are pointing at different fears: 'live account' means a customer's tenant, not the production environment.

## Options considered

(a) Keep the trigger as written; give the demo from a separate deployment. (b) Remove the environment check and rely on the separate-tenant_id design alone. (c) Keep a guard but move it from 'environment' to a dedicated constant, and additionally constrain the seeder at the privilege level.

## Decision

Option (c). The trigger's condition becomes system_constant['demo_tenant_allowed'] = false rather than environment = 'production'; the constant is seeded true and is flipped false in any deployment that serves a real customer tenant. Independently and more importantly, the seeder connects as a dedicated role crm_seeder whose policy is USING (tenant_id = app.current_tenant() AND EXISTS (SELECT 1 FROM tenant t WHERE t.id = app.current_tenant() AND t.is_demo)). A seeder pointed at a live tenant writes zero rows. The unique index ON tenant (is_demo) WHERE is_demo still caps the count at one, forever.

## Consequences

The demo can be given from production, which is what actually happens, and DEMO-01..10 run against a production-shaped configuration. The 'refuses to run in a live account' guarantee gets stronger, not weaker: it stops being an environment-variable check that an env var can defeat and becomes a privilege fact. The residual decision Jorge must ratify is that a demo tenant is visible in the production database, which is exactly what the Demo chip and board footnote were designed for.
