# 05c — Closure Register

> **Phase 5 deliverable, companion to [`05-architecture.md`](05-architecture.md).**
> This is the correction record: what two reviewers found, what was closed, by which object, and what remains open.
> **Precedence:** errata §0.2 and Part I rulings of `05-architecture.md` win over everything here.
> Read §4 (the Gate-5 closure pass) before §2 and §3 — it supersedes them where they differ.

---

# §1 — What the reviewers found

Two reviewers attacked the seven architecture sections independently.

## §1.1 — Contradiction hunt against approved Phases 2–4

I read the four approved documents against the architecture sections supplied. Findings below, three lists, ordered by severity.

---

# (A) DIRECT CONTRADICTIONS WITH SOMETHING ALREADY APPROVED

**A1 · The architecture builds SSE. Three approved documents forbid it.**
- `04b-design-system.md` §1.10 opens with **"No SSE, no WebSocket."** and publishes the four-channel polling table as the refresh contract.
- `03-mvp-definition.md` item **62**: *"Public real-time Earnings board (**5-second polling**, no SSE)"*.
- `03-mvp-stories.md` §0, Cut list: *"Cut from this area per the too-big critic (recorded, not silently dropped): kiosk/TV route, TV takeover, **SSE**, freshness chip…"*

The architecture makes SSE + `LISTEN/NOTIFY` a signed pillar: `/sse/tenant`, `/sse/me`, a dedicated `LISTEN` connection, Gate 3 (unverified provider proxy behaviour for concurrent SSE), a `transport-in-use` metric, and an entire L4 failure class it discovered itself (*"every `NOTIFY` in that window is gone forever, while the browser's SSE connection stays alive with heartbeats… only L4's two-legged probe sees it"*). That is a whole risk surface, one Sprint-0 gate and one production-only probe **purchased for a transport the approved MVP explicitly cut**. Note the only approved text that supports SSE is `03-mvp-definition.md` §4 chain-walk 9 (*"re-ranks live over SSE with a polling fallback"*), which is prose that contradicts item 62 in its own document. Phase 5 must either strike SSE or reopen item 62 in writing — it cannot keep it silently.

**A2 · R1.3 is not implemented. The architecture implements the design R1.3 overruled.**
R1.3 (normative): *"The public leaderboard projection **excludes** ledger entries younger than the undo window (5s)… no viewer ever sees a number that later corrects itself."*
The architecture makes `earnings.leaderboard_projection` an **inline consumer, "driven by the ledger append, same statement"**, and justifies it with *"a lagging projection is a public money number that is wrong for as long as the lag."* That is precisely `04b` §1.3's rejected alternative: 04b's table row *"Known, accepted consequence: another seller's board can show `+$3,000` on one 5 s poll and the reversal on the next"* and its open question **Q2**. R1 Part I overrides 04b. The architecture inherited the superseded design. It also needs **two** projections, not one — R1.3 explicitly allows the seller's own *My Earnings* to show the pending row marked pending, and `04b` line 2140 has the win response returning `{new_total, rank, gap_to_next}` at T+0 for the celebration copy, which cannot come from the public projection.

**A3 · The celebration is modelled as a pg-boss delayed job. The approved design deleted the second timer on purpose.**
Architecture: *"The celebration is a `pgboss` consumer with a delay, never an inline one"*, `delay = undo_window + guard`, class `pgboss` = **at-least-once**.
Against:
- `04b` §1 token table: **`--time-celebration-delay: 5150ms` — "token deleted — the celebration fires on the undo window's close event… One timer, one event, no race, no drift."** A server-side delayed job re-introduces exactly the second timer that was deleted, plus queue latency.
- `04b` **D3-05**: *"the celebration renders between T+4 900 ms and T+5 100 ms, exactly once."* A pg-boss job in a folded process competing with `heavy` jobs cannot hold ±100 ms, and a delayed job that is late fires the confetti after the seller has moved on.
- `US-9.8` / `04b` §1.3: *"once per opportunity, forever"* via `opportunity.celebrated_at`, and *"Tab closed inside the window → the celebration is **not** replayed on next login."* At-least-once delivery with no named idempotency key contradicts both; a broadcast job also has no way to know the tab is gone.
- `04b` §1.3 sequence: the client owns the timer, the API only sets `celebrated_at`. The architecture inverted the ownership.

**A4 · `pipeline.stage_config_changed` is silently absent from the ledger's consumer set.**
`02b` §4 declares, for that event, the consumer *"Earnings & Leaderboard (**RECOMPUTES** when a closed_won flag toggles — every opportunity in that stage just gained or lost money)"*, and `02b` §8's resolution by Jorge says that event *"becomes more load-bearing than originally assumed."* `03-mvp-definition.md` item **61** lists *"**recompute on stage-flag change**"* as a shipped correction path.
The architecture's `earnings.ledger` inline row lists four events — `opportunity.won`, `opportunity.value_changed`, `opportunity.reopened`, `contact.merged` — and states elsewhere *"all **five** ledger inputs append rather than mutate."* Four listed, five asserted, and the fifth is never named. Because fan-out is computed by `INSERT … SELECT` against `ref.event_consumer`, an unregistered consumer is not a bug the model might fix later — it is **mechanically guaranteed never to run**. See C2: the requirement itself is wrong, but the architecture strikes it in silence, which Puerta 12 forbids.

**A5 · The dial is executed post-commit by the outbox relay. That breaks degraded mode and its own cited requirement.**
Architecture §3.1 sequence: `W-->>S: 200 {call_id}` … `OB->>A: POST two-legged-call (post-commit, outside the transaction)` — the outbox relay is a `worker`-role unit.
Against:
- The architecture's own §1.1: *"it makes the 5–15 second two-legged silence a **UI state problem, not a latency problem** (ARR-INT-03). It must never be modelled as an async job the seller waits on."* The sequence diagram models it as exactly that.
- `04-ux-flows.md` Flow 5 **D1/D2**: on a `503`, *"the banner shows `Calling Alan…` for up to 10 s, then flips red"*, the circuit breaker opens, buttons relabel to **Call from my phone**, a `tel:` link and a pre-filled **Log a call** sheet appear. With the dial in another process behind a queue, the request cannot observe the 5xx, the browser already has its `200`, and no channel is specified to flip the banner. The circuit breaker would live in the worker while the banner and the button labels live in the web process, with no named shared state.
- `04b` §3.4: `POST /calls` is measured **"(gate + dial)"** at p95 < 300 ms. Moving the dial out of the request silently redefines an approved measured endpoint.

**A6 · `moved_via` has seven values in the architecture and four in the catalog.**
`02b` §4 `opportunity.stage_changed`: `moved_via (kanban_drag | command_palette | mobile | automation)`. The architecture's L2 required coverage says *"a move via each of the **seven** `moved_via` values takes the identical server path."* Payload enums are part of the canonical contract, and the generator is specified to raise on payload/envelope drift. (The catalog is the one at fault here — see C-list — but the architecture must publish the amendment, not invent the enum.)

**A7 · `opportunity.stage_changed` is missing from the win transaction.**
The architecture's canonical picture of the drag-into-earning transaction emits only `app.event_emit — opportunity.won`. `02b` §4 requires `opportunity.stage_changed` on **every** card move including into closed stages, and names consumers that exist nowhere else: *"Communications (auto-pauses sequences when entering a closed stage)"*, Activities, Contacts timeline, Notifications, Reporting funnel/velocity. `US-LCP-12` Notes are explicit: *"Emits `opportunity.stage_changed`; downstream `opportunity.won` / `opportunity.lost` are emitted only by the gates."* Two events, in that order, in one transaction. The architecture's flagship diagram shows one.

**A8 · `contact.became_client` is described as scheduling a cross-sell. That automation is V1.1.**
Architecture: *"`contact.became_client` … schedules a cross-sell 45 days out."* `04-ux-flows.md` master flow step 27: *"(The cross-sell automation this event feeds is V1.1 — **the event is emitted, nothing consumes it in MVP**.)"* And `03-mvp-definition.md` §4 DEFECT CHECK: *"no cadence engine."* The consumer must be registered as emitting the event and **doing nothing else**, or the MVP grows an automation module.

**A9 · The capacity model budgets a wall board that was cut.**
§9.1.1: `+ 1 wall board × 86,400/5 = 17,280 req/day (24 h)`. `03-mvp-stories.md` §0 cut list: *"kiosk/TV route, TV takeover"*. `02b` §4 still names *"Kiosk/TV full-screen view"* as a consumer of `leaderboard.rank_changed` and `celebration.triggered` — that catalog text is older than the cut. Either the wall board is back (and then it needs a credential story the architecture does not have: `ARR-PRV-06` killed the kiosk token, better-auth sessions expire, and with email out of MVP there is no self-service recovery for an unattended display), or the line comes out of the load model.

---

# (B) APPROVED REQUIREMENTS THE ARCHITECTURE DOES NOT COVER

**B1 · Admin void / adjust-with-reason has no implementation surface.** `03-mvp-definition.md` item 61 (*"admin void/adjust-with-reason"*), `US-9.13` (typed reason from a fixed list, offsetting `entry_type = manual_adjustment` row, original never deleted, reason text visible to the seller in My Earnings, *"the only sanctioned way to change a number that is already public"*), and `04b` C-12 lists **`admin void`** as a ratified modal. The architecture's command surface is `/move`, `/win`, `/reverse`; `crm_app` has *no DML at all* on money tables; there is no `app.ledger_adjust()` definer, no `entry_type` beyond sale/reversal/value_correction, no reason capture, no MFA-scoped endpoint. As specified today this requirement is not merely missing — it is **unimplementable without a schema and privilege change**.

**B2 · D-4 (one credit per opportunity) has no mechanism.** `03-mvp-stories.md` §0 D-4: *"`opportunity.earnings_credited` is a boolean; earning→earning moves do not double-credit; reversal clears it; re-entry re-credits with a fresh `source_event_id`"*, tested by `US-9.2` (*"a card already credited is moved from one earning stage to another → no second row"*) and normatively by **R1.6** (*"One credit per opportunity; the second is a no-op"*). The architecture's entire exactly-once story is `UNIQUE (tenant_id, source_event_id)`, which by construction **permits** a second credit from a second, genuinely distinct event — which is exactly the earning→earning move and exactly the R1.6 wrap-up-`Sold`-plus-drag double path. The guard has to be a state column with a CHECK/partial-unique, not an event key.

**B3 · The 5-second exclusion breaks the ETag machine.** R1.3 requires a row to become publicly visible at T+5 s **with no writer at T+5 s**. The architecture's leaderboard read is a projection with *"a sequence-derived ETag"* and the poll is `If-None-Match`. Time passing does not bump a sequence. Result: the client holds the T+0 ETag, receives `304` on every tick, and the win never appears until some unrelated seller writes. That silently converts R6's board re-rank budget into "eventually", and it is invisible — every screen looks healthy. Any fix (time-bucketed ETag, a `pgboss` release job at T+5 s that bumps the watermark, a compound watermark including a wall-clock bucket) is a design decision that must be made in Phase 5, not discovered.

**B4 · The leaderboard cannot be built from ledger appends alone.** `US-9.5`: *"**every active seller** in the tenant is listed… a seller with `$0` is shown at the bottom, never hidden"*; Part III protected item 9: *"fifty names, fifty `$0`"* on go-live day; `US-9.12`: a deactivated seller *"disappears from the Today/Week/Month boards, and on the All-time board they remain with an **Inactive** chip"*; `US-9.6`: supervisors get no self-row but a tenant total. A projection upserted only on ledger append contains rows only for sellers who have sold. The read is a join against `app_user` with an activity predicate and a period predicate — and that join's cache key must also bump when a user is created, renamed or deactivated. None of this is in the projection or watermark design.

**B5 · The 49-name coverage gate is unsatisfiable as written.** The architecture: *"CI asserts that all 49 names appear at least once in `event_log`"* at the end of the integration suite. But several canonical names have **no MVP emitter by approved scope decision**: `sequence.enrolled`, `sequence.paused`, `sequence.completed`, `automation.executed` (no cadence engine — `03-mvp-definition.md` §4 DEFECT CHECK; the architecture itself registers `sequence_enroll` as `probe_only` and says *"nothing ships that enrols"*); `calendar.sync_failed` (two-way Google Calendar sync is V1.1, §6); plausibly `call.enriched` (recording disabled per D9) and `lead.import_completed` (CSV import moved to a builder-run runbook). The gate is a good idea aimed at the right defect class (the 66 ghosts), but it will be red on day one, and the predictable response is that somebody deletes it. It needs an explicit, versioned `no_mvp_emitter` column in `ref.event_schema` — which then becomes the enforceable list of what V1.1 must light up.

**B6 · Most of R6 has no build-breaking gate.** R6 says *"These fail the build, not a dashboard"* and `04b` §3.2 turns it into P1–P19 with warn/fail thresholds, fixed profiles (`desktop-ci`, `mobile-ci`, `dnd-ci`), versioned fixtures (`perf-500`, `perf-floor`, `perf-myday`), a single `perf-budgets.json`, and the no-silent-weakening PR rule. The testing section carries **P12/P13** (size-limit), **P17/P18** (axe, contrast) and moves **P7** to Axiom in production. Unmapped to any gate: **P1/P2** (LCP 1.5 s / 2.5 s with 500 leads), **P3** (CLS), **P4** (TBT), **P5** (the twelve <100 ms interactions), **P6** (drag 60 fps, p95 frame ≤ 16.7 ms, no long task > 50 ms), **P8/P9** (search), **P14** (win gate), **P15** (dial gate), **P16** (heap growth over 10 min of polling), **P19** (keyboard call loop). Also unmapped: `04b` regression assertions **R2-1…R2-6** (including R2-6: any reference to a `rot_threshold` fails the build — the mechanical form of **R1.7**). `perf-budgets.json` and the single-file-PR rule are themselves approved mechanisms with no home in the CI design.

**B7 · Both R7 items were carried to Phase 5 and neither is answered.**
(a) *"The compliance gate's timezone-resolution failure path needs a data source decision (zip→tz table vs area code) in Phase 5."* This is MVP item 10, and `US-603` makes the failure path a **fail-closed hard block** with published copy (`We can't confirm this lead's time zone. Add their state to continue.`) and the reason break-glass exists at all (Flow 5 §E1). No table, no vendor, no refresh policy, no fallback ordering, no gate.
(b) *"Exact fixed card height vs. anatomy density — re-validate against a real 500-card render during the spike."* Not in the Sprint-0 gate ladder (Gate 0-hour/1/2/3/7 are all backend).

**B8 · R3.5 has no mechanism.** *"Never render another seller's identity in a seller-facing timeline. After an ownership repair, prior activity reads `Handled before this record moved to you`."* The timeline is a derived projection the architecture never lets anyone write directly — good — but nothing in the projection or in RLS strips `actor_user_id → display_name` for rows authored by a previous owner. This is a silo leak that renders as a name on screen, and the row is legitimately visible, so the not-found machinery does not catch it.

**B9 · STOP has no priority lane through the ingest bulkhead.** `02b` §4 `message.received`: *"This event **must reach Automations before the next sequence step is due**"*, and the consent authority ruling forbids honouring a STOP on one channel and not another. The architecture's ingest edge is deliberately parse-free (*"No parse. No merge. No domain read"*), so `intent_hint='stop'` is unknowable until the worker's merge job runs. During the Gate-2 scenario the architecture itself sizes — 20,000 queued deliveries draining at 333/s — a STOP sits behind the backlog while the pg-boss T-1h reminder fires and the gate reads a `suppression_list` that does not yet contain the row. `singletonKey` serializes; it does not prioritize. This needs a declared priority class on `message.received` merges, or a cheap STOP sniff at the edge, and either way it needs a named mechanism.

**B10 · Break-glass expiry, and the two override events.** `US-9.13` and R3.3: admin-only, reason required, **auto-expires after 60 minutes**, banner for every signed-in user, expiry *"with no further action"*. The architecture has the table and `CHECK (scope = 'timezone_and_window')` — good, that is R3.3's "STOP and DNC are still enforced" made structural — but not the expiry mechanism. If expiry is a job, a missed job leaves the door open silently; if it is a read-side `now() < expires_at` predicate inside `app.compliance_check`, say so, because that is the version that cannot fail. `compliance.override_started` / `compliance.override_ended` (02b §4b) are never mentioned as emitters, while Flow 5 E2/E4 emits `admin.setting_changed` — pick one and register it.

**B11 · Degraded mode has no state.** MVP item 42 (*"Visible call-state UI + degraded mode — banner, `tel:` fallback, manual log when the API is down"*) and Flow 5 D2/D5: a tenant-level degraded flag, a 30-second health probe **only while degraded** (`04b` §1.10 channel 4, `GET /api/integrations/aloware/health` — one of the four channels carrying the polling floor in the architecture's own arithmetic), circuit open/close on *two* consecutive 200s, a recovery line, and button relabeling. There is no table, no owner role and no cross-process propagation for that flag, and in split topology the breaker trips in the worker while the banner renders from the web.

**B12 · Quiet hours.** `US-9.11`: inside the seller's quiet window (default 8pm–8am **in their display timezone**) the notification is *"stored and badged but no desktop popup is raised; nothing is dropped."* A third timezone rule (D-5 names three: tenant business, user display, lead-local) with no home in the notification consumer.

**B13 · `contact.owner_changed` needs a negative declaration.** `US-9.12`: *"any Earnings already credited stay with the ORIGINAL seller — money does not move with the record."* `contact.merged` **does** move money (two-row pair, correctly designed). These two events are one keystroke apart in the registry and one of them is a public-money mutation. `ref.event_consumer` can only express what a consumer *is*; there is no way to express "this event must never reach the ledger". A CI assertion on the exact ledger-input set (the same shape as the inline-count literal) is the cheapest fix.

**B14 · The demo tenant is an approved artifact with mechanical requirements and no owner.** R4.1 (12–15 sellers), R4.2 (a lead outside the calling window **at any hour a demo may run** — a seeding-time computation, not a fixed timestamp), R4.3 (silo-proof URL baked into the runbook), R4.5 (separate tenant, idempotent, visibly marked, **refuses to run in a live account**), `US-9.14` (idempotent across re-runs; env-gated). "Refuses to run in production" and "idempotent" are exactly the class of guarantee this project says must be mechanical.

**B15 · Edit deal value.** `US-9.3` requires an `Edit deal value` command with a required reason producing a `value_correction` delta, reachable from the opportunity header **and** from the My Earnings row, and `04b` C-06 ratifies the component. The architecture forbids a generic `PATCH` and revokes `UPDATE` on transition columns — correct — but never names the command, and never says whether `premium_annual_cents` is writable by `crm_app` at all. If it is, the win gate's CHECK is not the only door to money; if it is not, this story needs a definer.

---

# (C) PLACES WHERE THE ARCHITECTURE IS RIGHT AND THE APPROVED DOCUMENT IS WRONG

These must be published as explicit corrections in the Phase 5 documents. Silence here is how a builder ships the older text.

**C1 · `04b` §1.3 + Q2 (the accepted leaderboard flicker) is dead.** R1.3 overrides it: the flicker is *not* accepted, the projection excludes rows younger than 5 s. `04b`'s open question Q2 (*"Confirm the flicker is preferred"*) is answered by Part I and should be struck, along with the line *"Known, accepted consequence: another seller's board can show +$3,000 on one 5 s poll and the reversal on the next."*

**C2 · "Recompute" is struck everywhere. It contradicts a forward-only ledger with no recompute job.** Wrong text: `02b` §4 (`pipeline.stage_config_changed` → *"RECOMPUTES when a closed_won flag toggles"*; `contact.merged` → *"recompute ONLY if a closed-won opportunity changed owner"*), `02b` §8 item 1 (*"a flag change **recomputes** rather than silently re-writes history"*), `03-mvp-definition.md` item 61 (*"recompute on stage-flag change"*). Right text, and it is the newer and more specific: `03-mvp-stories.md` §0 **D-2** (*"The ledger is immutable and forward-only… **No recompute job exists.** Corrections happen through the admin void/adjust surface (US-9.13), never through config"*), **D-3**, and `US-9.4`'s testable form (*"no recompute job is enqueued (**verify: job queue is empty after the change**)"*). Publish: (i) stage-flag changes are non-retroactive and write **zero** ledger rows; (ii) `contact.merged` corrections are **compensating append pairs**, not recomputation; (iii) `02b` §8 item 1's real requirement survives as a **column** — each ledger row carries the stage-config identity and the stage-name snapshot that produced it — which the architecture already has in its L2 coverage ("both name snapshots are populated") and should state as the replacement.

**C3 · R6's "Board re-rank < 5 s" is arithmetically impossible and Part I already contradicts itself.** R1.3 holds a row invisible for 5 s; `04b` §1.10 polls every 5 s with ±500 ms jitter and skip-if-in-flight. Floor is 5 s + up to 5 s + jitter. **R4.4 in the same Part I says the demo presenter must narrate "the ~10 seconds between the win and the second screen re-ranking."** Publish one number in the single Phase 5 budget table — the honest one is ≈10 s worst case, ~11 s p95 — and mark R6's `< 5 s` row as superseded by R1.3+R4.4, not "moved for convenience". (Same table must carry the ARR's other two corrections: the mutually unsatisfiable bundle/TTI pair, and the sub-2 s leaderboard promise.)

**C4 · Roughly twenty event names used in `03-mvp-stories.md` Notes do not exist in the 49.** The architecture's generated `EventName` union is right and will reject all of them at typecheck; the stories are stale and a builder reading only the stories ships ghosts. Publish the remap table: `earnings.credited` / `earnings.reversed` / `earnings.adjusted` → `earnings.updated` (already rejected in `02b` §4b as redundant); `deal_value.corrected` → `opportunity.value_changed`; `stage_config.changed` → `pipeline.stage_config_changed`; `notification.dispatched` → rejected, no consumer; `book.viewed` → **audit row, not an event** (§4b rejection — the architecture states this correctly and should keep the sentence); `call.suppressed` / `message.suppressed` → `compliance.send_blocked`; `call.logged` / `call.outcome_recorded` → `call.completed` + `activity.completed`; `audit.compliance_override` → `compliance.override_started/ended`; `call.missed` → `call.completed` filtered `direction=inbound, disposition_canonical=missed`; `sms.inbound` → `message.received`; `meeting.starting_soon` → `appointment.starting_soon`; `aloware_map.verified` → `integration.mapping_verified`; `ownership.transferred` → `contact.owner_changed`; `user.created` / `user.role_changed` / `notification.permission_granted` → **audit rows, no canonical event exists and none should be added.**

**C5 · `US-9.2`'s "consumes `opportunity.stage_changed`" is wrong.** `02b` §4 is explicit: *"Earnings deliberately does NOT consume this — it consumes `opportunity.won` only."* The architecture is right. Worth publishing because the wrong version is the one that double-credits.

**C6 · `04-ux-flows.md` Flow 5 D1 ("`call.initiated` is emitted only on a 2xx") is already superseded** by `02b` §4b correction 1. The architecture declares this — keep the declaration; it is the model case for how the other corrections should read.

**C7 · The master flow's own step table contradicts R1.1.** Step 10: *"The speed-to-lead clock stops **on dial initiation**, not on answer."* R1.1 and `02b` §4b correction 2 say `call.completed` with connected/voicemail. Part I wins; the Part II step table (and the narrative's `First touch in 21s` at 12:07:19, which is in fact the connect moment) needs the correction stamped on it. The architecture's ruling — the merge job is the writer, only on canonical `connected`/`voicemail` — is right.

**C8 · `US-9.7` ("the selection is… restored per user across sessions") contradicts R5.3** (*"persists to the URL for sharing, **never across sessions**. All-time is the default on every fresh load"*). R5.3 wins; the story AC must be rewritten, and the architecture must not ship a `user_preference` row for it.

**C9 · `US-9.14`'s demo seed of "3 sellers" contradicts R4.1 (12–15).** R4.1's reasoning is decisive (*"with three rows there is no podium, no top-10 and no self-row with neighbours"*). Same story's fixture counts (~40 contacts, ~15 credited) need scaling with it.

**C10 · `US-604`'s "valid signature" acceptance criterion is not knowable yet.** `ARR-INT-02` and the architecture are right: Aloware webhook signing, retry and ordering are **unverified**, and the design assumes at-least-once, out-of-order, possibly unsigned. Rewrite the AC as capability-gated (`ref.provider_capability`) with the path-secret + rate-metered token as the floor, rather than leaving a build-blocking AC that may have no counterpart.

**C11 · `04b` contradicts itself on card height.** §3.6 P6 forced choice says *"Fixed card height — **108 px** desktop / 92 px mobile"*; §1 line 137 rules **120 px desktop / 156 px mobile** and shows the row budget proving 108 cannot hold the mandated anatomy plus the R3.6 chip. The supersession note makes Parts 1–2 authoritative: **120/156**. Publish it, because 108 is the number sitting in the performance section a builder will read.

**C12 · MVP item 30's "server rollback" is incoherent under the ratified Class-O design.** `04b` §1.1/C2: an `open→open` move is *held entirely client-side for 5 000 ms* and D3-01 asserts **zero** network requests when undone — there is nothing on the server to roll back. `US-LCP-12` also carries both readings in one story (AC 1 says optimistic + rollback, AC 4 says *"committed server-side first… renders only after the 200"*). 04b C2 is the resolution and the architecture follows it correctly; the item-30 and US-LCP-12 wording must be corrected rather than left for the builder to reconcile.

**C13 · `moved_via`'s four catalog values cannot express what R1.5 requires validating.** R1.5 names five paths that must all be server-validated — *drag, move-sheet, keyboard, wrap-up "Sold", raw API* — plus `automation` for the human-only refusal test, plus `command_palette`. The catalog's enum mixes a device (`mobile`) with mechanisms and cannot distinguish move-sheet from keyboard from wrap-up. The architecture's seven-value enum is the right shape (see A6); publish it as an amendment to `02b` §4 with the mapping, so it stops being an invented value.

---

**One methodological note for the parent.** Three of the four A-findings above (A1, A2, A3) share a root cause worth naming in the Phase 5 document: the architecture was written against the ARR register, and the register's UX entries (`ARR-UX-09`, `ARR-UX-10`) faithfully carry `04b`'s *mechanics* while dropping Part I's *rulings*, which are the layer that overrides them. Anywhere the architecture cites an `ARR-UX-*` id, R1–R7 should be checked as the senior source.

---

## §1.2 — Adversarial review against the 127-requirement register

# ADVERSARIAL REVIEW — Phase 5B architecture sections vs. ARR (127 requirements)

**Verdict up front.** The design is strong where the database is the enforcer and weak — sometimes catastrophically — wherever the enforcer is a file that "a PR must touch and nothing else." There is no PR. There is no reviewer. Roughly a third of the declared mechanisms in these sections reduce, under vibecoding, to "Claude edits the literal and the build goes green." Below: 14 ARR breaches, 11 inter-section contradictions, the mechanisms that can be walked around, the honest cost of folding, and two scenarios where CI is green, the screen is correct, and the money is permanently wrong.

---

## 1. ARR non-negotiables this design does NOT satisfy, or satisfies halfway

### 1.1 `ARR-UX-11` — live call state has no channel. **UNSATISFIED.**
ARR-UX-11 is non-negotiable and says explicitly: *"Phase 5 must either add a dedicated high-frequency call-state channel (e.g. GET /calls/:id at 1–2 s) or invoke R7's explicit permission to revisit the transport… Whichever is chosen must be declared as a change."*

The API section publishes the channel inventory (§2.1 family table, §2.3 "the fourteen measured endpoints… plus the four delta/health channels") and **no call-state channel appears in either list.** `/sse/me` exists in the route table but nothing anywhere says the call-state machine rides it, nothing budgets its latency, and nothing declares the change. Meanwhile the Aloware section's own sequence diagram requires `call.completed` to reach the browser to open the wrap-up sheet, and 04b §5 requires banner transitions at 12 s and 20 s with sub-second fidelity. **The single most compliance-sensitive UI surface in the product has no specified delivery path.**

### 1.2 `ARR-MVP-11` + `R7` — SSE is used but never declared, and the polling floor was never reconciled with it. **UNSATISFIED.**
ARR-MVP-11 states SSE was explicitly cut and *"Rules out a persistent-connection transport for the MVP unless Phase 5 explicitly declares the change."* The design ships `/sse/tenant` and `/sse/me` as a first-class family and simultaneously (§9.1.1) sizes the entire system against a **690,000 req/day polling floor as if SSE did not exist.** Both cannot be the transport. There is no arbitration rule anywhere: does the PollScheduler stop the two 5 s channels when SSE is connected? If yes, the §9.1.1 arithmetic, the return-herd analysis and the 304-share alarm are all measuring a fallback path; if no, every leaderboard change is delivered twice and the "transport-in-use" metric (signed non-negotiable 6) is meaningless because both transports are always in use.

### 1.3 `ARR-EVT-24` / Puerta 12 — the realtime budget is never restated. **UNSATISFIED.**
Puerta 12 requires ARR-EVT-24 (`p95 < 2 s` drop-to-every-client) to be **reformulated per channel**, because ARR-MVP-10's undo window makes < 2 s impossible for the leaderboard. Neither the API, Scale nor Testing section restates it. L4 asserts "Axiom p95 over the 14 real endpoints" — endpoint latency, not drop-to-client latency. The one budget that no transport can meet is the one budget nobody wrote down.

### 1.4 `ARR-MVP-27` / `ARR-CMP-08` — the SMS-dark second pass is missing from CI. **UNSATISFIED.**
ARR-MVP-27, non-negotiable: *"The full acceptance suite must pass a second time with `sms_enabled=false` with no path erroring."* The Testing section declares exactly one matrix axis — `TOPOLOGY=folded|split` — and no `sms_enabled` axis. Given `ARR-CMP-09` (10DLC is in flight, launch is SMS-dark), **the configuration the product will actually launch in is the one configuration never tested end to end.**

### 1.5 `ARR-UX-16` — WCAG gate is absent from the failure-class map. **UNSATISFIED / MISPLACED.**
ARR-UX-16 is non-negotiable and gate-blocking: axe-core, zero serious/critical, **ten screens × four states**. §2's failure-class map (L0–L4) contains contrast matrix and pseudo-locale at L0 and "D3-01..D3-17" at L3, and nothing else. The doctrine sentence — *"If a level has no failure class of its own, it is theatre and is not built"* — cuts the other way here: a required build-breaking gate that appears in no level does not exist.

### 1.6 `ARR-PRV-05` — exports are named as catastrophe #3 and then not closed. **HALF.**
The Security section ranks insider exfiltration third and its only mechanisms are "private R2 objects, short-expiry presigned URLs, unauthenticated canary GET returns 403." ARR-PRV-05 requires: `masking_applied` driven by a **machine-readable PII field classification** (not hand-maintained), a written reason above a threshold, and **anomaly alerting on mass export / off-hours bulk activity**. None of the three has a mechanism. A departing seller exporting their whole book is legitimate use of an owner-scoped endpoint; nothing here notices.

### 1.7 `ARR-EVT-03` — global `event_id` uniqueness is a convention. **HALF.**
ARR-EVT-03 is non-negotiable ("UNIQUE across the whole event store"). The data model concedes it is enforced *per partition* and globally only "by generation." The Event section then builds the four build-time doors for event *names* and says nothing about ids. Fine as an engineering trade — but it is currently an unstated downgrade of a non-negotiable, and the compensating control ARR-EVT-03 names (a per-consumer `(consumer_name, event_id)` processed-events record) was replaced by outbox rows that are **dropped at 14 days**.

### 1.8 `ARR-MVP-20` — "exactly-once for DB-only handlers" is asserted, not mechanised. **HALF.**
The delivery-class table claims exactly-once for DB-only outbox handlers. That is true only if the handler's own write and the `event_outbox` status flip commit in one transaction. Nowhere is that stated as a requirement of the relay, and one declared consumer (`celebration-broadcast` enqueue → pg-boss) is **not** DB-only in the relevant sense unless the pg-boss `send` runs on the same connection inside the same transaction. pg-boss's default idiom does not. Result: a relay crash between handler-commit and status-flip re-runs the consumer → a second `celebration.triggered` enqueue. ARR-MVP-20 names that exact outcome as forbidden ("no second celebration"). The only surviving net is `opportunity.celebrated_at`, which is a *client*-armed flag for the local toast, not the server broadcast.

### 1.9 `ARR-MVP-18` — the 5-second `lead.created` SLA has no queue priority. **HALF.**
Intake enqueues a job; webhook merges enqueue jobs; job classification is `weight ∈ {light, heavy}` (a CPU axis) with **no latency-criticality axis**. A 20,000-message provider replay (§9.2.3) puts 20,000 jobs into the same worker ahead of the ping-post lead that ARR-MVP-18 requires to emit `lead.created` within 5 seconds — the number that speed-to-lead, and therefore the entire lead spend, is measured against.

### 1.10 `ARR-EVT-13` — the STOP chain inherits the same backlog. **UNSATISFIED, and this one is legal.**
`ARR-EVT-13` non-negotiable: *"Loss **or delay** of that hop is a legal failure, not a UX degradation"* and the hop must complete "before the next sequence step is due." `message.received` is materialised by the merge job on the worker. The bulkhead isolates ingest CPU from web CPU; **it does nothing for the worker queue.** During the recovery storm the STOP is job number 14,000 in a FIFO drain. §9.2.3 lists the storm's victims as "the board" and concludes the bulkhead protects it. The actual victim is TCPA.

### 1.11 `ARR-INT-03` / `ARR-MVP-26` / `ARR-INT-09` — the dial was moved off the request path. **CONTRADICTS THE ARR.**
The Aloware §3.1 diagram dispatches the outbound two-legged POST from the **outbox relay, post-commit, on the worker**. ARR-INT-03 says the dial endpoint "must return synchronously within [the 10-second] budget or fail into degraded mode," and ARR-MVP-26 requires an explicit 10-second client-visible timeout that opens the pre-filled Log-a-call form. With the POST behind an outbox relay on another process, the seller's 200 has already been returned; an Aloware 5xx or timeout is now discovered by a worker with no channel back to the browser (see 1.1). ARR-INT-09's breaker — which must open on 3 consecutive 5xx/timeouts inside 60 s and reach every signed-in browser — now observes failures in a process that renders nothing, and the breaker's shared-state store is never specified.

**And the relay's dispatch latency is never budgeted anywhere**, despite three deadlines depending on it: the dial (5–15 s two-legged window plus a 12 s escalation), the Aloware disenroll of `ARR-EVT-14`, and the celebration broadcast.

### 1.12 `ARR-EVT-11` — a refusal by CHECK constraint emits nothing. **STRUCTURALLY UNSATISFIED.**
ARR-EVT-11 requires `opportunity.gate_blocked` on every refusal, and *"Refusal is the absence of a state change, never a rolled-back one."* The design's headline mechanism is that both gates are `CHECK` constraints ("CHECK constraint, not an if-statement"). A CHECK violation **aborts the transaction**, taking with it any `app.event_emit` / `app.audit_write` / `admin_alert` written before it. So the durable refusal record and the counter that ARR-EVT-11 calls *"the only way to prove the guard fires rather than being bypassed"* can only come from a **service-layer pre-check that duplicates the gate logic** — which is precisely the second implementation ARR-MVP-09 and ARR-UX-03 forbid. Two copies of the gate now exist; the L2 test asserts only the SQLSTATE 23514 path, so **divergence between the pre-check and the constraint is untested in the direction that matters**: pre-check more permissive → the seller gets a 500 and the copy "Couldn't record this sale" on a legitimate win; pre-check less permissive → a 422 the database would have accepted, and no `gate_blocked` telemetry either way.

### 1.13 `ARR-EVT-23` — the tenant-wide channel payload has no type-level guard. **HALF.**
ARR-EVT-23 requires *"a tenant-wide channel whose payload type literally cannot express lead data."* The design gives two physical URLs (`/sse/tenant`, `/sse/me`) and stops. No generated union type, no registry row, no test, and — critically — **`/sse/**` is not under `routes/api/**`, so it is invisible to all five registry-driven suites** (§1.4). The one broadcast that crosses the silo by design is the one surface with no automated silo assertion.

### 1.14 `ARR-MVP-23(d)` / signed non-negotiable 4 — the money-type CI test is missing. **HALF.**
Non-negotiable 4 requires four layers; the Testing section ships two (branded `Money` + the coercion lint) and drops (d): *"a CI test that FAILS if any monetary field is typed as a plain number in TypeScript."* The lint that remains keys on `Money`-typed values **or a `*_cents` field name** — so a new column named `premium_annual` typed `number` passes tsc, passes the lint, and passes every test.

---

## 2. Contradictions BETWEEN sections

**C1 — Two names for the one variable the owner's requirement rests on.**
API §2.1: `PROCESS_ROLES` (`web,worker,ingest`). Aloware §2: `ROLES=web,worker,ingest`. The fold/split mechanism is a single environment variable and this design names it two different things in two sections. The failure mode of reading the wrong one is a process that mounts its default set — silently.

**C2 — Three incompatible spellings of the two URLs that can never change.**
- API §2.2: `/intake/v1/:source_token`, `/webhooks/aloware/v1` — and asserts *"The two externally-called surfaces **are** versioned."*
- Aloware §4.1: `https://in.<domain>/hooks/aloware/{endpoint_token}`, `https://in.<domain>/intake/{source_token}` — **no version segment**, and `/hooks/` not `/webhooks/`.
- Security D-SEC-1: `POST /webhooks/aloware/{path_secret}` — a third credential name.

These are the URLs handed to lead vendors and registered in Aloware; ARR-MVP-18 and ARR-INT-12 make them contractual. Worse, the Aloware section's CI grep gate keys on the **literal strings** `/hooks/` and `/intake/` — it will not fire on `/webhooks/`. The mechanism and the thing it guards are written in different sections in different dialects.

**C3 — The rate meter and the retry storm cancel each other.**
Aloware §4.1: webhook token resolution is *"identical to `intake_source`… resolved through a SECURITY DEFINER function that returns ids only and **increments its own rate meter**."* Data model: `rate_limit_per_minute` default 120. Scale §9.2.3: the ingest edge must absorb **333 req/s = 19,980/min** on recovery. Either the meter does not apply to the Aloware endpoint (then the design's own §9.2.3(b) verdict applies: a `429` we cannot prove is retried is *"a lost webhook wearing a status code"* — ARR-INT-07 violation), or it does and Gate 2 fails in the first second by design.

**C4 — §9.2.2 states the ETag failure mode backwards.**
Scale §9.2.2: *"If the watermark stops being bumped inside a writer transaction, every poll returns `200` instead of `304`."* That is inverted. A watermark that stops being bumped produces an ETag that stops changing, so every poll returns **`304` forever and the board silently freezes showing stale data** — which is exactly the failure the Event section names correctly when it justifies the inline watermark bump ("the seller's own poll answers 304 against their own write"). Consequence: the §9.5 alarm is built on the 304 *share dropping* (the benign, expensive direction). **The dangerous direction — 304 share pinned at 100 % while writes are happening — has no alarm anywhere.**

**C5 — Security claims five execution contexts are covered; the data model records the pg-boss one as an open ruling.**
Security A01 lists five contexts and asserts *"authorization is generated, not authored."* But the pg-boss handler sets its RLS context **from its own job payload**, and the data model's open questions state plainly: *"a job payload with a wrong tenant_id would be scoped to the wrong tenant… (a) sign payloads with HMAC, (b) re-derive tenant_id from subject_id via a definer function… needs a ruling because it changes every handler signature."* The Security section presents as closed what the data model records as open. Under a replay/DLQ-retry path an attacker-influenced or corrupted id in a payload is a cross-tenant write with RLS fully enabled and perfectly happy.

**C6 — The Testing section commits a number the signed thesis says is unsatisfiable.**
L0 hard-codes `size-limit` at **250 KB gzip / 60 KB CSS** as build-breaking, citing ARR-UX-08. Puerta 8 (signed) says the 250 KB and the 2.0 s TTI of ARR-MVP-25 are **mutually unsatisfiable**, that ~120–150 KB would be required, and that *"ESTA MEDICION, NO LA ASPIRACION, FIJA EL NUMERO QUE VA A CI."* The brief for this phase repeats it. Wiring 250 KB into CI before Gate 8 runs pre-decides the contradiction the phase exists to close, in favour of the number that cannot be met.

**C7 — "Every endpoint / every response" is scoped to `routes/api/**` only.**
§1.4's five suites iterate `route-registry.generated.ts`, built by *"scanning `routes/api/**`."* Outside that tree and therefore outside all five suites: the whitelisted UI loader (§1.2, the only route that serves **real board data as SSR HTML**), every `routes/ui/**` document response, `/sse/**`, `/auth/**`, `/intake/**`, `/webhooks/**`, `/healthz`, `/readyz`. So:
- the **cache** suite (signed non-negotiable 14 — the fatal-hazard graft) does not cover the one HTML response carrying a seller's board;
- the **silo** suite does not cover the SSR route reached by URL, which is precisely the path ARR-UX-04 names ("reached by URL, notification deep link or search");
- the **topology** suite's "no endpoint orphaned" claim excludes the ingest and SSE families it most needs to cover.

**C8 — "The entire unauthenticated attack surface is three POST routes" is false in the same document.**
The API family table lists `/healthz`, `/readyz` with auth `none`, mounted on **all** roles, and the Security diagram itself draws the worker's health route touching Postgres. Five routes, two of them GETs that execute a query. Minor as a vulnerability; corrosive as a claim, because the sentence is doing rhetorical work ("a large part of this product's security posture was bought in Phase 3 by cutting features").

**C9 — The 14 measured endpoints are 17, and one of them cannot be measured at launch.**
§2.3 names 14, then adds "plus the four delta/health channels" including `GET /api/leaderboard` a second time. `POST /api/messages` is in the k6 set while `ARR-CMP-08`/`ARR-CMP-09` guarantee the tenant launches SMS-dark, so that endpoint's p95 measures a typed refusal.

**C10 — Replay is "one job" for two disjoint mechanisms.**
Event §replay and ARR-EVT-21 require every projection rebuildable *as one job* from `event_log`, and the design implements it as "re-materialize outbox rows." But `leaderboard_projection` is maintained by an **inline** consumer, which by construction has no outbox row (the fan-out `WHERE` clause excludes `inline`), and the ledger itself is never replayed. The leaderboard rebuild is therefore a completely different code path (a SUM over `earnings_ledger`) that no section names, and it is the one projection ARR-EVT-21 calls out by name.

**C11 — `mfa` is mandated on `tenant_admin` endpoints while transactional email is out of MVP.**
`defineEndpoint` makes `mfa` non-optional for `scope: 'tenant_admin'` — a compile-time gate on a capability no ARR requirement asks for. The signed stack removed transactional email to V1.1 with the accepted consequence *"no hay reset de password autogestionado."* MFA with no email channel means no enrollment recovery: an admin who loses their TOTP device permanently loses **break-glass** (ARR-CMP-03), which is the compliance escape hatch that exists for the case where the calling-window resolver is wrong and 50 sellers cannot work. This is a new hard dependency that contradicts a signed cut.

---

## 3. Declared "mechanisms" that are conventions wearing a badge

**The systemic finding first.** This design uses the phrase *"a PR that touches that file and nothing else"* as an enforcement mechanism at least three times: the UI-loader whitelist (§1.2), the RLS exception list, and the `etag: 'none'` exception list. It also uses *"a CI test asserts `count(*) … equals a literal in the test file"* for the inline tier, and `perf-budgets.json` for the budgets. **Every one of these presumes a human reviewer reading a diff. The project's own first-order design constraint says there is none.** Under vibecoding the enforcement of all of them is: the model edits the literal, or adds the row, and the build turns green. The Testing section *knows* this — it is the entire justification for the fixture-immutability VCS gate ("the way that guarantee actually dies is not a missing test — it is somebody 'fixing' a v1 fixture so a new consumer goes green") — and then does not apply the insight to the five places that need it most. The inline-consumer count, the exception lists and `perf-budgets.json` need the same append-only-at-the-VCS-layer treatment, or they are documentation.

Specific bypasses:

1. **A table in `public` is invisible to every net.** `security.harden()` loops `pg_class` **in schemas `app` and `ref`**; the CI catalog gate checks "any relation in `app`." Drizzle's default schema is `public`. A model asked to add `saved_view` or `board_preference` will, by inertia, create it in `public` — where it gets no `FORCE`, no policies, no registry row, **no `harden()` raise, and no CI failure.** If any migration ever emits the standard `GRANT ALL ON ALL TABLES IN SCHEMA public TO crm_app`, that table is tenant-wide readable and writable. This is the exact "tabla nueva que nadie agregó a la lista" hole, and the keystone mechanism does not look there. Fix is one line: `harden()` must raise on any relation in **any** schema not on the versioned exception list, not only on unclassified relations inside two named schemas.

2. **The registry-driven silo suite cannot test the endpoints that leak most.** It works by "call as Seller B with a Seller A id." Six of the fourteen measured endpoints take **no record id**: `/api/board`, `/api/my-day`, `/api/search`, `/api/leaderboard`, `/api/notifications`, `/api/board/since`. For these there is nothing to substitute and no not-found shape to assert; their protection is entirely the RLS policy on the underlying tables. In particular **`GET /api/search` is structurally untestable by this harness**, while ARR-UX-04 (non-negotiable) requires that search "never return, count or hint at another seller's records." That needs a purpose-built two-seller fixture with colliding names, phones and emails and an assertion of zero rows — not a registry loop.

3. **The inline registry is decorative and the six rows it decorates are the money and consent rows.** §2.2 says it out loud: inline consumers *"are ordinary statements written into three command paths… Their registry rows exist to declare and lock the classification… not to drive execution."* So the design's proudest structural property — *"an emitter cannot forget a consumer,"* offered as the cure for the 66-ghost failure mode — **holds for every consumer except the six that touch money, consent and the compliance gate.** And there is no counter-net: the three "double-credit" nets all guard against crediting twice; nothing guards against crediting **zero** times. If `app.ledger_append` is dropped from the close-gate path in a refactor, the fan-out `WHERE delivery IN ('outbox','pgboss')` guarantees no outbox row is written either, so the sale is credited nowhere, by design.

4. **`defineEndpoint()` is not enforceable by the scanner as described.** "Every file under `routes/api/**` exports the result of one factory" is a convention; React Router will happily serve a hand-written `loader` in that tree, and the generator that "scans and reads each endpoint's declared metadata" has no stated behaviour for a module it cannot read. It must **fail the build on any module in `routes/api/**` whose default export lacks the factory's brand**, and the file-route table must fail on any module in `routes/ui/**` exporting `loader`/`action` outside the one-entry whitelist. Neither is stated.

5. **The `ReadTx` guarantee has a documented backdoor that is available to every GET.** The design says *"A `GET` that writes does not compile,"* then immediately carves out `book.viewed` by moving the write into the **scope resolver**, "in the same request frame, before the handler runs." That is not an exception in the type system — it is a general-purpose write channel attached to every GET, reachable by moving three lines up a layer. And its atomicity is unspecified: if the audit insert and the read are separate transactions, an audit failure yields an unaudited supervisor read (ARR-PRV-03) or a read that 500s after the audit row landed.

6. **The coverage gate is satisfiable without a production emitter.** "CI asserts all 49 names appear at least once in `event_log` at the end of the integration suite" is an assertion about **table contents**, not about reachable code. The natural green-the-build move is a test helper that emits the missing name. The gate needs to assert emission from a non-test module (e.g. the emitter's call site is reachable in the built bundle), or it measures nothing.

7. **`ref.provider_capability` can be talked into `verified`.** The `CHECK` requires `verified_at IS NOT NULL AND evidence_ref IS NOT NULL` — `evidence_ref` is free text. A migration seeding `status='verified', evidence_ref='spike'` satisfies the boot assertion for every `mvp_required` capability. The discriminated-union type is excellent; the state that unlocks it is writable by the same actor that wants it unlocked.

8. **`set-config-must-be-local` is scoped to "the SQL corpus"** — an undefined boundary in a codebase where SQL lives inside Drizzle template literals in `.ts` files. Undefined lint scope is how a lint gets bypassed without anyone deciding to bypass it.

9. **`security.harden()` protects `app` and `ref`; nothing re-applies GRANTs after a restore.** The monthly restore drill checks `FORCE`, roles, revoked GRANTs and triggers — good, and the best control in the document. But it is monthly and it runs in CI against a dump; a real restore performed by Jorge in an incident restores whatever the dump contains and boots. The boot assertion catches the *owner-identity* case only. A restored database that comes back with `FORCE` off but a non-owner `crm_app` boots clean and shows every seller the whole book. The boot assertion should also verify `relforcerowsecurity` on a canary set of relations, not only `current_user`.

---

## 4. The foldable topology: what actually breaks, and whether the cheap rung is honest

**It is honest at Escalón 1 only if two things stated as facts are re-labelled as assumptions.**

**4.1 The folded process violates its own interaction budgets by construction.** The Aloware section states that in a process whose roles include `web`, heavy jobs run "at concurrency 1 with a **200 ms cooperative batch budget**." A 200 ms batch on a single-threaded Node process is a 200 ms long task. The budgets in force are: interaction repaint ≤ 100 ms, no frame > 34 ms and **no long task > 50 ms during a drag (P6)**, and `304` p95 ≤ 80 ms. A 200 ms cooperative batch blows all four, deterministically, every time an export or an archive job runs while someone drags a card. Meanwhile the Testing section says *"CI runs the whole E2E suite in both topologies… the mechanical form of 'separating later needs no redesign' is that the un-separated build is tested on every merge."* It does not say the **performance** budgets run in both topologies — and they cannot, because folded cannot pass them. So either (a) perf runs split only, and the cheap rung is never measured where it breaks, or (b) perf runs folded and the nightly is permanently red. **This is the fold's central unresolved question and the document answers it by omission.**

**4.2 The safety case for folding rests on an assumption ARR-INT-02 forbids.** §9.2.3 concedes the bulkhead is what buys the isolated event loop, and the API section says the register *"accepts [losing it] at Escalón 1 (2–3 sellers, no storm)."* The storm's magnitude is not a function of our seller count — it is a function of **the provider's queued backlog and replay concurrency**, which ARR-INT-02 (non-negotiable) says is unverified and must be assumed to be the weakest case. A pilot with 3 sellers that suffers a provider outage can receive the same 333/s drain, into a single process that is also serving the SSR board, the SSE hub, the LISTEN connection and every job. "No storm at Escalón 1" is a provider assumption wearing a seller-count costume.

**4.3 The bulkhead is optional-by-default even after the split.** `INGEST_FALLBACK=on` (default) mounts the ingest routes on the web process in split mode. The stated compensating control is an `admin_alert` of kind `ingest_on_web`. An alert is not a mechanism, and this one fires in exactly the situation where nobody is reading alerts. A vendor that was ever given the app hostname keeps posting there forever, and the bulkhead the third service was bought for is bypassed for that source permanently — while §9.2.3 continues to compute the storm against a service the traffic no longer reaches.

**4.4 The highest-impact fold failure has no detector: a missing worker.** The topology test asserts "the union of `role` across the deployed process set covers every route" — a CI check over declared configuration. Nothing checks the **actually running** set. Set the worker's env var wrong, or forget the worker service on the split, and: the outbox never drains, the T-1h reminders never fire, celebrations never broadcast, the reconciliation backfill never runs, the retention purge never runs, the Aloware disenroll never happens (ARR-EVT-14, "a robot keeps texting a lead who already replied STOP") — **and the board, the leaderboard and every screen look perfect**, because the inline tier still commits the money and bumps the watermark. There is no named heartbeat, no outbox-depth alert, no scheduler-lag metric in these sections, despite `ARR-OPS-03` calling scheduler lag "a monitored first-class metric." The fold/split design *creates* this failure class and does not instrument it.

**4.5 Two other real losses on folding, unstated.** (i) The dedicated `LISTEN` connection shares an event loop with the ingest edge; a saturated loop delays heartbeats and the SSE clients time out while the process is technically healthy — the exact silent-transport failure that signed non-negotiable 5 exists to detect, now made *more* likely by the cheap rung. (ii) Connection arithmetic inverts: §9.2.1 sizes 3 × 8 = 24 sustained and lists "fold ingest back into web" as the last-resort answer to a low connection ceiling — but §9.2.1's own step 4 and the Escalón-1 fold are the same action described once as a defeat and once as the recommended launch posture, with no statement of what pool `max` the folded process uses.

---

## 5. The most dangerous scenarios — CI green, screen correct, money wrong or silo open

### SCENARIO A (the crown jewel): the undo-window correction is computed under the reader's own RLS scope, so the public board is wrong for everyone except the seller who made the sale — and the natural test proves it works.

The public leaderboard read is: `leaderboard_projection` (tenant-scoped, every seller reads every row) **minus** a correction CTE that scans `earnings_ledger` for rows younger than the undo window. The data model describes that CTE as returning *"zero to two rows for the entire tenant."*

But `earnings_ledger`'s policy is `append_only_owner`:
```
USING (tenant_id = app.current_tenant()
   AND (owner_user_id = app.current_user_id() OR app.scope_is_global()))
```
A seller's session is `scope_mode='owner'`. **The CTE therefore sees only that seller's own pending rows.** Consequences, all simultaneous:

- Seller A wins $3,000. A's board correctly hides it for 5 s. **Every other seller's board shows it instantly** — and if A undoes, it corrects itself in front of the whole office. That is the precise outcome `ARR-MVP-10` (non-negotiable) exists to prevent: *"so no viewer ever sees a number that later corrects itself."*
- The ETag is `hash(max(seq), pending_watermark)` where `pending_watermark` is the max `recorded_at` inside the window — also computed under the reader's scope. So **fifty sellers compute fifty different ETags for the same public resource**, and for every seller except the winner the watermark component is `0`, meaning the ETag does not change when the pending row ages out. That is the "silent freeze on the most expensive surface" the data model says the `pending_watermark` was invented to prevent — reintroduced by the policy, for 49 of 50 users.
- **The test a competent engineer writes is: win as Seller A, poll the leaderboard as Seller A, assert the pending entry is excluded. It passes.** The bug is only visible from a second session, which the harness has (DEMO-01 uses two contexts) but which no assertion in these sections points at the *pending-exclusion* property.

And the only two ways out are both bad, which is why this must be ruled explicitly rather than discovered:
1. Widen `earnings_ledger` RLS to tenant-wide read so the CTE works — which exposes `opportunity_id`, `contact_id`, `stage_name_snapshot`, `product_type`, `delta_cents` and `reason` for every seller's every sale, across the silo, inside a CTE that no screen renders and no silo test inspects. A cross-silo PII leak with no UI symptom.
2. Move the whole public read into a `SECURITY DEFINER` function that returns only `(user_id, display_name, total_cents, rank)` — the correct answer, and the one consistent with "you cannot leak a column the projection does not contain." **No section says this.** The design says "the board reads the projection."

**This is the single most valuable finding in the review.** It sits exactly in the seam between the isolation section and the leaderboard read path, it produces a wrong public money number, and every mechanism in the document passes.

### SCENARIO B: the premium edit that never reaches the ledger.

The design's proudest privilege fact is column-level: `REVOKE UPDATE (stage_id, current_stage_type, stage_entered_at) ON app.opportunity FROM crm_app` — so a generic `PATCH` that grows a `stage_id` key gets `permission denied` from the engine. **The same revoke is not applied to `premium_annual_cents`, `premium_monthly_cents` or `premium_mode`.**

So: a seller edits the premium on an already-closed-won opportunity. Claude writes the obvious Drizzle update. Every `CHECK` passes (`annual = monthly * 12`, range $1–$100,000, mode-present). The card shows the new number. The opportunity detail shows the new number. **No `opportunity.value_changed` is emitted and no ledger row is appended** — because nothing forces the emission; the inline registry row is declarative (§3.3) and the fan-out excludes inline consumers.

The public all-time board keeps the old number. Forever. There is **no recompute job by design** (ARR-MVP-07), and the ledger is the system of record that is never replayed. `ARR-EVT-07` names this exact link as *"the single most-forgotten link in the money chain,"* and the design mentions it in prose ("if Earnings only listens to `opportunity.won`, editing a premium after close silently corrupts a public all-time board") and then **protects the stage columns with a REVOKE while leaving the money columns writable by the app role.**

Symmetric fix, same mechanism, one migration: `REVOKE UPDATE (premium_monthly_cents, premium_annual_cents, premium_mode)` and route it through `app.opportunity_set_premium()`, a definer that appends the `value_correction` delta in the same transaction — plus an L2 test that a direct Drizzle premium update on a closed-won opportunity returns `permission denied`.

### SCENARIO C (leak, no id to attack): the implicitly-scoped list endpoint over an unclassified table.

Combine §3.1 (a table in `public` escapes `harden()` and the CI catalog gate) with §3.2 (list endpoints with no record id cannot be exercised by the registry silo suite). A feature adds `GET /api/board/columns` returning saved column preferences from a table Drizzle created in `public`, filtered by a hand-written `where userId = ctx.user.id`. RLS is off on that table; the where clause is correct today. A later refactor to support the supervisor global view lifts the predicate. The silo suite has no foreign id to pass and asserts nothing; `harden()` never saw the table; the catalog gate scopes to schema `app`; the boot assertion checks `contact`. Fifty sellers' board state — including saved filters that encode contact names — is tenant-wide readable, and the screen looks exactly the same.

### SCENARIO D (money credited but invisible, or the reverse): the pre-check / CHECK divergence of §1.12.

Because the durable gate is a `CHECK` and the 422 + `gate_blocked` + `admin_alert` must come from a pre-check that cannot live in the aborting transaction, the two implementations can drift by one condition — say the pre-check reads `stage.stage_type` by a join while the `CHECK` reads the denormalized `opportunity.current_stage_type`. During the window where they disagree, either every legitimate win returns a 500 with the copy "Couldn't record this sale — nothing was saved" (seller reads it as flakiness and stops reporting it — the exact dynamic signed non-negotiable 7 identifies), or refusals are returned with no `gate_blocked` row, so the counter that ARR-EVT-11 calls the only proof the guard fires reads zero and is interpreted as "no one is trying."

---

## 6. Minimal, mechanical changes that close the above

Ordered by damage prevented per unit of change. All of them are engine-level or build-level; none is a convention.

1. **Public leaderboard read becomes `app.leaderboard_read(period)` `SECURITY DEFINER`**, returning `(user_id, display_name, avatar_ref, total_cents, rank, etag)` and nothing else, computing both the pending correction and the ETag **tenant-wide inside the function**. Add an L2 test that wins as A and asserts B's read excludes the pending entry and that A's and B's ETags are byte-identical. Closes Scenario A and satisfies ARR-EVT-23's "cannot express lead data" for the SSE payload at the same time.
2. **`REVOKE UPDATE` on the three premium columns**, with `app.opportunity_set_premium()` appending the `value_correction` delta in-transaction. Closes Scenario B.
3. **`security.harden()` raises on any relation in any schema not on the versioned exception list**, not only on unclassified relations inside `app` and `ref`; and the pre-deploy job runs `REVOKE ALL ON SCHEMA public FROM crm_app`. Closes Scenario C.
4. **Give the gate a durable refusal path that is not a rolled-back transaction**: `app.stage_move()` opens a `SAVEPOINT`, attempts the write, and on `SQLSTATE 23514` rolls back to the savepoint and writes `gate_blocked` + audit + `admin_alert` in the surviving transaction. One gate, one implementation, refusal is durable, ARR-EVT-11 satisfied without a second copy of the rules.
5. **A latency-criticality axis on jobs** (`priority ∈ {compliance, interactive, bulk}`), `NOT NULL`, seeded from the same generated file, `harden()` raises on an unclassified row — exactly as `weight` already works. `message.received` materialisation and intake `lead.created` are `compliance`/`interactive`; webhook replay is `bulk`. Closes 1.9 and 1.10.
6. **Move the outbound dial back onto the request path**, or declare the call-state channel and the breaker store. As written, the dial contradicts ARR-INT-03, ARR-MVP-26 and ARR-INT-09 simultaneously.
7. **One name for the roles variable; one spelling for the two external URLs; publish both in a single table that the grep gate and the URL builder both consume.** Add a `worker_heartbeat` row written every 30 s and a build-breaking synthetic assertion that its age is under 2 minutes — the missing-worker detector the fold requires.
8. **Extend the registry to every served route**, not `routes/api/**`: the UI tree (so the SSR board response is covered by the `Cache-Control` suite and the not-found suite), `/sse/**`, `/intake/**`, `/webhooks/**`. Fail the build on any module in either tree that does not go through its factory.
9. **Add the `sms_enabled=false` matrix axis** (ARR-MVP-27) and recompute the CI minute budget with the topology axis included — the thesis already put the split matrix at ~1,800 of 2,000 minutes, and this design adds an axis without re-doing the arithmetic on a budget whose exhaustion silently disables every gate in the document.
10. **Make the append-only-at-VCS gate general**: `fixtures/events/**`, the inline-consumer count literal, `perf-budgets.json`, and all three exception lists. Anything whose enforcement sentence contains "a PR that touches that file and nothing else" needs a machine that refuses, because the reviewer that sentence assumes does not exist in this project.

---

# §2 — Mechanical reconciliation (engine-level closures)

## 7 · Mechanical reconciliation — the engine-level closures

This section supersedes any sentence in §§1–6 that it contradicts. It exists because the adversarial review established one systemic fact: **roughly a third of the declared mechanisms reduce, under vibecoding, to "the model edits the literal and the build goes green."** The phrase *"a PR that touches that file and nothing else"* appears at least three times as an enforcement mechanism and presupposes a reviewer this project does not have.

### 7.0 The rule every correction below satisfies

A correction is admissible here only if it is one of six things:

| Kind | Why it survives a model with a red build in front of it |
|---|---|
| A database constraint | Cannot be argued with; violation is `SQLSTATE`, not opinion |
| A revoked privilege | `permission denied` reaches the seller's screen the same minute |
| A trigger (incl. deferred constraint triggers) | Fires regardless of role, code path or ORM idiom |
| A type that does not compile | No build → no image → nothing to deploy |
| A build- or **deploy**-breaking assertion | A deploy that will not proceed cannot be amended by a later commit |
| A symptom on a seller's screen | Fifty people notice; a log line nobody reads is not a mechanism |

**Anything whose enforcement can be defeated by editing a literal is not a mechanism.** Where a literal is genuinely unavoidable, §7.6 moves the authority out of the working tree entirely.

Two derived doctrines used throughout:

1. **Prefer elimination over guarding.** A count literal in a test file becomes a table plus a `CHECK`; a whitelist file becomes a seeded relation the deploy validates.
2. **Prefer refusing to boot over serving wrong data.** Where the choice is between an outage Jorge can see and a silent silo breach he cannot, the design chooses the outage, explicitly.

---

### 7.1 SCENARIO A — the public leaderboard read is executed under the reader's own RLS scope

**The defect, restated precisely.** The public read is `leaderboard_projection` minus a correction CTE over `earnings_ledger` for rows younger than the undo window. `earnings_ledger` carries the `append_only_owner` policy:

```sql
USING (tenant_id = app.current_tenant()
   AND (owner_user_id = app.current_user_id() OR app.scope_is_global()))
```

A seller's session is `scope_mode='owner'`, so **the correction CTE sees only the reader's own pending rows.** Three consequences fire simultaneously:

- The winner's board correctly hides the sale for the undo window. **The other forty-nine see it instantly**, and see it reverse if the win is undone — the exact outcome `ARR-MVP-10` and R1.3 exist to forbid.
- `pending_watermark` is `0` for every non-winner, so **fifty sellers compute fifty different ETags for one public resource**, and for forty-nine of them the ETag does not change when the pending row ages out — the silent freeze the watermark was invented to prevent, reintroduced by the policy for 98 % of users.
- **The natural test passes.** Win as A, poll as A, assert exclusion. Green.

**Why widening the RLS is not the fix, and is ruled out permanently.** Making `earnings_ledger` tenant-readable so the CTE works exposes `opportunity_id`, `contact_id`, `stage_name_snapshot`, `product_type`, `delta_cents`, `reason` and `actor_user_id` for every seller's every sale, tenant-wide, inside a CTE that no screen renders. It is a cross-silo PII leak **with no UI symptom, no not-found to assert against, and no route for the silo suite to call** — the leak lives inside a query plan. It also converts a physically-restricted table into a policy-restricted one, which is the opposite direction of the whole isolation design ("you cannot leak a column the projection does not contain"). Ruled out and mechanised as ruled out: **schema gate S16** asserts the `qual` of `earnings_ledger`'s `p_app` policy contains `owner_user_id = app.current_user_id()`; a widening PR fails the pre-merge tier.

#### 7.1.1 The fix: one `SECURITY DEFINER` function, and the projection becomes unreadable

```sql
-- The ONLY public read path for the board. Column set is the payload contract (ARR-EVT-23).
CREATE FUNCTION app.leaderboard_read(p_period app.period_type)
RETURNS TABLE (
  user_id      uuid,
  display_name text,
  avatar_ref   text,
  total_cents  bigint,
  rank         integer,
  is_active    boolean,
  etag         text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = app, ref, pg_catalog
AS $$
DECLARE
  v_tenant  uuid        := app.current_tenant();     -- S8: definer re-asserts tenancy
  v_key     date;
  v_seq     bigint;
  v_pending timestamptz;
BEGIN
  IF v_tenant IS NULL THEN RETURN; END IF;           -- no context -> zero rows, never an error

  SELECT app.period_key_for(p_period, v_tenant) INTO v_key;   -- stamped in tenant.business_tz

  -- (1) ONE watermark row is the sequence component: bumped by app.ledger_append AND by the
  --     AFTER trigger on app_user (create / rename / deactivate). Roster changes move the ETag.
  SELECT w.seq INTO v_seq
    FROM app.channel_watermark w
   WHERE w.tenant_id = v_tenant
     AND w.owner_user_id = '00000000-0000-0000-0000-000000000000'::uuid
     AND w.channel = 'leaderboard';

  -- (2) TENANT-WIDE pending watermark, computed inside the definer, not under the reader's scope
  SELECT coalesce(max(e.recorded_at), 'epoch'::timestamptz) INTO v_pending
    FROM app.earnings_ledger e
   WHERE e.tenant_id = v_tenant
     AND e.recorded_at > clock_timestamp() - app.undo_window();

  RETURN QUERY
  WITH pending AS (                                  -- TENANT-WIDE correction: 0..2 rows
    SELECT e.owner_user_id, sum(e.delta_cents) AS pending_cents
      FROM app.earnings_ledger e
     WHERE e.tenant_id = v_tenant
       AND e.recorded_at > clock_timestamp() - app.undo_window()
       AND CASE p_period
             WHEN 'all_time' THEN true
             WHEN 'day'      THEN e.period_day   = v_key
             WHEN 'week'     THEN e.period_week  = v_key
             ELSE                 e.period_month = v_key
           END
     GROUP BY e.owner_user_id
  ), board AS (                                      -- every active seller, including $0 (US-9.5)
    SELECT u.id, u.display_name, u.avatar_url,
           coalesce(p.total_cents, 0) - coalesce(x.pending_cents, 0) AS total_cents,
           (u.deactivated_at IS NULL) AS is_active
      FROM app.app_user u
      LEFT JOIN app.leaderboard_projection p
             ON p.tenant_id = v_tenant AND p.user_id = u.id
            AND p.period_type = p_period AND p.period_key = v_key
      LEFT JOIN pending x ON x.owner_user_id = u.id
     WHERE u.tenant_id = v_tenant
       AND u.role = 'seller'
       AND (u.deactivated_at IS NULL
            OR (p_period = 'all_time' AND u.earnings_disposition = 'keep_in_history'))
  )
  SELECT b.id, b.display_name, b.avatar_url, b.total_cents,
         rank() OVER (ORDER BY b.total_cents DESC, b.display_name ASC)::int,
         b.is_active,
         encode(sha256(convert_to(
           coalesce(v_seq,0)::text || ':' ||
           extract(epoch from v_pending)::text || ':' ||
           p_period::text || ':' || v_key::text, 'UTF8')), 'hex')
    FROM board b;
END $$;

REVOKE ALL     ON FUNCTION app.leaderboard_read(app.period_type) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION app.leaderboard_read(app.period_type) TO crm_app;

-- THE CLOSING MOVE: the wrong read path stops existing.
REVOKE SELECT ON app.leaderboard_projection FROM crm_app;
```

**The revoke is the part that matters.** Without it, the definer function is a convention: a later refactor writes the projection query inline again and every test still passes. With it, `security.table_registry` reclassifies `leaderboard_projection` from `tenant_scoped_read` to `definer_only`, `harden()` re-applies the revoke on every deploy and every new partition, and **schema gate S6 is extended to assert `crm_app` holds zero `SELECT` on `leaderboard_projection`.** A Drizzle `select().from(leaderboardProjection)` returns `permission denied` → 500 → the seller reads the specified failure copy that minute. The sanctioned-cross-silo-exception list drops from two entries to one; the remaining exception is `app_user` (display names, forced by the recursion trap), which carries no money.

Four properties fall out that were previously claimed and not true:

| Property | Why it is now true |
|---|---|
| The pending correction is tenant-wide | Computed inside the definer, which runs as `crm_migrator` and is admitted by the `p_sys` policy; the function re-asserts `tenant_id = v_tenant` in every predicate |
| Fifty readers compute one ETag | The three ETag inputs (`channel_watermark.seq`, tenant-wide `pending_watermark`, `period_key`) are all reader-independent |
| The ETag moves when nothing writes | `pending_watermark` collapses to `epoch` when the last pending row ages out; and `period_key` rolls at business midnight, so the daily board rolls over with no writer — the two time-dependent freezes named in review-1 B3 |
| The payload cannot express lead data | The function's `RETURNS TABLE` **is** the type. `ARR-EVT-23`'s "a payload type that literally cannot express lead data" is now a catalog fact, and the SSE `leaderboard.rank_changed` payload type is generated from `pg_get_function_result()` rather than hand-written |

**Zero rows means broken context, not an empty board.** For a tenant-wide resource the "missing context returns zero rows" doctrine must not render as a blank leaderboard. The wrapper maps a zero-row result to `500 context_missing`. A blank board is impossible; a loud failure is not.

#### 7.1.2 Test **L2-A** — the assertion that would have caught it

```
GIVEN sellers A and B in one tenant, empty ledger, both sessions authenticated
WHEN  A closes an opportunity at $3,000 annual premium
THEN  inside the undo window:
        rA = GET /api/leaderboard as A ;  rB = GET /api/leaderboard as B
        assert rA.rows[A].total_cents == 0            -- winner's own board
        assert rB.rows[A].total_cents == 0            -- ← the defect: fails on today's design
        assert rA.etag === rB.etag  (byte-identical)  -- ← the second defect
      after undo_window + guard + epsilon, with NO intervening write:
        assert rB'.rows[A].total_cents == 300000
        assert rB'.etag !== rB.etag                   -- time-passing moves the ETag
      and:
        assert direct SELECT on app.leaderboard_projection as crm_app raises 42501
        assert pg_get_function_result('app.leaderboard_read') equals the sealed column list
```

The last assertion is the payload freeze: adding `contact_id` to the board's return type fails the build, because the column list is a sealed artifact (§7.6). The second-session assertion is added to `protected-list.json` as **DEMO-11**, so it inherits `retries: 0` and the no-skip rule.

---

### 7.2 SCENARIO B — the premium columns are writable, so a post-close edit never reaches the ledger

`REVOKE UPDATE (stage_id, current_stage_type, stage_entered_at)` exists. The same revoke was never applied to the money columns. A seller edits the premium of a closed-won opportunity, every `CHECK` passes (`annual = monthly × 12`, $1–$100,000, mode present), the card and the detail sheet show the new number, **no `opportunity.value_changed` is emitted and no ledger row is appended.** The public all-time board keeps the old number *forever*, because there is no recompute job by design and the ledger is never replayed. `ARR-EVT-07` calls this exact link "the single most-forgotten link in the money chain."

#### 7.2.1 The symmetric revoke, generalised so it cannot be forgotten again

```sql
REVOKE UPDATE (premium_monthly_cents, premium_annual_cents, premium_mode, product_type)
  ON app.opportunity FROM crm_app;
```

Applying it once is not enough — the next money column will be added without it. So the revoke set is **derived, not written**:

- `security.table_registry` gains `definer_only_columns text[] NOT NULL DEFAULT '{}'`, re-applied by `harden()` on every deploy and every partition (identical shape to the existing `immutable_columns`).
- Money is given a Postgres **domain**: `CREATE DOMAIN app.money_cents AS bigint;` and every monetary column is declared on it.
- **`harden()` raises** if any column of domain `app.money_cents` on any relation in any classified schema is absent from that relation's `definer_only_columns`. A new column `premium_annual app.money_cents` that nobody routed through a definer **fails the deploy**.
- **Schema gate S17** closes the escape hatch the review found in the money-type lint (1.14): any column on a relation in `app` whose type is `bigint` and whose name is not on the per-table sealed `non_money_bigints` list fails the build. `premium_annual bigint` therefore cannot exist; it is either `app.money_cents` (and thus definer-only, branded `Money` in TypeScript via the generated Drizzle custom type) or it does not compile past the schema gate. This is the missing fourth layer of signed non-negotiable 4, obtained from the engine instead of from a name regex.

#### 7.2.2 `app.opportunity_set_premium()` — the delta lands in the same transaction

```sql
CREATE FUNCTION app.opportunity_set_premium(
  p_opportunity_id uuid,
  p_mode           app.premium_mode,
  p_monthly_cents  app.money_cents,
  p_annual_cents   app.money_cents,
  p_reason_code    ref.value_change_reason,   -- typed, seeded list (US-9.3 required reason)
  p_reason_note    text,
  p_client_edit_key uuid                      -- idempotency: UNIQUE, beacon/retry safe
) RETURNS app.money_change_result
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, ref, pg_catalog AS $$
DECLARE
  v_tenant uuid := app.current_tenant();
  v_actor  uuid := app.current_user_id();
  v_old app.money_cents; v_type app.stage_type; v_owner uuid;
  v_delta bigint; v_evt uuid;
BEGIN
  SELECT o.premium_annual_cents, o.current_stage_type, o.owner_user_id
    INTO v_old, v_type, v_owner
    FROM app.opportunity o
   WHERE o.tenant_id = v_tenant AND o.id = p_opportunity_id
   FOR UPDATE;                                            -- serialises concurrent edits
  IF NOT FOUND OR (v_owner <> v_actor AND NOT app.scope_is_admin())
    THEN RETURN ('not_found', NULL, NULL); END IF;        -- owner-scoped not-found, never a 403

  UPDATE app.opportunity
     SET premium_mode = p_mode,
         premium_monthly_cents = p_monthly_cents,
         premium_annual_cents  = p_annual_cents
   WHERE tenant_id = v_tenant AND id = p_opportunity_id;  -- every CHECK still applies

  IF v_type = 'earning' THEN
    v_delta := p_annual_cents - coalesce(v_old, 0);
    IF v_delta <> 0 THEN
      v_evt := app.event_emit('opportunity.value_changed', …);        -- same transaction
      PERFORM app.ledger_append(delta_cents => v_delta,
                                source_event_id => v_evt,
                                source_event_name => 'opportunity.value_changed',
                                entry_type => 'value_correction',
                                reason => p_reason_code::text, …);
      PERFORM app.leaderboard_apply(v_owner, v_delta, …);             -- same statement family
      PERFORM app.watermark_bump(v_tenant, NULL, 'leaderboard');      -- ETag moves for everyone
    END IF;
  END IF;
  PERFORM app.audit_write('opportunity.premium_changed', …);
  RETURN ('ok', v_delta, v_evt);
END $$;
```

The emission is not "remembered by the handler" — it is inside the only statement that can change the number. **The event and the ledger row cannot be separated from the write, because the write does not exist anywhere else.** `app.ledger_adjust()` (admin void / adjust-with-reason, `entry_type='manual_adjustment'`, `ref.adjustment_reason` seeded list, `app.scope_is_admin()` re-verified in the body) is specified as the second caller of the same primitive, which gives review-1 B1 an implementation surface it previously did not have.

#### 7.2.3 Tests **L2-B**

- **B1** — a direct Drizzle `update(opportunity).set({ premiumAnnualCents })` on a closed-won row returns `permission denied` (42501). *This is the test that fails today.*
- **B2** — `opportunity_set_premium` on a closed-won opportunity appends exactly one `value_correction` row whose `delta_cents = new − old`, and `app.leaderboard_read` as **another seller** reflects the new total once the window passes.
- **B3** — the same call on an **open** opportunity appends **zero** ledger rows (a premium edit before close is not a correction).
- **B4** — property test over 10⁵ random (old, new) pairs in the legal range: `sum(ledger deltas for the opportunity) == final premium_annual_cents` for every sequence of edits. This is the invariant the public all-time board depends on, expressed once.
- **B5** — `harden()` raises when a test migration adds `app.money_cents` column outside `definer_only_columns`.

---

### 7.3 SCENARIO C — a table in `public` is invisible to every net

`security.harden()` loops `pg_class` **in schemas `app` and `ref`**; the CI catalog gate S1 checks "any relation in `app`". **Drizzle's default schema is `public`.** A model asked to add `saved_view` or `board_preference` creates it there by inertia, where it gets no `FORCE`, no policies, no registry row, no `harden()` raise and no CI failure. Combined with §7.7.1 (list endpoints with no record id are untestable by the registry silo suite), fifty sellers' saved filters — which encode contact names — become tenant-wide readable and every screen looks identical.

#### 7.3.1 `harden()` becomes schema-agnostic

```sql
-- inside security.harden(), replacing the two-schema loop
FOR r IN
  SELECT c.oid, n.nspname, c.relname, c.relkind
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE c.relkind IN ('r','p','v','m','f')                    -- tables, partitions, views, foreign
     AND n.nspname NOT IN ('pg_catalog','information_schema','pg_toast')
     AND n.nspname NOT IN (SELECT schema_name FROM security.schema_exception)  -- sealed list
LOOP
  IF NOT EXISTS (SELECT 1 FROM security.table_registry t
                  WHERE t.schema_name = r.nspname AND t.table_name = r.relname)
  THEN
    RAISE EXCEPTION 'unclassified relation %.% (%): every relation in every schema must be '
                    'classified or its schema must be on the versioned exception list',
                    r.nspname, r.relname, r.relkind USING ERRCODE = 'HR001';
  END IF;
END LOOP;
```

`security.schema_exception` is a seeded relation (`auth`, `pgboss`, `ref`, `security`, `cron` if present), each row carrying `exception_reason NOT NULL`, and it is sealed by §7.6. The check is now **"any relation anywhere that is not classified"**, not "any unclassified relation inside two named schemas."

#### 7.3.2 `public` is stripped, and the app role cannot even name it

```sql
REVOKE ALL ON SCHEMA public FROM PUBLIC, crm_app;
REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM PUBLIC, crm_app;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC, crm_app;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, crm_app;
ALTER DEFAULT PRIVILEGES FOR ROLE crm_migrator IN SCHEMA public
  REVOKE ALL ON TABLES FROM PUBLIC, crm_app;                 -- kills the future GRANT ALL too
ALTER ROLE crm_app SET search_path = app, ref, pg_catalog;   -- public is not on the path
```

Three independent nets now cover the same hole, in the order they fire: the app role **cannot resolve** an unqualified name in `public`; `harden()` **raises at deploy**; S1 is rescoped from two schemas to "every schema not on the sealed exception list" and **fails the pre-merge build**.

#### 7.3.3 Test **L2-C**

Inside the Testcontainers instance, a test migration executes `CREATE TABLE public.saved_view (…)` and the test asserts: (a) `security.harden()` raises `HR001` naming `public.saved_view`; (b) as `crm_app`, `SELECT * FROM saved_view` raises `permission denied` **and** `relation does not exist` when unqualified; (c) S1 fails. This is the mechanical proof that the keystone mechanism now looks where the model actually creates tables.

---

### 7.4 SCENARIO D — a `CHECK` violation destroys the durable refusal record the ARR requires

`ARR-EVT-11` (non-negotiable) requires `opportunity.gate_blocked` on **every** refusal and states *"refusal is the absence of a state change, never a rolled-back one."* The design's headline mechanism is that both gates are `CHECK` constraints. A `CHECK` violation **aborts the transaction**, taking with it any `event_emit`, `audit_write` or `admin_alert` written before it. The only previously available exit was a service-layer pre-check duplicating the gate logic — the second implementation `ARR-MVP-09` and `ARR-UX-03` forbid — and the review showed the two copies diverge in the direction nobody tests: a permissive pre-check gives a 500 and *"Couldn't record this sale"* on a legitimate win; a strict pre-check gives a 422 the database would have accepted, and `gate_blocked` reads zero either way.

#### 7.4.1 The engine fact this rests on

**In PL/pgSQL, a `BEGIN … EXCEPTION … END` block establishes a subtransaction (an implicit `SAVEPOINT`).** Entering the handler rolls back everything the block did and **leaves the enclosing transaction valid and writable.** One gate, one implementation, durable refusal.

```sql
CREATE FUNCTION app.stage_move(
  p_opportunity_id uuid, p_to_stage_id uuid, p_moved_via app.moved_via,
  p_client_move_key uuid, p_premium_annual_cents app.money_cents,
  p_premium_mode app.premium_mode, p_lost_reason_id uuid, p_lost_reason_note text
) RETURNS app.move_result                       -- ('moved'|'refused'|'not_found', code, event_id)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, ref, pg_catalog AS $$
DECLARE
  v_tenant uuid := app.current_tenant();
  v_constraint text; v_code ref.refusal_code; v_evt uuid; v_tx uuid;
BEGIN
  BEGIN                                    -- ← THIS BLOCK IS THE SAVEPOINT
    INSERT INTO app.stage_transition (…)   -- CHECK (to_stage_type <> 'earning' OR actor_type='human')
      RETURNING id INTO v_tx;
    UPDATE app.opportunity SET stage_id = p_to_stage_id, …
     WHERE tenant_id = v_tenant AND id = p_opportunity_id;   -- the two gate CHECKs fire here
    PERFORM app.event_emit('opportunity.stage_changed', …);  -- ALWAYS, per 02b §4 (review-1 A7)
    IF (SELECT current_stage_type FROM app.opportunity
         WHERE tenant_id=v_tenant AND id=p_opportunity_id) = 'earning' THEN
      v_evt := app.event_emit('opportunity.won', …);
      PERFORM app.ledger_append(…, source_event_id => v_evt, entry_type => 'sale');
      PERFORM app.leaderboard_apply(…);
      PERFORM app.watermark_bump(v_tenant, NULL, 'leaderboard');
    END IF;
    RETURN ('moved', NULL, v_evt);

  EXCEPTION WHEN check_violation OR not_null_violation THEN
    -- Everything above is rolled back. The OUTER transaction is alive and writable.
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
    SELECT r.refusal_code INTO v_code
      FROM ref.constraint_refusal r WHERE r.constraint_name = v_constraint;
    IF v_code IS NULL THEN RAISE; END IF;        -- unmapped constraint = a bug, fail loudly
    v_evt := app.event_emit('opportunity.gate_blocked',
               payload => jsonb_build_object('refusal_code', v_code,
                                             'constraint',   v_constraint,
                                             'moved_via',    p_moved_via, …));
    PERFORM app.audit_write('opportunity.gate_blocked', verdict => 'blocked',
                            verdict_input_snapshot => …);
    PERFORM app.admin_alert_maybe('gate_blocked_burst', …);
    RETURN ('refused', v_code, v_evt);           -- committed by the caller's COMMIT
  END;
END $$;
```

#### 7.4.2 The refusal code is derived from the constraint, so it cannot drift

`GET STACKED DIAGNOSTICS … CONSTRAINT_NAME` returns **the constraint's own name**. `ref.constraint_refusal (constraint_name PK, refusal_code, copy_key)` maps it to a typed code and an ICU string key. Two mechanical consequences:

- **`harden()` raises** if any `CHECK` constraint on `app.opportunity` or `app.stage_transition` has no mapping row. Adding a gate condition without its refusal copy **fails the deploy**.
- The TypeScript refusal union is generated from `ref.constraint_refusal`, so **the HTTP layer cannot invent a refusal code** and there is no place to write a second copy of the rules. `src/domain/gateDecision` survives only as a client-side *hint* for pre-disabling a drop target; it cannot produce a 422 because the 422 body's type is the generated union and its value comes from the function's return.

#### 7.4.3 Bounded cost, and the one prohibition

One subtransaction per attempted move. At the product's volume (hundreds of moves per day) this is free. The pattern must **never** be nested inside a per-row loop (subxid/SLRU pressure). Mechanised as **S18**: a `pg_proc.prosrc` query — the same shape as S8 — asserts that `app.stage_move` contains exactly one `EXCEPTION` block and that no definer function containing an `EXCEPTION` block also contains `LOOP`.

#### 7.4.4 Tests **L2-D**

- **D1** — a refused move: the transaction **commits**; `event_log` has exactly one `opportunity.gate_blocked`; `audit_log` has exactly one row with `verdict='blocked'`; `stage_transition` has **zero** rows for that opportunity; the opportunity's `stage_id` is unchanged. Read from a *second* session after commit, so the durability is real.
- **D2** — the same refusal via each of the seven `moved_via` values and via a raw SQL `UPDATE`: identical refusal code, identical body, one `gate_blocked` each. (The raw `UPDATE` fails earlier — `REVOKE UPDATE (stage_id, …)` — which is the correct stricter answer and is asserted as such.)
- **D3** — twelve consecutive refusals produce twelve `gate_blocked` rows: the counter `ARR-EVT-11` calls *"the only way to prove the guard fires rather than being bypassed"* is now non-zero and monotonic.
- **D4** — a test migration adds a `CHECK` to `app.opportunity` with no `ref.constraint_refusal` row; `harden()` raises.
- **D5** — no service-layer pre-check exists: a query asserts the generated refusal union has exactly one producer (the function's return type) and that `src/domain/gateDecision` is imported only by `src/ui/**`.

---

### 7.5 The counter-net nobody had: a sale credited **zero** times

The review's §3.3 named it: all three double-credit nets guard against crediting twice; **nothing guards against crediting zero times.** If `app.ledger_append` is dropped from the close path in a refactor, the fan-out `WHERE delivery IN ('outbox','pgboss')` guarantees no outbox row is written either, so the sale is credited nowhere — by design, silently, with a perfectly correct-looking card.

**The mechanism is a deferred constraint trigger, the same technique the model already uses for "a lead never exists without a card":**

```sql
CREATE CONSTRAINT TRIGGER t_earning_must_credit
  AFTER INSERT ON app.stage_transition
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.to_stage_type = 'earning')
  EXECUTE FUNCTION app.assert_credited();
-- app.assert_credited() raises SQLSTATE 'MN001' at COMMIT if no earnings_ledger row exists
-- with (tenant_id, opportunity_id, entry_type='sale') that is not superseded by a reversal.
```

**A move into an earning stage that credited nothing cannot commit.** The refactor that "simplifies" the close path turns the drag red on the seller's screen the first time it runs, instead of publishing a leaderboard that is quietly missing a sale.

The symmetric guarantee (review-1 B2 / R1.6 — *one* credit per opportunity, re-credit after reversal) is closed at the same time and in the same layer: `opportunity.earnings_credited boolean NOT NULL DEFAULT false`, flipped true by `ledger_append` on a `sale` and false on a `reversal`, with `ledger_append` refusing a second `sale` while it is true and returning `already_credited` as a **success** path. `UNIQUE (tenant_id, source_event_id)` alone permits an earning→earning move to credit twice from a genuinely distinct event; this state column is what actually forbids it.

---

### 7.6 The seal chain — enforcement when there is no reviewer

Everything whose enforcement sentence contains *"a PR that touches that file and nothing else"* is documentation. Two moves fix it.

#### 7.6.1 First, eliminate the literal wherever possible

| Was a file/literal | Becomes |
|---|---|
| `count(*) WHERE delivery='inline' = 6` in a test file | `ref.inline_consumer_allowlist` (seeded by migration) + `CHECK (delivery <> 'inline' OR consumer_name IN allowlist)` on `ref.event_consumer` + `harden()` asserting count equality. A seventh inline consumer needs a **migration**, not an edit |
| RLS exception list (file) | `security.table_registry` exception rows + `security.schema_exception`, `exception_reason NOT NULL` |
| `etag: 'none'` exception list (file) | `ref.etag_none_exception (route_key PK, reason NOT NULL)`, seeded by migration; the ETag suite joins it |
| UI-loader whitelist (file) | `ref.ui_loader_whitelist (route_path PK, reason NOT NULL)`; the route generator **refuses to build** on a loader outside it (§7.7.2) |
| `perf-budgets.json` numbers | Mirrored into `system_constant` by the same seed generator, with the four-way drift test that already guards `undo_window_ms` (S13 shape) |
| 49-name coverage exemptions | `ref.event_schema.no_mvp_emitter boolean NOT NULL` (§7.7.5) |
| Refusal copy | `ref.constraint_refusal` (§7.4.2) |

A table seeded by a migration is not a file a model edits casually: changing it requires a new numbered migration, which is itself an append-only artifact, and the deploy runs it.

#### 7.6.2 Second, move the authority out of the working tree

For what genuinely must stay a file — `fixtures/events/**`, `contracts/events/**`, `perf-budgets.json`, `ci/guards.json` itself — the enforcement is a **hash chain sealed in production's own database**:

```
ci/guards.json          {path glob, mode: append-only | frozen | ratchet(direction)}
ci/seal-manifest.jsonl  append-only chain: {n, path, sha256, prev_line_sha, line_sha}
migrations/NNNN_seal.sql  INSERT INTO security.seal (n, head_line_sha, reason)
security.seal            append-only relation, immutable set, S6/S7 apply
```

Three enforcement points, in the order they fire:

1. **Pre-merge CI** — recompute every guarded digest, walk the chain; fail on any modified or deleted entry; `ratchet` fields may move only in the tightening direction.
2. **Deploy (the one that cannot be edited away)** — the migrator asserts that `security.seal.head_line_sha` **read from the live production database** is a prefix of the manifest in the image. A rewritten history is not a prefix → `harden()` raises → the deploy stops → **the previous image keeps serving.** The authority is a row in production, not a file in the repo.
3. **Boot** — every process asserts the image's manifest head equals `security.seal`'s head; mismatch → exit non-zero.

**The honest boundary, stated rather than hidden.** A model that writes a *new* migration can still advance the seal. What this machine guarantees is that every loosening is **permanent, counted and rendered**: `security.seal` is in the immutable set, so a seal advance can never be reverted or rewritten, and `/admin/system` renders `guards changed since last release: N` with the file list. Jorge's behavioural check is one number on one screen. This does not make loosening impossible; it makes it impossible to do **silently**, which is the property the reviewer was providing and the only one we can mechanise without him.

---

### 7.7 The specific bypasses

#### 7.7.1 (3.2) List endpoints with no record id — the collision fixture and the canary

Six of the fourteen measured endpoints take no id (`/api/board`, `/api/my-day`, `/api/search`, `/api/leaderboard`, `/api/notifications`, `/api/board/since`). The registry silo suite works by substituting a foreign id; for these there is nothing to substitute, and `GET /api/search` is *structurally* untestable by that harness while `ARR-UX-04` (non-negotiable) requires that search "never return, count or hint at another seller's records."

**Silo testability becomes a declared, non-optional property of every endpoint.** `defineEndpoint` gains:

```
siloProbe: { kind: 'foreign-id', fixture }               // existing treatment
         | { kind: 'listing', canary: true }             // the new one
         | { kind: 'none', reason }                      // lands on the sealed exception table
```

Not optional in the type: **a new id-less endpoint that declares nothing does not compile.**

**Fixture `silo-collision`** — the schema makes a genuine collision legal, which is what makes this fixture possible: `contact` is unique on `(tenant_id, owner_user_id, email_norm)` and `contact_phone` on `(tenant_id, owner_user_id, phone_e164)`, both **owner-scoped**, because ping-post resells the same consumer to two sellers. So the fixture seeds, for sellers A and B:

- identical `full_name` (`"Maria Rodriguez"`), identical `email_norm`, identical `phone_e164`;
- every one of A's free-text and identity fields additionally carries a **canary token** `ZZQA-<a_id>` (name suffix, note body, activity title, opportunity carrier, saved-filter label);
- three of each, so counts are asserted numerically.

**The assertions, for every `kind: 'listing'` endpoint, called as B:**

1. `assert !responseBody.includes('ZZQA-')` — a **byte-level assertion over the entire serialized response**, which catches a leak through *any* field, including fields added later that no test knows about.
2. `assert rows.length === 3` and every returned id ∈ B's id set — the counting/hinting clause of ARR-UX-04.
3. `next_cursor` minted for B cannot decode to any of A's rows: the cursor codec is HMAC'd over `(tenant, owner, sort key)` and a test asserts A's cursor presented by B is rejected, not merely empty.
4. For `/api/search` specifically, the query is run for the colliding string, the colliding phone in three formats, and the colliding email — the three shapes a real leak takes.

**Plus a bounded grep gate with a defined corpus:** no reference to `app.scope_is_global()` may appear under `src/db/sql/search/**`. Supervisor global search, if it ever ships, must be a separate declared route with its own `book.viewed` audit, not a lifted predicate inside the seller path.

#### 7.7.2 (3.4) `defineEndpoint()` is made verifiable — and unrouted if it is not used

"Every file under `routes/api/**` exports the result of one factory" is a convention; React Router will happily serve a hand-written `loader`. Three changes make it a build fact:

- The factory returns an object carrying a **module-private `unique symbol` brand**. There is no other way to construct one.
- The **route registry generator is a build prerequisite** (the server bundle imports `route-registry.generated.ts`). It imports every module under `routes/api/**` and `routes/ui/**` and **throws** on: any module in `routes/api/**` whose export lacks the brand; any bare `loader`/`action` export in that tree; any `loader`/`action` in `routes/ui/**` whose path is not in `ref.ui_loader_whitelist`; and any module it cannot import at all (previously unspecified behaviour). A throw here means no bundle, no image, nothing to deploy.
- **The framework route table is generated from the registry**, not from file conventions. A module the generator refused is therefore **not routed**: it 404s in E2E. The failure has a screen symptom, not just a build symptom.

#### 7.7.3 (3.5) The `ReadTx` backdoor is bounded by `GRANT EXECUTE`, not by layering

`book.viewed` was resolved by moving the write into the scope resolver "in the same request frame." That is a general-purpose write channel attached to every GET, reachable by moving three lines up a layer, and its atomicity was unspecified. Three closures:

1. **The resolver's handle is not a query interface.** Its type is `SystemTx = { beginRequest(args): Promise<Ctx> }` — one method, no `insert`, no `update`, no `execute`, no `sql`. Moving code up a layer yields an object that can write exactly one kind of row.
2. **Atomicity becomes structural.** `withTenant()` opens the transaction and calls `app.begin_request()` as its **first statement**; that definer sets the three GUCs *and* writes the `book.viewed` audit row (when `scope_mode <> 'owner'` and the subject's owner is not the caller) in the same statement, in the transaction that then performs the read. An audit-write failure aborts the transaction: **an unaudited supervisor read cannot commit, and a read that succeeded cannot lack its audit row.** That is `ARR-PRV-03`'s "composed in the same layer" as an engine fact.
3. **The ceiling is a privilege, not a rule.** `REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA app FROM crm_app`, then `GRANT EXECUTE` per function from `security.function_registry`, re-applied by `harden()`. **The complete set of writes reachable from any GET is now an enumerable catalog fact**, asserted by a CI query, regardless of what layer the code lives in.
4. **Bonus, engine-level leak detector for pooled context (3.8's real risk):** `app.begin_request()` raises if a context GUC is already set by a *different* transaction (`current_setting('app.txid', true)::bigint IS DISTINCT FROM txid_current()`). A session-mode pooler or a bare `SET` that leaks seller A's context onto seller B's connection produces a 500 on the **first** leaked request instead of perfectly rendered pages full of the wrong rows.

#### 7.7.4 (3.8) The lint corpus stops being undefined

"the SQL corpus" is undefined in a codebase where SQL lives inside Drizzle template literals. Defined mechanically: **SQL exists only in `db/functions/**/*.sql`, `src/db/sql/**/*.sql`, and `.ts` files under `src/db/**`.** An ESLint rule bans the `sql` tag and `.execute(` outside `src/db/**`; dependency-cruiser already forbids importing the pool from outside `src/db/**`. The lint's corpus is now an enumerable file set, and §7.7.3(4) is the backstop if it is ever bypassed.

#### 7.7.5 (3.6) The 49-name coverage gate measures reachable code, not table contents

"All 49 names appear at least once in `event_log`" is an assertion about table contents; the natural green-the-build move is a test helper. Replaced by a two-part gate:

- **Static (build):** the generator emits 49 typed emitters (`emit.opportunityWon(...)`), and an analysis over the **shipped bundle's** module graph asserts each emitter's call site is reachable from a role entrypoint. `tests/**` and `tools/**` are not in the bundle, so **a test helper cannot satisfy it.**
- **Declared exemptions:** `ref.event_schema.no_mvp_emitter boolean NOT NULL` marks the names that legitimately have no MVP emitter by approved scope decision (`sequence.*`, `automation.executed`, `calendar.sync_failed`, `lead.import_completed`, `call.enriched` while recording is disabled). The gate asserts `reachable_emitters ≡ 49 − no_mvp_emitter`. This closes review-1 B5 — the gate was red on day one and would have been deleted — and turns the exemption set into **the enforceable list of what V1.1 must light up**. Setting `no_mvp_emitter` requires a migration and moves the seal.
- **Runtime (integration) is kept** as the second leg, unchanged.

#### 7.7.6 (3.7) `provider_capability` cannot be talked into `verified`

`CHECK (status <> 'verified' OR (verified_at IS NOT NULL AND evidence_ref IS NOT NULL))` with `evidence_ref` as free text is satisfied by a migration seeding `evidence_ref='spike'`. Replaced by an evidence **foreign key to a real captured exchange**:

```sql
CREATE TABLE ref.capability_probe (
  probe_id       uuid PRIMARY KEY,
  provider       app.provider NOT NULL,
  capability     text NOT NULL,
  http_status    smallint NOT NULL,
  response_digest bytea NOT NULL,          -- sha256 of the stored provider response body
  raw_payload_id uuid NOT NULL,            -- FK: the body itself, in raw_payload_vault
  observed_at    timestamptz NOT NULL
);
ALTER TABLE ref.provider_capability
  ADD COLUMN evidence_probe_id uuid REFERENCES ref.capability_probe(probe_id),
  ADD CONSTRAINT verified_needs_probe CHECK (status <> 'verified' OR evidence_probe_id IS NOT NULL);
```

Plus a trigger: `verified_at` must equal the linked probe's `observed_at`, and the probe's `http_status` must be 2xx. Plus the boot assertion, extended: for every `tier='mvp_required'` capability in production, the linked probe must exist **and** its `response_digest` must equal `raw_payload_vault.body_sha256` for `raw_payload_id`. A fabricated verification has no probe row, no stored body and no matching digest, and **the process exits non-zero.** `/admin/integration-health` renders each capability with its probe timestamp and HTTP status, so "verified" is a rendered fact with a provenance, not a word in a column.

#### 7.7.7 (3.9) A real restore that comes back without `FORCE` must not boot

The monthly restore drill is the best control in the document and it runs in CI against a dump. A **real** restore performed during an incident restores whatever the dump contains and boots; the current boot assertion checks `current_user` only, so a restored database with `FORCE` off and a non-owner `crm_app` boots clean and shows every seller the whole book.

**The boot assertion becomes a posture assertion over a catalog digest.** `security.harden()` writes, as its final act, a row into `security.harden_run (schema_version, image_digest, ran_at, catalog_digest)` where `catalog_digest` is a hash over exactly the facts `harden()` itself sets, read back from the catalog:

- `relrowsecurity AND relforcerowsecurity` for **every** relation in `security.table_registry` (≈60 rows, one query — not a canary);
- the full `crm_app` grant matrix from `information_schema.role_table_grants` (zero DELETE anywhere; zero DML on the immutable set; zero SELECT on `leaderboard_projection` and on base tables carrying `deleted_at`);
- the presence of the statement-level immutability triggers from `pg_trigger`;
- the `EXECUTE` grant set from `security.function_registry`;
- the sealed schema-exception set.

**Every process, at every start, recomputes that digest and compares it to `security.harden_run`. Mismatch → `process.exit(1)` with the specific drifted fact named.** The failure mode of a bad restore therefore becomes **an outage Jorge can see**, not a silent tenant-wide leak. Recovery is documented and single-step: run the migrator image, whose last statement is `harden()`, which re-applies everything and re-writes the digest.

The honest cost: the digest can self-inflict an outage on legitimate catalog drift. It is scoped exclusively to facts `harden()` sets, so the only way it differs is genuine drift — and genuine drift in that set is precisely the condition under which serving is more dangerous than not serving.

---

### 7.8 Inter-section contradictions that are mechanical

#### 7.8.1 (C1) One name for the roles variable, and no silent default

`PROCESS_ROLES` in the API section vs `ROLES` in the Aloware section. The failure of reading the wrong one is a process that mounts its **default** set, silently.

- **The canonical name is `PROCESS_ROLES`.** There is exactly one reader: `src/config/env.generated.ts`, produced from a sealed `config/env.schema.yaml`.
- **There is no default.** A missing or empty `PROCESS_ROLES` → the process exits non-zero at boot.
- **The legacy name is poison.** The config module exits non-zero if `ROLES` is present at all, naming the correct variable in the message.
- **Unknown `APP_`-prefixed variables exit non-zero**, so a typo in the provider dashboard is a failed deploy, not a mis-mounted process.
- A dashboard misconfiguration therefore surfaces as *"the deploy failed"* — the loudest, cheapest signal available — never as a process quietly mounting the wrong families.

#### 7.8.2 (C2) One table for the two contractual URLs; the grep gate keys on a pattern, not a literal

Three incompatible spellings existed (`/webhooks/aloware/v1` vs `/hooks/aloware/{endpoint_token}` vs `POST /webhooks/aloware/{path_secret}`), and the CI grep gate keyed on the literals `/hooks/` and `/intake/` — so it does not fire on `/webhooks/`. **The mechanism and the thing it guards were written in different dialects.**

**Canonical, and binding:**

```
POST https://in.<domain>/webhooks/aloware/v1/{endpoint_token}
POST https://in.<domain>/intake/v1/{source_token}
```

One credential vocabulary: `endpoint_token` (Aloware), `source_token` (vendors). `path_secret` is struck.

- `ref.external_surface (key PK, path_template, version, credential_column, rate_policy, since_migration)` is seeded by migration and sealed.
- `src/ingress/urls.generated.ts` is **generated** from it; so are the ingress rows of the route registry; so is the grep gate's pattern.
- **The gate is a pattern, not a literal:** any string matching `/\/(webhooks?|hooks|intake)\//` outside the generated module fails the build. It fires on every spelling, including ones nobody has invented yet.
- An L2 test asserts `ref.external_surface` ≡ the generated URL builder ≡ the deployed route table, and the production synthetic posts to the composed URL.

#### 7.8.3 (C3) The rate meter and the retry storm stop cancelling each other

Either the 120/min meter applies to the Aloware endpoint — and Gate 2's 333 req/s recovery drain fails in the first second by design — or it does not, and the design must say so. **It does not, and the reason is mechanical rather than configured:**

- `app.resolve_intake_token()` (vendor ping-post) increments `tenant_lookup_meter`. Vendor abuse control is real and the vendor retries.
- `app.resolve_webhook_token()` is a **different function that does not contain the meter statement.** `ref.external_surface.rate_policy` records `admission_concurrency` for the webhook surface, and **schema gate S19** asserts `pg_proc.prosrc` for `resolve_webhook_token` contains no reference to the meter relation. The property is a function that lacks a statement, not a number someone can change.
- The webhook surface is bounded by the bounded-FIFO admission control already specified: it sheds at the **last** possible point, and it never sheds a payload it has not durably vaulted. Under `ARR-INT-02` (retry semantics unverified) a `429` is *"a lost webhook wearing a status code"*; the overflow response is therefore `202` **after** the vault write, never a bare 429.
- Gate 2 asserts: 20,000 webhooks at 333/s produce **zero** 429s on the webhook surface and zero lost payloads, while `304` p95 ≤ 80 ms holds.

#### 7.8.4 (C4) The ETag failure mode was stated backwards, and the dangerous direction had no alarm

**Correction, binding.** §9.2.2's sentence *"If the watermark stops being bumped… every poll returns 200 instead of 304"* is **inverted and is struck.** A watermark that stops being bumped produces an ETag that **stops changing**, so every poll returns `304` forever and **the board silently freezes showing stale data.** The existing alarm (304 share *dropping* below 75 %) watches the benign, merely-expensive direction.

Two alarms replace one:

| # | Direction | Condition | Response |
|---|---|---|---|
| **T5** | **Dangerous — frozen board** | Rolling 10 min in the US window: `304` share on the `leaderboard` channel ≥ 99 % **AND** `count(*) FROM app.earnings_ledger WHERE recorded_at > now() − 10 min` ≥ 1 | **Page.** Both terms come from our own tables plus the in-app probe counter (ARR-OPS-05) |
| **T6** | **Positive control** | The two-legged synthetic writes a ledger row in the demo tenant every 5 min and asserts (a) `app.leaderboard_read`'s ETag differs within 10 s, and (b) a headless SSE subscriber received `leaderboard.rank_changed` | **Page.** (a) is the frozen-watermark detector; (b) is the `LISTEN`-died detector already specified |
| T1 | Benign — cost | `304` share < 75 % | Cost alarm, unchanged |

`/admin/system` renders **board freshness: last ETag change N seconds ago**, so the frozen board is visible on a screen and not only in an alerting product.

#### 7.8.5 (C7) The registry covers every served route, not `routes/api/**`

The five suites iterated a registry built by scanning `routes/api/**`, which excludes the **one HTML response that carries a seller's real board**, every `routes/ui/**` document, `/sse/**`, `/auth/**`, `/intake/**`, `/webhooks/**`, `/healthz` and `/readyz`. So the cache suite (signed non-negotiable 14 — the fatal-hazard graft) did not cover the SSR board, and the silo suite did not cover the path `ARR-UX-04` names by name ("reached by URL, notification deep link or search").

The generator scans **every served tree**. Each entry declares `surface ∈ { json, document, stream, ingress, health }` and the five suites iterate the full set with per-surface expectations:

| Surface | Cache | Silo | ETag | Pagination | Topology |
|---|---|---|---|---|---|
| `document` (SSR) | `private, no-store` asserted | `siloProbe: listing` + canary body assertion | n/a | via the embedded board payload | role `web` |
| `stream` (`/sse/**`) | `no-store`, no compression, `X-Accel-Buffering: no` | payload type is generated from `app.leaderboard_read`'s result type — **it cannot express lead data** | n/a | n/a | role `web` |
| `ingress` | `no-store` | token resolution returns ids only | n/a | n/a | role `ingest` |
| `health` | `no-store` | n/a (declared `kind: 'none'`, sealed reason) | n/a | n/a | all |

The build fails on any module in either tree that does not go through its factory (§7.7.2), so "every endpoint / every response" is finally true of every response the product serves. **C8's claim is corrected in passing:** the unauthenticated surface is **five** routes — three POSTs plus `/healthz` and `/readyz`, two GETs that execute a query — and the sentence is rewritten rather than left doing rhetorical work.

#### 7.8.6 (C5) A job payload cannot express a tenant, so it cannot be scoped to the wrong one

The Security section presents five execution contexts as covered; the data model records the pg-boss one as an **open ruling** — a payload with a wrong `tenant_id` is a cross-tenant write with RLS fully enabled and perfectly happy. Closed with option (b), at the type level:

- `defineJob`'s payload type is `{ subjectType, subjectId, …scalars }` and **has no `tenant_id` field**. A payload carrying one does not compile.
- The handler wrapper calls `app.begin_job(kind, subject_type, subject_id)` — a `SECURITY DEFINER` that **re-derives** `tenant_id` and `owner_user_id` from the subject row and sets the GUCs. A corrupted or attacker-influenced id resolves to *that subject's* tenant or to nothing; it cannot select a tenant.
- S8 already asserts every definer body contains `app.current_tenant()`; `app.begin_job` is added to `security.function_registry` and is the only granted entry point for handlers.

---

### 7.9 (1.9 / 1.10) Jobs gain a latency-criticality axis with **reserved** capacity

Job classification is `weight ∈ {light, heavy}` — a **CPU** axis with no latency axis. During a 20,000-message provider replay a TCPA `STOP` sits at position 14,000 of a FIFO drain while the T-1h reminder fires and the compliance gate reads a suppression list that does not yet contain the row. `ARR-EVT-13` is explicit: *"loss **or delay** of that hop is a legal failure, not a UX degradation."* The bulkhead isolates ingest CPU from web CPU and **does nothing for the worker queue.**

#### 7.9.1 The axis, with the same mechanics `weight` already has

```sql
CREATE TYPE app.job_priority AS ENUM ('compliance','interactive','bulk');

CREATE TABLE ref.job_registry (
  job_name  text PRIMARY KEY,
  weight    app.job_weight   NOT NULL,     -- existing CPU axis
  priority  app.job_priority NOT NULL,     -- NEW latency axis
  lane      text GENERATED ALWAYS AS ('lane_' || priority::text) STORED
);
```

Seeded from the same generated file as `ref.event_consumer`. **`harden()` raises on any registry row that is unclassified, and on any queue name found in the built bundle that has no registry row** — adding a job without classifying its latency criticality **fails the deploy**, exactly as an unclassified table does.

| Priority | Members | Why |
|---|---|---|
| `compliance` | `message.received` merge (the STOP chain), suppression/consent append, Aloware disenroll (`ARR-EVT-14`), T-1h reminder dispatch, break-glass expiry side effects | Delay is a **legal** failure. The reminder is here, not in `interactive`: a late reminder can fire **outside the legal calling window** |
| `interactive` | intake `lead.created` materialisation (`ARR-MVP-18`'s 5 s SLA), call-merge for a live call, celebration broadcast, notification fan-out | Delay is a product failure measured in seconds — speed-to-lead is the number the entire lead spend is judged by |
| `bulk` | webhook replay, reconciliation backfill, export, event archive, retention purge, projection rebuild | Delay is invisible |

#### 7.9.2 Declaring the lane is not enough — the capacity is **reserved**

pg-boss's per-queue priority only orders a fetch *within* a queue. Three separate fetch loops with their own connections and their own concurrency are what stop a bulk drain from starving compliance:

- `WORKER_LANES` is **derived from the registry**, never configured by hand.
- A process whose `PROCESS_ROLES` includes `worker` **exits non-zero at boot if its lane set does not include `compliance`.** The compliance lane cannot be accidentally undeployed.
- The enqueuer cannot choose the lane: the generator emits one typed enqueue helper per job (`enqueue.callMerge(...)`) and the lane is looked up from the registry at enqueue time. A raw `boss.send('x')` enqueues into a queue **no lane drains**, and the L2 topology-shaped test asserts that the union of lanes drains every registered queue and that every queue name in the built bundle is registered.
- Each lane writes **its own heartbeat row** (§7.10), so a starved or wedged lane is visible per lane rather than as "the worker looks up."

#### 7.9.3 The STOP reaches the compliance lane, and a mis-classification costs latency, not correctness

The ingest edge is deliberately parse-free, so `intent_hint='stop'` is unknowable until the merge job runs — yet lane selection happens **at enqueue time**. The resolution:

- The edge applies **one pure, total domain function** (`stopKeyword()`, already in `src/domain/**` and property-tested) to the first 320 bytes of the message-body field. No domain read, no DB read, no merge — the parse-free rule is about **business meaning**, and a keyword match is not business meaning.
- A match enqueues into `lane_compliance`; everything else into `lane_interactive`.
- **The fallback is correctness-preserving:** the merge job re-evaluates `intent_hint` properly, and the consent + suppression append is already an `inline` consumer inside the merge transaction. A mis-classified STOP is therefore *late*, never *lost* — and the residual risk is stated in §7.12 rather than hidden.

#### 7.9.4 Tripwires and the decisive test

T3 (scheduler lag) splits per lane: **T3a** compliance oldest-pending > 15 s → page; **T3b** interactive > 60 s → page; **T3c** bulk > 30 min → informational. All three are queries over `scheduled_job` and the lane heartbeat rows — our own tables, rendered in-app (ARR-OPS-05).

**Test L2-P (the storm, priced as a unit test):** enqueue 20,000 `bulk` jobs, then one `compliance` job; assert the compliance job starts within 5 s with the full backlog present. Assert the same with the topology axis `folded`. This is §9.2.3's recovery storm reduced to a build-breaking assertion.

---

### 7.10 (4.4) The missing-worker detector — the highest-impact fold failure

Today the topology test asserts that *declared configuration* covers every route. **Nothing checks the actually running set.** Set the worker's env wrong, or forget the worker service on the split, and: the outbox never drains, T-1h reminders never fire, celebrations never broadcast, the Aloware disenroll never happens (`ARR-EVT-14` — *"a robot keeps texting a lead who already replied STOP"*), the reconciliation backfill and the retention purge never run — **and every screen looks perfect**, because the inline tier still commits the money and bumps the watermark. The fold/split design *creates* this failure class and did not instrument it.

#### 7.10.1 Heartbeats are per **role**, written by the **work loop**

```sql
CREATE TABLE security.required_role (             -- seeded by migration, sealed (§7.6)
  role_name              text PRIMARY KEY,        -- web, worker, worker:compliance,
  max_heartbeat_age_secs integer NOT NULL         -- worker:interactive, worker:bulk, ingest
);

CREATE TABLE security.process_heartbeat (
  role_name     text PRIMARY KEY,
  instance_id   text NOT NULL,
  beat_at       timestamptz NOT NULL,
  image_digest  text NOT NULL,
  schema_version text NOT NULL
);
```

Two design choices carry the whole mechanism:

- **The expectation lives in the schema, not in the deployment.** The required set is seeded by migration and is **topology-independent**: a folded process writes heartbeats for all the roles it mounts. A missing worker service and a `PROCESS_ROLES` that omits `worker` produce the **same** stale row. The misconfiguration cannot edit its own expectation, because the expectation is in the database and sealed.
- **The heartbeat is written by the work loop, not by a timer.** The `worker` row is upserted by the outbox relay's own claim loop; each lane row by its own fetch loop. A process that is *up* but whose relay is wedged still goes stale — which is the failure that matters and the one a liveness ping would miss.

#### 7.10.2 The synthetic assertion that breaks at 2 minutes

```sql
SELECT r.role_name,
       clock_timestamp() - coalesce(h.beat_at, 'epoch') AS age
  FROM security.required_role r
  LEFT JOIN security.process_heartbeat h USING (role_name)
 WHERE h.beat_at IS NULL
    OR h.beat_at < clock_timestamp() - make_interval(secs => r.max_heartbeat_age_secs);
```

`max_heartbeat_age_secs = 120` for `worker` and each lane. A non-empty result fails **leg 3 of the two-legged production synthetic** (which already runs every 5 minutes for the ledger/ETag/SSE check) → page.

#### 7.10.3 The part that makes it undeniable: fifty sellers see it

An alert is not a mechanism when the disease is *"every screen looks perfect."* The same staleness predicate drives the existing `degraded_banner` poll channel (`GET /api/system/status`, already one of the four channels in the load model). When the `worker` role is stale beyond its threshold, the endpoint returns `worker_stalled` and **every signed-in browser renders the amber bar**: *"Background processing is paused. Reminders and call logging may be delayed."* Fifty people asking the same question in the same hour is a detector that cannot be ignored, and it costs one predicate over a table the poll already reads.

#### 7.10.4 Test **L2-W**, which is build-breaking

Boot the stack with `PROCESS_ROLES=web` only and `max_heartbeat_age_secs=2`; then assert:

1. `GET /api/system/status` reports `worker_stalled`;
2. the L3 leg renders the amber bar in a seller's browser;
3. the synthetic query returns the `worker` row and the probe fails;
4. `/admin/system` shows the per-lane last-seen ages;
5. with `PROCESS_ROLES=web,worker,ingest` (folded), **all** required roles beat and the banner does not render — proving the detector is topology-independent rather than a split-only artifact.

Complementary depth metrics, all from our own tables: outbox oldest-pending age, `dead_letter` unresolved count, per-lane scheduler lag (§7.9.4).

#### 7.10.5 (4.1) The folded rung's batch budget is measured, not asserted

A 200 ms cooperative batch on a single-threaded Node process is a 200 ms long task, which blows the ≤100 ms interaction budget, the 34 ms frame budget, P6's "no long task > 50 ms during a drag" and the 80 ms `304` p95 — deterministically, every time an export runs while somebody drags a card. The document answered this by omission. Ruled:

- In a process whose roles include `web`, the cooperative batch budget is **20 ms, not 200 ms**, and it is enforced at runtime: the batch loop yields via `setImmediate` and a `perf_hooks` event-loop-delay monitor **aborts the current batch** when p99 lag exceeds 50 ms, re-queuing the remainder. Heavy work is slower folded; that is the honest price of the cheap rung.
- **P6 runs in the folded topology with a `bulk` job in flight** as a nightly matrix leg. If the folded rung cannot hold the drag budget under load, the build is red and the rung is not honest — which is the answer the review asked for and the opposite of not measuring it.

#### 7.10.6 (4.3) The bulkhead's default bypass gets a deadline and a rotation state

`INGEST_FALLBACK=on` by default mounts ingest routes on web in split mode; the compensating control was an `admin_alert`, which fires exactly where nobody is reading alerts. Improved, though not fully closed: the flag becomes `INGEST_FALLBACK_UNTIL` (a timestamp, boot-asserted to be ≤ 30 days after the image build date, so it cannot mean *forever*); every `ingest_on_web` occurrence increments a per-source counter; crossing the threshold sets `intake_source.rotation_required`, which renders on `/admin/integration-health` and blocks the source from being marked healthy. Residual risk is recorded in §7.12: a stubborn vendor still costs web CPU until an admin rotates the token, because losing the lead is worse than losing the bulkhead.

---

### 7.11 Two more silent leaks closed while adjacent

**Prior-owner identity in the timeline (R3.5 / review-1 B8).** *"Never render another seller's identity in a seller-facing timeline"* had no mechanism: the row is legitimately visible, so the not-found machinery never sees it. Closed at the column: `CHECK (NOT (render_payload ? 'actor_display_name'))` on `timeline_entry`, plus the existing rule that copy is an ICU key with params rather than a rendered sentence. The projector writes `actor_label_key='timeline.actor.previous_owner'` whenever `actor_user_id <> owner_user_id`. **The payload cannot carry the name**, so the leak has no channel.

**`contact.owner_changed` must never reach the ledger (review-1 B13).** `ref.event_consumer` can express what a consumer *is*, not what it must never be. Added as a positive assertion of the negative fact: a CI query asserts the exact ledger-input set is `{opportunity.won, opportunity.value_changed, opportunity.reopened, contact.merged, <admin adjust>}` — five names, byte-compared to a sealed table. Adding `contact.owner_changed` to the money chain is a red build, and the two events are one keystroke apart in the registry.

---

### 7.12 What Jorge sees on a screen — the validation contract

Every mechanism above has a behaviour, because behaviour is the only thing that gets validated here.

| If this breaks | What Jorge (or a seller) sees |
|---|---|
| Board read written against the projection again | *"Couldn't load the leaderboard"* — `permission denied`, that minute |
| Premium edited outside the definer | The save fails on screen with the specified copy; the number never changes without a ledger row |
| A table created in `public` | **The deploy fails**, naming the table. Nothing ships |
| A gate condition added without refusal copy | **The deploy fails**, naming the constraint |
| A close path that credits nothing | The drag fails at COMMIT the first time it runs |
| A restore that lost `FORCE` | **Nothing boots.** An outage, not fifty full books |
| A missing or wedged worker | **Amber bar in every browser** within 2 minutes, plus a page |
| A frozen leaderboard ETag | `/admin/system` shows "last ETag change N s ago" climbing; T5 pages |
| A capability marked verified without evidence | The process exits non-zero in production |
| The roles variable misspelled | **The deploy fails.** Never a silent default mount |
| A guarded file loosened | `/admin/system`: *"guards changed since last release: N"*, permanently, with the file list |
| An endpoint added with no silo probe | It does not compile |
| A hand-written loader under `routes/api/**` | It is not routed — 404 in E2E |
| A job added with no latency class | **The deploy fails** |

---

### 7.13 New schema gates and registries introduced by this pass

| Artifact | Kind | Closes |
|---|---|---|
| `app.leaderboard_read(period)` + `REVOKE SELECT ON leaderboard_projection` | definer + privilege | Scenario A, ARR-MVP-10, ARR-EVT-23, review-1 A2/B3/B4 |
| `app.opportunity_set_premium()`, `app.ledger_adjust()` | definer | Scenario B, ARR-EVT-07, review-1 B1/B15 |
| `app.money_cents` domain + `definer_only_columns` | domain + registry column | Scenario B generalised, review-2 1.14 |
| `security.schema_exception`, schema-agnostic `harden()` loop | deploy raise | Scenario C, review-2 3.1 |
| `app.stage_move()` subtransaction + `ref.constraint_refusal` | definer + registry | Scenario D, ARR-EVT-11, ARR-MVP-09 |
| `t_earning_must_credit` (deferred constraint trigger), `opportunity.earnings_credited` | trigger + column | review-2 3.3, review-1 B2 |
| `security.seal`, `ci/seal-manifest.jsonl`, `ci/guards.json` | hash chain sealed in prod | review-2 §3 systemic finding |
| `ref.inline_consumer_allowlist`, `ref.etag_none_exception`, `ref.ui_loader_whitelist` | seeded relations | the three "PR touching one file" lists |
| `siloProbe` (non-optional), fixture `silo-collision` | type + fixture | review-2 3.2, ARR-UX-04 |
| Branded endpoint factory + registry-generated route table | build failure | review-2 3.4, C7 |
| `SystemTx`, `app.begin_request()`, `security.function_registry` + `GRANT EXECUTE` allowlist | type + privilege | review-2 3.5, ARR-PRV-03 |
| Bundle-reachability emitter gate + `ref.event_schema.no_mvp_emitter` | build + registry | review-2 3.6, review-1 B5 |
| `ref.capability_probe` + digest-linked boot assertion | FK + boot | review-2 3.7 |
| `security.harden_run.catalog_digest` posture assertion | boot refusal | review-2 3.9 |
| `ref.job_registry.priority` + reserved lanes + lane boot assertion | registry + deploy + boot | review-2 1.9, 1.10, ARR-EVT-13, ARR-MVP-18 |
| `security.required_role`, `security.process_heartbeat` + amber bar | schema + screen | review-2 4.4, ARR-OPS-03 |
| `ref.external_surface` + pattern grep gate | seeded relation | review-2 C2 |
| `app.begin_job()` (tenant re-derived from subject) | definer + type | review-2 C5, data-model open ruling |
| **S16–S19** (ledger policy shape, non-money bigints, single exception block, unmetered webhook resolver) | catalog queries | A, 1.14, D, C3 |


---

# §3 — Approved requirements the architecture did not cover

## 10 · Approved requirements the architecture does not cover — closure

Sections 1–9 designed the system. This section closes the twenty approved requirements that survived that design without an implementation surface. It is not a wish list: every entry below ends in a **database object, a revoked privilege, a trigger, a type that does not compile, a build that goes red, or a symptom a seller sees on their own screen**.

**The admissibility rule for everything in this section.** This project has no code reviewer and no reviewed pull request. Therefore two constructions are inadmissible as enforcement and are treated as documentation wherever they appear:

1. *"a PR that touches that file and nothing else"* — it presumes a reviewer reading a diff.
2. *"a CI test asserts a count equals a literal in the test file"* — the literal is edited and the build goes green.

Where an existing mechanism in sections 1–9 rests on either construction, this section replaces it. Where a closure below needs a counted or listed fact, it is stored in `ref.ci_ratchet` (§10.0.1), which refuses the loosening write at the engine.

---

### 10.0 · Four general machines the individual closures depend on

These are built once and then reused eleven times below. Building them separately in eleven places is how a mechanism becomes a convention.

#### 10.0.1 `ref.ci_ratchet` — every budget, exception list and count becomes append-only at the engine

The systemic finding of the adversarial review is that roughly a third of the declared mechanisms reduce to "the model edits the literal and the build goes green". The general answer is the same append-only engine that already protects the money.

```
ref.ci_ratchet (
  name          text NOT NULL,             -- 'perf.P12_initial_js_gzip', 'events.inline_consumer_count', …
  direction     app.ratchet_direction NOT NULL,   -- ENUM: monotonic_down | monotonic_up | frozen_set
  value_num     bigint,
  value_set     text[],
  set_by_run    text NOT NULL,             -- CI run id, NOT NULL
  set_at        timestamptz NOT NULL DEFAULT clock_timestamp()
)
```

- **PK** `(name, set_at)`. Append-only by the same statement-level `BEFORE UPDATE OR DELETE OR TRUNCATE` trigger raising `AP001` used by `earnings_ledger`, plus `REVOKE UPDATE, DELETE, TRUNCATE`.
- **A `BEFORE INSERT` trigger refuses a loosening write.** For `monotonic_down`, a new `value_num` greater than the current minimum raises `AP002`. For `monotonic_up`, the inverse. For `frozen_set`, a new `value_set` that is not a **superset** of the previous one raises — additions are allowed, removals are not.
- CI connects as a dedicated role `crm_ci` holding `INSERT` and `SELECT` only. **Loosening a budget or deleting a frozen assertion is not a file edit; it requires `crm_migrator` and a migration.**
- The CI job reads the ratchet at start and compares the repository's `perf-budgets.json` against it. A repository value looser than the ratchet fails the run **before any test executes**, so "edit the budget to green the build" produces a red build with the message `perf.P12 loosened from 250000 to 400000 — refused by ratchet`.

Registered names at go-live: every `P1…P25` threshold; `events.inline_consumer_count`; `events.ledger_input_set` (frozen set); `rls.exception_list` (frozen set); `migrations.destructive_allowlist` (frozen set); `fixtures.events_v1` (frozen set of file digests); `ui.card_h_desktop` / `ui.card_h_mobile`.

Registry class `reference` in `security.table_registry`, `exception_reason = 'CI enforcement ledger, no tenant dimension, INSERT-only to crm_ci, immutable by trigger'`.

**Why this is not itself walkable:** the only actor who can weaken a ratchet is the actor who can run migrations, and the migration job is attached to exactly one service (ADR-S4) whose credentials never exist in CI or in the running processes (SEC-3).

#### 10.0.2 `security.column_classification` — `harden()` raises at column granularity

`security.table_registry` classifies tables. Three separate requirements below (PII masking on exports, the money-type gate, the timeline identity leak) need the same fact one level down, so it is built once.

```
security.column_classification (
  schema_name  text, table_name text, column_name text,
  pii_class    app.pii_class    NOT NULL,   -- none | direct_identifier | contact_point | sensitive | financial
  value_kind   app.value_kind   NOT NULL,   -- id | money | count | sequence | epoch_ms | text | enum | json
  mask_strategy app.mask_strategy NOT NULL, -- none | redact | last4 | hash | truncate_domain
  registered_in_migration text NOT NULL
)
```

- **PK** `(schema_name, table_name, column_name)`.
- `CHECK (pii_class = 'none' OR mask_strategy <> 'none')` — a PII column with no masking strategy cannot be classified.
- **`security.harden()` raises on any column of any relation in `app` with no classification row, exactly as it already raises on an unclassified relation.** It is the last statement of the pre-deploy migration job, so **a migration that adds a column without classifying it fails the deploy.** This is strictly stronger than a CI check: CI can be amended, a deploy that will not proceed cannot.
- Consumers: the export masker joins to it (§10.16), the money-type gate reads `value_kind = 'money'` from it (§10.20), and the timeline read is generated from it (§10.8).

#### 10.0.3 The promotion gate — "fails the build" restated honestly under a 2,000-minute budget

`R6` says the performance budgets *"fail the build, not a dashboard"*. Under the CI minute budget, Lighthouse, k6, axe and rAF sampling cannot run per pull request. The design's answer today is "nightly", and a nightly failure blocks nothing. That is the gap, and the honest closure is not to move the tests — it is to move the gate.

> **Ruling.** Merge-time gates are the pre-merge tier. **Release-time gates are the perf and accessibility tiers, enforced by the deploy job, not by CI.**

Mechanism, in the one place that cannot be amended:

- The nightly writes `ref.ci_ratchet('release.last_green_nightly', frozen_set, {<commit_sha>})` and a companion row `release.last_green_nightly_at`.
- **The pre-deploy migration job's first statement asserts** that the commit being deployed has an ancestor in that set whose age is under 48 hours. It exits non-zero otherwise, `harden()` never runs, and the **old image stays live** — the same failure shape as an unclassified relation.
- The break-out is deliberately unpleasant and visible: setting `PERF_GATE_OVERRIDE=<sha>` in the provider dashboard allows one promotion and writes `admin_alert(kind='release_gate_overridden')`. That alert is **unacknowledgeable** until a green nightly lands (a `CHECK` on the acknowledge path against the ratchet row), so it sits on `/admin/integration-health` as a red line Jorge sees on the screen he already looks at.

This is what converts P1–P6, P8, P9, P14–P20 and the axe suite from a dashboard into a gate without spending minutes the budget does not have.

#### 10.0.4 Deferred constraint triggers — the "credited zero times" family

Every net in the money design guards against crediting **twice**. Nothing guards against crediting **zero** times: if `app.ledger_append` is dropped from the close-gate path in a refactor, the fan-out `WHERE delivery IN ('outbox','pgboss')` guarantees no outbox row either, and the sale is credited nowhere with every test green.

The general shape used three times below:

```sql
CREATE CONSTRAINT TRIGGER <name>
  AFTER INSERT OR UPDATE OF <cols> ON app.<table>
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (<state predicate>)
  EXECUTE FUNCTION app.assert_<invariant>();
```

Deferred to COMMIT, so statement ordering inside the transaction is irrelevant and the assertion cannot be defeated by writing the ledger row "later in the function". A transaction that ends with a money-bearing state and no money row **cannot commit**, and the seller sees the published copy *"Couldn't record this sale — nothing was saved."*

---

### 10.1 · B1 — Admin void / adjust-with-reason (`US-9.13`, MVP item 61, `04b` C-12)

**What is required.** A typed reason from a fixed list, an offsetting `entry_type = 'manual_adjustment'` row, the original never deleted or edited, the affected seller's total and rank updating, and **the reason text visible to that seller in My Earnings**. `US-9.13` calls this *"the only sanctioned way to change a number that is already public."*

**Why it is unimplementable today.** `crm_app` has no DML on `earnings_ledger` at all — correct, and it means there is no path. The enum already carries `manual_adjustment`; nothing else exists: no definer, no typed reason, no admin re-assertion, no render obligation.

#### The schema

```sql
CREATE TYPE app.adjustment_reason AS ENUM
  ('duplicate_credit','wrong_amount','test_data','other');   -- exactly four

ALTER TABLE app.earnings_ledger
  ADD COLUMN adjustment_reason app.adjustment_reason,
  ADD COLUMN adjusts_entry_id  uuid,
  ADD CONSTRAINT ledger_adjust_shape CHECK (
        entry_type <> 'manual_adjustment'
     OR (adjustment_reason IS NOT NULL
         AND adjusts_entry_id IS NOT NULL
         AND actor_user_id   IS NOT NULL
         AND length(btrim(reason)) >= 10)),
  ADD CONSTRAINT ledger_adjust_exclusive CHECK (
        adjustment_reason IS NULL OR entry_type = 'manual_adjustment'),
  ADD CONSTRAINT ledger_adjust_fk
      FOREIGN KEY (tenant_id, adjusts_entry_id)
      REFERENCES app.earnings_ledger (tenant_id, id);
```

- **The reason is required by the engine, not by a Zod schema.** A ten-character minimum after trimming means whitespace does not satisfy it.
- **You cannot adjust a row that does not exist**, by foreign key.
- **Exactly four reasons.** A fifth is `ALTER TYPE`, i.e. a migration. A CI catalog gate asserts `enum_range(NULL::app.adjustment_reason)` has four labels — the same mechanical form as the three-label role enum.

#### The writer

`app.ledger_adjust(p_entry_id uuid, p_reason app.adjustment_reason, p_reason_text text)`, `SECURITY DEFINER`, owned by `crm_migrator`, and it has **no amount parameter**. That is the load-bearing property:

> A void is always **exactly the negation of a named row**. An admin cannot invent a number, because the function signature cannot express one.

The body, in one transaction: re-assert `app.current_tenant()` (satisfies gate S8); re-read `app_user.role = 'admin'` **from the table**, never from the GUC; copy `owner_user_id`, `opportunity_id`, `contact_id`, `stage_id`, `stage_name_snapshot`, `stage_config_version`, `business_tz_snapshot` and **all three `period_*` keys from the adjusted row** (a void of a January credit must leave January's board, not today's); set `delta_cents := -original.delta_cents`; set `source_event_id := uuidv5(NS_LEDGER_ADJUST, adjusts_entry_id::text)`; append; bump `leaderboard_projection`; bump `channel_watermark`; `app.event_emit('earnings.updated', …)`; `app.audit_write(...)`.

The deterministic `source_event_id` means **the existing `UNIQUE (tenant_id, source_event_id)` makes a double-click a no-op success path and makes any ledger entry voidable at most once, ever** — with no new code and no check-then-insert race.

#### Denial shape and the missing second factor

The route is `scope: 'tenant_admin'`; a seller or supervisor receives the owner-scoped not-found, byte-identical to a genuine 404 (`ARR-UX-04`, the break-glass pattern). The definer's `insufficient_privilege` raise is the second net for a route added without the scope declaration.

**MFA is declared `false` on this endpoint, and that is a ruling, not an omission.** The signed stack removed transactional email to V1.1, so an admin who loses a TOTP device has no self-service recovery and would permanently lose break-glass — the compliance escape hatch that exists for the case where fifty sellers cannot dial. Mandating a second factor with no enrolment recovery buys less than it costs. **The compensating control is mechanical and better suited to this product: the person whose number changed sees the change and the reason on their own screen.** See below.

#### The seller-visible obligation, as a type

`My Earnings` reads the ledger directly (the private path). The row type is a discriminated union:

```
type LedgerRow =
  | { kind:'sale';              delta: Money; … }
  | { kind:'reversal';          delta: Money; … }
  | { kind:'value_correction';  delta: Money; reason_text: string }
  | { kind:'manual_adjustment'; delta: Money;
      reason_code: AdjustmentReason;      // required
      reason_text: string;                // required, non-optional
      adjusts_entry_id: LedgerEntryId }
```

The renderer is an exhaustive `switch` closed by a `never` check. **A `manual_adjustment` row that renders without its reason does not compile.**

Protected E2E `DEMO-11`: an admin voids seller A's credit; within one poll interval A's My Earnings shows the offsetting row carrying the reason text, A's leaderboard total drops by exactly that amount, and the original row is still present.

**Complexity:** low. One enum, three constraints, one definer, one union type.

---

### 10.2 · B2 — D-4, one credit per opportunity (`R1.6`, `US-9.2`, `03-mvp-stories` D-4)

**The defect, stated precisely.** The whole exactly-once story is `UNIQUE (tenant_id, source_event_id)`. That key is satisfied by a **second, genuinely distinct event** — which is exactly the earning→earning move and exactly the `R1.6` wrap-up-"Sold"-plus-drag double path. The guard must be a **state**, not an event key.

#### The mechanism: a credit epoch plus two partial unique indexes

```sql
ALTER TABLE app.earnings_ledger ADD COLUMN credit_epoch integer NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX earnings_one_sale_per_epoch_uidx
  ON app.earnings_ledger (tenant_id, opportunity_id, credit_epoch)
  WHERE entry_type = 'sale';

CREATE UNIQUE INDEX earnings_one_reversal_per_epoch_uidx
  ON app.earnings_ledger (tenant_id, opportunity_id, credit_epoch)
  WHERE entry_type = 'reversal';
```

`credit_epoch` is computed inside `app.ledger_append` as the count of prior `reversal` rows for that opportunity. Two concurrent gate submissions compute the same epoch; **the index is the arbiter, not the count**, so the second `INSERT … ON CONFLICT DO NOTHING` returns NULL, the function returns `already_credited`, the caller logs and proceeds, and the seller's total is unchanged. That is `R1.6`'s *"the second is a no-op"* as a success path rather than an error — the same shape the `source_event_id` path already uses, so there is one idiom, not two.

Life cycle, and it is the whole requirement: `sale(epoch 0) +3000` → `reversal(epoch 0) −3000` → re-entry `sale(epoch 1) +3000`. Net contribution equals exactly one credit (`US-9.3`). The second index makes an undo double-tap and a replayed `opportunity.reopened` no-ops too.

**Why this beats `opportunity.earnings_credited boolean`.** A boolean lives on a mutable table and needs `UPDATE`; the ledger is immutable by trigger and `crm_app` has no DML anywhere in the money path. The index is a database object no code path can route around: raw SQL, a second definer, a replay job, a webhook consumer and a future refactor all collide with the same index.

#### The counter-net: crediting zero times

Applying §10.0.4:

```sql
-- fires at COMMIT on any transaction that leaves an opportunity in an earning stage
CREATE CONSTRAINT TRIGGER opportunity_earning_requires_credit
  AFTER INSERT OR UPDATE OF current_stage_type ON app.opportunity
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.current_stage_type = 'earning')
  EXECUTE FUNCTION app.assert_credit_exists();
```

`app.assert_credit_exists()` raises unless a `sale` row exists for `(tenant_id, opportunity_id)` at the current epoch. **An opportunity cannot sit in an earning stage at COMMIT with no ledger row.** This closes the adversarial finding that the inline registry is declarative and nothing forces the append: if `app.ledger_append` is dropped from the close-gate path, every close fails loudly at commit instead of succeeding silently with the money missing.

#### Required assertions (named-assertion registry, L2)

`ledger.one_credit.earning_to_earning` · `ledger.one_credit.wrapup_then_drag` · `ledger.one_credit.reverse_then_recredit_nets_one` · `ledger.zero_credit_impossible` (delete the append inside a test transaction, assert `AP0xx` at COMMIT) · `ledger.concurrent_double_submit_yields_one_row`.

**Complexity:** low. One column, two indexes, one deferred trigger.

---

### 10.3 · B3 + Scenario A — the 5-second exclusion and the ETag machine

Two findings with one root and one fix.

**The defect.** The public value is **time-dependent**: a row becomes visible at T+5.5 s with **no writer at T+5.5 s**. The design knows this and answers with `ETag = hash(max(seq), pending_watermark)`. But the correction CTE and the watermark are both computed under the **reader's** RLS scope, and `earnings_ledger` is `append_only_owner`. Therefore:

- the winner's own board correctly hides the pending row;
- **every other seller's board shows it instantly**, and corrects itself in front of the whole floor if undone — the exact outcome `R1.3` / `ARR-MVP-10` exists to prevent;
- for 49 of 50 sellers `pending_watermark = 0` and never changes, so the ETag is frozen and the board silently stops updating;
- **the natural test passes**: win as A, poll as A, assert exclusion.

Neither of the two obvious exits is acceptable. Widening `earnings_ledger` to tenant-wide read exposes `opportunity_id`, `contact_id`, `stage_name_snapshot`, `product_type`, `delta_cents` and `reason` across the silo inside a CTE that no screen renders and no silo test inspects — a cross-silo PII leak with no UI symptom.

#### The ruling

> **The public leaderboard read is `app.leaderboard_read(period_type, period_key)`, `SECURITY DEFINER`, returning `(user_id, display_name, avatar_ref, total_cents, rank, is_active, tenant_total_cents, etag)` and nothing else.** The projection, the pending correction and the ETag are all computed **tenant-wide inside the function**. `earnings_ledger` RLS is not widened.

The return type is the containment: *you cannot leak a column the function does not return*. The same fact simultaneously satisfies `ARR-EVT-23`'s "a payload type that literally cannot express lead data" (§10.19).

#### The mechanical proofs, because a corrected formula is not a mechanism

1. **Byte-identity across readers (L2, protected).** Seller A wins. Read `/api/leaderboard` as A, as B and as a supervisor. Assert **all three ETags are byte-identical**, all three bodies are byte-identical, and the pending entry is absent from all three. Any scope-dependent computation makes this red.
2. **The zero-writer transition (L2, protected).** With **no intervening write**, sleep past `undo_window_ms + undo_projection_guard_ms` and re-read. Assert the ETag **changed** and the entry is now present, for all three readers. This is B3 stated as an assertion: if time cannot move the ETag, this test is red. It costs one real 5.5-second sleep in one integration test.
3. **`REVOKE SELECT ON app.leaderboard_projection FROM crm_app`.** Today the projection is sanctioned cross-silo exception #1 with a tenant-wide read policy — which is exactly the door through which a handler-written board query reappears without the pending correction. After this closure the projection is `definer_only`: `USING (false) WITH CHECK (false)`, readable only inside `app.leaderboard_read()`. The exception list shrinks from two entries to one, and the S4 gate enforces the shrink because the exception list is a `frozen_set` ratchet — an entry can be added only by migration, and this removal is a migration.
4. **The dangerous-direction alarm, which does not exist anywhere today.** The scale section states the ETag failure backwards and alarms only on the 304 share *dropping* (the benign, expensive direction). The dangerous direction is **304 share pinned at 100 % while writes are happening**. Production monitor: `channel_watermark.seq` for `(tenant, ZERO_UUID, 'leaderboard')` increased in the last 10 minutes **AND** zero `200` responses observed on `/api/leaderboard` in the same window → page. The L4 two-legged probe extends to the board: the probe seller writes a real ledger row (ADR-T6) and a **second** probe session's conditional GET must flip 304→200 inside P21.

**Complexity:** medium. One definer, one policy change, one alarm, two tests.

---

### 10.4 · B4 — the leaderboard cannot be built from ledger appends alone

**What is required.** `US-9.5`: *"every active seller in the tenant is listed… a seller with `$0` is shown at the bottom, never hidden."* Protected item 9: *"fifty names, fifty `$0`"* on go-live day. `US-9.12`: a deactivated seller *"disappears from the Today/Week/Month boards, and on the All-time board they remain with an **Inactive** chip."* `US-9.6`: supervisors get no self-row but a tenant total.

A projection upserted only on ledger append contains rows only for sellers who have sold. On go-live day the board is empty and the headline differentiator demos as a blank screen.

#### The read is a LEFT JOIN inside the definer, and the period rule is a predicate

Inside `app.leaderboard_read()`:

```sql
FROM app.app_user u
LEFT JOIN app.leaderboard_projection p
       ON p.tenant_id = u.tenant_id AND p.user_id = u.id
      AND p.period_type = $1 AND p.period_key = $2
WHERE u.tenant_id = app.current_tenant()
  AND u.role = 'seller'                       -- supervisors are structurally absent
  AND ( $1 = 'all_time'
          AND (u.deactivated_at IS NULL OR u.earnings_disposition = 'keep_in_history')
        OR $1 <> 'all_time' AND u.deactivated_at IS NULL )
```

with `COALESCE(p.total_cents, 0)` and `is_active := (u.deactivated_at IS NULL)`. Fifty names and fifty `$0` fall out of the `LEFT JOIN` on day one with no seed. `US-9.12`'s appear/disappear rule becomes a **predicate difference, not a UI filter** — there is no client-side list to forget to filter, and the Inactive chip is driven by returned data.

#### The ETag must move when the roster moves

The day a fiftieth seller is created, nobody's board shows them until an unrelated seller sells. Fix:

```sql
CREATE TRIGGER app_user_bumps_leaderboard
  AFTER INSERT OR UPDATE OF display_name, deactivated_at, earnings_disposition, role
  ON app.app_user FOR EACH ROW
  EXECUTE FUNCTION app.bump_leaderboard_watermark();
```

A trigger, not a service call, so an admin screen, the demo seeder, a migration and a raw SQL correction all bump it. This is precisely the class of writer a service-layer bump misses.

#### A ledger row can only belong to a seller

`app_user` already carries the redundant `UNIQUE (tenant_id, id, role)` provisioned *"so other tables can carry an FK-guaranteed denormalized role copy if ever needed."* It is needed:

```sql
ALTER TABLE app.earnings_ledger
  ADD COLUMN owner_role app.user_role NOT NULL DEFAULT 'seller',
  ADD CONSTRAINT ledger_owner_is_seller CHECK (owner_role = 'seller'),
  ADD CONSTRAINT ledger_owner_role_fk
      FOREIGN KEY (tenant_id, owner_user_id, owner_role)
      REFERENCES app.app_user (tenant_id, id, role);
```

**A ledger row for a supervisor or an admin cannot be committed**, so "supervisors get no self-row" is a schema fact and not a rendering rule.

#### Protected screen assertions

`DEMO-12`: fifty sellers, zero ledger rows → the board renders fifty rows, all `$0`, the published empty-state copy, and no row hidden at 375 px. `DEMO-13`: deactivate a seller holding credits → absent from Today/Week/Month, present on All-time with the `Inactive` chip, and the observing seller's board updates within one poll interval without a manual refresh.

**Complexity:** low, given §10.3's definer already exists.

---

### 10.5 · B5 — the 49-name coverage gate is unsatisfiable, and satisfiable dishonestly

Two defects in one gate. *"CI asserts that all 49 names appear at least once in `event_log`"* is **red on day one**, because several canonical names have no MVP emitter by approved scope decision — and the predictable response to a permanently red gate is that somebody deletes it. And it is **satisfiable by a test helper that emits the missing name**, so it measures table contents rather than reachable code.

#### Part 1 — the emitter state is a column, and the gate becomes two-sided

```sql
ALTER TABLE ref.event_schema
  ADD COLUMN mvp_emitter app.emitter_state NOT NULL,     -- app | operator_tool | deferred_v1_1
  ADD COLUMN deferred_reason text,
  ADD COLUMN deferred_by_requirement text,
  ADD CONSTRAINT emitter_deferral_documented CHECK (
        mvp_emitter <> 'deferred_v1_1'
     OR (deferred_reason IS NOT NULL AND deferred_by_requirement IS NOT NULL));
```

Seeded as `deferred_v1_1`, each citing the approved decision that cut it: `sequence.enrolled`, `sequence.paused`, `sequence.completed`, `automation.executed` (no cadence engine — `03-mvp-definition` §4 DEFECT CHECK; the architecture already registers `sequence_enroll` as `probe_only`); `calendar.sync_failed` (two-way Google Calendar sync is V1.1). Seeded as `operator_tool`: `lead.import_completed` (CSV import ships as a script plus runbook, not a wizard). `call.enriched` stays `app` — it is emitted by the merge job for disposition enrichment and is unrelated to the recording ruling.

**The gate is two-sided, and that is what makes flipping the column useless:**

- every `app` name **must** appear in `event_log` at the end of the integration suite;
- every `deferred_v1_1` name **must not** appear in `event_log` **and must not appear as an emitter call site in the built bundle**.

Flipping a name to `deferred_v1_1` to green the build turns the other side red the instant any code emits it. If no code emits it, the name is genuinely deferred — which is the truth we wanted recorded.

#### Part 2 — the gate asserts reachable code, not table contents

`emit()` is typed `emit<N extends EventName>(name: N, …)` and an ESLint rule forbids a non-literal first argument. After `pnpm build`, `tools/emitter-scan.mjs` walks the **production bundle's** module graph from the declared process entrypoints (the same generated role registry that drives §10.19) plus the declared operator-tool entrypoints, and collects every emitted literal. The collected set must equal the `app` ∪ `operator_tool` set exactly.

**A test helper is not in the production bundle, so it cannot satisfy the gate.**

#### The payoff

`SELECT event_name, deferred_reason, deferred_by_requirement FROM ref.event_schema WHERE mvp_emitter = 'deferred_v1_1' ORDER BY 1` **is** the V1.1 backlog. It is emitted into `docs/generated/event-catalog.md` by the same generator, so the drift gate (`pnpm gen:events && git diff --exit-code`) prevents it from being edited into agreement with a wish.

**Complexity:** low for the column, medium for the bundle scan.

---

### 10.6 · B6 — the R6 budgets and the `04b` regression assertions have no build-breaking home

Three distinct gaps, three closures.

**(a) Nightly is not a gate.** Closed by §10.0.3: the promotion gate makes P1–P6, P8, P9, P14–P20 and the axe suite block **the release**. The failure Jorge sees is a deploy that stops and an unacknowledgeable red line on `/admin/integration-health`.

**(b) `perf-budgets.json` can be edited to green a build.** Closed by §10.0.1: every threshold is a `monotonic_down` ratchet row in Postgres. Loosening requires `crm_migrator`. The CI job compares the repository file to the ratchet **before running any test**, so the loosened value never gets the chance to pass.

**(c) `04b`'s R2-1…R2-14 have no home at all.** They are mapped here, once, and the mapping is generated rather than transcribed.

| Check | Level | Mechanism |
|---|---|---|
| **R2-1** card box / uniform pitch | L3 on `perf-500` | Computed height of every `KanbanCard` variant equals `--card-h`; column pitch variance = 0. Runs on the same fixture as P6, so it also discharges **B7(b)** and publishes `C11`'s 120/156 as a ratchet value |
| **R2-2** node budget | L3 | ≤ 28 DOM nodes/card, ≤ 14 rendered cards/column at any viewport |
| **R2-3 / R2-4** signal slot, R3.6 chip slot | L3 | One signal chip max; a payload carrying the recent-contact flag that renders without the chip fails |
| **R2-5** `first_touch_at` writer | L2 catalog | Only `pipeline.speed_to_lead` (consumer of `call.completed`) is registered against `first_touch_latency_seconds`; the write-once trigger is the second door. The **absence** of any `call.initiated` binding is asserted by name |
| **R2-6** `rot_threshold` | **L0, two doors** | ESLint/grep over the whole repository including `en-US.json`, migrations and SQL: any word-boundary occurrence of `rot_threshold` fails. Plus a catalog gate: `information_schema.columns` contains no column matching `%rot%threshold%` in any schema. This is `R1.7` in mechanical form |
| **R2-7** non-owner identity in a timeline | L2 + L3 | See §10.8 |
| **R2-8** retry chip | L3 | Tapping a retry chip must close the sheet; `Save` must not render on an empty note field |
| **R2-9** four-states coverage | L3, registry-driven | See §10.15 — the four states are declared per screen and iterated |
| **R2-10** string length | L0 | Production font metrics at 375 px over `en-US.json` |
| **R2-11** target size | L3 | 44×44 / 8 px separation on card, My Day row, action bar, block panel, wrap-up sheet |
| **R2-12** animatable-property lint | L0 | No `transition`/`animation` on a non-compositor property inside `src/board/**` |
| **R2-13** skeleton box diff | L3 | Every skeleton box equals its loaded box |
| **R2-14** axe subset | **pre-merge** | Component-level axe on the eight named surfaces × four states, in the `fast` job |

**The mapping cannot rot.** `required-assertions.json` is **generated** from the union of the route table, `contracts/ui/regression-checks.yaml` (the R2 table transcribed once), the `DEMO-*`/`D3-*` id list and the P-number table. A CI test fails if any id resolves to zero or more than one non-skipped test. Deleting a check from the yaml removes it from `docs/generated/` too, and the `frozen_set` ratchet `ui.regression_checks` refuses the removal at the engine.

**Complexity:** medium — the individual assertions are cheap; the generated registry is the work.

---

### 10.7 · B7 — the two items `R7` carried to Phase 5

**(a) The lead-local timezone data source — closed, with the two mechanisms it was missing.**

`SEC-9` / `ADR-SEC-01` rules the chain (bundled ZIP/ZCTA→IANA primary, NANPA area code always `tz_confidence='low'`, state last, fail-closed at every level, candidate-set intersection on straddles). That is the decision `R7` asked for. Two things it does not yet have, and both matter because this feeds a **hard block that can stop fifty sellers**:

1. **A deploy assertion on the dataset itself.** An empty or half-loaded `ref.zip_timezone` produces `blocked_timezone_unknown` for every dial in the tenant — a floor-wide outage with no error anywhere. The pre-deploy job asserts `count(*) >= system_constant['tz_dataset_min_rows']` **and** that the loaded dataset version equals `system_constant['tz_dataset_version']`, and exits non-zero otherwise. A deploy that would stop the floor does not proceed.
2. **A screen symptom.** `/admin/integration-health` renders `Time zone dataset: <version> · <row_count> rows · sources verified <date>` alongside a rolling count of `blocked_timezone_unknown` verdicts. A broken or stale dataset shows as a spike on a number Jorge already looks at, rather than as fifty sellers phoning him.

**(b) Fixed card height re-validated against a real 500-card render — added to the gate ladder.**

Gate **G12** already runs a 1200 ms drag across three columns of a 500-card board at 2× CPU. Its assertion set gains: every `KanbanCard` variant's computed height equals `--card-h`; the full anatomy including the `R3.6` reserved chip slot renders without overflow at 375 px with production font metrics; and the measured values are written to `ref.ci_ratchet` as `ui.card_h_desktop` / `ui.card_h_mobile`.

> **Failure criterion, declared now so it is not improvised.** If `120 / 156` (the `04b` Part 1–2 ruling that supersedes §3.6's `108 / 92` — finding C11) cannot hold the mandated anatomy at 500 cards while meeting P6, **the anatomy is cut, not the height.** The height is what makes the virtualization arithmetic true; the anatomy is negotiable and the arithmetic is not.

**Complexity:** low. Both are additions to gates that already exist.

---

### 10.8 · B8 — `R3.5`, never render another seller's identity in a timeline

**Why the existing machinery misses it.** After an ownership repair the timeline rows legitimately belong to the new owner (`timeline_entry.owner_user_id` is denormalized and moves with the contact), so RLS passes, the owner-scoped not-found machinery never engages, and the leak renders as a **name on the screen**. This is a silo breach with a perfectly healthy-looking system.

**Where the leak actually lives.** `timeline_entry` has no `actor_user_id` column; it has `render_payload jsonb`. A name inside free-form JSON is worse than a column: it cannot be classified, cannot be revoked, and cannot be seen by any catalog gate.

#### Three mechanisms, in the order they fire

1. **The identity is promoted to a real column and forbidden inside the JSON.**

```sql
ALTER TABLE app.timeline_entry
  ADD COLUMN actor_user_id uuid,
  ADD CONSTRAINT timeline_no_actor_in_payload CHECK (
      NOT (render_payload ?| ARRAY['actor_name','actor_display_name',
                                   'actor_initials','actor_avatar_url','actor_user_id']));
```

The engine refuses a payload carrying an actor identity key. `render_payload` is additionally validated per `kind` against a generated JSON Schema with `additionalProperties: false`, asserted over stored rows in the weekly tier.

2. **The column is unreadable by the application role.**

`crm_app` reads `timeline_entry_live` (S9 already forces the view-only pattern), and **the view does not contain `actor_user_id`.** New catalog gate **S17**: `crm_app` holds no column privilege on `app.timeline_entry.actor_user_id` in `information_schema.column_privileges`. *You cannot leak a column the view does not contain* — the same sentence that protects the leaderboard, applied to the second place it is needed.

3. **The seller-facing read is a definer that returns a label key, never an identity.**

`app.timeline_read(contact_id, cursor)` returns `actor_label_key` and a `actor_display_name` that is **NULL unless the actor is the reader**:

```sql
CASE WHEN te.actor_user_id = app.current_user_id() THEN 'timeline.actor.you'
     WHEN te.actor_user_id IS NULL                 THEN 'timeline.actor.system'
     ELSE 'timeline.actor.previous_owner' END
```

`timeline.actor.previous_owner` maps to the locked catalog string `Handled before this record moved to you` (`R3.5` verbatim; locked under `ARR-MVP-28`, so a snapshot test on this string is a legitimate build-breaker). The supervisor path uses the same function under `app.scope_is_global()` and writes the `book.viewed` audit row.

#### The assertion (R2-7, protected)

Two-context L3: A's contact with three activities is transferred to B; B opens the timeline; assert **zero occurrences of A's display name, full name, initials, avatar URL or user id — in the network response body, not only in the DOM.** Asserting on the body is what catches "the name shipped and CSS hid it".

**Complexity:** medium. One column, one CHECK, one view change, one definer, one catalog gate.

---

### 10.9 · B9 — STOP has no priority lane through the ingest bulkhead

`ARR-EVT-13` is non-negotiable and the language is unusual: *"Loss **or delay** of that hop is a legal failure, not a UX degradation."* The bulkhead isolates ingest CPU from web CPU and **does nothing for the worker queue**. During the storm the architecture itself sizes — 20,000 queued deliveries draining at 333/s — a STOP is job number 14,000 in a FIFO drain while the T-1h reminder fires and the gate reads a `suppression_list` that does not yet contain the row. `singletonKey` serializes; it does not prioritize. The victim named in §9.2.3 is "the board". The actual victim is TCPA.

#### Mechanism 1 — a latency-criticality axis on jobs, built exactly like `weight`

```
job_registry.priority app.job_priority NOT NULL   -- compliance | interactive | bulk
```

Seeded from the same generated file as `weight`, and **`security.harden()` raises on an unclassified registry row** — the identical mechanism `weight` already proves. Adding a job without a priority fails the deploy.

- `compliance`: `message-merge` where the STOP sniff fired, `consent.stop_recorder` materialisation, `compliance.override_ended`.
- `interactive`: intake `lead.created` (this also closes the `ARR-MVP-18` 5-second SLA, which had no latency axis either).
- `bulk`: webhook replay, export, archive, reconciliation.

**Reserved concurrency, not merely priority ordering.** A priority queue with one worker slot still blocks behind a long-running bulk job. The worker runs three fetch loops with a dedicated slot for `compliance` that `bulk` may never occupy. This is the bulkhead applied *inside* the worker, which is where the storm actually hurts.

#### Mechanism 2 — a STOP sniff at the edge that is not a parse

The ingest edge is deliberately parse-free. The sniff is a **byte scan of the raw body** for the carrier-mandated keyword set (`STOP`, `STOPALL`, `UNSUBSCRIBE`, `CANCEL`, `END`, `QUIT`) — no JSON parse, no schema, no domain read, no allocation. A match sets the enqueued merge job's `priority = 'compliance'`.

- False positives are free (a compliance-priority merge of an ordinary message costs nothing).
- The function lives in `src/ingress/stopSniff.ts`, is pure, is L1 property-tested against the carrier keyword list, and **dependency-cruiser forbids it importing anything from `src/domain/**` or `src/db/**`** — so it cannot grow into a parser and re-import the latency it exists to avoid.
- Declared residual: a STOP arriving base64-encoded or in a field not present in the raw bytes misses the sniff. It still merges, at `interactive` priority.

#### Mechanism 3 — the assertion that makes the lane real

Gate **G6 / P24** gains a named, protected assertion: during the 20,000-webhook replay at 333/s, inject one STOP; assert the `suppression_list` row exists within **5 seconds** and that a dial to that number issued at T+5 s returns `blocked_suppressed`. A STOP that lands behind the backlog is a red build, in both topologies.

**Complexity:** medium. The classification machinery already exists; the reserved-slot worker loop is the new part.

---

### 10.10 · B10 — break-glass expiry and the two override events

**Expiry is already ruled correctly** — `expires_at GENERATED ALWAYS AS (started_at + interval '60 minutes') STORED`, computed on read, with a deterministic two-statement close-then-engage. What is missing is the guarantee that no code path can *read past* the expiry, and an emitter for the two override events.

#### The expired row is unreadable by the code that would honour it

Rather than trusting every future gate author to write `clock_timestamp() < expires_at`:

```sql
CREATE VIEW app.active_override_v WITH (security_invoker = true) AS
  SELECT id, tenant_id, started_by_user_id, reason, scope, started_at, expires_at
  FROM app.break_glass_override
  WHERE ended_at IS NULL AND clock_timestamp() < expires_at;

REVOKE SELECT ON app.break_glass_override FROM crm_app;
GRANT  SELECT ON app.active_override_v   TO crm_app;
```

**An expired override is not visible to any query the gate can write.** Catalog gate **S18**: no `SECURITY DEFINER` function other than the admin history reader may reference `break_glass_override` in `pg_proc.prosrc`; `app.compliance_check` must reference `active_override_v`. The banner, which reads the same view, disappears on its own at sixty minutes with no job, no event and no client timer — `ARR-CMP-03`'s *"expires with no further action"* becomes a read-time fact.

#### The two override events get a registered emitter, and one contradiction is ruled

`compliance.override_started` / `compliance.override_ended` are fully specified in the event layer (payloads, `admin.audit` inline, `realtime.banner_broadcast` outbox) but never registered to an emitter, while the UX flow emits `admin.setting_changed` for the same act.

> **Ruling: the two compliance events are the emitters; `admin.setting_changed` is not emitted for break-glass.** Break-glass is not a setting — it is a time-bounded compliance act with permanent retention. Mechanism, in the established negative-assertion shape: `ref.event_consumer` contains no row binding `admin.setting_changed` to `realtime.banner_broadcast`, and CI asserts that pair's absence by name.

**Who emits `override_ended` on auto-expiry.** The safety property is job-free (the view predicate), so the event is telemetry, not enforcement. `compliance.override_ended` is a `pgboss` job enqueued at engage time with `startAfter = expires_at` and `singletonKey = override_id`. If the worker is dead the override is **still expired** and the banner is **still gone**; only the audit event is late. The gap is alarmed rather than assumed: production monitor on `count(override_started) − count(override_ended)` over rows whose `expires_at` is more than five minutes past. A lazy close inside the read path is explicitly rejected — it would be a general-purpose write channel attached to a read, which is the backdoor pattern the adversary already flagged elsewhere.

**Complexity:** low.

---

### 10.11 · B11 — degraded mode has no state

The Aloware section does specify `app.integration_health` as a row with read-time staleness and a watermark bump. Three things prevent it from being real.

1. **The table is not in the signed 45-table model, so it has no `security.table_registry` row — `harden()` would abort the deploy.** That is the correct failure, and it means the closure is mandatory rather than cosmetic. Registered as: class `tenant_scoped` (the banner must reach every signed-in user including supervisors), `WITH CHECK (false)` for `crm_app`, `immutable = false`, `app_can_insert = false`. Both writers are definers.

2. **"Any process may open, only the probe may close" needs a mechanism, not a rule.** A caller-identity check is unavailable (the database does not know the process role). Instead the close path is gated by a **foreign key to a scheduled-job row**: `app.integration_health_probe_result(p_probe_job_id uuid, p_ok boolean)` carries `FK (tenant_id, probe_job_id) REFERENCES app.scheduled_job` restricted to `kind = 'aloware_health_probe'`, and only the probe dispatcher mints such a row. A request path has no probe id, so the FK refuses it. The circuit closes when the row's own `consecutive_successes` reaches 2 — a **data** rule, not a caller rule, so a lucky success on one seller's request cannot reopen the floor.

3. **The split-topology failure — the breaker trips in the worker while the banner renders from the web — needs the test that proves the shared state works.** Added to the topology matrix and to the protected list: in `split`, drive the Aloware stub to 5xx from the **worker's** outbox dispatch and assert that the **web** process's `GET /api/integrations/aloware/health` flips within one poll interval, the banner renders, every Call button relabels to *Call from my phone*, and the `tel:` link plus the pre-filled Log-a-call sheet appear. The same test runs `folded`. A design where the breaker and the banner live in different processes with no proven channel is exactly what this assertion exists to catch.

**One more mechanical tightening while here.** The polling-channel CI assertion today pins only the sub-30-second set. It is widened to **exact equality on the whole registered map** — `{leaderboard: 5000, call_state: 5000, notifications: 5000, board_since: 15000, my_day_since: 15000, integration_health: 30000}` — stored as a `frozen_set` ratchet. A fourth channel at *any* period fails the build, not just a fourth fast one, because the cost model is driven by total channels and not by the fastest one.

**Complexity:** low.

---

### 10.12 · B12 — quiet hours, the third timezone rule with no home

`US-9.11`: inside the seller's quiet window (default 8 pm–8 am **in their display timezone**) the notification is *"stored and badged but no desktop popup is raised; nothing is dropped."* `D-5` names three timezone rules; this is the third, and it has no home in the notification consumer.

#### The ruling: the server decides, and the client has no input to decide with

```sql
ALTER TABLE app.app_user
  ADD COLUMN quiet_hours_start smallint NOT NULL DEFAULT 20,
  ADD COLUMN quiet_hours_end   smallint NOT NULL DEFAULT 8,
  ADD CONSTRAINT quiet_hours_range CHECK (quiet_hours_start BETWEEN 0 AND 23
                                      AND quiet_hours_end   BETWEEN 0 AND 23);

ALTER TABLE app.notification
  ADD COLUMN desktop_popup boolean NOT NULL;     -- NOT NULL, no DEFAULT
```

`NOT NULL` with **no default** is the mechanism: the `notifications.owner` consumer that forgets to compute it fails the insert. The value is computed inside the consumer with the same `AT TIME ZONE` evaluator used by every other timezone rule in the product — the fourth use of one machine, not a fourth implementation.

**The client cannot recompute or override it.** The notification component's props type carries `desktop_popup: boolean` and **no timestamp**. An ESLint rule bans `Intl.DateTimeFormat().resolvedOptions().timeZone` and `new Date().getHours()` outside `src/format/**`. A client that wanted to evaluate quiet hours has nothing to evaluate.

**The three rules, published once and enforced by import graph.** Tenant business tz → period keys and nothing else. User display tz → all human-facing formatting **and quiet hours**. Lead-local tz → the calling window and nothing else. dependency-cruiser restricts readers of `app_user.display_tz` to `src/format/**` and `src/notifications/**`; readers of `tenant.business_tz` to `src/money/**` and the ledger definer; readers of the lead-local resolver to `app.compliance_check` only.

**Assertions.** L1 property test over every hour of a year in the five US zones, including the wrap-around window (20→8 crosses midnight — the classic defect). L3 protected: with the clock inside the quiet window, assert the row is stored, the badge increments, and `window.Notification` was **not** constructed; then assert the item is visible on return.

**Complexity:** low.

---

### 10.13 · B13 — `contact.owner_changed` needs a negative declaration in the schema

`contact.owner_changed` and `contact.merged` are one keystroke apart in the registry, and one of them is a public-money mutation. The event layer already carries `money_moved = false` as a payload literal and asserts the missing registry pair by name — a good declaration, but a per-pair test is a line someone deletes.

#### The strong form lives in the ledger's own CHECK

```sql
ALTER TABLE app.earnings_ledger
  ADD CONSTRAINT ledger_source_is_a_declared_input CHECK (
        entry_type = 'manual_adjustment'
     OR source_event_name IN ('opportunity.won','opportunity.value_changed',
                              'opportunity.reopened','contact.merged'));
```

**A ledger row sourced from `contact.owner_changed` cannot be committed.** Adding the name is `ALTER TABLE`, a migration and a deploy gate — not a test edit. This is `ARR-MVP-22` and `US-9.12` (*"money does not move with the record"*) expressed as an engine fact.

#### The positive set is a frozen ratchet, not a literal

`SELECT event_name FROM ref.event_consumer WHERE consumer_name = 'earnings.ledger'` must equal exactly `{opportunity.won, opportunity.value_changed, opportunity.reopened, contact.merged}`, stored as `events.ledger_input_set` in `ref.ci_ratchet` with `direction = 'frozen_set'`. Additions require a migration; **removals are refused by the trigger**, which is the direction that matters — the failure mode is a refactor that quietly drops `opportunity.value_changed` and silently corrupts the all-time board.

#### And the symmetric positive: `contact.merged` must move money atomically

A merge appends a compensating **pair**. A half-applied pair is money that vanished. Applying §10.0.4:

```sql
ALTER TABLE app.earnings_ledger ADD COLUMN merge_pair_id uuid;

CREATE CONSTRAINT TRIGGER ledger_merge_pair_complete
  AFTER INSERT ON app.earnings_ledger
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.merge_pair_id IS NOT NULL)
  EXECUTE FUNCTION app.assert_merge_pair();     -- count = 2, sum(delta_cents) = 0,
                                                -- count(distinct owner_user_id) = 2
```

#### Protected assertion

`DEMO-14`: transfer a contact holding a credited opportunity from A to B. Assert A's leaderboard total is **unchanged**, B's is **unchanged**, the record appears in B's book and leaves A's on the next query, and B's timeline of the prior activity renders the `R3.5` copy. One test covering `ARR-MVP-22`, `US-9.12` and §10.8.

**Complexity:** low.

---

### 10.14 · B14 — the demo tenant has approved mechanical requirements and no owner

`R4.1` (12–15 sellers), `R4.2` (a lead outside the calling window **at any hour a demo may run** — a seeding-time computation, not a fixed timestamp), `R4.3` (silo-proof URL baked into the runbook), `R4.5` (separate tenant, idempotent, visibly marked, **refuses to run in a live account**), `US-9.14` (idempotent across re-runs).

Most of the enforcement already exists and is good: the `crm_seeder` role whose policy is `USING (tenant_id = app.current_tenant() AND EXISTS (SELECT 1 FROM tenant t WHERE t.id = app.current_tenant() AND t.is_demo))`, `CREATE UNIQUE INDEX ON tenant (is_demo) WHERE is_demo`, deterministic `uuidv5` ids and a double-seed checksum test. Four things are missing or contradictory.

#### (a) One approved contradiction must be ruled: "refuses to run in production"

`ARR-MVP-27` says the demo seed refuses to run when the environment is production, and the data model carries a trigger refusing `is_demo = true` in production. **ADR-T2 (no staging) and ADR-T5 (the demo tenant lives in production) make that trigger unimplementable** — the ten-minute demo is given in production because there is nowhere else.

> **Ruling.** The guarantee that matters is *"cannot write to a live tenant"*, not *"cannot run in production"*. The production trigger is struck. The `crm_seeder` policy replaces it and is **strictly stronger**: an environment check passes happily when `ENVIRONMENT` is unset; a policy cannot. A seeder pointed at a live tenant writes **zero rows** — no error to swallow, no partial write to clean up.
>
> Second layer, because the seeder must never live inside the app: **the web, worker and ingest processes assert at boot that `SEEDER_DATABASE_URL` is absent from their environment and exit non-zero if it is present.** The seeder credential exists only in the operator's local environment.

`ARR-MVP-27`'s literal wording is published as superseded-in-form, satisfied-in-intent.

#### (b) `R4.2` at any hour — the honest answer, because the naive one is arithmetically false

At 2 pm ET, no US timezone is outside 9 am–8 pm lead-local (ET 14, CT 13, MT 12, PT 11, AKT 10, HT 9). **No choice of US lead can produce a calling-window block at that hour.** So:

1. The seed includes one contact that is **permanently** `blocked_timezone_unknown` — no `zip5` row, no `state_code`, an NPA that resolves nowhere. Hour-independent by construction, and it demonstrates the fail-closed block, the published copy and the break-glass release.
2. The seed includes **one contact per US timezone**, so that at any demo hour outside roughly 12:00–17:00 ET at least one is `blocked_calling_window`.
3. **The demo page tells the presenter which lead is blocked right now.** `app.demo_blocked_contact()` is evaluated at read time and rendered on the demo tenant's home. The demo script is generated, not written down and stale.
4. **The assertion:** a property test drives `app.demo_blocked_contact()` at all 24 hours of a simulated day and asserts it returns a non-null contact at every one. If the seed set cannot satisfy it, the test is red — which is what forces item 1 to exist.

#### (c) `R4.1` supersedes `US-9.14`'s three sellers (finding C9)

The seeder asserts `BETWEEN 12 AND 15` sellers as a named test, with the fixture counts scaled proportionally (~40 contacts and ~15 credited opportunities do not produce a podium, a top-10 and a self-row with neighbours at 12–15 sellers). At least one credited opportunity per period bucket, at least one reversal, and the `R4.4` narration points intact.

#### (d) `R4.3` — the runbook is generated and verified

The seeder emits `docs/generated/demo-runbook.md` containing the exact URLs the presenter uses, **including the other-seller record URL that must return the owner-scoped not-found**. A CI test fetches every URL in that file as the demo presenter's session and asserts the expected status for each. A stale runbook fails the build; a presenter never has to obtain a silo-proof URL live.

**Complexity:** medium, concentrated in the seed-set design.

---

### 10.15 · B15 + Scenario B — Edit deal value, and the premium columns nobody revoked

These are one defect. `US-9.3` requires an `Edit deal value` command with a **required** reason producing a `value_correction` delta, reachable from the opportunity header **and** from the My Earnings row. The architecture correctly forbids a generic `PATCH` and revokes `UPDATE (stage_id, current_stage_type, stage_entered_at)` — and then **leaves `premium_annual_cents`, `premium_monthly_cents` and `premium_mode` writable by `crm_app`.**

The consequence is the worst failure in the document: a seller edits the premium on an already-closed-won opportunity, the obvious Drizzle update succeeds, every `CHECK` passes, the card and the detail show the new number, **no `opportunity.value_changed` is emitted and no ledger row is appended**, and the public all-time board keeps the old number forever, because there is no recompute job by design and the ledger is never replayed. `ARR-EVT-07` calls this link *"the single most-forgotten link in the money chain."*

#### The symmetric fix, same mechanism, one migration

```sql
REVOKE UPDATE (premium_monthly_cents, premium_annual_cents, premium_mode)
  ON app.opportunity FROM crm_app;
```

`app.opportunity_set_premium(p_opportunity_id, p_premium_cents, p_mode, p_reason)`, `SECURITY DEFINER`, in one transaction: write the columns; **if `current_stage_type = 'earning'`, append a `value_correction` row whose `delta_cents` is computed as `new_annual − old_annual` from the row's prior value** — never a parameter; bump the projection; bump the watermark; emit `opportunity.value_changed`; write the audit row.

- `ALTER TABLE app.earnings_ledger ADD CONSTRAINT value_correction_needs_reason CHECK (entry_type <> 'value_correction' OR length(btrim(reason)) >= 10);` — the reason is required by the engine.
- A no-op edit hits the existing `CHECK (delta_cents <> 0)`; the definer returns `no_change` as a success path, the same idiom as `already_credited`.
- The existing `CHECK (premium_monthly_cents IS NULL OR premium_annual_cents = premium_monthly_cents * 12)` makes `US-9.3`'s monthly→annual conversion case uncommittable if the converter is wrong.

#### The counter-net, so a future definer cannot forget either

```sql
CREATE CONSTRAINT TRIGGER premium_change_requires_correction
  AFTER UPDATE OF premium_annual_cents ON app.opportunity
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.current_stage_type = 'earning'
                     AND NEW.premium_annual_cents IS DISTINCT FROM OLD.premium_annual_cents)
  EXECUTE FUNCTION app.assert_value_correction_exists();
```

**A premium change on a closed-won opportunity cannot commit without its ledger row**, regardless of which code path made the change.

#### Reachability, which is a screen requirement

`POST /api/opportunities/:id/value`, covered by the silo suite. Protected L3 `D3-18`: the command is reachable from the opportunity header **and** from the My Earnings row, both keyboard-only, and both produce the same audit row shape. L2 `money.direct_premium_update_denied`: a direct Drizzle update of `premium_annual_cents` on a closed-won opportunity returns `permission denied`.

**Complexity:** low. One revoke, one definer, one deferred trigger.

---

### 10.16 · 1.4 — the `sms_enabled=false` axis is missing from CI

`ARR-MVP-27`, non-negotiable: *"The full acceptance suite must pass a second time with `sms_enabled=false` with no path erroring."* The Testing section declares one matrix axis, `TOPOLOGY`. Given `ARR-CMP-09` (10DLC in flight, launch is SMS-dark), **the configuration the product will actually launch in is the one configuration never tested end to end.**

#### The ruling inverts the default, which is what makes it fit the budget

> **SMS-dark is the baseline for every run. `sms_live` is the variant.**

The product launches dark. Testing dark as an occasional rehearsal and live as the default is backwards, and correcting it costs **zero** additional minutes for the baseline.

| Tier | Matrix | Billed |
|---|---|---|
| Pre-merge | `sms_dark` only | unchanged |
| Nightly | `{folded, split} × sms_dark` | unchanged (~25 min) |
| Weekly | `split × sms_live` — one extra Playwright pass | +8 min × 4 = **+32 min/month** |

Restated budget: committed **1,680** of 2,000, reserve **320 (16 %)**. The arithmetic is published because adding an axis without re-doing it is how quota exhaustion silently disables every gate in the document.

#### The mechanisms, so the flag is genuinely injected

- `sms_enabled` is a **column on `tenant`**, so the suite flips a row. There is nothing to inject and no module constant to read.
- ESLint bans any `process.env.SMS*` reference anywhere; dependency-cruiser forbids `src/**` from importing a `config/flags` module. The flag is reachable only through `app.compliance_check()`.
- Catalog gate: `pg_proc.prosrc` of `app.compliance_check` contains `sms_enabled` — the same grep shape as S8.
- `alowareSms.send()` requires a `GateVerdict<'allow'>` token only the gate can mint, so **a route that skips the gate does not compile**. The UI's disabled state is a courtesy.

#### The assertion that makes "no path erroring" mean something

The dark run asserts, as a **global** fixture-level check rather than per test: **zero 5xx responses across the entire suite**; `count(scheduled_job WHERE state='failed') = 0`; `count(terminal_reason = 'skipped: sms_disabled') > 0`. A path that throws instead of resolving to the first-class terminal `skipped` state is a red build.

**Complexity:** low, once the default is inverted.

---

### 10.17 · 1.5 — the WCAG gate appears in no level of the failure-class map

`ARR-UX-16` is non-negotiable and gate-blocking: axe-core, zero serious or critical, **ten screens × four states**. The failure-class map contains contrast and pseudo-locale at L0 and `D3-01..D3-17` at L3, and nothing else. The map's own doctrine cuts against it: *"if a level has no failure class of its own, it is theatre and is not built"* — a required gate that appears in no level does not exist.

#### The failure class, named

L3 accessibility catches what no other level structurally can: **a control operable with a mouse and unreachable with a keyboard; a dialog that traps focus in the wrong direction; a disabled control whose reason is invisible; a live region that announces nothing or announces twice.** None of these is a compile error, a database constraint or a network assertion, and all four are shipped-and-invisible in a product whose owner validates by looking at the screen.

#### The four states must be reachable by a hook, not by a lucky network condition

- Every one of the ten screens declares `states: ['empty','loading','error','no_permission']` in the route registry.
- The app honours `?__state=` **only when a signed test header is present** (HMAC over the route path plus a build-scoped secret), so it is not an open backdoor.
- The axe job iterates the registry: 10 × 4 = 40 runs. **A screen in the registry with an unreachable state fails the build.** This is what converts "ten screens × four states" from prose into an enumeration, and it discharges `R2-9` at the same time.
- **The hook must be provably absent in production**: it sits behind a build-time constant that is dead-code-eliminated, and a CI test greps the **production bundle** for the literal `__state`, failing if present. A bundle grep, not a source grep.

#### Where it fires

- **Pre-merge (`fast` job):** component-level axe over the eight `R2-14` surfaces × four states, using jsdom. This is the highest-frequency regression class and it belongs at merge time.
- **Nightly:** the full ten screens × four states in a real browser (P17), plus keyboard-only P19.
- **Release:** blocked by the promotion gate (§10.0.3). A red axe nightly stops the deploy.

Traceability gains the row it does not have today: `ARR-UX-16 → L3 accessibility class · P17 · R2-9 / R2-11 / R2-14 · promotion gate`.

**Complexity:** low for the gate, medium for making forty states genuinely reachable.

---

### 10.18 · 1.6 — exports are catastrophe #3 and none of the three required controls exists

`ARR-PRV-05` requires three things the Security section does not have: `masking_applied` driven by a **machine-readable PII classification** rather than a hand-maintained per-report list; a **written reason above a threshold**; and **anomaly alerting on mass export and off-hours bulk activity**. The stated catastrophic scenario — a departing agent exporting their whole book — is *legitimate use of an owner-scoped endpoint*, so nothing in the current design notices.

#### (a) Masking is catalog-driven, and the catalog cannot go stale

`security.column_classification` (§10.0.2) is the source. `app.export_build()` joins the selected columns to it and applies `mask_strategy`. **A column with no classification row cannot be selected** — the join yields no strategy and the function raises — and a *new* column with no classification **fails the deploy**, because `harden()` raises. That is what "machine-driven rather than hand-maintained" has to mean to be true a year from now.

`export_job.masking_applied` stops being a caller-supplied boolean: `crm_app` has no direct `INSERT` on `export_job`, the only writer is `app.export_request()`, and the definer sets the flag from whether any masked column was actually in the selection. A caller cannot claim masking it did not apply.

#### (b) The written reason is volume-driven, not scope-driven

Today's `CHECK (scope <> 'tenant' OR reason IS NOT NULL)` keys on scope, so a seller exporting 8,000 rows of their own book supplies nothing. Row count is unknown at request time, so this is two-phase:

```sql
ALTER TABLE app.export_job
  ADD COLUMN reason_required boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT export_reason_when_required CHECK (
        NOT reason_required
     OR (reason IS NOT NULL AND length(btrim(reason)) >= 20));
```

The job counts rows first and sets `reason_required` from `system_constant['export_reason_row_threshold']`. If the reason is absent, the job terminates as `status = 'blocked_reason_required'` and **the artifact is never written**. The requester sees a screen that says *"This export returned 8,412 rows. Tell us why."* and resubmits. Engine-enforced, and the symptom is on the screen rather than in a log.

#### (c) Anomaly alerting, as rows on a page Jorge already reads

An `AFTER INSERT OR UPDATE OF row_count, status ON app.export_job` trigger raises `admin_alert` rows:

| Kind | Condition |
|---|---|
| `export_volume` | `row_count > system_constant['export_alert_row_threshold']` (default 200), or ≥ N exports by the same user in a rolling 24 h |
| `export_off_hours` | `requested_at` in the requester's `display_tz` falls outside tenant business hours — the same `AT TIME ZONE` evaluator, a fifth use of one machine |
| `export_departing_actor` | the requester's `deactivated_at` is set, **or** their `role` changed within the prior 7 days |

The third is the departing-agent detector and it is a join, not a heuristic. `admin_alert`'s existing `UNIQUE (tenant_id, kind, subject_id) WHERE acknowledged_at IS NULL` prevents flooding, and its `tenant_admin_only` RLS means **the exporter cannot acknowledge the alert about their own export.**

Plus the artifact control that already exists, now asserted: a CI test fetches a presigned URL after `expires_at` and asserts `403`.

**Complexity:** medium. The column classification is the bulk of it and three requirements share it.

---

### 10.19 · 1.13 — the tenant-wide channel needs a type that cannot express lead data, and `/sse/**` is invisible to every suite

Two halves.

#### (a) The type — the strongest available form is "carries nothing"

`ARR-EVT-23` requires *"a tenant-wide channel whose payload type literally cannot express lead data."* ADR-02 already rules *push is a hint, poll is the truth*. Combining them gives the strongest possible answer:

> **The tenant-wide SSE frame type is `{ c: PollChannel; s: number }` and nothing else.** It cannot express lead data because it cannot express **any** data.

Enforcement: the serializer's parameter type is that union; the frame JSON Schema is `additionalProperties: false`; and the SSE stream carries the **production** response-validation exception already granted to the leaderboard payload — a frame with an extra key is dropped and alarmed rather than delivered.

The celebration therefore never crosses the tenant-wide channel: the frame says *the leaderboard watermark moved*, the client calls `app.leaderboard_read()` (§10.3), and that function's return type contains display name, avatar ref, totals and ranks — and structurally cannot contain a lead, contact or opportunity column. One mechanism satisfies `ARR-EVT-23`, Scenario A and B3 together.

#### (b) `/sse/**` is outside `routes/api/**`, therefore outside all five registry-driven suites

The registry is built by *"scanning `routes/api/**`"*, which excludes `/sse/**`, `/intake/**`, `/webhooks/**`, `/auth/**`, `/healthz`, `/readyz`, every `routes/ui/**` document response and the whitelisted UI loader — **the only route that serves real board data as SSR HTML.** The one broadcast that crosses the silo by design is the one surface with no automated silo assertion.

**Mechanism.** The registry's input becomes **the framework's own generated route manifest**, not a directory glob. A route that exists is in the manifest by construction, so the registry is exhaustive rather than conventional.

- Every manifest entry must resolve to a branded factory — `defineEndpoint`, `defineStream`, `defineIngress` or `defineDocument`. **The generator fails the build on any manifest entry whose default export lacks a brand**, and on any module in `routes/ui/**` exporting `loader`/`action` outside the one-entry whitelist. This closes the adversary's finding that `defineEndpoint()` is not enforceable as described — the framework will happily serve a hand-written loader in that tree.
- The five suites then iterate the full registry with per-family assertions. The families gain: SSE must be `no-store`, compression off, `X-Accel-Buffering: no`; ingress must be `no-store` and must not be reachable on the `worker` role; the SSR board document is now inside the **cache** suite (so the two-seller byte-identity test covers the one HTML response carrying a seller's board) and inside the **not-found** suite (the path `ARR-UX-04` names: *"reached by URL, notification deep link or search"*).

**The SSE silo assertion that does not exist today.** Open `/sse/me` as A and as B; drive a write in A's silo; assert B's stream receives **zero** frames and A's receives exactly one; then drive a leaderboard write and assert **both** receive the tenant frame and that the frame body matches `{c,s}` byte-for-byte. Protected, `retries: 0`.

**Complexity:** medium. The manifest-driven registry is the work; the assertions are cheap afterwards.

---

### 10.20 · 1.14 — the money-type CI test, layer (d)

Signed non-negotiable 4 requires four layers; two shipped (branded `Money`, the coercion lint) and one — *"a CI test that FAILS if any monetary field is typed as a plain number in TypeScript"* — is present as **S15 keyed on a name pattern**. The adversary's counterexample is exact: a new column named `premium_annual` typed `number` passes `tsc`, passes the lint, and passes S15, because the lint and the gate both key on `Money`-typed values **or a `*_cents` field name**.

#### The fix inverts the direction: money is detected by origin, not by name

1. **The catalog is the source of truth.** `security.column_classification.value_kind` (§10.0.2) marks money columns. A new column with no classification **fails the deploy** — so `premium_annual` must be classified before it can exist, and classifying it as anything but `money` is a visible, migration-level act.
2. **S15, rewritten.** `ts-morph` walks the emitted `.d.ts` of the Drizzle schema and the API contract types and asserts: for **every** catalog column with `value_kind = 'money'`, the corresponding TypeScript property is `Money` and not `number`. **The property name is irrelevant.**
3. **S15b, the reverse direction.** Every TypeScript property typed `Money` must map to a catalog column with `value_kind = 'money'`. You cannot brand a non-money field to dodge the arithmetic lint, and you cannot un-brand a money field without the catalog disagreeing.
4. **The hole in every branded type, closed.** A brand is defeated by one assertion. ESLint bans `as Money`, `as unknown as Money` and any type assertion to `Money` outside `src/money/**`. This is the door people actually use.
5. **S10 (engine, no float) and the Zod border primitive** are unchanged. The full set is five doors: border parse → brand → assertion ban → type gate keyed on the catalog → engine type gate.

`ARR-MVP-23`'s server-side proof that a monthly value cannot reach the board is closed by the constraint chain rather than by a formatting test: `leaderboard_read` sums `earnings_ledger.delta_cents`, written only by `ledger_append` from `premium_annual_cents`, which the opportunity `CHECK` ties to `monthly × 12`, and which the earning-stage `CHECK` requires to be non-null. An L2 test inserts a monthly-only opportunity and asserts the stage `CHECK` refuses it.

**Complexity:** low.

---

### 10.21 · Traceability — requirement to mechanism

| Requirement | Closed by | Failure Jorge sees |
|---|---|---|
| `US-9.13` admin void/adjust | `app.ledger_adjust` definer, 4-label enum, 4 CHECKs, discriminated union | Reason text on the seller's My Earnings row |
| `R1.6` / D-4 one credit | `credit_epoch` + two partial unique indexes | Second move credits nothing; total does not change |
| — credited zero times | deferred constraint trigger on `opportunity` | *"Couldn't record this sale — nothing was saved."* |
| `R1.3` / `ARR-MVP-10` undo exclusion | `app.leaderboard_read()` definer; projection becomes `definer_only` | Byte-identical ETags across sellers; board updates with no writer |
| `US-9.5` / `US-9.12` roster | `LEFT JOIN` from `app_user`; roster trigger on the watermark; `owner_role` FK | Fifty names, fifty `$0` on day one |
| `ARR-EVT-02` 49-name coverage | `ref.event_schema.mvp_emitter`, two-sided gate, bundle scan | Red build from either side of the flip |
| `R6` budgets | ratchet store + promotion gate | Deploy stops; unacknowledgeable red line on admin health |
| `R7`(a) timezone source | `SEC-9` + dataset deploy assertion + admin-health row | Deploy stops rather than fifty sellers blocked |
| `R7`(b) card height | G12 assertion set + `ui.card_h_*` ratchet | Red drag gate |
| `R3.5` timeline identity | jsonb CHECK + column revoke + `app.timeline_read()` + S17 | Zero occurrences of a foreign name in the response body |
| `ARR-EVT-13` STOP | `job_priority` + reserved concurrency + edge byte sniff + storm assertion | Red storm gate |
| `ARR-CMP-03` break-glass | `active_override_v` + revoke on the base table + S18 | Banner disappears at 60 min with no job |
| MVP 42 degraded mode | registry row, probe-id FK, split-topology assertion | Banner + `Call from my phone` in both topologies |
| `US-9.11` quiet hours | `desktop_popup` NOT NULL no-default + prop type with no timestamp | Badge without popup at 3 am |
| `ARR-MVP-22` money does not move | `ledger_source_is_a_declared_input` CHECK + frozen set | Transfer leaves both totals unchanged |
| `R4.1–R4.5` demo | `crm_seeder` policy, boot assertion on the seeder URL, 24-hour property test, generated runbook | Seeder writes zero rows against a live tenant |
| `US-9.3` edit deal value | premium column revoke + definer + deferred trigger | `permission denied` on a direct update |
| `ARR-MVP-27` SMS-dark | dark as the baseline axis; zero-5xx global assertion | Red weekly/nightly |
| `ARR-UX-16` WCAG | L3 accessibility class, 40 registry-driven state runs, promotion gate | Deploy stops |
| `ARR-PRV-05` exports | column classification, `reason_required`, three alert kinds | *"This export returned 8,412 rows. Tell us why."* |
| `ARR-EVT-23` tenant channel | `{c,s}` frame type; manifest-driven registry; two-stream silo test | Red silo suite |
| `ARR-MVP-23`(d) money type | catalog-driven S15/S15b + assertion ban | Red pre-merge |


---

# §4 — Gate-5 closure pass (supersedes §2 and §3 where they differ)

## 11 · Gate-5 closure pass — the seven fatal items and the five defects the reconciliation introduced

### 11.0 · The rule this section applies, and one correction to the audit's own prescription

The closure audit named the recurring trap correctly and called it **NEW-7**: in this project *"only `crm_migrator` can weaken this"* means *"Claude writes a migration, and nobody reads the diff."* Eleven closures in §7 and §10 rest on that doctrine. Every object below is therefore graded against three properties, and only these three, because they are the only ones that survive the actor who writes migrations:

| | Property | Why it survives |
|---|---|---|
| **(a)** | A symptom on a seller's screen | Fifty people notice within one poll interval |
| **(b)** | A gate anchored **outside the working tree** — a value that exists only in the Render dashboard, or a row in the live production database | The tree can be rewritten; neither of these is in the tree |
| **(c)** | Re-assertion at **deploy** and at **boot** | A deploy that will not proceed cannot be amended by a later commit; a process that will not boot is an outage, not a silent breach |

A closure that has none of the three is documentation, and is labelled as such below rather than presented as a mechanism.

**One correction to the audit's prescription, and it is load-bearing.** §8's NEW-7 prescribes *"a `ddl_command_end` event trigger that refuses to drop or replace a protected trigger/function/policy unless a matching ratchet row exists."* That object is specified in full in §11.11 — **and it cannot be installed on the chosen platform.** `CREATE EVENT TRIGGER` requires superuser; the approved data model records four times (§"Open questions", `security.table_registry` mechanism note, `sec-1` §"Left open", `sec-3` §12) that Render's managed Postgres does not grant it and that *"the design does not depend on one."* Specifying only the event trigger would therefore have closed NEW-7 on paper and left it open in production. §11.11 accordingly ships **two** objects: the event trigger, gated on the Gate-0 grant probe, and the **protected-object digest chain**, which requires no superuser, carries the full weight when the trigger is unavailable, and is what actually anchors the other eleven closures.

---

### 11.1 · (§9.1-1 / NEW-1) `app.undo_window()` is deleted, and the two intervals get names that cannot be swapped

**The defect.** One function name is required to mean 5,500 ms in the public projection predicate and 5,000 ms in `app.celebrate_once()`. At 5,500 the client claims at ≈5,050–5,200 ms, the predicate is false, `celebrated_at` is never written, and *"once per opportunity, forever"* degrades to *never*. At 5,000 the public board reveals a still-undoable row for ~500 ms — the exact `ARR-MVP-10` outcome. The four-way drift test compares **keys**, so it is green in both branches.

#### 11.1.1 · The ruling

> **`app.undo_window()` is dropped.** It is replaced by two functions whose names share no substring and whose call sites are disjoint and registered:
>
> | Function | Value | Sole call site |
> |---|---|---|
> | `app.projection_reveal_delay()` | `undo_window_ms + undo_projection_guard_ms` = **5,500 ms** | the pending predicate inside `app.leaderboard_read()` |
> | `app.undo_deadline()` | `undo_window_ms` = **5,000 ms** | the admissibility predicate inside `app.celebrate_once()` |
>
> Neither function is named `undo_window`. **Dropping the ambiguous name is the load-bearing half**: every surviving call site must be re-decided rather than silently inheriting whichever number the function happens to return.

Published in all three normative texts, by locator:

| Document | Locator | Amended to read |
|---|---|---|
| `phase5/data-model.md` | §5 *"The public projection and the 5-second undo window"* | *"The exact predicate is `e.recorded_at <= clock_timestamp() - app.projection_reveal_delay()`. `app.undo_window()` does not exist."* |
| Part I rulings | **P2.1** bullet 3 (`app.celebrate_once()` body) | `… AND clock_timestamp() >= won_at + app.undo_deadline() AND clock_timestamp() < won_at + app.undo_deadline() + app.celebration_claim_grace() …` |
| Part I rulings | **P2.1** final bullet (Puerta 10) | *"Two named keys from one source, and **two named functions from those keys**: `undo_window_ms = 5000` → `app.undo_deadline()`, TypeScript token, CSS custom property; `undo_projection_guard_ms = 500` → consumed only by `app.projection_reveal_delay()`. Puerta 10 is amended to cover two keys and two functions from one source."* |
| §7.1.1 | `leaderboard_read` body, lines computing `v_pending` and the `pending` CTE | both `app.undo_window()` occurrences → `app.projection_reveal_delay()` |

#### 11.1.2 · The object: `ref.interval_binding`, and a drift test that compares **effective values at call sites**

```sql
CREATE TABLE ref.interval_binding (
  caller       text PRIMARY KEY,      -- 'app.leaderboard_read', 'app.celebrate_once'
  callee       text NOT NULL,         -- 'app.projection_reveal_delay', 'app.undo_deadline'
  expected_ms  integer NOT NULL,
  source_key   text NOT NULL,         -- FK-in-spirit to app.system_constant.key
  registered_in_migration text NOT NULL,
  CONSTRAINT interval_binding_distinct UNIQUE (callee)     -- one caller per interval, both ways
);
```

`security.harden()` gains four assertions over that table. All four are **deploy-breaking**, and none of them reads a literal from a test file:

1. **Call-site exclusivity.** For each row, `pg_proc.prosrc` of `caller` contains `callee || '('` and contains **exactly one** member of `SELECT callee FROM ref.interval_binding`. A body calling both, or calling neither, raises `IV001`.
2. **Effective value, evaluated — not the name.** `EXECUTE format('SELECT extract(epoch FROM %s())*1000', callee)` must equal `expected_ms`. This is the assertion the audit asked for: it executes the function at each registered call site's callee and compares the **number**, so renaming, aliasing or re-bodying is caught.
3. **The two numbers must differ, and by exactly the guard.** `app.projection_reveal_delay() - app.undo_deadline()` must equal `make_interval(secs => undo_projection_guard_ms/1000.0)` read from `app.system_constant`. Collapsing them to one value raises `IV003`.
4. **The ghost name is gone.** No `pg_proc.prosrc` in any schema may contain the string `undo_window`. A surviving caller raises `IV004` at deploy, before it can raise `42883` at runtime.

The existing four-way drift test (SQL · TypeScript token · CSS custom property · seed file) is **kept and extended to a fifth leg**: `ref.interval_binding.expected_ms` must equal the value in `app.system_constant` for `source_key`, so the binding table cannot drift away from the constant it claims to mirror.

#### 11.1.3 · The symptom, because the failing branch is otherwise invisible

The dangerous branch has no screen symptom by construction — confetti is client-rendered, so a permanently refused claim looks perfect. It is made visible:

```sql
-- app.celebrate_once(p_opportunity_id uuid, p_source_event_id uuid)
--   RETURNS app.celebration_outcome
CREATE TYPE app.celebration_outcome AS ENUM
  ('recorded','already_recorded','reversed','too_early','too_late');
```

`too_early` and `too_late` write `admin_alert(kind='celebration_claim_window_wrong')`, which is **unacknowledgeable** while any such alert is younger than 24 h (the same `CHECK`-on-acknowledge shape §10.0.3 uses for `release_gate_overridden`). `/admin/system` renders **`celebration claims: N recorded · N refused-on-timing (24 h)`**. In a correctly wired system `too_early` is structurally impossible and `too_late` is rare (a closed laptop). A wiring error puts a red line on the screen Jorge already reads, on the first win after deploy.

**Walkable?** Partly, and honestly. A migration can change `expected_ms` in `ref.interval_binding` and the constant together, and assertions 1–4 stay green — the table is data, and data is one INSERT away for the actor who writes migrations. What it cannot do is change them **inconsistently**, which is the actual defect: the two functions can no longer silently mean the same number, a call site cannot silently call the wrong one, and the ambiguous name no longer exists to be called by accident. `ref.interval_binding` is registered in `security.protected_object` (§11.11), so an edit to it is counted and rendered. The residual is "Claude deliberately re-decides the undo window in a migration", not "Claude wires the wrong number without noticing" — and only the second one was the fatal defect.

---

### 11.2 · (§9.1-2 / B13 / C5-review-1) The negative declaration: `ref.ledger_forbidden_input`

**The defect.** `events.ledger_input_set` is a `frozen_set` ratchet, and a `frozen_set` **permits supersets**. The dangerous direction here is an addition. `contact.owner_changed` reaching the ledger is one INSERT away, and it is precisely the event that would make money move with the record when `US-9.12` and `ARR-MVP-22` say it must not.

#### 11.2.1 · The object

A `CHECK` constraint whose entire content is the negative fact, on the table that classifies events:

```sql
ALTER TABLE ref.event_schema
  ADD COLUMN ledger_role app.ledger_role NOT NULL,            -- ENUM ('input','forbidden')
  ADD CONSTRAINT ledger_forbidden_input CHECK (
        ledger_role <> 'input'
     OR event_name NOT IN ('contact.owner_changed',
                           'opportunity.stage_changed',
                           'pipeline.stage_config_changed',
                           'contact.became_client',
                           'opportunity.lost'));
```

and the referential half that makes it bite on the money table rather than only on the catalog:

```sql
ALTER TABLE ref.event_schema
  ADD COLUMN ledger_input_name text
    GENERATED ALWAYS AS (CASE WHEN ledger_role = 'input' THEN event_name END) STORED,
  ADD CONSTRAINT event_schema_ledger_input_uq UNIQUE (ledger_input_name);

ALTER TABLE app.earnings_ledger
  ADD CONSTRAINT ledger_source_is_a_declared_input
    FOREIGN KEY (source_event_name)
    REFERENCES ref.event_schema (ledger_input_name);
```

**Why this is the negative declaration the review asked for and §10.13's `CHECK` was not.** §10.13 wrote the positive list *inside* the ledger's own `CHECK`, so widening it is `ALTER TABLE … DROP CONSTRAINT … ADD CONSTRAINT` on the money table — one migration, one statement, indistinguishable from any other schema change. Here the two facts are separated:

- **The negative fact is a named constraint that lists the forbidden events and nothing else.** Making `contact.owner_changed` a ledger input requires `ALTER TABLE ref.event_schema DROP CONSTRAINT ledger_forbidden_input`. That is a **DDL drop of a named constraint**, which is exactly the event class `security.protected_object` (§11.11) registers, counts and renders. It cannot be done by flipping a row.
- **The generated column is the enforcement surface.** A forbidden event's `ledger_input_name` is `NULL`, so it is not a referenceable key. A ledger row sourced from `contact.owner_changed` fails the foreign key with `23503` regardless of which definer, replay job, webhook consumer or future refactor writes it.
- `events.ledger_input_set` moves from `frozen_set` to **`sealed_set`** (§11.3) so the positive set is closed in *both* directions — B13's addition risk and §10.13's silent-removal risk are now the same object's two arms.

**What Jorge sees.** `DEMO-14` (protected, `retries: 0`): transfer a contact holding a credited opportunity from A to B; A's leaderboard total is unchanged, B's is unchanged, the record moves. If the forbidden event ever became an input, that assertion is red before anything ships.

**Walkable?** The constraint drop is walkable by a migration — nothing in Postgres can prevent `crm_migrator` from dropping a constraint. What is *not* walkable is doing it invisibly: `ledger_forbidden_input` and `ledger_source_is_a_declared_input` are both in `security.protected_object`, so the drop either (i) is refused by the event trigger where it exists, or (ii) makes `harden()` raise `PO001` at the next deploy unless a dashboard-token authorization exists, and in either case appends a permanent row to `security.protected_object_history` that renders on `/admin/system`. This is a genuine downgrade from "impossible" to "counted and rendered" and it is stated as such.

---

### 11.3 · (§9.1-3 / 1.14 / Scenario B derived / NEW-5) Ratchet directions that refuse additions and pin values

**The defect.** `frozen_set` permits supersets, so `rls.exception_list`, `migrations.destructive_allowlist`, `events.ledger_input_set` and S17's `non_money_bigints` are each loosened by **inserting one row** — "the model edits the literal" rebuilt as "the model inserts a row". And no direction can pin an exact value, which `ui.card_h_desktop` / `ui.card_h_mobile` need.

#### 11.3.1 · The corrected direction vocabulary

```sql
CREATE TYPE app.ratchet_direction AS ENUM (
  'monotonic_down',   -- numeric: a new value greater than the current minimum raises AP002
  'monotonic_up',     -- numeric: the inverse
  'pinned',           -- numeric: NEW — any value <> the registered value raises AP004
  'shrink_only',      -- set:     NEW — a new set that is not a SUBSET of the previous raises AP005
  'sealed_set'        -- set:     NEW — a new set that is not EQUAL to the previous raises AP006
);
-- 'frozen_set' is STRUCK. It is superset-only, which is the wrong arm for every list it guarded.
```

Reassignment of every registered name, published so no list keeps the inverted direction by inertia:

| Name | Was | **Is** | Why |
|---|---|---|---|
| `rls.exception_list` | `frozen_set` | **`shrink_only`** | Exempting a new table from RLS is the loosening. Removing an exemption is the tightening and stays free |
| `migrations.destructive_allowlist` | `frozen_set` | **`shrink_only`** | Same arm: adding a permitted destructive operation is the danger |
| `security.schema_exception` seed | `frozen_set` | **`shrink_only`** | Adding a schema to the exemption list is what produced NEW-4 |
| S17 `non_money_bigints` (per table) | `frozen_set` | **`shrink_only`** | Adding `premium_annual` here is Scenario B, one row later |
| `events.ledger_input_set` | `frozen_set` | **`sealed_set`** | Additions are B13; removals silently corrupt the all-time board (§10.13). Both arms are fatal |
| `fixtures.events_v1` (file digests) | `frozen_set` | **`sealed_set`** | A fixture set that may grow is a fixture set that may be replaced |
| `ui.card_h_desktop` / `ui.card_h_mobile` | *(unrepresentable)* | **`pinned` = 120 / 156** | N17's numbers, `04b` §3.6's 108 struck |
| `perf.P12_initial_js_gzip`, `perf.*` | `monotonic_down` | unchanged | Correct as written |
| `events.inline_consumer_count` | `monotonic_up`/literal | **`pinned` = 6** | A seventh inline consumer should be a decision, not a drift |

#### 11.3.2 · The object that makes the *direction itself* unwalkable

A direction stored per-row in an append-only table is chosen by whoever writes the newest row. So the direction is lifted out of the value table into an immutable registry keyed by name:

```sql
CREATE TABLE ref.ci_ratchet_name (
  name                    text PRIMARY KEY,
  direction               app.ratchet_direction NOT NULL,   -- no DEFAULT: unclassified is impossible
  registered_in_migration text NOT NULL,
  rationale               text NOT NULL CHECK (length(btrim(rationale)) >= 20)
);

ALTER TABLE ref.ci_ratchet
  ADD CONSTRAINT ci_ratchet_name_fk FOREIGN KEY (name) REFERENCES ref.ci_ratchet_name (name),
  DROP COLUMN direction;            -- the direction is a property of the NAME, not of the row
```

- `ref.ci_ratchet_name` is in the **immutable set**: the statement-level `BEFORE UPDATE OR DELETE OR TRUNCATE` trigger raising `AP001` that already protects `earnings_ledger`. Changing a direction from `sealed_set` to `shrink_only` therefore requires **dropping that trigger**, which is a protected-object drop (§11.11) — not a row edit and not a migration nobody notices.
- `crm_ci` holds `INSERT, SELECT` on `ref.ci_ratchet` and **`SELECT` only** on `ref.ci_ratchet_name`. CI can record a measurement; it can never reclassify what a measurement means.
- The `BEFORE INSERT` trigger on `ref.ci_ratchet` joins to `ref.ci_ratchet_name` to select the arm. A new name with no registry row raises `AP007` — **there is no default direction**, so the NEW-5 failure mode ("a new list inherits the additive arm") is not expressible.
- `harden()` asserts every name referenced by any CI job exists in `ref.ci_ratchet_name`, so registering the value and forgetting the direction fails the deploy.

**What Jorge sees.** A refused loosening is a red build with the specific message — `non_money_bigints: refused, 'premium_annual' is not in the previous set (shrink_only)` — before any test executes. For `ui.card_h_*`, the drag gate G12 is red instead of a 108-px card shipping.

**Walkable?** The values are walkable by migration; the **arms** are not, without dropping a protected trigger. That is the correct place to spend the guarantee: the audit's finding was not "the numbers can change", it was "the guard points the wrong way and nothing says so". A `shrink_only` list that a migration adds to is refused by the engine; the only path is to change the classification, and that path is counted on Jorge's screen.

---

### 11.4 · (§9.1-4 / A2) `app.my_standing_read()` — the private read the win gate needs

**The defect.** After `REVOKE SELECT ON app.leaderboard_projection FROM crm_app`, the win gate's `{new_total, rank, gap_to_next}` — which **P2.4 requires inside the `200`**, because nothing may be fetched at T+5,000 ms — has no read path. The only sanctioned read, `app.leaderboard_read()`, excludes pending rows tenant-wide, including the winner's own. The celebration would print the seller's **pre-win** total and **pre-win** rank to the person who just sold.

**`R1.3` explicitly permits the fix**: the seller may see their own pending row, marked pending. That is `N2` in P5.3 (*"Private (closer's own My Earnings) — immediate, rendered marked pending"*), never extended to the win gate.

#### 11.4.1 · The object

```sql
CREATE TYPE app.my_standing AS (          -- a COMPOSITE, not a TABLE: one row, by type
  new_total_cents    app.money_cents,
  rank               integer,
  gap_to_next_cents  app.money_cents,
  includes_pending   boolean,
  period             app.period_type
);

CREATE FUNCTION app.my_standing_read(p_period app.period_type)
RETURNS app.my_standing
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = app, ref, pg_catalog
AS $$
DECLARE
  v_tenant uuid := app.current_tenant();
  v_self   uuid := app.current_user_id();
  v_key    date;
  r        app.my_standing;
BEGIN
  IF v_tenant IS NULL OR v_self IS NULL THEN
    RAISE EXCEPTION 'context_missing' USING ERRCODE = 'CTX03';   -- never a silent zero
  END IF;
  SELECT app.period_key_for(p_period, v_tenant) INTO v_key;

  WITH board AS (          -- SAME shape as leaderboard_read, but pending is INCLUDED for self only
    SELECT u.id,
           coalesce(p.total_cents, 0)
             - CASE WHEN u.id = v_self THEN 0 ELSE coalesce(x.pending_cents, 0) END
             AS total_cents
      FROM app.app_user u
      LEFT JOIN app.leaderboard_projection p
             ON p.tenant_id = v_tenant AND p.user_id = u.id
            AND p.period_type = p_period AND p.period_key = v_key
      LEFT JOIN (SELECT e.owner_user_id, sum(e.delta_cents) AS pending_cents
                   FROM app.earnings_ledger e
                  WHERE e.tenant_id = v_tenant
                    AND e.recorded_at > clock_timestamp() - app.projection_reveal_delay()
                  GROUP BY 1) x ON x.owner_user_id = u.id
     WHERE u.tenant_id = v_tenant AND u.role = 'seller' AND u.deactivated_at IS NULL
  ), ranked AS (
    SELECT id, total_cents, rank() OVER (ORDER BY total_cents DESC) AS rnk FROM board
  )
  SELECT s.total_cents, s.rnk::int,
         coalesce((SELECT min(n.total_cents) - s.total_cents
                     FROM ranked n WHERE n.total_cents > s.total_cents), 0),
         EXISTS (SELECT 1 FROM app.earnings_ledger e
                  WHERE e.tenant_id = v_tenant AND e.owner_user_id = v_self
                    AND e.recorded_at > clock_timestamp() - app.projection_reveal_delay()),
         p_period
    INTO r
    FROM ranked s WHERE s.id = v_self;

  RETURN r;
END $$;

REVOKE ALL     ON FUNCTION app.my_standing_read(app.period_type) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION app.my_standing_read(app.period_type) TO crm_app;
```

**Five properties, each of them a containment rather than a convention:**

1. **It cannot become a board.** The return type is a **composite, not a `TABLE`**. There is no row set to widen. Adding a second seller's identity to the response requires changing the type, which is a protected-object change (§11.11).
2. **It cannot leak an identity.** No `user_id`, no `display_name`, no `avatar_ref` is returned. `gap_to_next_cents` is a difference, and the public board already shows every total to every seller in the tenant, so it discloses nothing `app.leaderboard_read()` does not.
3. **It cannot contaminate the public read.** It returns **no `etag`**. Every `json` surface in the route registry must source its ETag from the generated registry; a route answering a conditional GET from `my_standing_read` has no ETag source and `ref.etag_none_exception` is a sealed relation. So it cannot be quietly substituted for `GET /api/leaderboard` and reintroduce reader-dependent ETags — the exact defect Scenario A closed.
4. **It re-asserts tenancy inside the definer** (gate S8) and raises `CTX03` rather than returning a zero row, per §7.1.1's *"zero rows means broken context, not an empty board"*.
5. **It is the only additional caller.** `POST /api/opportunities/:id/win`'s declared output type carries `new_total: Money; rank: number; gap_to_next: Money; includes_pending: boolean` — a handler that returns early cannot populate it, the same shape P3's `dial_outcome` uses. `security.function_registry` grants `EXECUTE` to `crm_app`, and a catalog gate asserts `my_standing_read` is referenced from exactly one module, `src/db/sql/win-gate/**`.

**What the seller sees — `DEMO-16` (protected, `retries: 0`).** A wins $3,000. Inside the window: the win response's `new_total` equals A's prior total **+300000** and `includes_pending = true`; B's `GET /api/leaderboard` still shows A's **pre-win** total; A's and B's ETags remain byte-identical. After the window with no intervening write: B's board shows the new total. **The single assertion catches both branches** — a celebration printing the pre-win number, and a private read that leaked into the public one.

**Walkable?** Yes in the ordinary sense — a migration can widen the composite type. But the widening is loud in three places at once: the type is registered in `security.protected_object`; `DEMO-16`'s byte-identity leg goes red if the private path contaminates the public one; and `pg_get_function_result('app.my_standing_read')` is compared against `ref.sealed_signature` (§11.8) exactly as the board's is. The failure this closes — *the winner reads their pre-win rank* — is now impossible without an affirmative, recorded act.

---

### 11.5 · (§9.1-5 / C5-review-2) `app.begin_job()` — tenancy is re-derived, never transported

**The defect.** The pg-boss handler sets its RLS context **from its own job payload**. A replayed, corrupted or attacker-influenced `tenant_id` is a cross-tenant write with RLS fully enabled and perfectly happy. The data model records it as an **open ruling** (*"PG-BOSS SCHEMA ON THE RLS EXCEPTION LIST"*, option (a) HMAC vs option (b) re-derivation); the Security section presents it as closed. **P8.5 rules in favour of (b).** This is that ruling's object.

#### 11.5.1 · The object

```sql
CREATE TYPE app.job_subject AS ENUM
  ('opportunity','contact','message','call','appointment','export_request',
   'intake_source','outbox_entry','tenant');

CREATE FUNCTION app.begin_job(
  p_job_kind     text,
  p_subject_type app.job_subject,
  p_subject_id   uuid
) RETURNS app.job_context
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = app, ref, pg_catalog
AS $$
DECLARE v_tenant uuid; v_owner uuid;
BEGIN
  -- 1. The ONLY source of tenancy: the subject row itself.
  SELECT r.tenant_id, r.owner_user_id INTO v_tenant, v_owner
    FROM app.resolve_owner(p_subject_type, p_subject_id) r;   -- definer, one branch per subject type

  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'job subject %/% does not resolve to a tenant',
      p_subject_type, p_subject_id USING ERRCODE = 'CTX02';   -- dead-letter, never a wrong tenant
  END IF;

  -- 2. Context is SET here and nowhere else, is_local = true.
  PERFORM set_config('app.tenant_id',  v_tenant::text,        true);
  PERFORM set_config('app.user_id',    coalesce(v_owner::text, ''), true);
  PERFORM set_config('app.scope_mode', 'owner',               true);
  PERFORM set_config('app.actor_type', 'system',              true);
  PERFORM set_config('app.ctx_txid',   txid_current()::text,  true);   -- §7.7.3(4) pooled-leak net

  PERFORM app.audit_write('job.context_opened', …);
  RETURN (v_tenant, v_owner, p_job_kind)::app.job_context;
END $$;
```

**Four nets, in the order they fire:**

1. **The payload cannot express tenancy, at the type level.** `JobPayload<T>` is `{ subjectType: JobSubject; subjectId: Uuid } & Scalars` and has no `tenantId` member. A payload carrying one **does not compile**. Belt: the enqueue helper's runtime schema is `additionalProperties: false` and additionally refuses any key matching `/tenant/i`, so a stringly-typed `boss.send()` on the edge of the type system is refused at enqueue, not discovered at drain.
2. **The handler cannot open its own context.** `REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA app FROM crm_app` plus per-function `GRANT` from `security.function_registry` (§7.7.3) is already in force. A **catalog gate** is added: `app.begin_job` and `app.begin_request` are the **only** two `EXECUTE`-granted functions whose `prosrc` contains `set_config('app.tenant_id'`. A third door cannot be built as a definer either.
3. **A corrupted id fails closed, loudly.** It resolves to *that subject's* tenant or to nothing; it can never **select** a tenant. `CTX02` sends the job to `dead_letter`, whose unresolved count is already a rendered metric, and the lane's T3 scheduler-lag tripwire pages.
4. **The `ctx_txid` binding** kills the pooled-connection inheritance vector in the same statement: `app.current_tenant()` returns `NULL` when `current_setting('app.ctx_txid', true)::bigint IS DISTINCT FROM txid_current()`, so a context leaked from a previous unit of work on the same pooled connection produces zero rows, not wrong rows.

**Publication.** The data model's open question *"PG-BOSS SCHEMA ON THE RLS EXCEPTION LIST … mitigation options (a) HMAC-signed payloads (b) re-derive from subject_id"* is **closed in favour of (b)** and marked closed by locator. `sec-4` §"five execution contexts are covered" is true only with this in force, and now says so.

**Walkable?** Two honest residuals, neither of which is the finding.

- **The general GUC-forging vector remains, and it is pre-existing.** `sec-2` §5 already documents it: Postgres does not gate the `SET LOCAL` utility statement on custom placeholder GUCs, so a hand-written `SET LOCAL app.tenant_id = …` by `crm_app` is syntactically possible in *any* of the five contexts. The nets are the dependency-cruiser rule (only `withTenant` is exported; the pool is module-private) and the grep gate on the three literals outside `src/db/context/**` — both tree-local, both walkable. The engine-level close is the **signed-context GUC** (an HMAC over `tenant‖user‖scope‖txid` re-verified inside `app.current_tenant()`, with the key in a relation `crm_app` cannot read), which `sec-2` correctly defers as a **Sprint-0 measured option** because `current_tenant()` is evaluated by RLS and the cost must be measured against the 300 ms p95 before it becomes load-bearing. **Carry it as a Gate-5 residual with an owner, not as a closure.**
- What C5 named — *the handler trusts its own payload* — is closed outright, and closed at the type level rather than by discipline.

---

### 11.6 · (§9.1-6 / C10-review-2) `app.leaderboard_rebuild()` — the one named, **verifying** rebuild path

**The defect.** `ARR-EVT-21` names `leaderboard_projection` specifically. After the revoke, any rebuild can only be a definer or migrator path, and none is specified beyond a name in P5.1. This is the single code path capable of rewriting money that fifty people have already seen.

#### 11.6.1 · The ruling

> **A rebuild that changes no number needs no permission. A rebuild that changes a number is an incident, and must leave the same trail an admin void leaves.** `verify_only` is the default; `repair` requires a ticket that states the expected drift **before** the drift is measured.

```sql
CREATE TYPE app.rebuild_mode AS ENUM ('verify_only','repair');

CREATE TABLE ops.projection_rebuild_ticket (        -- append-only, immutable set, S6/S7 apply
  ticket_id             uuid PRIMARY KEY,
  tenant_id             uuid NOT NULL,
  period_type           app.period_type NOT NULL,
  requested_by          uuid NOT NULL REFERENCES app.app_user(id),
  reason                text NOT NULL CHECK (length(btrim(reason)) >= 40),
  max_abs_drift_cents   bigint NOT NULL CHECK (max_abs_drift_cents >= 0),
  opened_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
  consumed_at           timestamptz
);

CREATE TABLE ops.projection_rebuild_diff (          -- append-only; the durable evidence
  ticket_id uuid NOT NULL REFERENCES ops.projection_rebuild_ticket(ticket_id),
  tenant_id uuid NOT NULL, user_id uuid NOT NULL,
  period_type app.period_type NOT NULL, period_key date NOT NULL,
  was_cents bigint NOT NULL, now_cents bigint NOT NULL,
  PRIMARY KEY (ticket_id, user_id, period_type, period_key)
);

CREATE FUNCTION app.leaderboard_rebuild(
  p_period    app.period_type,
  p_mode      app.rebuild_mode DEFAULT 'verify_only',
  p_ticket_id uuid             DEFAULT NULL
) RETURNS ops.rebuild_result
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, ref, ops, pg_catalog AS $$
-- 1. pg_advisory_xact_lock(hashtext('lb_rebuild:'||v_tenant||p_period))  -- no interleaving
-- 2. Recompute totals from app.earnings_ledger ONLY. The ledger is the authority.
-- 3. Write every (was_cents <> now_cents) into ops.projection_rebuild_diff. ALWAYS, both modes.
-- 4. IF p_mode = 'verify_only' THEN RETURN the diff summary. No write to the projection. END IF.
-- 5. IF p_ticket_id IS NULL THEN RAISE 'RB001 repair requires a ticket'.
--    IF ticket.consumed_at IS NOT NULL THEN RAISE 'RB002 ticket already consumed'.
--    IF sum(abs(now-was)) > ticket.max_abs_drift_cents THEN RAISE 'RB003 drift %, ticket allows %'.
-- 6. UPDATE app.leaderboard_projection to the recomputed totals; bump seq.
-- 7. PERFORM app.watermark_bump(v_tenant, NULL, 'leaderboard');       -- fifty ETags move
-- 8. For every affected seller: app.event_emit('earnings.updated', …) and append a
--    ledger row entry_type='projection_repair', delta = (now - was), reason = ticket.reason,
--    source_event_id = uuidv5(NS_REBUILD, ticket_id||user_id||period_key)  -- idempotent, once ever
-- 9. UPDATE ticket SET consumed_at = clock_timestamp();  app.audit_write('projection.rebuilt', …)
$$;
```

**Six properties that make it not-ad-hoc:**

1. **The ledger is never written by the rebuild except as an append.** Step 8 appends a `projection_repair` entry rather than silently editing a total, so the invariant `sum(ledger deltas) == projection total` — property-tested by L2-B4 — holds *after* a repair, and the repair is itself explicable. History is never rewritten; it is corrected forward, exactly as `P4.5` requires of every public number.
2. **The safe mode is the default**, and it is the one anyone can run at any time. Drift detection costs nothing and requires no ceremony.
3. **The dangerous mode cannot be silent.** `RB001`/`RB002`/`RB003` mean a repair with no ticket, a replayed ticket, or a drift larger than the ticket predicted all fail. Predicting the drift *before* measuring it is the property that makes a rubber-stamp ticket useless.
4. **The seller whose number changed sees why.** A `projection_repair` row renders in My Earnings through the same discriminated union as `manual_adjustment` (§10.1) — a `projection_repair` arm carrying `reason_text: string` **non-optional**, so **a repair that renders without its reason does not compile.**
5. **It cannot become a second money writer.** Schema gate **S20** (same `pg_proc.prosrc` shape as S8/S18/S19): `app.leaderboard_rebuild`'s body contains no `INSERT`, `UPDATE` or `DELETE` against `app.earnings_ledger` other than through `app.ledger_append(entry_type => 'projection_repair')`, and contains no reference to `app.opportunity`.
6. **It is enumerable.** `ARR-EVT-21`'s *"one job"* is now exactly two named definer functions, and the pair is asserted complete: `app.replay(from_seq, to_seq, consumers[])` (which still raises on any `inline` consumer) and `app.leaderboard_rebuild(period, mode, ticket)`. A CI catalog query asserts no other `EXECUTE`-granted function writes `app.leaderboard_projection` besides `app.leaderboard_apply()`.

**What Jorge sees.** `/admin/system` renders **`last projection rebuild: <when> · <n> rows changed · ticket <id> · <reason>`**, and the row is permanent because `ops.projection_rebuild_diff` is append-only. `projection_repair` is registered in `ref.job_registry` at `bulk` priority (§11.7).

**Walkable?** A migration can insert a ticket with a large `max_abs_drift_cents` and run a repair. That is by design — a genuine post-incident repair must be possible without Jorge holding a keyboard at 2 a.m. What it cannot do is happen **quietly**: the diff rows are permanent, the seller's own My Earnings shows a `projection_repair` line with the reason, and `/admin/system` carries the record. The prohibited outcome — *money on fifty screens is rewritten by a path nobody named and nobody can see afterwards* — is closed. The residual is stated: `ops.projection_rebuild_ticket.reason` is free text, and free text is only as good as the person writing it; the compensating control is that it is rendered to the affected seller, not filed in a log.

---

### 11.7 · (§9.1-7 / B9 / 1.9 / 1.10) `ref.job_registry.priority` — the latency axis

**The defect.** `weight ∈ {light, heavy}` is a **CPU** axis with no latency axis. During the 20,000-message replay the architecture itself sizes, a TCPA `STOP` is job 14,000 in a FIFO drain, and the 5-second `lead.created` SLA is behind the same drain. `ARR-EVT-13` is explicit that *delay* is a **legal** failure, not a UX degradation.

**Note on provenance.** §7.9 and §10.9 both build this axis and the audit could not see either. They are consolidated here into one object, and **one contradiction between them is ruled**: §7.9.3 places the STOP sniff in `src/domain/**`; §10.9 places it in `src/ingress/stopSniff.ts` with dependency-cruiser forbidding imports from `src/domain/**` and `src/db/**`. **§10.9's placement wins** — it is the self-consistent one, and it is what keeps the parse-free ingest rule true.

#### 11.7.1 · The object, with the exact mechanics `weight` already has

```sql
CREATE TYPE app.job_priority AS ENUM ('compliance','interactive','bulk');

ALTER TABLE ref.job_registry
  ADD COLUMN priority app.job_priority NOT NULL,        -- NO DEFAULT. Unclassified is impossible
  ADD COLUMN lane text GENERATED ALWAYS AS ('lane_' || priority::text) STORED;
```

- **Seeded from the generated file**, the same one that seeds `weight` and `ref.event_consumer`. `pnpm gen:jobs && git diff --exit-code` is the drift gate.
- **`harden()` raises** (a) on any `ref.job_registry` row with no `priority`, and (b) on **any queue name present in the built bundle that has no registry row**. Adding a job without classifying its latency criticality **fails the deploy**, exactly as an unclassified relation does. `NOT NULL` with no default means the classification cannot be omitted; the bundle scan means the registry cannot be bypassed.

| Priority | Members | Why |
|---|---|---|
| `compliance` | `message.received` merge (the STOP chain), suppression/consent append, Aloware disenroll (`ARR-EVT-14`), T-1h reminder dispatch, break-glass expiry side effects | Delay is a **legal** failure. The reminder is here, not in `interactive`: a late reminder can fire **outside the legal calling window** |
| `interactive` | intake `lead.created` materialisation (`ARR-MVP-18`'s 5 s SLA), call-merge for a live call, notification fan-out | Delay is measured in seconds on the number the entire lead spend is judged by |
| `bulk` | webhook replay, reconciliation backfill, export, event archive, retention purge, `projection_repair` (§11.6) | Delay is invisible |

#### 11.7.2 · Reserved capacity, not priority ordering

pg-boss's per-queue priority orders a fetch *within* a queue; one worker slot still blocks behind a long bulk job. Three fetch loops, own connections, own concurrency:

- `WORKER_LANES` is **derived from the registry**, never configured by hand.
- A process whose `PROCESS_ROLES` includes `worker` **exits non-zero at boot if its lane set omits `compliance`.** The compliance lane cannot be accidentally undeployed, in either topology.
- **The enqueuer cannot choose the lane.** The generator emits one typed helper per job (`enqueue.callMerge(...)`) and the lane is looked up from the registry at enqueue time. A raw `boss.send('x')` enqueues into a queue **no lane drains**, and an L2 topology-shaped test asserts the union of lanes drains every registered queue.
- Each lane writes **its own heartbeat row** into `security.process_heartbeat` (§7.10), so a starved or wedged lane is visible per lane and drives the amber bar in every browser.

#### 11.7.3 · The STOP reaches the lane, and a mis-classification costs latency, never correctness

The ingest edge is parse-free, so `intent_hint='stop'` is unknowable at enqueue time. Resolution: `src/ingress/stopSniff.ts` is a **pure byte scan of the first 320 bytes of the raw body** for the carrier keyword set (`STOP`, `STOPALL`, `UNSUBSCRIBE`, `CANCEL`, `END`, `QUIT`) — no JSON parse, no schema, no domain read, no DB read, no allocation. dependency-cruiser forbids it importing from `src/domain/**` or `src/db/**`, so it cannot grow into a parser and re-import the latency it exists to avoid. A match enqueues `lane_compliance`; everything else `lane_interactive`. False positives are free. **The fallback is correctness-preserving**: the merge job re-evaluates `intent_hint` properly and the consent + suppression append is an `inline` consumer inside the merge transaction, so a missed sniff is *late*, never *lost*. Declared residual: a STOP arriving base64-encoded or in a field absent from the raw bytes misses the sniff.

#### 11.7.4 · The assertion that makes the lane real

**Gate G6 / P24, protected:** during the 20,000-webhook replay at 333/s, inject one STOP. Assert the `suppression_list` row exists within **5 seconds** and that a dial to that number issued at T+5 s returns `blocked_suppressed`. Asserted in **both** topology legs, `folded` and `split`. **L2-P:** enqueue 20,000 `bulk` jobs, then one `compliance` job; assert it starts within 5 s with the full backlog present. Tripwires split per lane: T3a compliance oldest-pending > 15 s → page; T3b interactive > 60 s → page; T3c bulk > 30 min → informational.

**Walkable?** A migration can reclassify a job from `compliance` to `bulk`. Two things make it not free: `ref.job_registry` is seeded from a generated file under the `ci/guards.json` seal, so the reclassification advances `security.seal` and appears in `/admin/system`'s *"guards changed since last release: N"*; and **G6 is a protected assertion with `retries: 0`** — reclassifying the STOP chain makes the storm gate red, in both topologies, before the deploy gate is reached. The honest residual is the sniff's coverage, not the lane.

---

### 11.8 · (NEW-2) One sealed signature, published once, with the two substantive decisions ruled

**The defect.** The one artifact whose freeze test is supposed to break the build exists in three versions with two arities, and §7.1.2 asserts equality against *"the sealed column list"* without saying which. P5's precedence clause selects the narrowest, which drops `US-9.6` and inverts the boolean that renders the **Inactive** chip.

#### 11.8.1 · The published signature — this one, everywhere

```sql
app.leaderboard_read(p_period app.period_type)
RETURNS TABLE (
  user_id            uuid,
  display_name       text,
  avatar_ref         text,
  total_cents        app.money_cents,
  rank               integer,
  is_inactive        boolean,
  tenant_total_cents app.money_cents,
  etag               text
)
```

**Decision 1 — one argument, not two.** §10.3's `(period_type, period_key)` is **struck**. `period_key` must be computed **inside** the function from `tenant.business_tz` via `app.period_key_for()`. A caller-supplied period key is a caller-supplied truth about time, and — decisively — it makes the ETag **caller-dependent**, which destroys the byte-identity property that closes Scenario A. The narrower arity is the correct one here and the reason is mechanical, not stylistic.

**Decision 2 — `tenant_total_cents` stays.** P5.2's list is **amended**, not applied. `US-9.6` requires the supervisor tenant total; B4 confirms that after `REVOKE SELECT ON leaderboard_projection` there is no other read path; grep confirms `tenant_total` appears in no section and nowhere in the data model. Applying the narrowest list would drop an approved requirement silently — the exact Puerta-12 failure mode. It is computed tenant-wide inside the definer and is identical on every returned row.

**Decision 3 — the boolean is `is_inactive`, and the body is corrected to match.** §7.1.1 computes `(u.deactivated_at IS NULL) AS is_active`; P5.2 names the column `is_inactive`. Shipping P5.2's *name* over §7.1.1's *body* renders the **Inactive** chip on every active seller and omits it from the deactivated one — a wrong chip on fifty screens, from a naming collision. The chip is named `Inactive` in `US-9.12` and `04b`, so the field is `is_inactive` and the body becomes:

```sql
(u.deactivated_at IS NOT NULL) AS is_inactive
```

A CI test asserts the React prop feeding `<InactiveChip>` is `is_inactive` and that no negation appears between the two — the inversion is caught at the one place it can be introduced.

#### 11.8.2 · The object: `ref.sealed_signature`, so "the sealed list" names itself

```sql
CREATE TABLE ref.sealed_signature (            -- immutable set; AP001 trigger; sealed by §7.6.2
  function_signature text PRIMARY KEY,         -- 'app.leaderboard_read(app.period_type)'
  result_text        text NOT NULL,            -- verbatim pg_get_function_result() output
  sealed_in_migration text NOT NULL,
  requirement_refs   text[] NOT NULL           -- {ARR-EVT-23, US-9.5, US-9.6, US-9.12, R1.3}
);
```

`harden()` asserts, for **every** row, that `pg_get_function_result(function_signature::regprocedure) = result_text`, and raises `SS001` naming the drifted signature. §7.1.2's ambiguous assertion is replaced by a lookup with a primary key. Registered at go-live: `app.leaderboard_read`, `app.my_standing_read` (§11.4), `app.stage_move`, `app.opportunity_set_premium`, `app.ledger_adjust`, `app.leaderboard_rebuild`, `app.begin_job`. Adding `contact_id` to the board's return type fails the **deploy**, not only the build.

**Walkable?** A migration can update `result_text` and the function together. `ref.sealed_signature` is in the immutable set and in `security.protected_object`, so the update requires dropping the `AP001` trigger — counted and rendered (§11.11). What is closed outright is the version ambiguity: there is now exactly one place to look, it has a primary key, and the two substantive decisions are ruled in writing instead of resolved by a precedence clause nobody applied.

---

### 11.9 · (NEW-4 + NEW-6) One managed-schema predicate feeds both `harden()` loops

**The defects.** §7.3.1 made the relation check schema-agnostic **by exempting the schemas on `security.schema_exception`**, whose seed includes `ref` — so `ref.event_consumer` (the fan-out authority), `ref.constraint_refusal` (the refusal map) and `ref.ci_ratchet` (the enforcement ledger) fell **out** of the hardening net that the old two-schema loop covered. §10.0.1 simultaneously registers `ref.ci_ratchet` in `security.table_registry`, which the exemption makes moot. And §10.0.2's column classification still raises **only for relations in `app`**, immediately after the relation check stopped being schema-shaped.

**The root cause is one conflation:** *"we do not own this schema"* (`auth`, `pgboss`, `cron` — foreign DDL, foreign upgrade cycle) and *"this schema needs no classification"* were the same flag.

#### 11.9.1 · The object

```sql
CREATE TYPE app.schema_posture AS ENUM ('managed','foreign');

CREATE TABLE security.schema_policy (          -- replaces security.schema_exception
  schema_name      text PRIMARY KEY,
  posture          app.schema_posture NOT NULL,
  exception_reason text NOT NULL,
  CONSTRAINT core_schemas_are_managed CHECK (
    schema_name NOT IN ('app','ref','security','ops') OR posture = 'managed')
);
-- seed: app/ref/security/ops = managed ; auth/pgboss/cron = foreign (foreign DDL, foreign upgrades)

CREATE FUNCTION security.managed_relations()
RETURNS TABLE (oid oid, nspname text, relname text, relkind "char")
LANGUAGE sql STABLE AS $$
  SELECT c.oid, n.nspname, c.relname, c.relkind
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN security.schema_policy p ON p.schema_name = n.nspname
   WHERE c.relkind IN ('r','p','v','m','f') AND p.posture = 'managed';
$$;
```

- **`security.managed_relations()` is the single source of "what `harden()` looks at."** Both loops read it: the relation-level unclassified check (`HR001`) and the **column-level** classification check (`HR002`), which is thereby extended from `app` to every managed schema in the same statement that fixes NEW-4. NEW-6 cannot recur because there is no second definition of the corpus to forget to update.
- **Schema gate S21** asserts `pg_proc.prosrc` of `security.harden()` contains **no `pg_class` scan** other than through `security.managed_relations()`. A future loop that re-hardcodes a schema list fails the pre-merge tier.
- **`core_schemas_are_managed` is a table `CHECK` that names the four core schemas literally.** Demoting `ref` to `foreign` is not a row edit — it requires `ALTER TABLE security.schema_policy DROP CONSTRAINT core_schemas_are_managed`, a protected-object drop (§11.11). This is the point of the object: NEW-4 happened because a *row* in a permissive list took `ref` out of the net. A row can no longer do that.
- A **foreign** schema is exempt from *classification* only; it is **not** exempt from the grant assertion. The `catalog_digest` (§7.7.7) still covers `crm_app`'s grant matrix on every schema, so `pgboss` cannot quietly acquire tenant-table privileges.
- `security.schema_exception`'s registered ratchet name becomes **`shrink_only`** (§11.3): adding a schema to the exemption set is the loosening and is refused at the engine.

**Test L2-C is extended.** Alongside `CREATE TABLE public.saved_view`, the test asserts (d) an unclassified `ref.new_thing` raises `HR001`, and (e) an unclassified **column** on `ref.event_consumer` raises `HR002`. Both would pass silently today. Coverage of the enforcement-metadata tables is restored to strictly better than the pre-reconciliation loop, which covered `app` and `ref` but never `security` or `ops`.

**Walkable?** Yes, by dropping the `CHECK` — and only by dropping the `CHECK`, which is exactly the act §11.11 counts. What was walkable *by inserting a row* no longer is.

---

### 11.10 · (NEW-3) Protected assertion ids are allocated by primary key, not by prose

**The defect.** `DEMO-11` is bound to the leaderboard second-session assertion in §7.1.2 **and** to the admin-void E2E in §10.1. `protected-list.json`'s CI rule fails when an entry resolves to zero or more than one test — so the reconciliation ships a red gate.

#### 11.10.1 · The reassignment (binding)

| Id | Assertion | Source |
|---|---|---|
| `DEMO-01`…`DEMO-10` | the ten original protected items | `sec-3` §6.2, unchanged |
| **`DEMO-11`** | **leaderboard second-session: byte-identical ETags across readers, pending row absent for all, ETag moves with no writer** | §7.1.2 **L2-A** — first claim, and the crown-jewel assertion |
| `DEMO-12` | fifty sellers, zero ledger rows → fifty rows, fifty `$0`, no row hidden at 375 px | §10.4 |
| `DEMO-13` | deactivate a seller holding credits → absent from Today/Week/Month, present on All-time with the **Inactive** chip | §10.4 |
| `DEMO-14` | transfer a contact holding a credited opportunity → both totals unchanged | §10.13 |
| **`DEMO-15`** | **admin voids seller A's credit → A's My Earnings shows the offsetting row with its reason text; total drops by exactly that amount; the original row is still present** | §10.1 — **reassigned from `DEMO-11`** |
| **`DEMO-16`** | win-gate private standing: `new_total` reflects the win, `includes_pending = true`, B's public board still shows the pre-win total, ETags byte-identical | §11.4 — new |

#### 11.10.2 · The object, so a third collision is not possible

```sql
CREATE TABLE ref.protected_assertion (         -- seeded by migration; immutable set
  assertion_id     text PRIMARY KEY,           -- 'DEMO-11', 'D3-05', 'R2-7'
  title            text NOT NULL,
  source_locator   text NOT NULL,              -- '§7.1.2 L2-A'
  added_in_migration text NOT NULL
);
```

`protected-list.json` and `required-assertions.json` are **generated from this table**, not hand-maintained. Two documents claiming `DEMO-11` become a **primary-key violation in the seeding migration** — the deploy fails, naming the id. NEW-3 stops being a CI rule that reports a collision after the fact and becomes an engine fact that refuses to create one. The existing report gate (fails on any `skipped` / `fixme` / `fail` on a `/^(DEMO-\d\d|D3-\d\d)/` title) and `retries: 0` are unchanged and now iterate the generated list.

**Walkable?** A migration can rename ids. It cannot create a duplicate, which is the defect. Combined with the §10.6 rule that any id resolving to zero or more than one non-skipped test fails the run, an id that exists but tests nothing is still red.

---

### 11.11 · (NEW-7) What actually survives the actor who writes migrations

**The defect, restated as the audit named it.** *"Only `crm_migrator` can weaken this"* means *"Claude writes a migration."* Append-only triggers, `harden()` itself and the ratchet triggers are all droppable or replaceable by a migration, and there is no reviewer. **Eleven closures rest on this doctrine, and §11.1–§11.10 add nine more.**

#### 11.11.1 · The registry — one row per object whose removal changes what the system means

```sql
CREATE TYPE security.ddl_object_kind AS ENUM
  ('trigger','function','policy','constraint','index','type','event_trigger');

CREATE TABLE security.protected_object (
  object_kind       security.ddl_object_kind NOT NULL,
  object_identity   text NOT NULL,           -- pg_identify_object_as_address form
  definition_sha256 bytea NOT NULL,          -- pg_get_functiondef / pg_get_triggerdef /
                                             -- pg_get_constraintdef / pg_policies row digest
  protected_since_migration text NOT NULL,
  reason            text NOT NULL,
  PRIMARY KEY (object_kind, object_identity)
);

CREATE TABLE security.protected_object_history (   -- APPEND-ONLY. Never revertible. Rendered.
  n bigserial PRIMARY KEY, object_kind security.ddl_object_kind NOT NULL,
  object_identity text NOT NULL, change_kind text NOT NULL,   -- dropped | replaced | disabled
  old_sha bytea, new_sha bytea, authorization_id bigint NOT NULL,
  happened_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
```

**Registered at go-live (the set is small and almost never changes):** the `AP001` append-only triggers on `earnings_ledger`, `audit_log`, `consent_ledger`, `ref.ci_ratchet`, `ref.ci_ratchet_name`, `ref.sealed_signature`, `ref.protected_assertion`, `security.seal`, `ops.projection_rebuild_*`; `security.harden()` itself; `security.managed_relations()`; `app.current_tenant()`, `app.begin_request()`, `app.begin_job()`; `app.leaderboard_read()`, `app.my_standing_read()`, `app.leaderboard_rebuild()`, `app.stage_move()`, `app.ledger_append()`, `app.opportunity_set_premium()`, `app.ledger_adjust()`, `app.celebrate_once()`, `app.projection_reveal_delay()`, `app.undo_deadline()`; the constraint triggers `t_earning_must_credit`, `opportunity_earning_requires_credit`, `ledger_merge_pair_complete`; the constraints `ledger_forbidden_input`, `ledger_source_is_a_declared_input`, `core_schemas_are_managed`, `ledger_owner_is_seller`, `ledger_adjust_shape`; the `p_app` / `p_sys` policies on every money-bearing relation; the two partial unique indexes of §10.2.

#### 11.11.2 · The authorization, anchored **outside the working tree**

```sql
CREATE TABLE security.ddl_authorization (
  id bigserial PRIMARY KEY,
  object_kind security.ddl_object_kind NOT NULL, object_identity text NOT NULL,
  justification text NOT NULL CHECK (length(btrim(justification)) >= 40),
  authorized_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  consumed_at timestamptz, consumed_by_txid bigint
);

CREATE TABLE security.ddl_authorization_key (      -- one row; crm_app has no privilege at all
  id smallint PRIMARY KEY CHECK (id = 1),
  key_sha256 bytea NOT NULL
);

CREATE FUNCTION security.authorize_ddl(
  p_kind security.ddl_object_kind, p_identity text,
  p_justification text, p_token text
) RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER AS $$
-- RAISES 'DA001 invalid or absent DDL authorization token' unless
--   digest(p_token,'sha256') = (SELECT key_sha256 FROM security.ddl_authorization_key)
-- INSERTs the row; writes admin_alert(kind='ddl_authorized'), unacknowledgeable for 7 days.
$$;
```

> **`DDL_AUTHORIZATION_TOKEN` exists in exactly one place: Jorge's Render dashboard.** It is not in the repository, not in CI, not in any running process's environment except the one-shot migration job, and it is not in this document. The migration runner reads `process.env.DDL_AUTHORIZATION_TOKEN` and passes it to `security.authorize_ddl()`. **A migration written by a model cannot supply a value the model does not have.**

This is property **(b)** from §11.0 — the gate anchored outside the code tree — applied to the one act the whole doctrine depends on. It is deliberately scoped to protected-object changes only (roughly thirty objects that change almost never), **not** to ordinary seal advances, so it does not make Jorge a bottleneck on normal work.

#### 11.11.3 · Enforcement point 1 — the event trigger, **if and only if the platform grants it**

```sql
CREATE FUNCTION security.refuse_unauthorized_ddl() RETURNS event_trigger
LANGUAGE plpgsql AS $$
-- For each row of pg_event_trigger_ddl_commands():
--   CREATE OR REPLACE FUNCTION / ALTER POLICY / ALTER TABLE on a protected identity:
--     recompute definition_sha256; if it differs and no un-consumed matching
--     security.ddl_authorization row exists -> RAISE 'PO002' (rolls back the whole DDL);
--     otherwise consume the row and append to protected_object_history.
--   command_tag 'ALTER TABLE': additionally assert every protected trigger on that
--     relation still has pg_trigger.tgenabled <> 'D'  (catches DISABLE TRIGGER, which
--     reports the TABLE as the object identity, not the trigger).
$$;
CREATE EVENT TRIGGER t_protect_ddl  ON ddl_command_end
  EXECUTE FUNCTION security.refuse_unauthorized_ddl();

CREATE FUNCTION security.refuse_unauthorized_drop() RETURNS event_trigger …;
CREATE EVENT TRIGGER t_protect_drop ON sql_drop
  EXECUTE FUNCTION security.refuse_unauthorized_drop();
```

**Both are required.** `ddl_command_end` does **not** report dropped objects; `pg_event_trigger_dropped_objects()` is only available in an `sql_drop` trigger. `CREATE OR REPLACE FUNCTION` is caught by the first; `DROP TRIGGER` / `DROP FUNCTION` / `DROP POLICY` / `ALTER TABLE … DROP CONSTRAINT` by the second. Because `ddl_command_end` fires **inside the same transaction** as the command, a `RAISE` rolls the DDL back — the refusal is atomic, not compensating.

> **Platform reality, and it is why this cannot be the primary.** `CREATE EVENT TRIGGER` **requires superuser**, and the approved corpus records in four places that Render's managed Postgres does not grant it and that the design must not depend on one. Gate 0's grant probe (`sec-5` §Gate-1 assert (f)) decides. **If the grant exists, the event triggers install as belt-and-braces. If it does not, §11.11.4 carries the entire weight, and `/admin/system` renders `DDL guard: catalog-digest only (event triggers not granted)` so the absence is a stated fact rather than an assumption.**

#### 11.11.4 · Enforcement point 2 — the digest chain, which needs no superuser and is the primary

**At deploy.** `security.harden()`, **before** writing its `harden_run` row, walks `security.protected_object` and raises **`PO001`** naming the object if any row's object is **missing**, **disabled** (`tgenabled = 'D'`, `evtenabled = 'D'`) or has a **different `definition_sha256`** — *unless* an un-consumed `security.ddl_authorization` row matches, in which case it consumes the row, records the new hash and appends to `security.protected_object_history`. **`harden()` refuses to bless a drop it was not shown a token for.** The deploy stops; the previous image keeps serving.

**At boot.** Every process recomputes the `catalog_digest` of §7.7.7 — now extended to include (i) every `security.protected_object` row's live definition hash, (ii) `evtenabled` for both event triggers where installed, and (iii) `security.protected_object_history`'s head — and compares it to `security.harden_run`. Mismatch → `process.exit(1)` naming the drifted object. A dropped trigger becomes **an outage Jorge can see**, not a silent breach.

**Against the circular attack.** A migration that neuters `harden()` and rewrites `protected_object` would produce a self-consistent new digest. It is closed by the seal chain of §7.6.2: `security.protected_object`'s content hash is a member of `ci/seal-manifest.jsonl`, `security.seal` is append-only and immutable, and boot asserts the image's manifest head equals `security.seal`'s head. Advancing the seal for a protected-object change requires `security.authorize_ddl()` and therefore the dashboard token.

**On Jorge's screen, permanently.** `/admin/system` renders **`protected objects changed since go-live: N`** with the object list, the justification text and the date, sourced from `security.protected_object_history`, which is append-only and cannot be reverted or rewritten. Next to it: `guards changed since last release: N` (§7.6.2). **Two numbers on one screen are the behavioural check that replaces the reviewer.**

#### 11.11.5 · The honest boundary, stated rather than hidden

**This does not make loosening impossible. It makes loosening require a value the model does not possess, and makes every loosening permanent, counted and rendered.**

What a migration alone can still do: create tables, add columns, add constraints, seed rows, advance ordinary guard files. That is normal work and it should stay cheap.

What a migration alone can **no longer** do: drop or replace any of the ~30 registered objects without either (i) being refused in-transaction by the event trigger where the platform grants it, or (ii) stopping the next deploy at `PO001`, or (iii) stopping every process at boot on digest mismatch. To get past all three it needs a `security.ddl_authorization` row, and to get that it needs the dashboard token — property (b).

What remains genuinely open: a **superuser** on the database can disable an event trigger and can drop anything. On Render, the application does not hold superuser, and the migrator's credential lives only in the deploy job's environment (`sec-4`, ADR-S4, SEC-3). If that credential is ever exposed to a workflow that executes PR-branch code, every mechanical guarantee in this document evaporates in one statement — which `sec-4` §"Where it lives" already states, and which the token does not change.

---

### 11.12 · What this pass does **not** close

Presented as declared residual risk with owners, per the audit's recommended gate condition — not as closures.

1. **The signed-context GUC** (§11.5). Hand-forging `SET LOCAL app.tenant_id` remains syntactically possible for `crm_app` in all five execution contexts. The engine-level close is specified and its cost is a Sprint-0 measurement against the 300 ms p95. **Pre-existing, not introduced here.**
2. **§9.2 items 8–17 of the audit** — `3.9` restore-and-boot beyond the digest, `4.1` folded perf topology, `C2`/`C1` review-2 naming, `1.4` SMS-dark axis, `C6` the pre-cemented 250 KB, `4.4`'s opportunistic write, `C7`/`3.2`/`3.4` registry coverage. Several are addressed by §7.7–§7.10 text the auditor could not see; **each needs a verification pass against the untruncated documents before it is called closed.**
3. **All of §9.3, the publication debt.** Every correction in this section is published with its locator; the pre-existing debt (`A6`, `C1`, `C4`, `C5`, `C7`, `C11`, `C13` review-1, `B7(a)`, `B12`, `B14`/`C9`, `1.7`, `3.5`, `3.7`, `3.8`, `4.2`, `4.3`, `4.5(ii)`) is not touched here. **Puerta 12's failure mode is not the unfixed contradiction; it is the one that was fixed in silence.**
4. **Gate-0 dependency.** §11.11.3's event triggers are conditional on a grant probe that has not run. The design does not depend on them, and `/admin/system` states which mode is live.


---

# §5 — Closure audit (first pass — verdict: NOT READY)

## CLOSURE AUDIT — Phase 5B reconciliation vs. the 80 findings of review-1 and review-2

## 0 · Audit scope, and the bar I applied

**What I was given.** Both reviews in full; the rulings text truncated inside **P5.2** (P5.3, P5.4, P6, P7, P8 not supplied); the mechanical corrections truncated inside **§7.4.2** (§7.5–§7.9 not supplied); the gap closures truncated inside **§10.5** (§10.6–§10.20 not supplied). Where a closure is *named by cross-reference* but its text falls beyond the cut, I rule **PARTIAL (unverified)** and say so — I do not credit a mechanism I cannot read. This is not pedantry: §10.5's own title concedes a gate can be "satisfiable dishonestly", and a closure I cannot inspect is exactly that.

**The bar for CLOSED.** The defect cannot recur without a schema migration, and after that migration `harden()` / a constraint / a type / a revoked privilege / a seller-visible symptom re-asserts the invariant. A mechanism whose enforcement is *a literal in a test file*, *an added row in a permissive list*, *an alert nobody reads*, or *a diff someone must read* is not CLOSED. I applied it to the corrections' own text, including where a ruling's mechanism violates the admissibility rule the corrections themselves publish.

Tally: **24 CLOSED · 1 RULED · 28 PARTIAL · 30 OPEN**, plus **7 defects the reconciliation itself introduces** (§4), two of which are in the fatal class.

---

## 1 · REVIEW-1 — LIST A (contradictions with approved documents)

| # | Verdict | Basis / remaining hole |
|---|---|---|
| **A1** SSE forbidden by three approved texts | **CLOSED** | P1 declares the change and writes the three amendments out **by locator** (item 62, `03-mvp-stories` §0 cut list, `04b` §1.10 opening line); the channel generator raises on `push_capable` without `poll_interval_ms`, so the arithmetic can never silently drop. |
| **A2** R1.3 unimplemented; two projections needed | **PARTIAL** | The public exclusion is now tenant-wide (§7.1) and My Earnings keeps the private ledger path (§10.1). **But after `REVOKE SELECT ON leaderboard_projection`, no read path is specified for the win gate's `{new_total, rank, gap_to_next}`, which P2.4 requires inside the 200.** The only sanctioned read excludes the winner's own pending row, so the celebration would print the pre-win total and rank. |
| **A3** celebration as a `pgboss` delayed job | **CLOSED** | P2 deletes the job: client-owned timer, opaque non-`Jsonable` token (persisting it does not compile), `app.celebrate_once()` conditional UPDATE. Only failure mode left is *no* confetti. (Arithmetic defect: NEW-1.) |
| **A4** `pipeline.stage_config_changed` absent from ledger consumers | **CLOSED** | P4 voids `ARR-EVT-09`, strikes the four recompute texts by locator, removes `closed_flags_changed[]` from the payload (`additionalProperties:false` → typecheck), and CI asserts the pair's absence; unregistered fan-out is *mechanically guaranteed never to run*. |
| **A5** dial executed post-commit by the relay | **CLOSED** | P3: `RequestScoped` capability token a job context cannot mint, `dial_outcome` in the endpoint's output type, dependency-cruiser ban, no `comms.aloware_dial` registry row. Residual: `04b` §3.4's `(gate + dial) p95 < 300 ms` must appear in P5.4's superseded list — not verifiable in the supplied excerpt. |
| **A6** `moved_via` 7 values vs 4 in the catalog | **PARTIAL** | `app.moved_via` is the parameter type in §7.4.1, so the seven-value enum ships — but no correction publishes the amendment to `02b` §4 with the mapping, which is what A6 asked for. The enum remains, on paper, invented. |
| **A7** `opportunity.stage_changed` missing from the win transaction | **CLOSED** | §7.4.1 emits it unconditionally inside `app.stage_move()`, and the column-level `REVOKE UPDATE (stage_id, current_stage_type, …)` makes that function the only writer — the emission cannot be separated from the move. |
| **A8** `contact.became_client` schedules a V1.1 cross-sell | **OPEN** | Untouched. Nothing registers the event as consumer-less; the MVP still grows an automation in prose. |
| **A9** capacity model budgets a cut wall board | **OPEN** | §9.1.1's `17,280 req/day` line is untouched and no channel in P1.2's registry is a kiosk. The credential story `ARR-PRV-06` killed is still absent. |

## 2 · REVIEW-1 — LIST B (approved requirements not covered)

| # | Verdict | Basis / remaining hole |
|---|---|---|
| **B1** admin void / adjust-with-reason | **CLOSED** | §10.1: four-label enum, three CHECKs (incl. 10-char trimmed reason), FK to the adjusted row, definer **with no amount parameter** (an admin cannot invent a number), `uuidv5` idempotency making any entry voidable at most once ever, and a discriminated union whose `manual_adjustment` arm **does not compile without rendering the reason**. Strongest closure in the set. |
| **B2** D-4, one credit per opportunity | **CLOSED** | §10.2: `credit_epoch` + two partial unique indexes (the index is the arbiter, not a count), plus the deferred `opportunity_earning_requires_credit` trigger closing the **credited-zero-times** direction nobody had guarded. |
| **B3** 5 s exclusion breaks the ETag machine | **CLOSED** | §7.1/§10.3: all three ETag inputs are reader-independent; `pending` collapses to `epoch` and `period_key` rolls at business midnight **with no writer**; the zero-writer L2 test and the 100 %-304 alarm are the assertions. (Interval defect: NEW-1.) |
| **B4** board cannot be built from ledger appends | **PARTIAL** | LEFT JOIN + `app_user_bumps_leaderboard` trigger + `ledger_owner_is_seller` FK/CHECK close US-9.5 and US-9.12 mechanically. **US-9.6's supervisor tenant total does not survive**: P5.2's sealed column list (which wins on precedence) has no `tenant_total_cents`, §10.3's does, and `crm_app` now has no other read path — grep confirms `tenant_total` appears nowhere in any section or in the data model. |
| **B5** 49-name coverage gate unsatisfiable | **PARTIAL (unverified)** | §10.5 is titled for both defects ("unsatisfiable, and satisfiable dishonestly") but its text is beyond the cut; the `no_mvp_emitter` column and the non-test-emitter assertion are not visible. |
| **B6** most of R6 has no build-breaking gate | **PARTIAL** | §10.0.3 is an honest and strong closure: perf/axe become **deploy-time** gates anchored on a ratcheted green nightly, with the override visible as an unacknowledgeable admin alert. Still unmapped: `04b` R2-1…R2-6 (including R2-6, the mechanical form of R1.7), the fixed profiles/fixtures, and **which topology perf runs in** (see 4.1). |
| **B7(a)** timezone data source decision | **OPEN** | No table, no vendor, no refresh policy, no fallback ordering. US-603's fail-closed hard block still has no data source, and break-glass exists precisely for when this is wrong. |
| **B7(b)** card height re-validated on a real 500-card render | **PARTIAL** | `ui.card_h_desktop` / `ui.card_h_mobile` are in the ratchet, but no ratchet direction can pin a value (NEW-5), and no Sprint-0 gate renders 500 cards. |
| **B8** R3.5 timeline identity leak | **PARTIAL (unverified)** | §10.0.2 exists and names §10.8 as its consumer ("the timeline read is generated from it"); the generation rule and the `Handled before this record moved to you` path are beyond the cut. |
| **B9** STOP has no priority lane through the bulkhead | **OPEN (unverified)** | Nothing visible builds the latency-criticality axis; §10.0.x builds four general machines and none is a queue priority. Legal exposure, not UX. |
| **B10** break-glass expiry | **CLOSED** | P3.5 makes expiry a read-time `now() < expires_at` inside `app.compliance_check()` — a missed job cannot leave the door open — and registers `compliance.override_started/ended` as the banner emitters. |
| **B11** degraded mode has no state | **CLOSED** | P3.4/P3.5: `app.integration_health` row, any process may OPEN / only the prober may CLOSE, `last_probe_at` staleness computed at read time so a dead prober cannot show green, one read feeding breaker + banner + every button label. |
| **B12** quiet hours | **OPEN** | The third timezone rule still has no home in the notification consumer. |
| **B13** `contact.owner_changed` negative declaration | **PARTIAL** | `events.ledger_input_set` is registered as a `frozen_set` ratchet — but `frozen_set` refuses **removals** and permits **additions**, and here the dangerous direction *is* an addition. Money moving with the record is one INSERT away. |
| **B14** demo tenant has mechanical requirements and no owner | **OPEN (unverified)** | R4.2 (a lead outside the window at any hour a demo runs), R4.5 (refuses to run in a live account), idempotency — none visible. The demo tenant appears only as a fixture in P1.2.8. |
| **B15** Edit deal value | **CLOSED** | `app.opportunity_set_premium()` with typed `ref.value_change_reason`, idempotency key, and the ledger append inside the only statement that can change the number. The two required entry points remain a UI claim, not a mechanism. |

## 3 · REVIEW-1 — LIST C (the approved document is the one that is wrong)

| # | Verdict | Basis / remaining hole |
|---|---|---|
| **C1** `04b` §1.3 + Q2 flicker is dead | **PARTIAL** | The behaviour is now correct, but **no correction strikes `04b` §1.3's "known, accepted consequence" line or Q2 by locator** the way P1.1 strikes the SSE texts. Puerta 12 forbids the silent version. |
| **C2** "recompute" struck everywhere | **CLOSED** | P4 publishes every strike with its locator and replaces the real requirement with four `NOT NULL` snapshot columns, incl. `CHECK (stage_type_snapshot = 'earning')`. |
| **C3** R6's "< 5 s re-rank" is arithmetically impossible | **PARTIAL (unverified)** | P5.1 creates the single normative table and P5.4 the supersession list; P5.3's rows are beyond the cut, so the honest ≈10 s / ~11 s p95 and the R6-vs-R4.4 collision cannot be confirmed as published. |
| **C4** ~20 ghost event names in the stories | **PARTIAL** | The generated union rejects them at typecheck (mechanical, and it is the part that matters); the remap table review-1 asks to publish is absent, so the stale stories stay uncorrected for a builder reading only them. |
| **C5** `US-9.2`'s "consumes `opportunity.stage_changed`" | **PARTIAL** | §10.2's epoch indexes make the double credit impossible even if a builder believes the story — but the correction is unpublished and `ledger_input_set` accepts additions (B13). |
| **C6** Flow 5 D1 already superseded | **CLOSED** | P3's "What does not change" restates it by name and keeps `call.initiated` pre-confirmation. |
| **C7** master flow step 10 vs R1.1 | **PARTIAL** | P3 restates R1.1 correctly; the Part II step table and the `First touch in 21s` narrative are still not stamped. |
| **C8** `US-9.7` persistence vs R5.3 | **OPEN** | Untouched; the risk is a `user_preference` row shipping. |
| **C9** demo seed 3 vs R4.1's 12–15 | **OPEN** | Untouched (see B14). |
| **C10** `US-604` "valid signature" AC | **OPEN** | Untouched, and §3.7 shows `provider_capability` can still be talked into `verified`. |
| **C11** card height 108 vs 120/156 | **PARTIAL** | The ratchet holds the keys; it cannot pin an exact value, and §3.6's 108 is not struck. |
| **C12** MVP item 30 "server rollback" | **OPEN** | Untouched; `US-LCP-12` still carries both readings. |
| **C13** `moved_via` cannot express what R1.5 validates | **PARTIAL** | Same as A6 — the shape ships, the amendment is unpublished. |

## 4 · REVIEW-2 — §1, the fourteen ARR breaches

| # | Verdict | Basis / remaining hole |
|---|---|---|
| **1.1** `ARR-UX-11` call state has no channel | **CLOSED** | P1.1 names `call_state` on `/sse/me` with a 2,000 ms floor in the generated registry, and P1.2.6 runs the full banner sequence with `/sse/**` blocked at the network layer — the incident path is the path CI runs. |
| **1.2** SSE undeclared; polling floor unreconciled | **PARTIAL** | P1.3/P1.5 settle arbitration mechanically ("push is a hint, the poll is the truth"; registry byte-identical with SSE dead; falling request volume alarmed as a *defect*). **But the "exactly two push channels" bound is enforced by "a counted literal in the test file" — the construction §10.0 declares inadmissible — and `realtime.push_channel_count` is not among the ratchet's registered names.** |
| **1.3** `ARR-EVT-24` never restated per channel | **PARTIAL (unverified)** | P1.4 defers to "that channel's published latency budget (P5)"; P5.3 is beyond the cut. Drop-to-client vs endpoint p95 is exactly what was missing. |
| **1.4** `sms_enabled=false` second pass | **OPEN** | No axis anywhere in the visible corrections. The configuration the tenant launches in remains the one never tested end to end. |
| **1.5** `ARR-UX-16` axe gate absent | **PARTIAL** | §10.0.3 gives axe a deploy-blocking home. The ten-screens × four-states matrix is enumerated nowhere and is not ratcheted. |
| **1.6** `ARR-PRV-05` exports | **PARTIAL** | §10.0.2 delivers the machine-readable classification with `CHECK (pii_class='none' OR mask_strategy<>'none')` and a per-column `harden()` raise at deploy — genuinely strong. The written reason above a threshold and the mass-export / off-hours anomaly alerting are not visible (§10.16 beyond the cut). |
| **1.7** `ARR-EVT-03` global `event_id` uniqueness | **OPEN** | Untouched; still an unstated downgrade of a non-negotiable whose compensating control expires at 14 days. |
| **1.8** `ARR-MVP-20` exactly-once for DB-only handlers | **PARTIAL** | The named instance evaporates (P2 removes the enqueue). The delivery-class table's general claim still depends on "handler write and status flip commit in one transaction", which no correction states as a requirement of the relay. |
| **1.9** `ARR-MVP-18` 5 s SLA has no queue priority | **OPEN (unverified)** | No priority axis in the visible text. |
| **1.10** `ARR-EVT-13` STOP behind the backlog | **OPEN (unverified)** | Same missing axis. This one is TCPA, not UX. |
| **1.11** dial moved off the request path | **CLOSED** | See A5. The breaker is a row, not module state; `dependency-cruiser` forbids module-level mutable state in `src/adapters/**`; the folded/split matrix would surface divergence. |
| **1.12** `ARR-EVT-11` — a CHECK destroys the refusal record | **CLOSED** | §7.4's PL/pgSQL `BEGIN…EXCEPTION` subtransaction is an engine fact: one gate, one implementation, refusal durable, `ARR-MVP-09`'s "no second copy" preserved. Residual: nothing forces every gate constraint to have a `ref.constraint_refusal` row, so a **renamed constraint turns a refusal into an abort** — fail-loud, but "gate_blocked on *every* refusal" is still not literally true. |
| **1.13** `ARR-EVT-23` payload type guard | **CLOSED** | Frame typed `{channel, seq}` with `additionalProperties:false` and a union-membership test; the board payload becomes `pg_get_function_result()` of the definer. Residual: the "sealed" type exists in three versions (NEW-2). |
| **1.14** money-type CI gate missing | **PARTIAL** | `app.money_cents` domain + `definer_only_columns` derived + `harden()` raise + S17 is far stronger than a name regex. **But S17's escape is a per-table `non_money_bigints` allowlist held as a `frozen_set`, and additions to a frozen_set are permitted — so `premium_annual bigint` ships by inserting one row.** |

## 5 · REVIEW-2 — §2, the eleven inter-section contradictions

| # | Verdict | Basis / remaining hole |
|---|---|---|
| **C1** `PROCESS_ROLES` vs `ROLES` | **OPEN** | Verified by grep: `ROLES=` in sec-1 (×6) and sec-5, `PROCESS_ROLES` in sec-2. Untouched. Reading the wrong one mounts a default role set silently. |
| **C2** three spellings of the two external URLs | **OPEN** | No single table is published; the grep gate still keys on `/hooks/` and `/intake/` while the API section writes `/webhooks/aloware/v1`. These are contractual URLs handed to vendors. |
| **C3** rate meter vs the 333/s replay | **OPEN** | Untouched; Gate 2 still fails by design or the meter does not apply and `ARR-INT-07` is violated. |
| **C4** §9.2.2 states the ETag failure backwards | **CLOSED** | §10.3.4 names the dangerous direction and pages on *304 pinned at 100 % while the watermark moves*, plus a second-session leg on the L4 probe. |
| **C5** pg-boss handler sets RLS context from its own payload | **OPEN** | The data model records this as an open ruling; Security presents it as closed. Untouched by all three corrections. **This is a cross-tenant write with RLS enabled and perfectly happy.** |
| **C6** 250 KB committed vs Puerta 8 | **OPEN — aggravated** | §10.0.1 registers `perf.P12_initial_js_gzip` as `monotonic_down` and quotes 250000 in its own refusal message. The disputed number is now **cemented before Gate 8 measures**, and correcting it upward requires a migration. |
| **C7** registry scoped to `routes/api/**` | **PARTIAL** | P1.2.7 puts `/sse/**` inside the registry (P8.3). `routes/ui/**` — the one HTML response carrying a seller's board — plus `/intake/**`, `/webhooks/**`, `/auth/**`, `/healthz` are not visible. |
| **C8** "three POST routes" is false | **OPEN** | Untouched. |
| **C9** 14 measured endpoints are 17; one measures a refusal | **OPEN** | Untouched. |
| **C10** replay is "one job" for two disjoint mechanisms | **OPEN — harder now** | After `REVOKE SELECT`, any leaderboard rebuild must be a definer/migrator path, and none is named. `ARR-EVT-21` calls this projection out by name. |
| **C11** `mfa` mandated vs no email channel | **RULED** | §10.1 rules `mfa:false` on the void endpoint with a published reason and a compensating control that is seller-visible. Caveat: `defineEndpoint`'s type must actually permit `mfa:false` for `scope:'tenant_admin'`, or the ruling does not compile. |

## 6 · REVIEW-2 — §3, mechanisms that are conventions

| # | Verdict | Basis / remaining hole |
|---|---|---|
| **§3 systemic** ("a PR that touches that file and nothing else") | **PARTIAL** | `ref.ci_ratchet` is the right engine and does defeat "edit the number, green the build" for monotonic budgets, with `crm_ci` holding INSERT/SELECT only. Three holes: `frozen_set` is inverted for allowlists (NEW-5); there is no direction that pins an exact value; and **nothing protects the *invocation* — the CI and deploy configuration that reads the ratchet lives in the same working tree.** Only §7.6 (beyond the cut) claims to move authority out of the tree. |
| **3.1** a table in `public` | **CLOSED** | §7.3: schema-agnostic `harden()` raise (HR001), `REVOKE ALL ON SCHEMA public`, `ALTER ROLE crm_app SET search_path`, default-privileges revoke, rescoped S1, and L2-C asserts all three nets. (Regression it introduces: NEW-4.) |
| **3.2** silo suite cannot test id-less list endpoints | **PARTIAL (unverified)** | §7.7.1 is referenced as the place this is handled; the `GET /api/search` two-seller colliding-fixture assertion `ARR-UX-04` requires is beyond the cut. |
| **3.3** inline registry is decorative; nothing forces the append | **PARTIAL** | §10.0.4 + §10.2's deferred constraint trigger close it for the money row — an opportunity **cannot commit** in an earning stage with no ledger row. The consent and compliance-gate rows are claimed as two further uses of the same shape; neither is visible. |
| **3.4** `defineEndpoint()` brand not enforced | **PARTIAL (unverified)** | P8.3 beyond the cut; no visible statement that a module lacking the factory brand fails the build. |
| **3.5** `ReadTx` backdoor via the scope resolver | **OPEN** | Untouched. A general-purpose write channel attached to every GET, with unspecified atomicity. |
| **3.6** coverage gate satisfiable by a test helper | **PARTIAL (unverified)** | §10.5's title names the defect; the text is cut. |
| **3.7** `provider_capability` talkable into `verified` | **OPEN** | Untouched; `evidence_ref` is still free text. |
| **3.8** `set-config-must-be-local` scope undefined | **OPEN** | Untouched. |
| **3.9** restore does not re-apply GRANTs; boot assertion too narrow | **OPEN** | §10.0.3 makes `harden()` a **pre-deploy** step — which does not run on restore-and-boot. A dump with `FORCE` off still boots clean and shows every seller the whole book. |

## 7 · REVIEW-2 — §4 (foldable topology) and §5 (scenarios)

| # | Verdict | Basis / remaining hole |
|---|---|---|
| **4.1** folded 200 ms batch violates P6/P5 by construction | **OPEN** | §10.0.3 moves perf to a release gate but never states which topology it runs in. The recommended launch posture remains the one the budgets cannot pass, answered again by omission. |
| **4.2** storm magnitude is a provider property, not a seller count | **OPEN** | Untouched. |
| **4.3** `INGEST_FALLBACK=on` by default | **OPEN** | Untouched; still an alert as the compensating control, in exactly the situation where nobody reads alerts. |
| **4.4** missing worker has no detector | **PARTIAL** | P3.5's instinct is right and it is seller-visible — but the flip is *a write performed by "any web request that observes"*. Delete those lines and no banner ever appears. It must be a **read-time predicate in the same read as the breaker's `last_probe_at` staleness**, which P3.4 already demonstrates. |
| **4.5(i)** LISTEN starvation on the folded process | **CLOSED (harm eliminated)** | P1.3/P1.5 make an alive-and-mute transport harmless (poll is the truth, unconditional) and alarmed as a defect; P1.2.8 keeps both legs of the synthetic check, re-pointed. |
| **4.5(ii)** folded connection arithmetic / pool `max` | **OPEN** | Untouched; the same action is still described once as a defeat and once as the launch posture. |
| **Scenario A** public read under the reader's RLS scope | **CLOSED** | The definer plus **`REVOKE SELECT ON app.leaderboard_projection`** — the revoke is the load-bearing half — plus S16 pinning the `qual`, plus L2-A's second-session and byte-identical-ETag assertions. Confirmed compatible with the data model: `crm_app` already has *no DML* on the projection. |
| **Scenario B** premium edit never reaches the ledger | **CLOSED (named columns) / PARTIAL (derived rule)** | The revoke + `opportunity_set_premium()` + B1's `permission denied` test close it for premium. The rule meant to stop the *next* money column leaks through S17's additive allowlist (NEW-5). |
| **Scenario C** unclassified table in `public` | **CLOSED** | §7.3, three independent nets, proven by L2-C. |
| **Scenario D** pre-check / CHECK divergence | **CLOSED** | §7.4 eliminates the second implementation rather than testing it. Residual as in 1.12: no completeness gate on `ref.constraint_refusal`. |

---

## 8 · Defects the reconciliation itself introduces

These are not review findings; they are new, and two of them are in the fatal class.

**NEW-1 · `app.undo_window()` is required to mean two different numbers.** The approved data model defines it as `make_interval((undo_window_ms + undo_projection_guard_ms)/1000)` = **5,500 ms**, and §7.1.1's pending predicate calls it bare. P2 declares `undo_window_ms = 5000` with `app.undo_window()` as one of its three representations, states the 500 ms guard applies **only to the public projection predicate**, and then writes `app.celebrate_once()` against `won_at + app.undo_window()`.
 · If it returns 5,500: the client renders at T+5,000 ms and claims at ≈5,050–5,200 ms → `clock_timestamp() >= won_at + 5500` is false → **every legitimate claim is refused, `celebrated_at` is never set**, and "once per opportunity, forever" degrades to nothing.
 · If it returns 5,000: **the guard is nowhere in the public predicate** and the board can reveal a still-undoable row for ~500 ms — the exact `ARR-MVP-10` outcome §7.1 exists to prevent.
The four-way drift test compares *keys*, not *call sites*, so it is green in both branches.

**NEW-2 · The one sealed artifact exists in three versions.** P5.2: `(user_id, display_name, avatar_ref, total_cents, rank, is_inactive, etag)`, one argument. §7.1.1: identical but `is_active`, one argument. §10.3: adds `tenant_total_cents`, **two arguments**. §7.1.2 asserts `pg_get_function_result()` equals "the sealed column list" — undefined which. P5's precedence clause selects the narrowest, which is the version that drops US-9.6 (B4) and inverts the boolean the Inactive chip renders.

**NEW-3 · `DEMO-11` is assigned twice.** §7.1.2 binds it to the leaderboard second-session assertion; §10.1 binds it to the admin-void E2E; §10.4 adds DEMO-12/13. `protected-list.json`'s CI rule maps *ten* protected items to exactly one test id each and fails when an entry resolves to zero or more than one test.

**NEW-4 · §7.3.1 is a coverage regression for `ref`.** The old loop covered `app` **and** `ref`. The new schema-agnostic loop *excludes* schemas on `security.schema_exception`, whose seed list includes `ref` — so `ref.event_consumer` (the fan-out authority), `ref.constraint_refusal` (the refusal map) and `ref.ci_ratchet` (the enforcement ledger) drop out of the hardening net. §10.0.1 simultaneously registers `ref.ci_ratchet` in `security.table_registry`, which the exception makes moot.

**NEW-5 · `ci_ratchet` has no direction that refuses an addition, and none that pins a value.** `frozen_set` permits supersets, so `rls.exception_list`, `migrations.destructive_allowlist`, `events.ledger_input_set` and S17's `non_money_bigints` are all loosened by **inserting one row** — the second bypass the brief names explicitly. `ui.card_h_*` needs equality, which no direction expresses.

**NEW-6 · Column classification is still two-schema-shaped.** §10.0.2 raises only for relations in `app`, immediately after §7.3.1 made the relation-level check schema-agnostic.

**NEW-7 · "Only `crm_migrator` can weaken this" is, in this project, "Claude writes a migration."** Append-only triggers, `harden()` itself and the ratchet triggers are all droppable or replaceable by a migration, and no reviewer sees it. What actually survives that actor are only three things: a symptom on a seller's screen, the deploy gate anchored in the provider dashboard, and re-assertion at deploy time. The missing piece has a known shape — a `ddl_command_end` event trigger that refuses to drop or replace a protected trigger/function/policy unless a matching ratchet row exists — and it should be specified before this doctrine is relied on eleven times.

---

## 9 · Priority list of what is still OPEN or PARTIAL

### 9.1 · Class "CI green, screen correct, money or law wrong" — these first

1. **NEW-1 — `app.undo_window()` means 5,000 in P2 and 5,500 in §7.1.1/the data model. One branch silently kills the celebration record; the other reopens the public-flicker window `ARR-MVP-10` forbids. The drift test cannot see it. This is the same defect class as Scenario A, introduced by the fix for Scenario A.**
2. **B13 / C5(r1) — `events.ledger_input_set` is a `frozen_set`, which permits additions. `contact.owner_changed` reaching the ledger is one INSERT away, and it is the event that makes money move with the record. The negative declaration the review asked for still cannot be expressed.**
3. **1.14 / Scenario B (derived rule) / NEW-5 — S17's `non_money_bigints` is an additive allowlist. The next money column ships as `bigint`, escapes the domain, escapes `definer_only_columns`, escapes the branded type, and edits go straight past the ledger — Scenario B verbatim, one row later.**
4. **A2 — after `REVOKE SELECT ON leaderboard_projection`, the win gate's `{new_total, rank, gap_to_next}` has no specified read path, and the only sanctioned read excludes the winner's own pending row. The celebration prints the pre-win total and the pre-win rank to the person who just sold.**
5. **C5(review-2) — the pg-boss handler still sets its RLS context from its own job payload. A replayed or corrupted `tenant_id` is a cross-tenant write with RLS fully enabled. The data model calls this an open ruling; Security calls it closed.**
6. **C10(review-2) — no named rebuild path for `leaderboard_projection`, and after the revoke it can only be a definer/migrator path. `ARR-EVT-21` names this projection specifically; an ad-hoc rebuild is the one code path that can rewrite money fifty people have already seen.**
7. **B9 / 1.10 / 1.9 — STOP still queues behind a 20,000-job drain, and the 5 s `lead.created` SLA behind the same. `ARR-EVT-13` says delay is a legal failure. The priority axis review-2 asked for was not built.**

### 9.2 · Structural, high

8. **§3 systemic / NEW-7** — the ratchet protects values, not invocations, and every "requires a migration" closure is walkable by the actor that writes migrations. §7.6 must be shown to move CI/deploy authority out of the tree, or a third of the closures degrade back to documentation.
9. **NEW-4** — `ref` newly exempt from `harden()`; the enforcement-metadata tables are the ones that fell out.
10. **NEW-2** — three column lists and two signatures for the one artifact whose freeze test is supposed to break the build.
11. **3.9** — restore-and-boot never runs `harden()`; a dump with `FORCE` off boots clean.
12. **4.1** — folded perf remains unmeasured and unresolved; the recommended launch topology is the untested one.
13. **C2(review-2)** — three spellings of two contractual URLs, with a grep gate keyed to the wrong literal. **C1(review-2)** — two names for the roles variable, verified still present.
14. **1.4** — `sms_enabled=false` axis absent; the launch configuration is untested.
15. **C6(review-2)** — the 250 KB number is now ratcheted, so Puerta 8's contradiction is pre-decided *and* hard to undo.
16. **4.4** — the worker-absent banner must be a read-time predicate, not an opportunistic write.
17. **C7(review-2) / 3.2 / 3.4** — registry coverage of `routes/ui/**` (the SSR board), `/intake/**`, `/webhooks/**`, and the search silo fixture, all unverified.

### 9.3 · Publication debt (Puerta 12: silence is not a resolution)
**C1, C4, C5, C7, C11, C13 (review-1), A6** — corrections that are implemented but not published with locators the way P1.1 and P4.2 publish theirs. **B7(a)** timezone data source, **B12** quiet hours, **B14/C9** demo tenant, **C8, C10, C12** (review-1), **A8, A9**, **1.7**, **3.5, 3.7, 3.8**, **4.2, 4.3, 4.5(ii)**, **C3, C8, C9 (review-2)** — untouched.

---

## 10 · Verdict on GATE 5

**Not ready. Close-but-not-ready, and the gap is small enough to be worth naming precisely rather than re-opening the design.**

What the three corrections achieved is real and it is the hard part: the crown-jewel defect (Scenario A) is closed by a revoked privilege rather than a corrected formula; Scenario B, C and D are closed by a revoke, a schema-agnostic raise and an engine fact respectively; B1, B2, B10, B11, B15, A3, A4, A5, A7 are closed by objects the database enforces regardless of what any handler believes; and §10.0.4's deferred trigger closes the *credited-zero-times* direction nobody had even guarded. That is a materially different document from the one the two reviewers attacked.

What blocks the gate is that **the reconciliation reintroduced its own instance of the exact failure class it was written to eliminate.** NEW-1 puts a money number on fifty screens whose correctness depends on one function name meaning two different things across three normative texts, with a green drift test. NEW-5 rebuilds "the model edits the literal" as "the model inserts a row" for four allowlists, one of which is the money-type gate and one of which is the ledger input set. A2 leaves the celebration's headline number without a read path. Presenting this at Gate 5 without those closed would ratify, under signature, the precise defect the phase existed to remove.

**Recommended gate condition:** the seven items in §9.1 close before presentation — six of them are single objects (one interval decision published in all three texts, one sealed column list, an `exact` ratchet direction plus an anti-additive direction for allowlists, one named private read for the win response, one definer re-deriving `tenant_id` from `subject_id`, one named rebuild path, one priority column). §9.2's items 8–12 should be presented **as declared residual risk with owners**, not as closures. Everything in §9.3 is publication debt and can be carried into the document itself, provided it is carried *visibly* — the failure mode Puerta 12 names is not the unfixed contradiction, it is the one that was fixed in silence.

---

# §6 — Final audit (verdict: PASS, conditional)

## FINAL GATE-5 ADJUDICATION — Phase 5B closure pass

**Auditor of record.** Authority to pass or fail Gate 5. Documents read in full or in the relevant part: `closure-audit.md`, `rec-rulings.md` (P1–P9), `rec-mechanisms.md` (§7.1–§7.13), `rec-gaps.md` (§10.0–§10.21), `sec-1`, `sec-3`, `sec-5`, `phase5/data-model.md`. Every claim graded below was checked against the source text, not against the closure's own summary of it.

---

## 0 · What I verified before grading anything

Five load-bearing claims the closure makes about the corpus. All five hold.

| Claim | Verified where |
|---|---|
| `CREATE EVENT TRIGGER` requires superuser and Render does not grant it; the design must not depend on one | `data-model.md` §`table_registry` mechanism note, §"Open questions" (EVENT TRIGGERS REQUIRE SUPERUSER), a third occurrence at the RLS re-application note; `sec-1` §"Left open"; `sec-3` §"A Postgres EVENT TRIGGER…"; `sec-5` Gate-1 assert **(f)**. **Six occurrences, not four.** |
| NEW-1 is real | `data-model.md`: `app.undo_window()` = `(undo_window_ms + undo_projection_guard_ms)/1000` = 5,500. `rec-rulings.md` P2.1 bullet 3 calls it in `celebrate_once()`, and P2.1's Puerta-10 bullet says the 5,000 key is "consumed by **both**". Two texts, two numbers, one name. |
| NEW-2's three versions | P5.2 `is_inactive`, 1 arg, no tenant total · §7.1.1 `is_active`, 1 arg, no tenant total · §10.3 `is_active`, **2 args**, with `tenant_total_cents`. |
| NEW-3's collision | `rec-mechanisms.md` §7.1.2 assigns DEMO-11 to L2-A; `rec-gaps.md` §10.1 assigns DEMO-11 to the admin void. `sec-3` §6.2's CI rule fails on an id resolving to ≠ 1 test. |
| NEW-4's exemption seed | §7.3.1: `security.schema_exception` seed = `auth, pgboss, ref, security, cron`. `ref` **and** `security` are out. The closure's "strictly better than the pre-reconciliation loop" is correct. |

Two corpus facts the closure did **not** claim, which I verified because they bear on my grading: **§7.8.6 already closed C5 at the type level**, **§7.7.7 already is the restore-and-boot catalog digest**, **§7.8.1/§7.8.2 already close C1/C2**, and **§7.10.3 already makes the worker-absent detector a read-time predicate driving the amber bar**. The closure's assertion that §9.2 items 8–17 are largely *publication* debt rather than *missing mechanism* is therefore well founded — I confirmed four of them by hand.

**§11.0's correction to my predecessor's own prescription is upheld and is the single best judgement in this pass.** Specifying the `ddl_command_end` trigger alone would have closed NEW-7 on paper and left it open in production on the platform this project actually runs on. Shipping the digest chain as primary and the event triggers as grant-conditional is correct.

---

## 1 · The seven fatal items of §9.1

### 1 · NEW-1 · `app.undo_window()` — **CLOSED**

Dropping the ambiguous name is the right load-bearing half; two names with disjoint registered call sites is the right shape; and assertion 2 — `EXECUTE format('SELECT extract(epoch FROM %s())*1000', callee)` compared to `expected_ms` — is the **effective-value** assertion my predecessor demanded, not a key comparison. Assertion 3 (the difference must equal the guard) forecloses collapse. `too_early` gives the otherwise-invisible branch a screen symptom. Deploy-breaking, not test-file literals.

Two defects in the closure's own text, both **fail-closed**, carried as errata **E4** and **E7**.

### 2 · B13 / C5(r1) · the negative declaration — **PARTIAL**

The structure is right and is a genuine improvement on §10.13: the negative fact becomes a *named constraint whose drop is a registered DDL event*, and the positive set moves `frozen_set → sealed_set`, so both arms close at once. `DEMO-14` is the screen assertion.

It does not reach CLOSED because the enforcement surface has a hole and the replacement is unpublished:

- `app.earnings_ledger.source_event_name` is **nullable** — §10.13's surviving CHECK is `entry_type = 'manual_adjustment' OR source_event_name IN (…)`, which exists precisely because adjustments carry no source event, and §11.6 adds a second such entry type, `projection_repair`. A foreign key does not constrain NULL. The §10.13 CHECK was total over the money table; the FK is not.
- §11.2 **re-uses the constraint name `ledger_source_is_a_declared_input`** for a different object (an FK on `earnings_ledger`) than §10.13's CHECK of that exact name on that exact table, and never publishes the strike. Two readings: if §10.13's CHECK is dropped, the NULL hole is live; if it survives, the migration collides on the name. A name meaning two things — the trap this phase exists to kill, in the object written to kill it.

Errata **E5**.

### 3 · NEW-5 / 1.14 / Scenario B · ratchet directions — **CLOSED**

The strongest object in the pass. Lifting the direction out of the append-only value table into an immutable registry keyed by **name** is the correct diagnosis: a direction stored per row is chosen by whoever writes the newest row. `NOT NULL` with no default plus `AP007` on an unregistered name makes NEW-5's failure mode — a new list inheriting the additive arm — **not expressible**. `crm_ci` holding `SELECT` only on the registry is the right split: CI may record a measurement, never reclassify what one means. Every registered name is explicitly reassigned, which is the half a lesser pass would have skipped.

Residual: the `perf.P12` cell blesses §10.0.1 as "correct as written" while the closure's own open list says C6 is aggravated and unfixed. Errata **E6**.

### 4 · A2 · `app.my_standing_read()` — **PARTIAL**

The containments are real and well chosen: a composite rather than a `TABLE` (no row set to widen), no identity columns, **no ETag** so it cannot be substituted for the public read and reintroduce reader-dependent ETags, `CTX03` instead of a silent zero, one registered caller module, and the return type sealed in `ref.sealed_signature` so widening fails the **deploy**. `DEMO-16`'s byte-identity leg catches contamination in the direction that matters.

It does not reach CLOSED because it is **a second implementation of the board's rank, and it diverges from the first in two respects that no assertion covers**:

1. **Tie-break.** §7.1.1 ranks `ORDER BY total_cents DESC, display_name ASC`; §11.4 ranks `ORDER BY total_cents DESC`. `rank()` collapses ties, so equal totals yield *different rank integers* in the two functions. On go-live day — Part III item 9, "fifty names, fifty `$0`" — every seller is tied. The first win prints one rank in the celebration and a different one on the board minutes later.
2. **Population.** §7.1.1's board includes deactivated sellers when `p_period = 'all_time' AND earnings_disposition = 'keep_in_history'` (this is `US-9.12`, the **Inactive** chip). §11.4 filters `deactivated_at IS NULL` unconditionally. On the all-time board the two functions rank over different populations.

`DEMO-16` asserts `new_total`, `includes_pending`, B's pre-win total and ETag identity. It does **not** assert that the rank the winner is told equals the rank the board will show. Green test, wrong number, on the biggest moment in the product — the exact class of A2 itself. Errata **E2**.

### 5 · C5(review-2) · `app.begin_job()` — **CLOSED**

Four nets in firing order, and the first is at the type level: a payload that cannot *express* tenancy, belted by an enqueue-time refusal of any key matching `/tenant/i` for the stringly-typed edge. `app.resolve_owner()` means a corrupted id resolves to that subject's tenant or to nothing — it can never *select* a tenant. `CTX02` dead-letters into a rendered metric. The catalog gate limiting `set_config('app.tenant_id'` to two `EXECUTE`-granted functions closes the third-door path. The `ctx_txid` binding kills the pooled-connection inheritance vector in the same statement.

**And the residual is handled the way this phase requires and the previous pass did not.** The general `SET LOCAL` GUC-forging vector is pre-existing (`sec-2` §5), its only current nets are tree-local and therefore walkable, and its engine-level close — the signed-context GUC — is deferred as a **Sprint-0 measured** option because `current_tenant()` is evaluated by RLS and the cost must be priced against the 300 ms p95. Carrying that as a declared residual with an owner instead of folding it into the closure is the correct call. Presenting it as closed would have been the failure my predecessor punished.

### 6 · C10(review-2) · `app.leaderboard_rebuild()` — **PARTIAL**

The governance shell is right and I would not change it: `verify_only` default, a ticket that must state `max_abs_drift_cents` **before** the drift is measured (which is what makes a rubber-stamp ticket useless), `RB001/RB002/RB003`, append-only diff evidence, advisory lock, S20, the enumerated pair, and a `projection_repair` arm whose `reason_text` is non-optional so a repair that renders without its reason does not compile. History corrected forward, never rewritten.

It does not reach CLOSED because **steps 6 and 8 double-count**. Step 2 recomputes totals from the ledger; step 6 sets the projection to that recomputed total `T_ledger`; step 8 then appends a ledger row of `delta = now − was = T_ledger − T_proj`. After the repair, `sum(ledger) = T_ledger + drift ≠ projection`. Property 1 explicitly claims the invariant `sum(ledger deltas) == projection total` "holds *after* a repair" and cites L2-B4 as its property test — the mechanism as written breaks the invariant it claims to preserve, by exactly the drift, in the one path that rewrites money fifty people have already seen. It fails loud (L2-B4 goes red), but the specification is contradictory and the builder is left to invent the resolution. Errata **E3**.

### 7 · B9 / 1.9 / 1.10 · the latency axis — **CLOSED**

`NOT NULL` with no default plus the **built-bundle scan** is the pair that matters: the registry cannot be bypassed by a job that never registers. Reserved capacity rather than intra-queue priority is the correct reading of pg-boss. The boot refusal when a worker's lane set omits `compliance` is property (c) applied to the one lane where delay is a legal failure. The enqueuer cannot choose the lane. Per-lane heartbeats make a starved lane visible per lane. G6/P24 at `retries: 0` in **both** topology legs makes a reclassification red before the deploy gate is reached.

It also **rules a real contradiction** I verified independently: §7.9.3 puts the STOP sniff in `src/domain/**` and calls it "already property-tested there"; §10.9 puts it in `src/ingress/stopSniff.ts` with dependency-cruiser forbidding `src/domain/**` imports. These cannot both be true. §10.9 is the self-consistent one and the closure rules for it by locator. Correct.

Residual (sniff coverage: base64, or a field absent from the first 320 raw bytes) is bounded, correctness-preserving via the inline consent append inside the merge transaction, and declared rather than buried.

---

## 2 · NEW-1 … NEW-7

| | Verdict | Basis |
|---|---|---|
| **NEW-1** | **CLOSED** | See §9.1-1. Errata E4, E7. |
| **NEW-2** | **CLOSED** | One signature, one place to look, a primary key, and — decisively — the **two substantive decisions are ruled in writing with mechanical reasons** instead of resolved by a precedence clause nobody applied. Decision 1 is right for the stated reason: a caller-supplied `period_key` makes the ETag caller-dependent and destroys the byte-identity property that closes Scenario A. Decision 2 is right: applying the narrowest list would drop `US-9.6` silently, which I confirmed is an approved requirement ("supervisors get no self-row but a tenant total"). Decision 3 is right in **both** halves — the name *and* the body — and the CI assertion on the `<InactiveChip>` prop with no negation between catches the inversion at the one place it can be introduced. Caveat: `ref.sealed_signature` seals the **result type**, not the body. See E1. |
| **NEW-3** | **CLOSED** | The correct level: two documents claiming `DEMO-11` become a **primary-key violation in the seeding migration**, not a CI message after the fact. Generating `protected-list.json` and `required-assertions.json` from the table removes the hand-maintained surface entirely. Note the same instrument was not applied to the adjacent schema-gate id space — S20 and S21 are allocated by prose. Low severity, same class. |
| **NEW-4** | **PARTIAL** | Root cause named exactly right: *"we do not own this schema"* and *"this schema needs no classification"* were one flag. Splitting posture from exemption, and making `core_schemas_are_managed` a table CHECK that names the four schemas **literally**, converts a row edit into a protected-object drop. That is the correct move. But the implementation inverts the corpus default — see E1. |
| **NEW-5** | **CLOSED** | See §9.1-3. |
| **NEW-6** | **PARTIAL** | Same object as NEW-4, and the right one: a single `security.managed_relations()` read by **both** loops means there is no second definition of the corpus to forget to update, and S21 stops a future loop from re-hardcoding a schema list. Same defect as NEW-4 — E1. |
| **NEW-7** | **PARTIAL** | The architecture is sound and the honesty is real: registry, append-only history, rendered count, `PO001` at deploy, boot digest extended to protected-object hashes and the history head, event triggers correctly demoted to grant-conditional belt-and-braces with the live mode rendered on `/admin/system` rather than assumed. **The anchor claim is overstated.** See E1's sibling, errata **E1b**. |

---

## 3 · Did this pass do it again? — the errata

I looked specifically for what the brief names: names meaning two things, additive lists presented as locks, assertions comparing keys instead of values, and mechanisms depending on someone reading a diff. **It did it again — but smaller, mostly fail-loud, and enumerable.** Seven items. None re-opens a design decision. Each is a transcription-level ruling.

### E1 — `security.managed_relations()` inverts the corpus default from fail-safe to fail-open **(highest severity)**

§7.3.1's loop is `WHERE nspname NOT IN (SELECT schema_name FROM security.schema_exception)` — **default-included**. §11.9's replacement is `JOIN security.schema_policy p ON p.schema_name = n.nspname WHERE p.posture = 'managed'` — **default-excluded**. A schema with no policy row is scanned by neither `HR001` nor `HR002`.

NEW-4 was *"a row in a permissive list took `ref` out of the net."* The replacement makes *the absence of a row* take anything out of the net. `core_schemas_are_managed` protects only the four schemas it names literally; a fifth schema created by a migration is invisible to both loops, and the closure's boast that "a row can no longer do that" is true only because now no row is needed.

**Mitigation, and it is the closure's own:** `public` has no policy row under the published seed, so §7.3.3's L2-C leg (a) — `harden()` raises `HR001` naming `public.saved_view` — **goes red**. The defect is caught at pre-merge by a protected test the same section says it keeps. Fail-loud, not silent.

**Fix (one assertion):** `harden()` raises on any namespace in `pg_namespace` outside `pg_catalog / information_schema / pg_toast / pg_temp*` with no `security.schema_policy` row, and S21 asserts that raise exists. Restores default-deny.

### E1b — the DDL authorization token is not, as specified, outside the reach of the actor it is meant to stop

§11.11.2 states in boldface: *"A migration written by a model cannot supply a value the model does not have."* The same paragraph states the token is present in *"the one-shot migration job"* environment and that *"the migration runner reads `process.env.DDL_AUTHORIZATION_TOKEN` and passes it to `security.authorize_ddl()`."*

The migration runner is code in the working tree, and it executes with the token in its environment, on every deploy, running migrations the model writes. A migration — or a one-line edit to the runner — can therefore call `security.authorize_ddl()` with a value nobody typed. Property **(b)**, the gate anchored outside the tree, is not achieved as written. This matters more than any other item because §11.11 is the keystone that twenty-plus closures lean on.

What survives the walk is still substantial and is exactly what §11.11.5 honestly describes: the change is **counted and rendered** — `security.protected_object_history` is append-only, `/admin/system` shows `protected objects changed since go-live: N` with justification and date, and the boot digest turns a drop into an outage. Properties (a) and (c) hold unconditionally. Only the strongest claim fails.

**Fix (one sentence, no object changes):** the token must not exist in any automated job's environment. The `security.ddl_authorization` row is created **out of band by Jorge** — one statement in the provider's SQL console, or a manually started one-off job into which he pastes the token — before the deploy that consumes it. The deploy job then holds no token and consumes a row it cannot create. Delete the boldface claim if this is not adopted, and grade §11.11 as (a)+(c) only.

### E2 — `app.my_standing_read()` re-implements the board's rank and diverges from it

Tie-break and all-time population, per §9.1-4 above. **Fix:** one shared ordering expression and one shared population predicate for both functions, plus a `DEMO-16` leg asserting `my_standing_read(period).rank` equals the caller's rank from `leaderboard_read(period)` after the window, on a fixture containing (i) two sellers with equal totals and (ii) one deactivated seller with `earnings_disposition = 'keep_in_history'` on `all_time`.

### E3 — `leaderboard_rebuild()` steps 6 and 8 double-count

Per §9.1-6 above. **Fix:** rule which is authoritative. Either the projection is set to `sum(ledger) *after* the repair append`, or the `projection_repair` entry carries `delta_cents = 0` and exists only to render the reason on the affected seller's My Earnings. State it, and state which arm L2-B4 asserts.

### E4 — the ETag body is unreconciled, and this pass edited the exact lines without noticing

P5.1 (normative) defines the third ETag input as `next_eligibility_epoch = min(recorded_at) + undo_window_ms + undo_projection_guard_ms` over pending rows, or `0` when none. §7.1.1 implements `v_pending = coalesce(max(e.recorded_at), 'epoch')`. §11.1 rewrites those two lines to swap the interval function and leaves the aggregate.

`max()` is wrong, and concretely: with wins W1 at *t*=0 and W2 at *t*=3 s, `max` is 3 both before and after *t*=5.5 s, so the ETag does not move at the moment W1 becomes eligible. Every poll answers `304`, the board holds W1 hidden until W2 ages out at *t*=8.5 s, and the chain extends with each further win inside the window. Budget N1 is 11,000 ms hard-fail with a floor of 5,500 + 5,000 + jitter already at 10,500 — any chaining busts the hard fail. This is **B3's exact failure re-entering through a formula that `ref.sealed_signature` does not cover**, and L2-A's zero-writer leg uses a single win, so it is green.

`ref.sealed_signature` seals the result type, not the semantics. **Fix:** adopt P5.1's `min(recorded_at) + app.projection_reveal_delay()`, publish it into §7.1.1 by locator, and reconcile P5.1's separate `roster_seq` channel row against §7.1.1's folded `'leaderboard'` watermark (behaviourally equivalent, textually contradictory — say which ships).

### E5 — the ledger negative declaration has a NULL hole and a name collision

Per §9.1-2. **Fix:** `CHECK (entry_type IN ('manual_adjustment','projection_repair') OR source_event_name IS NOT NULL)` alongside the FK, a distinct constraint name, and an explicit published strike of §10.13's CHECK by locator.

### E6 — C6 / `perf.P12` is blessed and disowned in the same document

§11.3.1's reassignment table — presented as the binding publication — lists `perf.P12_initial_js_gzip` as *"unchanged · Correct as written"*, while the closure's own open list says C6 *"is aggravated and this pass does not fix it"* and recommends the opposite. §10.0.1 seeds the disputed 250000 into the refusal message; P5.3.1 rules that `perf-budgets.json` ships `null` and the build fails on a null budget. As written, the two are mutually unsatisfiable.

**Fix:** promote the closure's own recommendation from "recommended" to **ruled** — register the ratchet *name* in `ref.ci_ratchet_name` with `direction = 'monotonic_down'` and **no value row in `ref.ci_ratchet` until Gate 8 writes the first one**; the null-budget build failure is the only gate before then; strike §10.0.1's 250000 example by locator. The new name/value split makes this expressible, which it was not before this pass.

### E7 — assertion IV004 bans a substring its own objects must contain

*"No `pg_proc.prosrc` in any schema may contain the string `undo_window`."* The `app.system_constant` key is **`undo_window_ms`** and is read by SQL; `app.undo_deadline()` and `app.projection_reveal_delay()` must both read it by that key. As written the assertion raises `IV004` on the two replacement functions themselves, and no deploy can ever succeed. Fail-closed, therefore harmless — but it is a string test standing in for a meaning test, in the object built to eliminate a name that meant two things.

**Fix:** scope IV004 to the call, not the substring: no `prosrc` may match `\mapp\.undo_window\s*\(`.

### E8 — the residual register the verdict depends on is not in the document

§11.5 cites *"§11.12 item 1"*; there is no §11.12. The submitted §11.11.5 is truncated mid-sentence. The declared-open list exists as loose prose outside the numbered document. **Fix:** publish it as §11.12 with a number, an owner and a gate per line.

---

## 4 · The NEW-7 test applied to every closure

Graded only against (a) a symptom on a seller's screen, (b) a gate anchored outside the working tree, (c) re-assertion at deploy or boot.

| Object | Walkable by a migration? | Survives on |
|---|---|---|
| Two interval functions + `ref.interval_binding` | Values yes, **inconsistency no** | (a) `too_early` alert · (c) four deploy-breaking assertions |
| `ledger_forbidden_input` + FK | By a constraint drop only | (a) DEMO-14 · (c) PO001 · counted in history |
| `ref.ci_ratchet_name` | Values yes, **arms no** without dropping a protected trigger | (c) engine refusal before any test runs |
| `app.my_standing_read` | Type widening yes | (c) `ref.sealed_signature` fails the deploy · (a) DEMO-16 |
| `app.begin_job` | Payload cannot express tenancy **at the type level** | compile-time + (c) catalog gate |
| `app.leaderboard_rebuild` | Deliberately yes, with a ticket | (a) seller's own My Earnings shows the repair and its reason · permanent diff |
| `ref.job_registry.priority` | Reclassification yes | (a)+(c) G6/P24 red at `retries: 0` in both topologies · seal advance rendered |
| `ref.sealed_signature` | With an AP001 drop | (c) counted and rendered |
| `ref.protected_assertion` | Rename yes, **duplicate no** | (c) PK violation in the seeding migration |
| `security.schema_policy` | By a CHECK drop — **and by silence** (E1) | (c), once E1 is applied |
| `security.protected_object` | **(b) is not achieved as written** (E1b) | (a) two numbers on `/admin/system` · (c) PO001 + boot digest |

**Conclusion of the test.** Ten of eleven objects carry at least one of the three properties unconditionally. The eleventh — the keystone — carries (a) and (c) unconditionally and (b) only after E1b. That is a materially different document from the one my predecessor read, in which eleven closures rested on "requires a migration" and nothing else.

---

## 5 · Specified wrong vs. cannot be known until measured

Applying the brief's distinction precisely.

**Specified wrong — these are errata, and they block signature, not the gate:** E1, E1b, E2, E3, E4, E5, E6, E7, E8. Every one is decidable now, by transcription or by a ruling already made elsewhere in the corpus (E4 is already ruled by P5.1; E2 is already ruled by §7.1.1's own ORDER BY and population predicate; E6 is already ruled by P5.3.1). None requires a measurement, a vendor answer, or a reconsidered decision. None re-opens an object.

**Cannot be known until measured — these are Sprint-0 gates and must not block a design gate:** the `CREATE EVENT TRIGGER` grant probe; the signed-context GUC's cost against the 300 ms p95; N15/N16 bundle and TTI; the folded-topology batch budget; the measured connection ceiling; Aloware's ack latency and whether it signs webhooks.

**Publication debt — carried visibly, per Puerta 12:** all of §9.3, plus the strikes this pass owes (§10.13's CHECK, P5.1's one-argument `leaderboard_rebuild`, `sec-3` §6.2's "ten protected items" now sixteen, §7.9.1's `interactive` lane still listing a celebration broadcast that P2 deleted).

---

## 6 · Verdict

I pass Gate 5. The reasoning, stated plainly because the record should carry it:

My predecessor's bar was correct and I have applied it. Against that bar, this pass closed five of seven fatal items outright, brought the remaining two to the point where each needs one ruling rather than one object, and closed five of seven self-inflicted defects. More importantly, it did three things the previous pass did not: it **corrected the audit's own prescription** where the prescription would not have worked on the chosen platform; it **refused to fold a pre-existing, unmeasured residual into a closure** (the signed-context GUC) when doing so would have looked better on paper; and it **stated its own downgrades** — "counted and rendered", not "impossible" — in the same sentence as the mechanism.

The defects I found are real and I have not softened them. Two are silent (E2's rank divergence, E4's ETag freeze) and those are the ones that would otherwise be ratified under signature. But both are single lines already decided elsewhere in the normative corpus, and I have decided them here. A fourth pass to apply nine transcriptions carries a demonstrated risk — three passes running — of introducing a tenth defect of the same class. That is the diminishing return this gate should refuse to pay.

**The pass is conditional and the condition is not decorative:** errata E1–E8 incorporated verbatim, and the residual register below rendered visibly in the document, not filed. If the errata are treated as optional, this verdict is void.

### DECLARED RESIDUAL RISK — must appear in the document, visibly

| # | Risk | Class | Gate that closes it |
|---|---|---|---|
| R1 | `SET LOCAL app.tenant_id` forging by `crm_app` is syntactically possible in all five contexts; current nets are tree-local and walkable. Engine close is the signed-context GUC | Pre-existing, **measured** | Sprint 0: price HMAC verification inside `current_tenant()` against N8's 300 ms p95, then rule |
| R2 | `CREATE EVENT TRIGGER` grant unknown; the digest chain carries full weight if absent | **Measured** | Sprint 0 grant probe, `sec-5` Gate-1 (f). `/admin/system` renders the live mode |
| R3 | DDL authorization reduces to (a)+(c) if the token stays in an automated job's environment | Specified | E1b at signature; operational placement confirmed in Sprint 0 |
| R4 | A superuser, or `crm_migrator`'s credential reaching a workflow that runs PR-branch code, defeats every mechanical guarantee in one statement | Structural, **unclosable in-document** | Deploy-credential isolation, audited at Sprint 0. Already stated in `sec-4` |
| R5 | STOP sniff misses base64 or a field outside the first 320 raw bytes → compliance lane missed | Bounded, correctness-preserving | Declared. Latency residual on a legal requirement — re-examine after Gate 2 with real carrier payloads |
| R6 | `ops.projection_rebuild_ticket.reason` is free text | Bounded | Compensated by rendering to the affected seller, not a log. Same strength as §10.1's void reason |
| R7 | C6 / `perf.P12` — the disputed 250 KB must not be ratcheted before Gate 8 measures | Specified (E6) | Errata now; Gate 8 writes the first value row |
| R8 | §9.2 items 8–17 were judged on truncated text; §7.7.7, §7.8.1, §7.8.2, §7.10.1-3 verified closed by me; §7.7.1/2/6, §10.5, §10.16 **not** verified | Verification | One pass against the untruncated documents before any of them is called closed or carried |
| R9 | §9.3 publication debt in full, plus the four strikes this pass owes | Puerta 12 | Carried into the document with locators |
| R10 | `ref.sealed_signature` seals result types, not bodies. E4 is the known instance; there may be others | Structural | Sprint 0: extend the seal to a normalised `prosrc` digest for the seven registered functions |
| R11 | Schema-gate ids (S1…S21) are still allocated by prose; NEW-3's instrument was built only for assertion ids | Same class, low severity | Fold S-ids into `ref.protected_assertion` or an equivalent PK |
| R12 | `too_late` celebration claims are routine under background-tab timer throttling (D3-09 mandates hidden tabs stop polling); making the composite alert unacknowledgeable for 24 h manufactures noise on the one screen that replaces the reviewer | Specified, low severity | Only `too_early` is unacknowledgeable; `too_late` is a counter |

**VERDICT: APTA for Gate 5, conditional on errata E1–E8 being incorporated verbatim and residual risks R1–R12 being published visibly in the document; if the errata are treated as optional, this verdict is void.**