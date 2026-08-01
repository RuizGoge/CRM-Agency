# ADR-031 — ADR-SEC-02 · No application-level field encryption

**Status:** accepted (Phase 5, pending GATE 5)

## Context

The database holds the PII of US consumers: names, E.164 phone numbers, emails, note and message bodies, premium amounts. The reflex control is to encrypt sensitive columns in the application before writing them. The realistic adversary set for this product is, in order: the code generator, a curious seller with valid credentials, a lead vendor with a valid token, a departing seller, and internet scanning.

## Options considered

(a) Application-level encryption of name / phone / email / bodies with a key in the platform environment. (b) Postgres pgcrypto with a key in the database or in the connection. (c) Rely on provider volume encryption at rest plus TLS verify-full in transit, and spend the effort on access control instead.

## Decision

Option (c). No application-level column encryption anywhere. Provider volume encryption at rest, TLS verify-full in transit asserted at boot, hashed intake tokens, hashed session material, private R2 with presigned short-expiry URLs verified by an unauthenticated canary GET that must return 403.

## Consequences

POSITIVE: the trigram search index (ARR-UX-14, p95 <= 200 ms) keeps working; CHECK (phone_e164 ~ E.164) stays enforceable at the storage layer; the owner-scoped dedupe unique index (ARR-MVP-19) and the tenant-wide suppression match (ARR-MVP-15) keep working, which matters because encrypting the phone column would break the TCPA control in order to satisfy a checkbox; no key-management surface, no key-rotation re-encryption job, no third failure mode where a wrong key silently produces garbage. NEGATIVE: an attacker holding a raw database dump reads plaintext PII. This is accepted because the dump requires either provider compromise (which volume encryption already addresses) or the application credential (which would be handed the plaintext through the ordinary code path regardless). The decision must be revisited if the product ever becomes genuinely multi-tenant with mutually distrusting tenants.
