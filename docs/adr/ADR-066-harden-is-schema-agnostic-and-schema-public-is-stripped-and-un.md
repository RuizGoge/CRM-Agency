# ADR-066 — ADR-R3 — harden() is schema-agnostic, and schema public is stripped and unreachable

**Status:** accepted (Phase 5, pending GATE 5)

## Context

security.harden() looped pg_class in schemas app and ref, and the CI catalog gate checked 'any relation in app'. Drizzle's default schema is public. A table created there gets no FORCE, no policies, no registry row, no harden() raise and no CI failure; if any migration ever emits GRANT ALL ON ALL TABLES IN SCHEMA public TO crm_app it is tenant-wide readable and writable. Combined with the fact that list endpoints with no record id cannot be exercised by the registry silo suite, this produces a leak with no route to attack and no screen symptom.

## Options considered

_(see Context; the rejected alternative is named inline)_

## Decision

harden() iterates every namespace except pg_catalog, information_schema and pg_toast and those on the seeded, sealed security.schema_exception list, raising HR001 on any relation with no registry row regardless of schema. The pre-deploy job additionally runs REVOKE ALL ON SCHEMA public FROM PUBLIC, crm_app (plus tables, sequences, functions), ALTER DEFAULT PRIVILEGES FOR ROLE crm_migrator IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC, crm_app, and ALTER ROLE crm_app SET search_path = app, ref, pg_catalog. Schema gate S1 is rescoped from two named schemas to every non-exempt schema.

## Consequences

Three independent nets now cover the hole in firing order: crm_app cannot resolve an unqualified name in public; harden() stops the deploy; S1 fails the pre-merge build. The Drizzle-by-inertia failure mode is closed at exactly the place the model actually creates tables. Cost: every legitimately exempt schema (auth, pgboss, ref, security) must carry a written reason in a sealed relation, and any provider-managed schema that appears later (an extension's) must be classified or exempted before the next deploy succeeds — which is intended, and is the same tradeoff the existing unclassified-table rule already accepted.
