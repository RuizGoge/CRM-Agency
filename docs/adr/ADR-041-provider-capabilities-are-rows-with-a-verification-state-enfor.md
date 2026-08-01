# ADR-041 — ADR-03 — Provider capabilities are rows with a verification state, enforced at compile time and at boot

**Status:** accepted (Phase 5, pending GATE 5)

## Context

ARR-INT-02 records that Aloware's delivery guarantees and API surface are unverified: whether webhooks are signed, whether they retry, whether the Sequence/Power Dialer/call-list APIs exist at our tier, whether two-legged presents each seller's caller ID, and whether the recording announcement fires on the two-legged path are all unknown. ARR-INT-01 and ARR-MVP-31 make the spike a hard gate before any dependent UI exists — but 'do not build the UI yet' is a process rule, and a process rule is exactly what a model will not remember.

## Options considered

(a) A typed client with all methods present and runtime feature flags — rejected: the flag is checkable and therefore forgettable, and the failure is a 404 in production. (b) Build only what the spike proved and add methods later — rejected: no mechanism stops someone adding one. (c) A `ref.provider_capability` registry with status unknown|verified|absent and tier mvp_required|mvp_optional|probe_only, exposed through a discriminated union where only the `verified` variant has a callable member, plus a boot assertion.

## Decision

Option (c). `alowareCapability('x')` returns `{status:'verified', call} | {status:'unknown'} | {status:'absent'}`; there is no `.callOrThrow()` and no default branch, so a caller that ignores the unverified cases does not compile. The process exits non-zero in production if any `mvp_required` capability is not `verified`. Dependency pairs are encoded in types: `sequenceEnroll()` requires a `DisenrollProof` token mintable only from a verified `sequence_disenroll` capability, so ARR-EVT-14 becomes structural.

## Consequences

ARR-INT-01's build gate becomes a deploy that will not start. Enrolment cannot ship before disenrolment is proven, which removes the 'robot keeps texting a lead who already replied' TCPA exposure by construction. Cost: every adapter call site carries an exhaustive switch, which is more verbose than a plain method call, and the registry must be seeded by migration from the spike's evidence rather than by hand.
