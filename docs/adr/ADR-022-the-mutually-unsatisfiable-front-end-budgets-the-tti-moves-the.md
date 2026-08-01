# ADR-022 — ADR-T1 — The mutually unsatisfiable front-end budgets: the TTI moves, the bundle holds

**Status:** accepted (Phase 5, pending GATE 5)

## Context

The ARR proved that ARR-UX-08 (250 KB gzip JS on the pipeline route, build-breaking) and ARR-MVP-25 ("Board, My Day and contact detail interactive in ≤ 2.0 s on a mid-tier Android over throttled 4G", also build-breaking) cannot both be satisfied. 250 KB over Slow-4G is ≈1.25 s of transfer alone; parse, compile and execute on a mid-tier Android at 4× CPU adds ≈0.9–1.2 s; measured TTI lands at ≈2.4–3.0 s. Fitting 2.0 s needs ≈120–150 KB gzip. Both numbers are currently written as gates that break the build, so as written the build is unpassable and the erosion path is that somebody quietly deletes one gate.

## Options considered

(a) Hold 2.0 s and cut the bundle to ~150 KB by dropping the accessible primitive set, the ICU runtime, the server-state cache or the virtualizer. (b) Hold 250 KB and move the interactive number. (c) Keep both and let the build be unpassable, i.e. let one gate be deleted silently. (d) Change the client framework to a signals-based one to buy bundle headroom.

## Decision

Option (b). ARR-UX-08's 250 KB is held and becomes P12 unchanged. ARR-MVP-25's "interactive ≤ 2.0 s" is superseded by a new budget P20 — mobile time-to-interactive on /pipeline at mobile-ci against perf-500 — set by measurement at Gate 8, rounded up to the next 100 ms, with a hard ceiling of 3 000 ms, implemented as a ratchet that may only ever decrease and only through a PR touching perf-budgets.json and nothing else. Option (a) is rejected because reaching 150 KB requires violating ARR-UX-16 (WCAG AA gate-blocking on ten screens × four states), ARR-UX-21 (ICU from the first commit, build-breaking on a missing key) or ARR-UX-05/09 — three separate non-negotiables with their own enforcement. Option (d) is out of scope: the stack is signed and does not reopen.

## Consequences

The bundle ceiling keeps its mechanism (size-limit) and remains the only real defence against dependency bloat. Mobile interactivity is now a measured, monotonically improving number rather than an aspiration that no gate could hold. DoD-9's ≤2.0 s bullet is formally superseded and must not be mined as a requirement later. The residual risk is that Gate 8 measures above 3 000 ms, in which case the ceiling is breached and the forced choice becomes a genuine component-surface reduction — which is why the ceiling is stated now rather than discovered later.
