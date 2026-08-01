# ADR-084 — ADR-G6 — MFA is not required on admin money endpoints in the MVP; the compensating control is that the affected seller sees the change

**Status:** accepted (Phase 5, pending GATE 5)

## Context

defineEndpoint makes mfa non-optional for scope 'tenant_admin'. The signed stack removed transactional email to V1.1 with the accepted consequence that there is no self-service password reset. MFA with no email channel means no enrolment recovery: an admin who loses their TOTP device permanently loses break-glass — the compliance escape hatch that exists for the case where the calling-window resolver is wrong and fifty sellers cannot work.

## Options considered

_(see Context; the rejected alternative is named inline)_

## Decision

mfa is declared false on the admin money endpoints (ledger_adjust, opportunity_set_premium) and on break-glass for the MVP, and the compile-time non-optionality is relaxed to a required explicit declaration so the choice appears in the registry rather than in a default. The compensating control is mechanical and specific to this product: every admin money write is audited with actor and reason AND is rendered to the affected seller in My Earnings within one poll interval. The person whose number changed is the detector.

## Consequences

Positive: break-glass stays reachable, which is the higher-order compliance property; the fraud control is a screen a real person reads daily rather than a factor nobody can recover. Negative: a stolen admin session can void credits. Bounded by the audit trail, the seller-visible reason, the fact that no amount can be invented (ADR-G5), and a single-tenant deployment where the admin is the owner. Revisit when transactional email lands in V1.1.
