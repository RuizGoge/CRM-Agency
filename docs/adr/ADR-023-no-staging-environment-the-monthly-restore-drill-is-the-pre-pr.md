# ADR-023 — ADR-T2 — No staging environment; the monthly restore drill is the pre-production fidelity mechanism

**Status:** accepted (Phase 5, pending GATE 5)

## Context

The cost ladder allows USD 0 at Escalón 0, USD 0–26 at Escalón 1 and USD 26–42.50 at Escalón 2, with a paid Postgres carrying backups as the single non-negotiable line. A staging environment with production-shaped data would add a second managed Postgres (≈USD 19) and a second CCPA perimeter holding lead PII. Meanwhile the failure this project actually cannot survive — a restored database that comes back without FORCE ROW LEVEL SECURITY, custom roles, revoked GRANTs or immutability triggers — is invisible to a staging environment anyway, because staging is provisioned by the same migration path that production is and therefore shares its assumptions.

## Options considered

(a) A permanent staging environment with a second Postgres. (b) Per-PR preview environments created and destroyed by the platform API. (c) No staging; substitute the monthly restore drill, the demo tenant in production, and image-level rollback.

## Decision

Option (c). There is no staging and no per-PR preview. The substitutes are named and each carries an assertion: (1) the monthly restore drill restores a real dump into ephemeral Testcontainers Postgres and runs the complete silo and append-only suite against it, explicitly asserting roles, revoked GRANTs, statement-level immutability triggers and FORCE RLS survived; (2) the demo tenant lives in production and is where the ten-minute demo is actually given, so production-shaped behaviour is exercised continuously; (3) rollback is the container image, which is instant and requires no rehearsal environment.

## Consequences

Two real losses, recorded rather than hidden: nothing discovers the platform proxy's SSE idle timeout, the connection storm of a rolling redeploy, or real egress shape before production — all three become hard Gate items rather than footnotes. In exchange, the CCPA perimeter stays at one production database plus R2, and the cost ladder holds at every rung. The restore drill is strictly more valuable than a staging environment for the one artifact the product cannot reconstruct.
