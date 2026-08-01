# ADR-089 — ADR-G11 — The demo tenant is constrained by a database role, and the 'refuses to run in production' requirement is superseded in form

**Status:** accepted (Phase 5, pending GATE 5)

## Context

ARR-MVP-27 and R4.5 both demand that the demo seed refuse to run in a live account, and the data model implements a trigger refusing is_demo=true when the environment is production. ADR-T2 (no staging) and ADR-T5 (the demo lives in production) make that trigger unimplementable — the ten-minute demo is given in production because there is nowhere else. Separately, R4.2's 'a lead outside the calling window at any hour a demo may run' is arithmetically unsatisfiable with US leads: at 2pm ET no US timezone is outside 9am-8pm lead-local.

## Options considered

_(see Context; the rejected alternative is named inline)_

## Decision

Strike the production trigger. The guarantee is 'cannot write to a live tenant', enforced by the crm_seeder role whose policy requires tenant.is_demo — a seeder pointed at a live tenant writes zero rows, which is strictly stronger than an env check that passes when the variable is unset. Add a boot assertion that the web, worker and ingest processes cannot see SEEDER_DATABASE_URL. For R4.2, seed one permanently blocked_timezone_unknown contact (hour-independent by construction) plus one contact per US timezone, and render app.demo_blocked_contact() at read time on the demo home so the presenter is told which lead is blocked right now; a property test asserts the function is non-null at all 24 hours of a simulated day.

## Consequences

Positive: the demo runbook cannot go stale (it is generated and every URL in it is status-asserted by CI) and the compliance-block moment survives an afternoon pitch. Negative: ARR-MVP-27's literal wording is published as superseded-in-form/satisfied-in-intent, which must be stated loudly or a future reader re-adds the trigger and breaks the demo.
