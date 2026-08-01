# Architecture Decision Records

> Phase 5. Each record: context → options → decision → consequences.
> **Precedence:** where an ADR disagrees with `05-architecture.md` §0.2 (errata) or Part I (rulings), those win.

| # | Decision |
|---|---|
| [001](ADR-001-transactional-emission-with-tiered-delivery-over-a-postgres-ou.md) | ADR-E1 — Transactional emission with tiered delivery over a Postgres outbox; pg-boss is the timer, not the bus |
| [002](ADR-002-the-consumer-classification-is-a-database-table-with-a-counted.md) | ADR-E2 — The consumer classification is a database table with a counted inline tier, not a convention |
| [003](ADR-003-the-event-contract-is-generated-from-json-schema-and-hand-edit.md) | ADR-E3 — The event contract is generated from JSON Schema, and hand-editing a generated file breaks the build |
| [004](ADR-004-stage-type-immutability-makes-pipeline-stage-config-changed-a-.md) | ADR-E4 — stage_type immutability makes pipeline.stage_config_changed a non-money event and deletes ARR-EVT-09's recompute job |
| [005](ADR-005-notify-carries-a-watermark-never-data-the-poll-interval-remain.md) | ADR-E5 — NOTIFY carries a watermark, never data; the poll interval remains a floor |
| [006](ADR-006-pg-boss-payloads-are-untrusted-handlers-re-derive-tenancy-and-.md) | ADR-E6 — pg-boss payloads are untrusted; handlers re-derive tenancy and cannot receive a tenant_id |
| [007](ADR-007-the-call-merge-job-payload-is-an-id-and-the-handler-folds-ever.md) | ADR-E7 — The call-merge job payload is an id, and the handler folds every unmerged row for that key |
| [008](ADR-008-process-topology-is-an-env-var-over-one-image-and-the-whole-in.md) | ADR-E8 — Process topology is an env var over one image, and the whole integration suite runs in both shapes |
| [009](ADR-009-retry-policy-is-a-per-consumer-column-and-external-effect-cons.md) | ADR-E9 — Retry policy is a per-consumer column, and external-effect consumers must declare an idempotency key or max_attempts = 1 |
| [010](ADR-010-01-resource-routes-are-the-only-server-api-ui-routes-never-exp.md) | ADR-API-01 — Resource routes are the only server API; UI routes never export loader or action |
| [011](ADR-011-02-pollable-gets-are-private-max-age-0-must-revalidate-never-n.md) | ADR-API-02 — Pollable GETs are 'private, max-age=0, must-revalidate', never 'no-store' |
| [012](ADR-012-03-404-is-the-only-denial-a-handler-can-express-403-can-only-b.md) | ADR-API-03 — 404 is the only denial a handler can express; 403 can only be produced by SQLSTATE 42501 or by a pre-record request rejection |
| [013](ADR-013-04-column-level-revoke-update-turns-four-service-layer-convent.md) | ADR-API-04 — Column-level REVOKE UPDATE turns four service-layer conventions into privilege facts |
| [014](ADR-014-05-reject-general-revoke-select-security-barrier-views-scope-a.md) | ADR-API-05 — Reject general REVOKE SELECT + security_barrier views / scope-argument functions; adopt the targeted, generated form |
| [015](ADR-015-06-app-begin-request-is-the-first-statement-of-every-request-t.md) | ADR-API-06 — app.begin_request() is the first statement of every request transaction and derives the context itself |
| [016](ADR-016-07-csrf-origin-sec-fetch-site-samesite-lax-with-the-token-in-t.md) | ADR-API-07 — CSRF: Origin/Sec-Fetch-Site + SameSite=Lax, with the token in the body on the one beacon-capable endpoint |
| [017](ADR-017-08-a-generated-route-registry-and-five-ci-suites-that-iterate-.md) | ADR-API-08 — A generated route registry, and five CI suites that iterate it |
| [018](ADR-018-09-every-endpoint-declares-a-process-role-folded-and-split-top.md) | ADR-API-09 — Every endpoint declares a process role; folded and split topologies both run in CI on every merge |
| [019](ADR-019-10-keyset-only-pagination-with-unsigned-position-cursors-no-of.md) | ADR-API-10 — Keyset-only pagination with unsigned position cursors; no OFFSET, no filter grammar |
| [020](ADR-020-11-session-lifetime-16-h-absolute-12-h-idle-renewed-at-most-ho.md) | ADR-API-11 — Session lifetime 16 h absolute / 12 h idle, renewed at most hourly |
| [021](ADR-021-12-arr-evt-24-s-p95-2-s-realtime-is-restated-per-channel-the-l.md) | ADR-API-12 — ARR-EVT-24's 'p95 < 2 s realtime' is restated per channel; the leaderboard's honest number is the undo window plus transport |
| [022](ADR-022-the-mutually-unsatisfiable-front-end-budgets-the-tti-moves-the.md) | ADR-T1 — The mutually unsatisfiable front-end budgets: the TTI moves, the bundle holds |
| [023](ADR-023-no-staging-environment-the-monthly-restore-drill-is-the-pre-pr.md) | ADR-T2 — No staging environment; the monthly restore drill is the pre-production fidelity mechanism |
| [024](ADR-024-latency-budgets-are-enforced-relatively-in-ci-and-absolutely-i.md) | ADR-T3 — Latency budgets are enforced relatively in CI and absolutely in production |
| [025](ADR-025-rollback-is-the-image-there-are-no-down-migrations.md) | ADR-T4 — Rollback is the image; there are no down migrations |
| [026](ADR-026-the-demo-tenant-is-permitted-in-production-the-seeder-is-const.md) | ADR-T5 — The demo tenant is permitted in production; the seeder is constrained by a database role, not by an environment check |
| [027](ADR-027-the-synthetic-probe-writes-real-ledger-rows-and-leaves-a-visib.md) | ADR-T6 — The synthetic probe writes real ledger rows and leaves a visible System Probe seller, rather than building a leaderboard-hiding mechanism |
| [028](ADR-028-coverage-is-100-branch-on-a-tiny-pure-domain-surface-plus-a-ge.md) | ADR-T7 — Coverage is 100 % branch on a tiny pure-domain surface plus a generated named-assertion registry, never a global percentage |
| [029](ADR-029-the-ci-minute-budget-is-a-monitored-build-breaking-budget-and-.md) | ADR-T8 — The CI minute budget is a monitored, build-breaking budget, and the matrix is split from the first commit |
| [030](ADR-030-01-lead-local-timezone-resolves-from-a-bundled-zip-zcta-iana-t.md) | ADR-SEC-01 · Lead-local timezone resolves from a bundled ZIP/ZCTA→IANA table with candidate-set intersection on straddles |
| [031](ADR-031-02-no-application-level-field-encryption.md) | ADR-SEC-02 · No application-level field encryption |
| [032](ADR-032-03-raw-payload-retention-is-60-days-with-two-independent-expir.md) | ADR-SEC-03 · Raw payload retention is 60 days, with two independent expiry mechanisms and an inverse liveness check |
| [033](ADR-033-04-call-recording-is-disabled-at-the-aloware-account-level-for.md) | ADR-SEC-04 · Call recording is disabled at the Aloware account level for the MVP regardless of the spike outcome, and is policed by artifact detection |
| [034](ADR-034-05-webhook-authentication-mode-is-a-runtime-constant-with-thre.md) | ADR-SEC-05 · Webhook authentication mode is a runtime constant with three modes, and a signature failure returns 204 with quarantine rather than 401 |
| [035](ADR-035-06-webhooks-are-admitted-and-shed-never-rate-limited-intake-is.md) | ADR-SEC-06 · Webhooks are admitted and shed, never rate-limited; intake is metered inside the token resolver |
| [036](ADR-036-07-csrf-is-prevented-by-origin-verification-not-by-a-token.md) | ADR-SEC-07 · CSRF is prevented by origin verification, not by a token |
| [037](ADR-037-08-pii-cannot-be-logged-because-the-field-names-do-not-type-ch.md) | ADR-SEC-08 · PII cannot be logged because the field names do not type-check |
| [038](ADR-038-09-tls-to-postgres-is-verify-full-with-a-pinned-ca-asserted-at.md) | ADR-SEC-09 · TLS to Postgres is verify-full with a pinned CA, asserted at boot |
| [039](ADR-039-process-topology-is-a-deployment-variable-one-image-roles-env-.md) | ADR-01 — Process topology is a deployment variable: one image, ROLES env, dedicated ingress hostname from day zero |
| [040](ADR-040-push-is-a-hint-poll-is-the-truth-sse-frames-carry-channel-seq-.md) | ADR-02 — Push is a hint, poll is the truth: SSE frames carry (channel, seq) only, and the call-state poller always runs during a live call |
| [041](ADR-041-provider-capabilities-are-rows-with-a-verification-state-enfor.md) | ADR-03 — Provider capabilities are rows with a verification state, enforced at compile time and at boot |
| [042](ADR-042-aloware-number-verification-is-three-way-the-third-leg-is-the-.md) | ADR-04 — Aloware number verification is three-way; the third leg is the seller's own authenticated session |
| [043](ADR-043-circuit-breaker-staleness-is-itself-the-degraded-condition-the.md) | ADR-05 — Circuit-breaker staleness is itself the degraded condition; the banner is computed at read time |
| [044](ADR-044-the-ingest-edge-never-returns-4xx-for-a-payload-it-holds-and-a.md) | ADR-06 — The ingest edge never returns 4xx for a payload it holds, and admission control bounds concurrency rather than admission |
| [045](ADR-045-call-initiated-is-emitted-before-aloware-confirms-flow-5-s-2xx.md) | ADR-07 — call.initiated is emitted before Aloware confirms; Flow 5's 2xx-only rule is superseded |
| [046](ADR-046-speed-to-lead-stops-on-call-completed-with-a-connected-or-voic.md) | ADR-08 — Speed-to-lead stops on call.completed with a connected or voicemail outcome, not on the tap |
| [047](ADR-047-a-late-webhook-merges-into-a-manual-degraded-mode-call-within-.md) | ADR-09 — A late webhook merges into a manual degraded-mode call within a bounded window |
| [048](ADR-048-reconciliation-and-replay-may-only-inject-at-the-ingest-edge-n.md) | ADR-10 — Reconciliation and replay may only inject at the ingest edge, never into the domain |
| [049](ADR-049-deployment-topology-is-a-runtime-role-set-on-a-single-image-no.md) | ADR-S1: Deployment topology is a runtime role set on a single image, not a code-level or build-level split |
| [050](ADR-050-the-render-workspace-stays-on-hobby-permanently-the-pro-jump-i.md) | ADR-S2: The Render workspace stays on Hobby permanently — the Pro jump is prohibited by arithmetic |
| [051](ADR-051-the-bulkhead-isolates-cpu-and-memory-not-postgres-postgres-is-.md) | ADR-S3: The bulkhead isolates CPU and memory, not Postgres — Postgres is protected by a read-free ingest path plus per-source metering |
| [052](ADR-052-one-migrator-n-boot-asserters-the-pre-deploy-migration-is-atta.md) | ADR-S4: One migrator, N boot-asserters — the pre-deploy migration is attached to exactly one service |
| [053](ADR-053-audit-log-is-permanent-in-postgres-with-no-archive-tier-and-is.md) | ADR-S5: audit_log is permanent-in-Postgres with no archive tier, and is accepted as the dominant long-run storage line |
| [054](ADR-054-the-split-trigger-is-a-measured-tripwire-never-a-headcount.md) | ADR-S6: The split trigger is a measured tripwire, never a headcount |
| [055](ADR-055-per-tenant-aloware-credentials-are-resolved-from-a-url-path-se.md) | ADR-S7: Per-tenant Aloware credentials are resolved from a URL path segment, decided now and built at tenant #2 |
| [056](ADR-056-bound-the-transport-change-to-two-channels-push-is-a-hint-the-.md) | ADR-P1: Bound the transport change to two channels; push is a hint, the poll is the truth |
| [057](ADR-057-the-celebration-is-client-timed-and-owner-scoped-delete-the-de.md) | ADR-P2: The celebration is client-timed and owner-scoped; delete the delayed job |
| [058](ADR-058-the-dial-executes-inside-the-seller-s-request-the-breaker-is-a.md) | ADR-P3: The dial executes inside the seller's request; the breaker is a row |
| [059](ADR-059-strike-recompute-replace-it-with-stage-configuration-identity-.md) | ADR-P4: Strike recompute; replace it with stage-configuration identity columns on every ledger row |
| [060](ADR-060-one-table-of-numbers-and-a-security-definer-public-leaderboard.md) | ADR-P5: One table of numbers, and a SECURITY DEFINER public leaderboard read to make it achievable |
| [061](ADR-061-publish-the-catalog-amendments-and-make-an-out-of-list-event-n.md) | ADR-P6: Publish the catalog amendments and make an out-of-list event name a build failure in five places |
| [062](ADR-062-the-kiosk-stays-cut-and-the-load-model-loses-its-line.md) | ADR-P7: The kiosk stays cut, and the load model loses its line |
| [063](ADR-063-one-name-for-the-fold-variable-one-spelling-for-the-two-contra.md) | ADR-P8: One name for the fold variable, one spelling for the two contractual URLs, one registry for every served route, one predicate for the keystone |
| [064](ADR-064-the-public-leaderboard-is-read-through-a-security-definer-func.md) | ADR-R1 — The public leaderboard is read through a SECURITY DEFINER function, and crm_app loses SELECT on the projection |
| [065](ADR-065-monetary-columns-are-definer-only-by-classification-not-by-a-r.md) | ADR-R2 — Monetary columns are definer-only by classification, not by a remembered REVOKE |
| [066](ADR-066-harden-is-schema-agnostic-and-schema-public-is-stripped-and-un.md) | ADR-R3 — harden() is schema-agnostic, and schema public is stripped and unreachable |
| [067](ADR-067-the-gate-s-refusal-is-durable-because-the-gate-runs-inside-a-p.md) | ADR-R4 — The gate's refusal is durable because the gate runs inside a PL/pgSQL subtransaction, and the constraint names its own refusal code |
| [068](ADR-068-a-move-into-an-earning-stage-that-credits-nothing-cannot-commi.md) | ADR-R5 — A move into an earning stage that credits nothing cannot commit |
| [069](ADR-069-guarded-files-are-authorised-by-a-row-in-production-not-by-a-d.md) | ADR-R6 — Guarded files are authorised by a row in production, not by a diff |
| [070](ADR-070-jobs-carry-a-latency-criticality-lane-with-reserved-capacity-a.md) | ADR-R7 — Jobs carry a latency-criticality lane with reserved capacity, and the enqueuer cannot choose it |
| [071](ADR-071-per-role-heartbeats-written-by-the-work-loop-and-a-missing-wor.md) | ADR-R8 — Per-role heartbeats written by the work loop, and a missing worker becomes a seller-visible amber bar |
| [072](ADR-072-every-served-route-goes-through-its-factory-or-it-is-not-route.md) | ADR-R9 — Every served route goes through its factory or it is not routed at all |
| [073](ADR-073-silo-testability-is-a-declared-non-optional-property-of-every-.md) | ADR-R10 — Silo testability is a declared, non-optional property of every endpoint |
| [074](ADR-074-the-boot-assertion-is-a-catalog-posture-digest-a-restore-that-.md) | ADR-R11 — The boot assertion is a catalog-posture digest; a restore that lost FORCE cannot boot |
| [075](ADR-075-a-provider-capability-is-verified-only-by-a-digest-linked-prob.md) | ADR-R12 — A provider capability is verified only by a digest-linked probe row |
| [076](ADR-076-one-name-for-the-roles-variable-one-seeded-table-for-the-two-c.md) | ADR-R13 — One name for the roles variable, one seeded table for the two contractual URLs |
| [077](ADR-077-job-payloads-cannot-express-a-tenant-the-handler-re-derives-it.md) | ADR-R14 — Job payloads cannot express a tenant; the handler re-derives it from the subject |
| [078](ADR-078-emitter-coverage-is-measured-over-the-shipped-bundle-and-names.md) | ADR-R15 — Emitter coverage is measured over the shipped bundle, and names with no MVP emitter are declared |
| [079](ADR-079-every-budget-exception-list-and-counted-assertion-becomes-an-a.md) | ADR-G1 — Every budget, exception list and counted assertion becomes an append-only row in Postgres, not a literal in a file |
| [080](ADR-080-nightly-performance-and-accessibility-results-gate-the-release.md) | ADR-G2 — Nightly performance and accessibility results gate the release, not the merge |
| [081](ADR-081-the-public-leaderboard-read-is-a-security-definer-function-the.md) | ADR-G3 — The public leaderboard read is a SECURITY DEFINER function; the projection is not readable by the application role |
| [082](ADR-082-one-credit-per-opportunity-is-a-partial-unique-index-over-a-cr.md) | ADR-G4 — One credit per opportunity is a partial unique index over a credit epoch, not an event key; and an earning stage cannot commit without its ledger row |
| [083](ADR-083-admin-void-writes-the-negation-of-a-named-row-the-function-has.md) | ADR-G5 — Admin void writes the negation of a named row; the function has no amount parameter |
| [084](ADR-084-mfa-is-not-required-on-admin-money-endpoints-in-the-mvp-the-co.md) | ADR-G6 — MFA is not required on admin money endpoints in the MVP; the compensating control is that the affected seller sees the change |
| [085](ADR-085-the-49-name-coverage-gate-becomes-two-sided-and-is-asserted-ov.md) | ADR-G7 — The 49-name coverage gate becomes two-sided and is asserted over the production bundle, not over table contents |
| [086](ADR-086-another-seller-s-identity-cannot-reach-a-timeline-the-actor-id.md) | ADR-G8 — Another seller's identity cannot reach a timeline: the actor id is a column, is revoked, and free-form JSON cannot carry it |
| [087](ADR-087-jobs-carry-a-latency-criticality-class-with-reserved-worker-co.md) | ADR-G9 — Jobs carry a latency-criticality class with reserved worker concurrency, and the ingest edge byte-scans for STOP |
| [088](ADR-088-an-expired-break-glass-override-is-unreadable-not-merely-unhon.md) | ADR-G10 — An expired break-glass override is unreadable, not merely unhonoured |
| [089](ADR-089-the-demo-tenant-is-constrained-by-a-database-role-and-the-refu.md) | ADR-G11 — The demo tenant is constrained by a database role, and the 'refuses to run in production' requirement is superseded in form |
| [090](ADR-090-the-premium-columns-are-revoked-and-routed-through-a-definer-w.md) | ADR-G12 — The premium columns are revoked and routed through a definer, with a deferred trigger as the counter-net |
| [091](ADR-091-sms-dark-is-the-ci-baseline-and-sms-live-is-the-variant.md) | ADR-G13 — SMS-dark is the CI baseline and SMS-live is the variant |
| [092](ADR-092-money-and-pii-are-detected-from-the-database-catalog-never-fro.md) | ADR-G14 — Money and PII are detected from the database catalog, never from a column name |