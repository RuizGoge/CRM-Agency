# ADR-074 — ADR-R11 — The boot assertion is a catalog-posture digest; a restore that lost FORCE cannot boot

**Status:** accepted (Phase 5, pending GATE 5)

## Context

The monthly restore drill is the best control in the document, and it runs in CI against a dump. A real restore performed during an incident restores whatever the dump contains and boots. The existing boot assertion catches the owner-identity case only, so a restored database that comes back with FORCE off but a non-owner crm_app boots clean and shows every seller the whole book, with no error, no warning and no log line. Nothing re-applies GRANTs after a real restore.

## Options considered

_(see Context; the rejected alternative is named inline)_

## Decision

harden() writes, as its final act, security.harden_run(schema_version, image_digest, ran_at, catalog_digest), where catalog_digest hashes exactly the facts harden() itself sets: relrowsecurity AND relforcerowsecurity for every relation in security.table_registry (the whole registry, not a canary), the complete crm_app grant matrix, the statement-level immutability triggers, the EXECUTE grant set from security.function_registry, and the sealed schema-exception set. Every process recomputes the digest at start and exits non-zero on mismatch, naming the drifted fact. Recovery is one documented step: run the migrator image, whose last statement is harden().

## Consequences

The failure mode of a bad restore becomes an outage Jorge can see rather than a silent tenant-wide leak — the design's stated preference where those are the only two options. It also catches any out-of-band change made through the provider's SQL console between deploys. Costs: a few catalog queries at every process start; and the digest can self-inflict an outage on legitimate drift, mitigated by scoping it strictly to facts harden() sets, since genuine drift in that set is precisely the condition under which serving is more dangerous than not serving.
