# ADR-030 — ADR-SEC-01 · Lead-local timezone resolves from a bundled ZIP/ZCTA→IANA table with candidate-set intersection on straddles

**Status:** accepted (Phase 5, pending GATE 5)

## Context

ARR-CMP-04 makes the 9:00-20:00 lead-local calling window a hard block with no attestation path, and ARR-CMP-05 leaves the data source explicitly open while warning that it feeds a block capable of stopping all fifty sellers. The persisted triple (lead_local_tz, tz_confidence, tz_source) exists on contact, and ref.zip_timezone / ref.area_code_timezone / ref.state_timezone are already on the RLS exception list. Unresolved: which dataset, its licence, its refresh, and what happens when a ZIP or state spans two zones.

## Options considered

(a) Bundled ZIP/ZCTA→IANA table as primary with NANPA area code and state as fallbacks. (b) NANPA area code only — always available since a phone is always present, but wrong for ported mobiles, which are common in the FE lead market. (c) A paid phone-intelligence API per lookup — accurate for ported numbers but a per-record recurring cost against a hard budget, and a new availability dependency in front of a fail-closed gate. (d) State only — trivially available, ambiguous for thirteen states. Orthogonally: for a straddling ZIP, pick the easternmost zone / pick the westernmost / return the candidate set and intersect.

## Decision

Option (a), resolved live by the gate rather than read from the persisted copy, with the straddle handled by CANDIDATE-SET INTERSECTION. ref.zip_timezone carries one row per (zip5, tz) pair, ~41k rows, ~1.5 MB, generated at build time from redistributable public-domain primary sources (Census ZCTA relationship files joined to IANA tzdata) with source URLs and checksums recorded in the generated file header and the version in system_constant['tz_dataset_version']. Area code always yields tz_confidence='low' and never 'high'. app.calling_window_check() allows only if the instant is inside 9:00-20:00 in EVERY member of the candidate set. Zones are stored as IANA names, never as fixed offsets. contact.lead_local_tz remains the cached value used for display, the badge and the dual-labelled slot picker; the gate re-resolves at evaluation time. Empty set at every level, or ANY lookup exception, yields blocked_timezone_unknown. A random npm zip-to-timezone package is explicitly rejected.

## Consequences

POSITIVE: no recurring per-lookup cost; a dataset correction takes effect for every lead at once with no backfill; there is no stale-copy bug class where the badge and the block disagree; the intersection rule makes an illegal dial unreachable through ambiguity, which neither easternmost nor westernmost achieves (each is conservative at one end of the day and permissive at the other). NEGATIVE: a small number of leads in straddling ZIPs lose a little legal calling time at both ends of the window; a ported mobile with no ZIP resolves at tz_confidence='low' and, if it also has no state, fails closed; the gate performs an extra indexed lookup per attempt (one to two rows, inside the 300 ms API p95). tzdata staleness becomes an outage class rather than a data-quality issue, mitigated by a CI test asserting the app image's ICU version and the database's pg_timezone_names agree, plus DST golden cases, plus a monthly alert on tzdata release age.
