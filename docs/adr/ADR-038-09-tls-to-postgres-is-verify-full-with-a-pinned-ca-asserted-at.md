# ADR-038 — ADR-SEC-09 · TLS to Postgres is verify-full with a pinned CA, asserted at boot

**Status:** accepted (Phase 5, pending GATE 5)

## Context

The application connects to a managed Postgres over the provider's network. The connection string the dashboard supplies typically works with sslmode=require. ARR-PRV-04 makes row-level isolation the product's primary security property, and every one of those guarantees is transported over this connection.

## Options considered

(a) sslmode=require — encryption without server authentication. (b) sslmode=verify-full with the provider CA bundled in the application image. (c) Rely on the provider's private network with no TLS assertion.

## Decision

Option (b), with a boot assertion: the process parses its own connection string and exits non-zero if it does not carry sslmode=verify-full, and the provider CA bundle is a file in the image.

## Consequences

POSITIVE: sslmode=require authenticates nothing and is one DNS answer away from a transparent man-in-the-middle that would see every row, every session context and every ledger append; the difference is one file and one config token. This is exactly the kind of setting that is correct the day it is written and silently downgraded later by a well-meaning 'fix the TLS error' change, which is why the assertion is at boot rather than in a comment. NEGATIVE: a provider CA rotation that is not reflected in the image causes a hard refusal to start rather than a degraded connection — which is the correct failure direction but is a real operational coupling, mitigated by the availability target being US business hours (ARR-OPS-04) and by the CA bundle being versioned in the repo.
