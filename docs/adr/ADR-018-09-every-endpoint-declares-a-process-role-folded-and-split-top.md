# ADR-018 — ADR-API-09 — Every endpoint declares a process role; folded and split topologies both run in CI on every merge

**Status:** accepted (Phase 5, pending GATE 5)

## Context

The owner requires that the three-process split (web / worker / ingest) be deployment configuration rather than an architectural assumption: the system must launch folded into one process at Escalón 1 and separate later without redesign or migration. A claim that 'it folds' decays the moment the folded configuration stops being exercised.

## Options considered

(a) Document that it folds. (b) Fold by commenting out route mounts. (c) Every endpoint declares role: 'web' | 'ingest' | 'both'; each process reads PROCESS_ROLES and mounts the matching families; the E2E suite runs in both TOPOLOGY=folded and TOPOLOGY=split as a CI matrix axis.

## Decision

(c), plus INGEST_FALLBACK=on by default so the web process also accepts /intake/* and /webhooks/* while split, writing an admin_alert of kind ingest_on_web per occurrence.

## Consequences

No URL breaks when the topology changes and no lead is lost to a stale vendor URL; the published vendor URL lives in intake_source and token rotation-with-grace already exists to re-issue it. The bulkhead becomes a hostname decision rather than a code decision — folding costs the isolated event loop and nothing else, which the register accepts at Escalón 1 (no retry storm at 2–3 sellers) and rejects at Escalón 2. Cost: the fallback partially dissolves the bulkhead if a vendor never migrates, which is why each occurrence alerts. The folded suite running on every merge is the only thing that keeps the fold real; without it the claim rots in a week.
