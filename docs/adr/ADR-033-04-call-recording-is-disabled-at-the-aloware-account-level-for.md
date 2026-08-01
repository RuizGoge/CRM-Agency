# ADR-033 — ADR-SEC-04 · Call recording is disabled at the Aloware account level for the MVP regardless of the spike outcome, and is policed by artifact detection

**Status:** accepted (Phase 5, pending GATE 5)

## Context

ARR-CMP-10 (decision D9) records that Aloware records at the account level, that whether the recording announcement fires on the Two-Legged Call path is unverified, and that CA, FL, PA, IL, WA and MA require all-party consent. Recording attachment, player and retention are already out of the MVP, and ARR-PRV-06 rules that media is referenced and never mirrored. The setting itself lives in a third party's dashboard where a support engineer or a plan change can flip it with no signal to us.

## Options considered

(a) Wait for the spike and enable recording if the announcement is proven to fire. (b) Disable unconditionally for the MVP. (c) Enable and add a per-state disclosure at dial time now.

## Decision

Option (b), unconditionally and without waiting. Since the MVP does not attach, play, mirror, index or retain recordings, recording yields zero product value and full legal exposure. The spike therefore does not decide whether we record; it decides what V1.1 must build. Enforcement of a setting we do not own is threefold: the existing aloware_health_probe scheduled job reads the account recording configuration and trips system_constant['recording_guard'] if it reports enabled OR cannot be read; while tripped, the gate emits blocked_recording_unverified for dials to contacts whose state_code is in ref.state_recording_regime with regime='all_party' and permits everything else; and the merge consumer raises admin_alert(kind='recording_detected') on any non-null recording_url, which detects reality rather than configuration. blocked_recording_unverified is not overridable, guaranteed by the single-value CHECK on break_glass_override.scope.

## Consequences

POSITIVE: eliminates per-call statutory exposure in six states we sell into, for a feature already cut; the artifact detector does not depend on the provider's configuration API being truthful or on anyone reading a dashboard, and fires on the first affected call; the state list is seeded data rather than an if-chain, so changing it is a row; ARR-CMP-10 already requires the dial path to carry the lead's state, so nothing is a rewrite. NEGATIVE: no recordings exist for dispute resolution, coaching or QA during the MVP; if the announcement turns out not to fire on the two-legged path, recording may never ship in this product and that must be said now rather than discovered later. The recording guard adds one predicate to the gate's hot path.
