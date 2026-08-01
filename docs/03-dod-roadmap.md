# 03 — Definition of Done & Post-MVP Roadmap

> Companion to [`03-mvp-definition.md`](03-mvp-definition.md).
> The Definition of Done applies to **every** feature before it counts as finished. The roadmap is expressed in **build order and dependencies only** — never in hours, days, sprints or team effort.

---

# A. Definition of Done

This checklist applies to **every** feature in the MVP, without exception. It is a gate, not a guideline: a feature that fails any single item is not finished, regardless of how well it demos. Each item is written so that a reviewer can answer **yes** or **no** by looking at the code, the running app, or the test output — never by asking how confident the builder feels.

Reference the item IDs (`DoD-1` … `DoD-13`) in the acceptance criteria of each build task.

---

### DoD-1 — Scope contract

- [ ] The feature's row in the MVP list is quoted in the task, and nothing outside that row was built.
- [ ] Any behaviour that arrived "for free" during the build and is **not** in the MVP list is either removed or logged as a roadmap row — it does not ship silently.
- [ ] The feature's place in the lead lifecycle chain (enters → contacted → scheduled → happened/no-showed → advanced → won/lost with reason → measured → ranked) is stated in one sentence, and the link it serves actually works end to end after the change.

### DoD-2 — All four UI states exist and were seen

Every surface that renders data has four states. "Renders nothing" is not a state.

- [ ] **Empty** — with teaching microcopy that names the next action, not a shrug. Verify: point the surface at a brand-new seller account with zero rows. It must explain what will appear here and offer the button that creates the first row (e.g. an empty book shows "No leads yet — add one in 15 seconds" with Quick-add wired).
- [ ] **Loading** — skeletons matching the final layout's shape and row count; no spinner-on-blank-page, no layout shift when data lands. Verify: throttle to Slow 4G in devtools and record the transition.
- [ ] **Error** — a human sentence, the retry affordance, and a preserved user input. Verify: force the endpoint to 500 and confirm nothing the user typed is lost.
- [ ] **No-permission** — renders the **owner-scoped not-found** shape. Verify: request another seller's record by ID; the response and the screen must both say "not found", never "belongs to another seller", never a name, never a count.

### DoD-3 — Silo scoping enforced at the query layer

- [ ] Every read and write path for the feature carries `tenant_id` **and** the owner predicate **inside the query/repository call**, not in a controller check, not in a React guard, not in a filter applied after fetch.
- [ ] There is at least one automated test that calls the feature's API as Seller B with Seller A's record ID and asserts the owner-scoped not-found response.
- [ ] No endpoint added by this feature returns a total, count, aggregate, name, or ID that spans owners — with the two sanctioned exceptions: the public leaderboard (which publishes only what the leaderboard is defined to publish) and supervisor/admin global read.
- [ ] Cross-silo shielding holds at intake: a dedupe or lookup that touches another seller's record reveals **no** field of it, only the fact that creation is blocked or updated in place for the current owner.

### DoD-4 — Permissions verified for all three roles

- [ ] The feature was exercised manually as **seller**, **supervisor** and **admin**, and the expected result for each is written into the task.
- [ ] Supervisor/admin global visibility is **read-only** on seller-owned data; any write attempt from those roles on another seller's book is rejected server-side and tested.
- [ ] No new role, flag, or per-user permission toggle was introduced. Roles remain the three fixed ones.
- [ ] Admin-only configuration surfaces are unreachable by URL for a seller session (tested, not merely hidden in the nav).

### DoD-5 — Events emitted per the canonical catalog

- [ ] Every event the feature emits exists in the canonical event catalog by name. New names are added to the catalog **in the same change**, with payload schema and version.
- [ ] Every event carries the mandatory envelope: `event_id`, `event_name`, `schema_version`, `tenant_id`, `actor_user_id`, `owner_user_id`, `subject_type` + `subject_id`, `occurred_at` (UTC, ISO-8601), `source`, `idempotency_key`.
- [ ] Every consumer of those events is idempotent on `event_id` / `idempotency_key`. Verify: replay the same event twice into a running system and assert zero duplicated side effects — no second ledger row, no second SMS, no second notification, no second celebration.
- [ ] Out-of-order delivery is tolerated: a webhook or job arriving after a later one does not overwrite newer state (upsert keyed on the provider ID, guarded by timestamp).
- [ ] Failures land in the dead-letter queue with the raw payload retained; nothing is dropped on the floor.

### DoD-6 — Compliance gate respected on any outbound action

Applies to any code path that can dial, text, or schedule a message.

- [ ] The action calls the **single** outbound compliance gate function. There is no second code path to a send, and grep confirms it.
- [ ] The gate is **fail-closed**: a consent lookup, timezone lookup, or suppression lookup that errors blocks the send. Verify with a forced lookup failure.
- [ ] Automated and SMS sends are hard-blocked when consent, suppression, or the calling window says no. A manual dial produces the amber warning plus attestation, never a silent pass.
- [ ] Every blocked or skipped send writes a plain-English reason to the lead timeline ("Not sent — lead's local time is 8:41pm").
- [ ] SMS paths respect the 10DLC registration flag and degrade to a plain banner rather than an exception.
- [ ] Consent, suppression, ownership and Earnings writes made by the feature appear in the append-only audit log with actor and timestamp.

### DoD-7 — Money integrity (any path that can touch Earnings)

- [ ] Earnings are written only through the append-only ledger's single writer, stamped with `period_key` and `source_event_id`, exactly-once.
- [ ] The transition into an Earnings stage was performed by a human actor; automated transitions cannot credit.
- [ ] Reopen, stage reversal, and premium correction produce a compensating ledger entry and a re-rank — verified by moving a won card back out and confirming the board changes.
- [ ] Premium is stored in both modes and displayed annualized; a monthly value entered at the win gate cannot reach the board un-converted (server-side test, not a client-side format).

### DoD-8 — Responsive verified on a real phone

- [ ] Any contact surface (contact detail, action bar, timeline, My Day, board, quick-add, quick-log, agenda strip) was opened on a physical phone-sized viewport at 375px and used to complete its primary task with one thumb.
- [ ] No horizontal scroll on the page body at 375px; wide content scrolls inside its own container.
- [ ] Tap targets on primary actions are at least 44×44px.
- [ ] Destructive or money-writing gestures are **not** drag-based on touch: the board uses the move-sheet, not touch-drag, into an Earnings stage.

### DoD-9 — Performance budget met

Measured on a mid-tier Android over throttled 4G, against a seeded book of 300 open opportunities and 5,000 activities.

- [ ] Board, My Day, and contact detail reach interactive in ≤ 2.0s; subsequent navigations ≤ 1.0s.
- [ ] Optimistic UI (stage move, quick-log, snooze) repaints in ≤ 100ms before the server round trip.
- [ ] API p95 for the feature's endpoints ≤ 400ms; no endpoint issues an unbounded query or an N+1 (verified by query log, and every list path is paginated or hard-capped).
- [ ] Leaderboard re-rank reaches a connected client ≤ 3s after the ledger write; the stale/freshness chip appears when the stream is degraded.
- [ ] No new always-on polling loop faster than 30s, and no scheduled job that fans out per-lead without a rate limit — the infra budget is under $100/month and it is a hard constraint, not an aspiration.

### DoD-10 — en-US microcopy reviewed, i18n-ready

- [ ] Zero hard-coded user-facing strings in components; everything reads from the string catalog with a stable key.
- [ ] Copy was read aloud once: no CRM jargon where a seller's word exists ("Call now", not "Initiate outbound engagement"), no dead ends, no error that blames the user.
- [ ] Dates, times and currency are formatted through the locale helpers; **lead-local time is labelled as such** wherever a lead's time is shown next to the seller's.
- [ ] Compliance-bearing copy (opt-out footer, attestation text, blocked-send reasons) is locked and not editable by sellers.

### DoD-11 — Tests written against the acceptance criteria

- [ ] Each acceptance criterion in the task maps to at least one automated test, named after it.
- [ ] The silo test (DoD-3), the idempotency/replay test (DoD-5), and — where applicable — the fail-closed gate test (DoD-6) and the exactly-once Earnings test (DoD-7) exist and pass.
- [ ] One end-to-end happy path through the feature's link in the lifecycle chain passes against a running app.
- [ ] The suite is green on a clean checkout, not only on the builder's machine.

### DoD-12 — Operable and reversible

- [ ] Errors are logged with `tenant_id`, `owner_user_id` and the correlating `event_id`; no PII (phone, email, SSN-shaped strings) in logs.
- [ ] Any scheduled or automated outbound introduced by the feature is covered by the admin kill switch, and the switch was tested while jobs were in flight.
- [ ] Schema changes are additive and forward-compatible; nothing hard-deletes, redaction is in place.
- [ ] The change can be reverted without leaving orphaned rows or half-credited ledger entries.

### DoD-13 — CONTEXT.md updated

- [ ] `CONTEXT.md` reflects the feature's data model additions, new events and their envelope, new config keys, and any new invariant a future change must not break.
- [ ] Anything deliberately **not** built (and why) is recorded, so the next session does not rediscover it as a bug.
- [ ] The entry is written for a reader with zero memory of this conversation.

---

### A feature is NOT done if…

- …it works on the builder's screen but nobody opened it as an empty account, a broken account, or another seller's account.
- …the silo is enforced in the component instead of the query — a hidden button is not a permission.
- …the "no-permission" screen tells the user the record belongs to someone else.
- …replaying the same webhook, event, or button double-click produces two of anything: two ledger rows, two texts, two meetings, two notifications.
- …any send can reach a lead without passing through the one compliance gate, or the gate passes when a lookup fails.
- …a blocked send is invisible to the seller, who then assumes the lead ignored them.
- …a number that appears on the public board can be produced, altered, or reversed by anything other than the single ledger writer.
- …a monthly premium can reach the leaderboard without conversion.
- …it was never opened on a phone, and the surface is one a seller uses while dialing.
- …it ships a blank-canvas configuration screen instead of seeded defaults the seller can edit.
- …it introduces a fourth role, a routing rule, or any behaviour that moves a lead between sellers.
- …the only test is that the builder clicked it once.
- …`CONTEXT.md` still describes the system as it was before the change.

---

# B. Roadmap after the MVP

Everything below is drawn strictly from the **OUT OF MVP** decisions. Nothing new is introduced.

The roadmap is expressed as **build order and dependencies only**. No hours, no days, no sprints, no team sizing — the product is built by vibecoding with Claude Code, so the only meaningful ordering variables are *what must exist first* and *what carries the most technical risk*.

**Two rules govern the whole roadmap:**

1. **Nothing may break the silo.** Several deferred items (escalation, ownership transfer, unmatched-call handling) sit directly on the seam where a lead-routing engine would get smuggled in. Each is built as an *ownership correction*, never as an *assignment engine*.
2. **The engine comes late, on purpose.** The cadence/automation block is the largest complexity and compliance surface in the product. It is deliberately sequenced *after* the compliance data it needs (state-level windows, consent expiry, per-number consent) and *after* the channels it would drive (email, dialer lists) exist and are stable.

**Permanently cut — never on this roadmap:** owner-jurisdiction/licensing checks, FE/IUL underwriting knockouts and all insurance-specialist record machinery, SSN capture, post-sale/placement/persistency/chargeback workflow, weighted pipeline forecasting, product-line boards, shared unmatched-call quarantine pools, iCal feeds, recurring/tele-app scheduling, MMS, open tracking, Aloware sequence mirroring, caller-ID rotation, and the multi-channel voicemail-drop ladder. If one of these is requested later, it is a scope conversation, not a backlog item.

---

## V1.1 — hardening, depth, and the engine

V1.1 is six waves. Waves are strictly ordered; rows inside a wave are also in build order but are largely independent of one another.

---

### Wave 1 — Harden what the MVP already ships

*Depends on: MVP complete. No new subsystems — every row is a second layer on data that already exists.*

| Capability | Why now | What it unlocks |
|---|---|---|
| Board filters + saved views, column sort & pagination, list/table view | The first thing that breaks at real volume is a board you cannot narrow; MVP shipped only the stale queue | Every later bulk and queue feature; the table view feeds exports |
| Timeline type filters + needs-review markers | Timelines only get long after weeks of auto-logged calls | Readable history before dials; a precondition for coaching review |
| Stage history / time-in-stage audit | The Earnings ledger proves money, not motion; the first "where do deals die" question needs stage timestamps | Time-in-stage signals, later cadence triggers, supervisor exception depth |
| Card snooze / follow-up date (standalone) | Now safe: the scheduled-callback activity is established as the default, so a bare snooze can't quietly replace a next step | Overdue triage and the Snoozed & Waiting view in Wave 5 |
| Duplicate-opportunity guard | Intake dedupe catches the person; a second card on the same person appears once sellers create manually at volume | Clean per-contact opportunity counts before the multi-opportunity rail |
| Multiple-opportunity rail on the contact | Schema separation already shipped; the UI matters once re-quotes exist | Cross-sell and re-quote motions without a second pipeline |
| Manual recycle of cold and lost opportunities | Lost leads are the cheapest inventory a seller has | A linked recycle record instead of a hand-retyped duplicate |
| Inbound call / reply clears cold and pins the card | Cheap once inbound events are proven stable in production | Accurate cold detection, which every nudge and report downstream trusts |
| Multi-number leads (number picker + per-number status) | Bad-number rates become visible after the first weeks of dialing | Per-number consent selection (Wave 2) and dial discipline (below) |
| Dial attempt discipline (attempt counter, cadence and day-part rotation) + callback-window field | Real logic that deserves its own iteration; needs attempt data the MVP timeline has now accumulated | Structured input the dialer lists and the cadence engine will consume |
| Tags with a governed tag library | Only once there is enough volume to need slicing — and it ships governed, not blank-canvas | Segment definitions for later bulk actions and enrollment |
| Bulk actions (desktop multi-select) — board and book | Requires filters/saved views to select *the right* rows | Mass disposition and, later, bulk enrollment — always behind a consent pre-flight |
| Cmd+K command palette (searches and executes) | A proven accelerator; safe to add once every action it fires is a stable button | Keyboard-speed operation for the desktop-managing half of the day |

**Hard dependency inside this wave:** bulk actions must not ship before the consent pre-flight pattern from the MVP gate is reused verbatim. A bulk action without a pre-flight is a bulk violation.

---

### Wave 2 — Intake, data ops, and the compliance backlog

*Depends on: Wave 1 (filters/bulk selection for the merge and transfer queues). Independent of comms and calendar depth — can run in parallel with Wave 3.*

| Capability | Why now | What it unlocks |
|---|---|---|
| Vendor field-mapping templates (named, versioned, transform library) | MVP ships one plain map per source; the second and third vendor make that unmaintainable | The replay tooling below, and self-serve source onboarding |
| Raw-payload replay & re-parse tooling | Requires versioned maps to replay *into* | Recovering leads lost to a bad map instead of losing them permanently |
| Intake operations tooling (unassigned quarantine, endpoint health monitor & failure alerts, token rotation, bulk ownership transfer) | Turnover hygiene and silent-endpoint detection become real after the first seller leaves | Safe seller offboarding; a monitored front door |
| Ownership transfer with audit + activity reassignment on offboarding | Needed the first time a seller leaves — and must be built as a *transfer*, never as routing | Continuity of a departed seller's book without breaching the silo |
| Manual merge / duplicate review queue with field-level resolution, reversible window, owner reassignment with history transfer | Exact-match prevention covers MVP; fuzzy duplicates accumulate | One record per human, which every metric quietly depends on |
| Inbound-unknown-caller lead creation + re-inquiry clock reset | Three entry doors already work; this closes the fourth without a shared pool | Re-inquiries counted as fresh, feeding the speed-to-lead clock |
| Hosted web forms bound to a seller | Sellers running their own ads outgrow posting to a raw webhook | Seller-owned lead generation — deliberately *forms only*, not a funnel builder |
| Consent expiry sweeper, two-party recording-consent flag by state, per-number consent selection | The compliance surface widens as multi-number leads (Wave 1) and recordings (Wave 3) arrive | Legal cover for recordings and for aged consent — a precondition for automation |
| State-level calling/texting window table | The conservative 9am–8pm floor is safe but leaves selling hours unused | Reclaimed dial hours; the scheduler the cadence engine needs |
| TrustedForm / Jornaya certificate retention via API | Priced against the infra budget once lead spend justifies it | Defensible proof of consent, not just a URL that may expire |
| Contact access log | CCPA-by-design is satisfied by owner scoping in MVP; the log is the evidence layer | Answering "who looked at this record" during an audit |
| CCPA data-subject action screens / redaction & erasure executor + compliance audit export | The model already permits erasure; this is the operator's console | Subject requests handled without an engineer running a script |
| Source performance / cost-per-acquisition & vendor ROI reporting | MVP already emits the attribution; this renders it | The buy/kill decision on every lead vendor |
| Lead-vendor attribution on comms events + per-lead language template routing | Nearly free once attribution and templates are both mature | Channel-level ROI and Spanish-speaking leads handled correctly |

---

### Wave 3 — Comms depth

*Depends on: MVP Aloware integration proven in production (webhooks stable, disposition map settled). Wave 2's consent items gate the recording rows.*

| Capability | Why now | What it unlocks |
|---|---|---|
| A2P 10DLC status console | The MVP banner is enough for one registration; a console pays off at the first renewal or rejection | Visibility into the single thing that can silence SMS entirely |
| Disposition mapping admin screen | The code-level map plus unmapped alert works until the carrier list churns | Non-engineer maintenance of call outcomes |
| Inbound voicemail ingestion + `sms.delivered` / carrier-filtering handling | Silent delivery failures stop being rare once volume climbs | Trustworthy "they didn't answer" vs "it never arrived" |
| My Conversations inbox + conversation search | Only pays off once there is history to search | A messaging home for the seller who lives in SMS |
| Send later / scheduled messages | Convenience with its own re-validation surface — safe once the gate re-checks at send time | Evening-composed, morning-sent follow-up |
| Recording attachment, player and retention policy | Requires the two-party consent flag from Wave 2 | Every coaching and transcript feature downstream |
| In-timeline recording player, transcript pane and AloAi summary card + AloAi summary → prefilled note | Depends on recording retention existing | Zero-typing call notes; searchable conversations later |
| Automatic call ↔ meeting linkage with recording and AI summary | Heuristic matching is only safe once outcome capture has a track record to validate against | Show-rate computed rather than self-reported |
| Supervisor conversation review + coaching notes | Supervisors already have global read; this is the workflow on top | Coaching as a product surface, not a screenshot in Slack |
| Click-to-call via the Aloware Talk Chrome extension | Two-legged Call now covers every device; the extension is an optimization for desk-bound sellers | Dialing from outside the CRM without losing the log |
| Email channel (per-seller sender identity, inbound capture and reply threading) | The heaviest single item: SPF/DKIM/DMARC and reputation across 50 senders — built only when call + SMS are fully stable | A third channel for the cadence engine; the `Message` envelope already anticipates it |
| Aloware Power Dialer list push, fresh-lead auto-enroll and calendar-driven dialer lists | A second Aloware integration surface, safe only after the first is boring | Dial-block productivity and Focus Mode's respecified loop |

---

### Wave 4 — Calendar depth

*Depends on: MVP calendar (meeting object, quick schedule, outcome capture) in daily use. Availability rows depend on the client un-deferring the availability/presence model.*

| Capability | Why now | What it unlocks |
|---|---|---|
| Month / week calendar grid + drag-to-reschedule | Desktop sugar, but the first thing asked for once the agenda strip is habitual | A planning view for the desktop-managing half of the day |
| Conflict / double-book detection | Low-frequency in phone sales; matters once appointment volume grows | Trustworthy booking without reading the day sheet |
| Appointment types & reminder template admin screen | Five seeded rows suffice until reminder copy needs tuning per type | Non-engineer control of reminder wording and cadence |
| Pre-call prep card | A deep link covers MVP; the card matters when back-to-back appointments leave no time to navigate | Faster context before a scheduled call |
| Availability profile (hours, buffers, min notice, caps, blackouts) | **Blocked** until the client's deferred availability/shift/presence decision lands | Booking links (V2), the SLA-holding availability window (Wave 5) |
| Two-way Google Calendar sync (+ sync-health banner, echo suppression, DST re-validation) | The module's largest technical risk: OAuth verification, quotas, echo loops — isolate it, don't bundle it | Sellers who live in Google stop double-entering |
| Team calendar lane view, meeting audit trail, show-rate / appointment-set metrics feed | Requires reliable outcome data (MVP) and linkage (Wave 3) to be meaningful | Supervisor answers beyond an exception list — without adding a second board or a second number |

---

### Wave 5 — The engine

*Depends on: Wave 2's compliance data (state windows, consent expiry, per-number consent), Wave 3's channels (email, dialer lists), Wave 4's availability profile. This is the single largest complexity and compliance surface in the product and is built last among the functional waves — deliberately.*

| Capability | Why now | What it unlocks |
|---|---|---|
| Automation engine core (trigger vocabulary, When/Only-if/Then, action catalog, business-hour waits, frequency caps, enrollment ledger, retry/DLQ) | Everything below is an application of it; MVP's single reminder ladder is the proof-of-concept it generalizes | One scheduler instead of five one-off jobs |
| Cadence / sequence engine block (steps, TCPA-aware scheduler, stage-bound triggers, bulk enroll, auto-pause on reply, attempt ceilings, duplicate-activity suppression) | The proven pattern from research, safe only on top of a compliance-aware scheduler | Systematic follow-up instead of memory + My Day |
| Per-lead automation strip, do-not-automate flag, playbook gallery, three-level kill-switch console | Controls for an engine that now exists | Safe operation; a seller can always take a lead off the rails |
| Speed-to-lead first-touch auto-SMS recipe | The largest TCPA/A2P surface in the product — it ships only behind the mature gate, consent expiry and 10DLC console | Sub-minute first touch without a human at the desk |
| Cold-lead nudge automation + unworked fresh-lead escalation | Built as a **notification to the owner**, never as reassignment — the silo rule is the design constraint | Fewer quietly dying leads |
| Enrollment handling on owner change | Depends on ownership transfer (Wave 2) and enrollments (this wave) | A departing seller's sequences don't text leads from a ghost |
| Seller availability window that holds the SLA clock | Depends on the availability profile (Wave 4) | Honest SLA metrics that don't punish off-shift hours |
| Inbound-response SLA clock (second clock class) | A second clock is only worth its complexity once the first one is trusted | Response-time as a managed metric |
| Overdue triage & bulk reschedule + Snoozed & Waiting view | Requires a backlog and paused enrollments to exist | Recovering a week of slippage in one pass |
| Follow-up health report (leads with no next activity) | The board flag covers the seller; the report covers the supervisor | Exception management at floor scale |
| Focus Mode (run-the-queue, one card at a time) | Its one-tap dial loop must be respecified around two-legged calling or dialer lists — both now exist | The highest-throughput calling surface in the product |
| Activity / enrollment audit trail beyond created_by / completed_by | Only meaningful once automation writes activities | Explaining why a lead got a message nobody remembers sending |

---

### Wave 6 — Leaderboard, recognition, and analytics

*Depends on: a materially longer Earnings ledger than the MVP will have at launch. Several rows are literally blank until history accumulates, which is why they are last — not because they are unimportant.*

| Capability | Why now | What it unlocks |
|---|---|---|
| Board ops (recompute & backfill with diff preview, standings & ledger CSV export, retire/anonymize a departed seller, accessibility pass) | Exports start mattering at the first pay period; a rebuild is a script before it needs a UI | Payroll-grade trust in the public number |
| Rank delta vs yesterday / 7 days + nightly standings snapshot | On an all-time board the column is blank for most rows until volume builds — replayable from the ledger when it isn't | Movement, which is what makes a cumulative board readable |
| Goal / quota attainment (% to goal, pace) | **Blocked** until the client defines a goal model — none exists in the binding decisions | Pace-based coaching without adding a second leaderboard |
| Gamification layer (secondary recognition categories, streaks, personal bests, badges & milestones) | Seven metric pipelines with windows, floors and tie-breaks is a module of its own; self-rank + dollar gap carries MVP | Recognition for the ~40 sellers who will never be top-3 — the named anti-pattern this defuses |
| Celebration tiers, mute / focus mode, floor-wide broadcast | Only matters once celebrations reach beyond the closer's screen and the TV | Escalating moments without becoming noise |
| Public seller profile card (tappable leaderboard rows) | MVP rows are deliberately not tappable; making them tappable is a silo decision, not a UI decision | Peer visibility — requires an explicit ruling on what a rival may see |
| Kiosk unauthenticated access token + auto-rotating scenes | The highest-risk artifact in the product: an unauthenticated URL publishing 50 named employees' earnings — token scoping and rotation must be designed, not bolted on | A TV that survives a browser restart without someone logging in |

---

## V2 — new product surfaces

V2 items are not deferrals of MVP work; each opens a surface the product does not currently have. All depend on the corresponding V1.1 wave being stable.

| Capability | Why now | What it unlocks | Depends on |
|---|---|---|---|
| Multiple typed pipelines (per-vertical) | Only once a second line of business exists — per-seller stage freedom covers everything before that | Selling something other than the current use case without forking the product | Wave 1 board depth; a real second vertical |
| Custom field engine with curated field packs (admin builder) | A blank-canvas field editor is the named anti-pattern; it is only defensible as *governed packs*, and only when a second vertical proves one authored pack isn't enough | Vertical adaptation without code | Multiple typed pipelines |
| Booking links + public booking page | An entire second product, and the only unauthenticated surface in the system besides the kiosk | Leads self-scheduling; inbound appointment volume | Availability profile (Wave 4), kiosk token security model (Wave 6) |
| Second attendee / decision-maker on the appointment; dial-block model | Doubles reminder and consent logic and presupposes dialer-session integration | Household/spouse selling motions; structured dial blocks | Power Dialer integration (Wave 3), cadence engine (Wave 5) |
| Live / warm transfer intake bound to a concurrent inbound call | Race-condition-heavy and tied to one lead-buying model | Buying transfer traffic, the highest-intent lead type | Intake ops tooling (Wave 2) |
| Vendor credit / return workflow for bad leads | A purchasing back-office, not a link in the lead's life — earns its place once lead spend is large | Recovering money on junk leads | Source performance / CPA reporting (Wave 2) |
| State-level and Sunday/holiday calling-rule table (full jurisdictional model) | The V1.1 state window table plus the conservative floor covers the exposure until multi-state volume is large | Maximum legal dial hours per jurisdiction | Wave 2 state window table |
| Formatted compliance/timeline export + CCPA subject-request console | Expected volume is near zero at one 50-seat tenant; volume arrives with more tenants | Answering subject requests at multi-tenant scale | Erasure executor (Wave 2); SaaS path |
| Transcript ingestion & search, template performance stats, comms cost meter, voicemail drop | Storage- and volume-gated; ringless voicemail additionally carries its own litigation profile and needs a legal ruling before it is built | Conversation intelligence and per-message cost control | Recordings + transcripts (Wave 3) |
| Cadence performance analytics | Reporting on an engine that must exist and run long enough to produce data | Which sequence actually works | Cadence engine (Wave 5) |
| Closed-Won welcome & referral ask + playbook performance analytics | The lifecycle ends at won and measured; this is a deliberate extension past that boundary | Referral as a lead source, closing the loop back to intake | Cadence engine (Wave 5) |
| Hall of Fame, positive-framing rank nudges, anomaly hold-before-public | Kiosk filler, an undecided social question, and a rule that would fire on every legitimate career-best close — all need a client ruling before they are built | Long-horizon recognition; a safety valve on the public number | Gamification layer (Wave 6) |
| Board configuration admin surface | With one board, one metric and one period there is nothing to configure — this only becomes real when tenant #2 wants a different metric | Per-tenant leaderboard definition | SaaS path (below) |

---

## The path to SaaS

Selling this to a second agency is not a feature — it is a sequence of preconditions. The MVP already pays the one debt that cannot be retrofitted (`tenant_id` on every row, redact-in-place, owner-scoped queries). Everything below builds on that and is ordered by dependency: **each stage is unsafe to attempt before the one above it.**

### Stage 0 — Already paid in the MVP

`tenant_id` on every table and every query predicate. No hard deletes. Owner-scoped not-found. Append-only audit for consent, suppression, Earnings and ownership. Tenant-scoped suppression keyed on E.164. **Nothing in V1.1 or V2 may introduce a query path that omits the tenant predicate** — that is a DoD-3 violation, and it is the one mistake that would make SaaS impossible later.

### Stage 1 — Tenant isolation proven

*Precondition for everything else.*

| Step | Why it is first | What it unlocks |
|---|---|---|
| Automated cross-tenant isolation test suite (every endpoint, every job, every webhook, every export) | You cannot sell isolation you have not proved; the test suite is the artifact you show a buyer | Permission to run two real tenants on one deployment |
| Tenant-scoped background jobs and rate limits | An MVP job that iterates "all leads" becomes a cross-tenant leak the day tenant #2 exists | Safe multi-tenant reminder ladders and, later, cadences |
| Per-tenant secret storage for Aloware credentials and webhook tokens | Each agency brings its own comms account and its own 10DLC registration | Tenant #2 sending SMS at all |
| Tenant-scoped kiosk and leaderboard routes | The riskiest public surface must never resolve across tenants | A wall TV per agency |

### Stage 2 — Tenant onboarding

*Depends on Stage 1.*

| Step | Why here | What it unlocks |
|---|---|---|
| Tenant provisioning (create tenant, seed stage template, loss reasons, lead sources, first admin) | Onboarding must be a repeatable operation, not a manual database session | A second agency without an engineer in the loop |
| Per-tenant Aloware wiring wizard (number map, webhook endpoints, 10DLC status) | The longest-lead-time step in any onboarding, and it is external | A tenant that can dial and text on day one |
| Tenant-level CSV import + consent attestation at onboarding scale | Every new agency arrives with an existing book | Migration off spreadsheets as the sales pitch |
| Per-tenant branding and locale defaults | Minimum viable white-labelling; strings are already externalized | An agency seeing its own name on the board |

### Stage 3 — Per-tenant configuration

*Depends on Stage 2 and on the V2 configuration surfaces.*

| Step | Why here | What it unlocks |
|---|---|---|
| Promote admin runtime config to fully per-tenant (stage templates, reminder ladders, appointment types, compliance copy) | MVP config is already runtime; this makes it tenant-partitioned rather than global | Tenants with genuinely different sales motions |
| Board configuration admin surface (metric, period, visibility) | Some agencies will not want an all-time board, or not a public one | Selling to agencies that reject the default recognition model |
| Feature flags per tenant | Not every tenant should get the cadence engine or the kiosk on day one | Tiering — the precondition for pricing |
| Custom field packs per tenant | Governed packs, never a blank canvas | Adjacent verticals without forking |

### Stage 4 — Billing

*Depends on Stage 3 — you cannot bill for tiers that do not exist as flags.*

| Step | Why here | What it unlocks |
|---|---|---|
| Plan / seat model and entitlement checks | Entitlements read the flags from Stage 3 | Enforceable plans |
| Subscription provider integration, invoices, dunning, trial and downgrade paths | Deliberately last in the money chain: downgrade behaviour must be defined *after* feature flags exist, or a downgrade silently deletes data | Self-serve revenue |
| Usage metering for cost-bearing resources (SMS segments, recording storage, transcript minutes) | The infra budget discipline from MVP becomes a per-tenant margin question | Not losing money on a heavy tenant |

### Stage 5 — Support and audit surfaces

*Depends on Stages 1–4. Built last, but a hard gate on selling to a customer with a compliance officer.*

| Step | Why here | What it unlocks |
|---|---|---|
| Scoped support impersonation — time-boxed, consented, fully audited, never silent | The single most dangerous capability in a multi-tenant CRM; it is built only once the audit log it writes into is mature | Supporting a tenant without asking for their password |
| Tenant health console (webhook failures, DLQ depth, job lag, 10DLC status, ledger anomalies) | Multi-tenant operations cannot be run by reading logs | Noticing a broken tenant before the tenant notices |
| Tenant-scoped compliance export pack (consent history, suppression, timeline, audit trail) | The first enterprise buyer will ask for this before signing | Passing a compliance review |
| Data residency / retention policy per tenant + tenant offboarding and export-then-purge | Retention promises made at sale must be executable | Legally exiting a customer relationship |

**The rule that keeps this path open:** every item in V1.1 and V2 must ship tenant-scoped from day one. Retrofitting tenancy onto a feature built single-tenant costs more than building it right — and the MVP's DoD-3 test is what enforces it, on every feature, from the first one.
