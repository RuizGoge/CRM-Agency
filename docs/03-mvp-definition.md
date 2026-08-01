# 03 — MVP Definition: What We Build First

> **Phase 3 deliverable.** Status: **complete, pending GATE 3.**
> **Annexes:** [`03-scoring-appendix.md`](03-scoring-appendix.md) (all 549 scored items) · [`03-mvp-stories.md`](03-mvp-stories.md) (Given/When/Then) · [`03-dod-roadmap.md`](03-dod-roadmap.md) (Definition of Done + V1.1/V2 + SaaS path)
> **Method:** 7 scoring agents scored every feature of the Phase-2 map against a published rubric; one Head-of-Product agent drew the MVP line; then **two adversarial critics with opposite mandates** attacked the result — one for being too big, one for being broken. Their conflict is the substance of this document. Final rulings are mine.

---

## 1. The scoring model (discuss the numbers with me)

```
score = (daily_value × frequency × demo_wow) ÷ complexity
```

Every axis is an integer 1–5 with published anchors:

| Axis | 1 | 3 | 5 |
|---|---|---|---|
| **daily_value** — value to a seller's actual day | nobody would notice it missing | makes a recurring task meaningfully better | the seller cannot do their job without it |
| **frequency** — how often it is used | a few times ever / admin setup | weekly | many times every single day |
| **demo_wow** — would an owner say "I want it" in 10 minutes | invisible | noticed and appreciated | the moment that sells the product |
| **complexity** — technical complexity, risk, dependencies, expected iterations under vibecoding | trivial CRUD | real logic or one integration | hard, risky, many moving parts or external dependencies |

**Complexity is never human hours, days, sprints or team effort** — that is a standing rule of this project. Full table of all 549 scored items: [`03-scoring-appendix.md`](03-scoring-appendix.md).

### How the funnel narrowed

| Stage | Count |
|---|---|
| Features catalogued in Phase 2 | 407 |
| Items scored (Phase-2 features + items the adversarial reviews proved were missing) | **549** |
| Scorers' recommendation: IN | 229 |
| Scorers' recommendation: V1.1 / V2 / CUT | 212 / 48 / 60 |
| Head-of-Product first cut | **66** |
| **After both critics and my rulings — the MVP we build** | **68** |

The count barely moved between the first cut and the final one. **The composition changed completely: 17 items were cut and 19 were added.** What came out was polish and second implementations. What went in was the plumbing that keeps a seller inside the product and keeps the public number correct. That trade is the real output of Phase 3.

---

## 2. The two critics (and what I ruled)

### Critic A — "TOO BIG"
> *"66 line items is not an MVP, it is a v1.4 with the reporting module deleted… the highest-risk dependency in the entire build (Aloware webhooks + 10DLC) is priced as plumbing at complexity 12 while a podium layout scores 60."*

Its sharpest finding: **queue proliferation** — seven different surfaces answered the same question ("what do I do next?"), spread across four modules so no single scorer saw it whole. Its second sharpest: **the scoring rewarded emotional appeal over necessity** — the leaderboard's presentation items carried the highest scores in the document.

### Critic B — "BROKEN"
> *"The chain is intact on paper and broken in practice. The coherence walkthrough proves each link EXISTS; it never proves a seller can get from one link to the next without leaving the product."*

Its sharpest finding: **there is no search anywhere** in 66 features — a lead calls the seller's cell and there is no way to pull up the record; the demo dies on *"show me John Smith"*. Its second sharpest: **the win gate was bound to a stage NAME, not to the counts-as-Earnings FLAG** — so a seller who flags "Application Submitted" writes to the public ledger with no premium and the 12× guard never fires. That directly violated your own D4 ruling.

### My rulings

**Accepted from Critic A (cut):**

| Cut | What it costs you |
|---|---|
| Kiosk/TV route, TV takeover, freshness chip, **SSE → 5-second polling** | No wall theater in week one; the board can be up to 5s stale (indistinguishable to a human) |
| CSV import **wizard** → an import run by the builder + an onboarding runbook | 50 manual imports at onboarding instead of a screen each seller uses once, ever |
| Admin config **screen** for loss reasons / lead sources / stage template | Changing a loss reason needs the builder, roughly twice a year |
| Template library (org + personal CRUD, segment counter) → **4–6 seeded message constants + merge renderer** | Sellers paste their own texts; no personal template storage |
| Reminder ladder → **exactly one send (T-1h)**; confirm/reschedule keyword parsing cut (STOP stays, in suppression) | Marginally lower confirmation rate; a "move it" reply is handled by a human via needs-reply |
| PWA push + SMS-to-seller alerts → **in-app live + desktop web notifications** | ⚠️ **Real cost, stated plainly:** a seller with the app closed on their phone learns about a lead when they open it. Critic A also priced the SMS alert channel at ~1,000 SMS/day, which would consume the entire <$100/month budget by itself |
| Seven queues → **two surfaces**: My Day (sectioned) + My Book (one list, one status chip) | No dedicated screen per queue type — everything is a section |
| Supervisor exception list → global read scoping on existing queries | The supervisor filters instead of being handed three reports |
| Snooze-with-presets (the scheduled-callback activity already covers it) | A seller names a time instead of clicking "tomorrow" |
| Calling-window confidence prompt and unmapped-disposition alert → **log lines** | Zero in week one |

**Rejected from Critic A (one item):** replacing drag & drop with the move-sheet on every device. Drag is the anchor's most visible moment and "kanban impecable" is on our protected demo list. **Counter-ruling:** drag on desktop, move-sheet on mobile — *and* the undo/celebration race the critic correctly identified is resolved by **delaying the celebration by the undo window (5s)**. The race was a real defect; the fix is a decision, not a cut.

**Accepted from Critic B (added, with why each is load-bearing):**

| Added | Why it cannot wait |
|---|---|
| **Global owner-scoped search** (name, phone E.164, email) | A lead calls; there is no other way to find them. Also the demo's first question. |
| **After-call wrap-up sheet** — outcome + note + **required next step with retry chips** | The single most load-bearing missing screen. On a Two-Legged API dial the seller is on their own handset, so Aloware returns *call status*, not a human disposition — the disposition map would have mapped mostly nulls and the whole back half of the chain would be fiction. It also fixes the no-answer hole: 70–80% of dials don't connect, and without preset retry chips a seller must hand-create ~60 callbacks a day. They won't. |
| **`stage_type` (open / earning / lost) on the stage editor; both gates bind to the TYPE** | Without it, renaming a column bypasses the premium gate and the loss-reason gate. Restores your D4 guardrail. |
| **Ledger recompute on flag change + admin void/adjust-with-reason** | Your D4 freedom without this leaves phantom money permanently on a public board. |
| **Edit deal value → `value_correction` ledger delta + audit row** | Sellers type a placeholder to move the card before the final number exists; today that wrong number is public forever. |
| **`attempt_count` + `last_attempt_at` on the card** | A seller either quits after two attempts or dials the same person twenty times. Also the only thing between this floor and a harassment claim. |
| **Period selector (Today / Week / Month / All-time)** over the same board, metric and ranking rule | Day one the all-time board is 50 rows of $0 — the differentiator is a blank screen at minute eight of the demo. See §5, D7: this needs your approval. |
| **Seeded demo data + first-run checklist** | Phase 2 called demo data *"the single highest-ROI item for sellability"* and the cut dropped it silently. |
| **CSV import must NOT auto-open opportunities** + a **"new opportunity on an existing contact"** verb | Otherwise day one opens as ~2,000 instantly-stale cards with every decay flag firing. And a lost lead that calls back six weeks later — the most common re-sale in this business — has no path, so the seller creates a typo'd duplicate to get a card, corrupting dedupe and suppression in one move. |
| **Contact field editing + bad-number flag** | Purchased leads arrive with wrong digits; without editing, a paid lead dies permanently. |
| **Admin single-record ownership transfer + Aloware number-map verification** | The real trigger isn't offboarding — it's a number mapped to the wrong seller during a 50-seat rollout, which puts leads *and* Earnings in the wrong book with no remedy. |
| **Per-seller notification quiet window + three named timezones** | Leads post at 3 a.m.; sellers disable push within a week, which kills speed-to-lead. Timezones: **tenant business tz** for periods, **per-user** for display, **lead-local** for the calling window only. |
| **Degraded dial mode + visible call-state UI** | Two-legged means the seller's own handset rings 5–15s later with nothing on screen — they tap twice, and in the demo there are fifteen silent seconds at the worst moment. When Aloware 500s, the button must fall back, not do nothing. |
| **Consent capture at booking** | A lead agreeing to a callback is the strongest express-consent moment in the flow, and it was not a capture point. One checkbox closes the largest no-show leak. |
| **Deterministic call↔meeting link** when the dial is launched from the appointment row | Otherwise the outcome is a second chore and sellers bulk-mark "showed" to clear the queue — manufacturing the exact fiction the feature exists to prevent. |
| **One generic CSV export + a today activity strip** (dials / contacts / appointments set) | Prevents the guaranteed week-two spreadsheet, and the activity strip is the honest counterweight for a new hire who can never catch the all-time leader. |
| **Tenant-wide, non-attributive recent-contact signal** ("this household was contacted by this office 12 minutes ago") | Ping-post sells the same consumer to two sellers in the same agency; per-owner dedupe guarantees two sellers dial the same person within the hour. The silo survives — it is the same *blocked-without-attribution* pattern already ruled for suppression. |
| **Configurable cold threshold + decay flags suppressed on imported / never-worked cards** | Cold=7d was decided in Phase 0 and went missing; without suppression every signal is red on the first Monday and becomes wallpaper. |
| **Hard-block dials outside the lead-local window** (replacing amber attestation) | Critic B: the append-only audit log would otherwise record exactly who chose to call at 8:40 p.m. local — *"that is the plaintiff's exhibit, not the defense."* |
| **Break-glass override on the compliance gate** (admin-only, audited) | Fail-closed is right; fail-closed with no key means one bad lookup table stops all 50 sellers from working. |

**Where both critics agreed — and I ruled hardest:**

1. **Aloware is the highest-risk item in the build and was priced as plumbing.** → **Sprint 0 is an integration spike.** No UI in Comms, Calendar, Pipeline-quick-actions or Leaderboard gets built until the spike proves: two-legged dial end to end, webhook signature verification, duplicate/replayed and out-of-order delivery, the real disposition vocabulary, missed-call events, recording-announcement behaviour, and actual 10DLC status.
2. **10DLC registration is a launch scenario, not a footnote.** Registration takes weeks and can be rejected. → **Start registration now, before anything is built**, and specify an **SMS-dark launch mode** (what ships call-only, what is hidden vs disabled-with-a-banner, what the reminder does).
3. **Four idempotency problems were being solved in four places** (webhook upsert, earnings exactly-once, celebration once-per-opportunity, reversal on reopen). → **One event-key pattern, one test suite.** This is *cheaper* than what was proposed, and it is the only place a bug is publicly visible to 50 people at once.
4. **The ledger retroactivity rule must exist before the code.** → **Ruled: forward-only and non-retroactive.** Un-flagging a stage does **not** claw back deltas already credited; flagging a stage does **not** re-score cards already sitting in it. Corrections happen through explicit `value_correction` / `reversal` / `manual_adjustment` ledger entries, never by silent recomputation. The ledger is immutable.

---

## 3. The MVP (68 items, in build order)

> Everything below is scoped by the silo rule, passes the one compliance gate where it contacts anyone, and emits the canonical events of [`02b-integration-map.md`](02b-integration-map.md).

### Sprint 0 · Integration spike (gate, not a feature)
**S0.** Aloware spike: two-legged dial, webhook signature + replay + out-of-order, real disposition vocabulary, missed-call events, recording-announcement behaviour, 10DLC status. **Nothing downstream is built until this returns.**

### 1 · Foundations & platform (7)
1. Auth & session (email/password, per-user, no SSO)
2. Three fixed roles: seller / supervisor / admin (no role builder)
3. **Row-level ownership scoping on every query** + owner-scoped not-found (never "belongs to another seller") — *this IS the silo*
4. Multi-tenant-ready, redact-in-place data model (`tenant_id` everywhere, no hard deletes, no billing)
5. Core object model: Contact ↔ Opportunity ↔ Activity ↔ Message (channel-agnostic, WhatsApp-ready enum)
6. Responsive app shell + navigation (desktop-to-manage / mobile-to-contact, en-US, i18n-ready strings)
7. Append-only audit log for consent, suppression, earnings and ownership writes

### 2 · Compliance core (6)
8. Consent ledger (append-only, per channel, per number; vendor certificate URL) — **+ capture at booking**
9. Suppression list — STOP / START / DNC, tenant-scoped, keyed on phone E.164, append-only
10. Lead-local time & calling-window resolver (zip/area-code → timezone at intake)
11. **ONE outbound compliance gate** — single choke point on every dial/SMS/reminder; fail-closed; **hard-block outside the lead-local window**; plain-English skip reason written to the timeline
12. **Break-glass override** — admin-only, audited, per-tenant
13. **Tenant-wide non-attributive recent-contact signal** (no names, no records — just "this office contacted this household N minutes ago")

### 3 · Lead intake (6)
14. Per-seller ping-post / lead-vendor webhook endpoint (one field map per source, raw body stored)
15. Deterministic ownership binding at the source (token → seller; inbound to a seller's number lands in that seller's book) — **no routing engine**
16. Deterministic dedupe at intake (phone/email), silo-shielded, same-owner exact match updates in place
17. **Auto-open an opportunity on `lead.created` only** (never on import)
18. Quick-add lead (mobile-first, 15 seconds)
19. Lead source stamped on every lead
*(CSV import moves to the onboarding runbook, run by the builder — see §4)*

### 4 · Contacts (8)
20. Unified per-lead timeline (calls, SMS, notes, meetings, stage moves, suppressed sends with reasons)
21. Contact / opportunity detail view (header + compliance badge + action bar + timeline, responsive)
22. Consent-aware action bar (Call / Text / Log / Schedule / Note — every button through the one gate)
23. Notes (pinning cut)
24. **My Book** — one list, one status chip *(replaces the five seeded working lists)*
25. Canonical touch engine (human-touch flag, last-touch, days-since-touch, cold detection — one source of truth)
26. **Global owner-scoped search** (name, phone E.164, email)
27. **Contact field editing + bad-number flag** (phone re-validated to E.164 and re-checked against suppression)

### 5 · Pipeline (12)
28. Kanban board of the seller's own opportunities — **anchor**
29. Card anatomy: annualized premium, days-since-touch, next activity, source, compliance badge, **attempt count**
30. Drag & drop with optimistic UI, undo and server rollback (desktop) — **celebration delayed by the undo window**
31. Mobile board — move-sheet instead of drag
32. Stale / deal-rotting alert on the board + "No next step" flag — **suppressed on imported and never-worked cards**
33. Quick actions from the card (Call, SMS, Schedule, Note, Log)
34. Fresh-lead treatment + speed-to-lead clock (**stops on `call.completed` with a connected/voicemail outcome**, not on the tap)
35. Per-seller stage editor with **required `stage_type` (open / earning / lost)** and the counts-as-Earnings flag, seeded default board
36. **Win gate bound to `stage_type=earning`** — annual premium required, monthly-or-annual question, converter, enforced server-side
37. **Loss reason bound to `stage_type=lost`** — typified, required
38. **New opportunity on an existing contact** (the re-sale / call-back-later path)
39. Optional descriptive product fields (`product_type`, `carrier`, `policy_number`, `draft_date` — fields, no workflow)

### 6 · Communications / Aloware (11)
40. Aloware account link + user ↔ number identity map, **with a verification step** (a test call/SMS must resolve to that seller before leads route to it)
41. Call now via Two-Legged Call API — the single dial service behind every surface
42. **Visible call-state UI + degraded mode** (banner, `tel:` fallback, manual log when the API is down)
43. Zero-effort auto call logging from Aloware webhooks (outbound, inbound, missed)
44. **One idempotency pattern** — signed envelope, event key, upsert, out-of-order tolerance, dead-letter queue *(shared by webhooks, earnings, celebration and reversal)*
45. Aloware disposition → semantic outcome map *(enrichment, not the source of truth)*
46. **After-call wrap-up sheet** — outcome + note + **required next step with retry chips** (creates the scheduled callback in one tap)
47. 1:1 SMS send from the thread (locked opt-out footer, merge fields)
48. Inbound SMS threading + needs-reply state
49. **4–6 seeded message constants + merge renderer** *(replaces the template library)*
50. Log-the-sale path from the call panel → hands straight to the win gate

### 7 · Calendar (7)
51. Meeting object linked to contact **and** opportunity (phone appointment default)
52. Two-click Quick Schedule from the pipeline card (lead-local time, duplicate guard) — **+ "may we text you a reminder?" consent capture**
53. Today / My Day agenda strip with tap-to-call
54. **Single SMS reminder (T-1h)** — gate-checked, suppression-aware with a visible reason, on a durable idempotent job runner
55. Outcome capture + Needs Outcome section *(it blocks nothing; the wrap-up sheet is where outcome is naturally captured)*
56. One-tap no-show logging + one-tap reschedule (spawns the recovery callback)
57. **Deterministic call↔meeting link** when the dial is launched from the appointment row

### 8 · Activities & My Day (2)
58. **My Day** — one sectioned, urgency-ranked surface (due now / today's appointments / needs outcome / needs reply / fresh) with a published ordering rule and a "why this is here" chip
59. Scheduled-callback activity with a hard due time

### 9 · Earnings & Leaderboard (6)
60. **Append-only Earnings ledger** — single writer, `period_key` stamped, exactly-once on `source_event_id`, human-only transitions into an earning stage, **forward-only semantics**
61. **Corrections:** reversal on reopen · `value_correction` on premium edit · **admin void/adjust-with-reason** · **recompute on stage-flag change**
62. Public real-time Earnings board (**5-second polling**, no SSE)
63. Board layout: podium 1-2-3 + top-10 + **always-visible self rank with neighbours + dollar gap to next**
64. **Period selector** (Today / This week / This month / All-time — *All-time is the default*) over the same board, metric and ranking rule
65. Closed-Won celebration — closer toast, once per opportunity, **fired after the undo window**, no floor-wide interruption

### 10 · Dashboard & oversight (3)
66. Seller home: My Day + My Earnings ledger view + rank & gap + **today activity strip (dials / contacts / appointments set)**
67. Supervisor / admin **global read scoping** (read-only across all books; no separate exception reports) + **one generic CSV export**

### 11 · Admin & first run (5)
68. Users & roles · **configurable cold threshold** · Aloware wiring · reminder kill switch · **single-record ownership transfer (audited)** · seeded loss-reason / lead-source / stage-template rows
69. **Seeded demo data + first-run checklist** (map and *test* your Aloware number, configure your stages, import your book, enable notifications)

---

## 4. Coherence check — the chain, link by link

CHAIN WALK — every link, and the exact MVP feature that carries it.

1) LEAD ENTERS — Covered three ways: the per-seller ping-post/lead-vendor webhook endpoint (the automatic door), Quick-add lead (15 seconds, mobile, for referrals and callbacks), and CSV import (day-zero migration of 50 existing books). Deterministic dedupe at intake runs before anything else so one person cannot become two cards, and Lead source is stamped on the record at creation. NO GAP.

2) LANDS IN ONE SELLER'S BOOK — Deterministic ownership binding at the source resolves the owner from the endpoint token (and, for inbound comms, from the seller's own Aloware number); Row-level ownership scoping enforces it on every query, with owner-scoped not-found so a seller cannot even prove another seller's lead exists; dedupe is silo-shielded for the same reason. Auto-open an opportunity on lead.created is the joint that turns the lead into a card — without it the board is empty on day one. My Book of Business + five seeded working lists is where leads live that are not on the kanban. NO GAP.

3) GETS CONTACTED (call / SMS / email) — Delivery: the notification router fires an owner-scoped new-lead alert (in-app live, PWA push, SMS deep link). Surfacing: fresh-lead treatment + the speed-to-lead clock on the card, plus the row at the top of My Day. Action: Call now via the Aloware Two-Legged Call API (the single dial service behind the card quick actions, the contact action bar and the Today strip), 1:1 SMS send from the thread with the locked opt-out footer, and inbound SMS threading with needs-reply state. Legality: every one of those paths passes the ONE outbound compliance gate, reading the consent ledger, the suppression list (STOP/START/DNC, tenant-scoped, E.164) and the lead-local calling-window resolver — hard block on SMS and automated sends, amber warn plus attestation on a manual dial, plain-English skip reason written to the timeline. Proof: zero-effort auto call logging from Aloware webhooks writes the call itself, behind the webhook reliability layer (idempotency, upsert by provider_call_id, out-of-order tolerance, DLQ), classified by the disposition → semantic outcome map, with quick-log/manual log as the fallback. ACCEPTED NARROWING, NOT A BREAK: email is deferred to V1.1. The chain names call/SMS/email, but the link is "gets contacted" and call + SMS carry it completely; email is redundant capacity whose real cost is deliverability across 50 senders, and shipping outbound email without inbound capture would be worse than not shipping it. TWO KNOWN LIMITS to state to the client: (a) MVP reminders and any blocked manual send are not queued-and-released — the gate tells the seller when the window opens rather than holding the message; (b) mobile push on iOS requires the seller to install the PWA, which is an onboarding step, not a missing feature.

4) GETS SCHEDULED — Two-click Quick Schedule from the pipeline card creates the meeting object linked to BOTH contact and opportunity (phone appointment is the default type, lead-local time shown, duplicate-appointment guard applied). Commitments that are not meetings — "call me Thursday at 2" — are the scheduled-callback activity with a hard due time. Either way the card now has a next activity, which is what the 'No next step' flag on the board watches for. NO GAP.

5) THE MEETING HAPPENS (OR NO-SHOWS) — The SMS reminder ladder runs on a durable idempotent job runner, passes the same compliance gate, and shows a visible reason when it is suppressed; SMS reply keywords (confirm / reschedule / STOP) cancel or move it so we never text someone who already answered. The seller is pulled in by the Today / My Day agenda strip with tap-to-call and a "call in 15 minutes" notification from the router. The outcome is not optional: mandatory outcome capture + a Needs Outcome queue, with one-tap no-show logging and one-tap reschedule that spawns the recovery callback activity. NO GAP.

6) THE CARD ADVANCES — Kanban board with full card anatomy (annualized premium, days-since-touch, next activity, source, compliance badge), drag & drop with optimistic UI, undo and server rollback on desktop, and a move-sheet on mobile so a touch-drag can never write Earnings by accident. The canonical touch engine (human-touch flag, last-touch, days-since-touch, cold detection) is the single source of the numbers printed on the card, and the stale/rotting alert plus the 'No next step' flag put decay where the seller is already looking. Stages themselves are the seller's: the per-seller stage editor ships a seeded default board and lets them mark which columns count as Earnings. NO GAP.

7) IT IS WON OR LOST WITH A REASON — Closed-Won passes the win gate: annual premium required, the monthly-or-annual question asked, both stored, annual displayed, enforced SERVER-SIDE, not in the drag handler. Because the sale becomes known on the call, the log-the-sale path from the call panel hands straight off to that same gate. Closed-Lost requires a typified loss reason from the admin-managed list — free text is refused. Optional descriptive product fields (product_type, carrier, policy_number, draft_date) ride along with no workflow attached. NO GAP.

8) IT IS MEASURED — One append-only Earnings ledger with a single writer, period_key stamped from v1, exactly-once on source_event_id, and human-only transitions into an Earnings stage; silent reversal on reopen or premium correction. Activity measurement comes from the canonical touch engine and the stored speed-to-lead latency (promoted from V1.1 precisely so this link has a stored number, not just a live countdown). The seller home shows My Earnings ledger, at-risk cards and rank; the supervisor global view is the read-only oversight the client asked for, with an exception list (unworked fresh leads, missing outcomes, no next step). NO GAP.

9) IT SHOWS ON THE PUBLIC RANKING — The all-time, real-time Earnings board reads the ledger projection, re-ranks live over SSE with a polling fallback, and shows a freshness/stale chip so it never lies confidently. Board layout gives the podium, the top-10, an always-visible self rank with neighbours and the dollar gap to next; the today/this-week ticker makes the TV change every day. The Closed-Won celebration fires from the same transaction as the ledger write (closer toast + TV takeover, once per opportunity), the kiosk route makes it genuinely public from an authenticated session, and the rank+gap widget on the seller home means the differentiator is seen by people who never go looking for it. NO GAP.

DEFECT CHECK — three things I am deliberately accepting and want on the record: email as a contact channel (V1.1, covered above); no automated first-touch SMS, so speed-to-lead in MVP is a human motion and depends on the seller actually reacting to the alert; and no cadence engine, so a three-attempt no-answer sequence is the seller working the "no answer" list from My Day rather than the system doing it. None of the three severs a link. Everything that WOULD sever a link — ownership, dedupe, the auto-opened opportunity, the dial path, auto call logging, the compliance gate, booking, outcome capture, the win gate, the loss reason, the ledger, the board — is IN.

**Two limits I am stating rather than hiding:**
- **Email is deferred to V1.1.** The chain says "call / SMS / email"; call + SMS carry the link completely. Outbound email without inbound capture would be worse than not shipping it, and deliverability across 50 senders is its own project.
- **Mobile notifications are in-app + desktop only.** A seller with the app closed on their phone learns about a lead when they open it. This is a real speed-to-lead cost, and it is the one place where the budget (<$100/month) and the differentiator genuinely conflict.

---

## 5. Decisions I need from you (D7–D9)

| # | Decision | Recommendation |
|---|---|---|
| **D7** | **Period selector on the leaderboard.** You chose all-time. On day one that board is 50 rows of **$0** — the differentiator is a blank screen in the demo — and by month three the gap to #1 is unreachable, so it stops moving for most of the floor. | Ship **one board, one number, one ranking rule** exactly as you decided, with a **period selector** (Today / Week / Month / All-time) where **All-time is the default**. `period_key` is already stamped on every ledger row, so this costs almost nothing. It does not create a second board — it filters the window. **Your call: adopt or veto.** |
| **D8** | **Do imported historical sales write to the Earnings ledger?** Yes = the public all-time board is seeded with 50 spreadsheets of unverifiable self-reported numbers, and the first dispute is on day one. No = a board labelled "all-time" shows zero for a floor with years of production. | **No.** The ledger starts at go-live and the board is labelled honestly (e.g. "Since launch"). If you want history, it goes in as audited admin-entered opening balances — never as a CSV column. |
| **D9** | **Recording.** Aloware records at the **account** level, and whether the recording announcement fires on a Two-Legged API dial is unverified. CA/FL/PA/IL/WA/MA require all-party consent. | Verify in the Sprint-0 spike. If the announcement does not fire on that path, **disable recording at the Aloware account level for the MVP** and bring it back in V1.1 with state-aware handling. |

---

## 6. Out of the MVP (documented, not built)

98 capabilities were explicitly placed outside the MVP. Full list with reasons below; the ordered roadmap is in [`03-dod-roadmap.md`](03-dod-roadmap.md).

### V1.1 (71)

| Capability | Why it is not in the MVP |
|---|---|
| Raw-payload replay & re-parse tooling | The raw body is stored in MVP; the replay/re-parse tooling is the expensive half. |
| Vendor field-mapping templates (named, versioned, transform library) | MVP ships one plain field map per source inside the endpoint. |
| Hosted web forms bound to a seller | Sellers running their own ads can post to their webhook URL; embeddable forms are the first inch of the funnel-builder slope. |
| Manual merge / duplicate review queue with field-level resolution | MVP resolves same-owner exact matches by update-in-place; the side-by-side merge UI is low-frequency admin work. |
| Intake operations tooling (unassigned quarantine, health monitor & failure alerts, endpoint token rotation, bulk ownership transfer) | With per-seller token binding the owner is always resolvable and a silent endpoint is noticed the same day; the rest is turnover hygiene. |
| Source performance / cost-per-acquisition & vendor ROI reporting | Reporting screens wearing an intake badge — MVP emits the attribution, a dashboard renders it later. |
| Inbound-unknown-caller lead creation + re-inquiry clock reset | Three entry doors already work; unmatched inbound is logged into the receiving seller's own book in MVP. |
| TrustedForm / Jornaya certificate retention via API | MVP stores the certificate URL; API retention is a paid per-cert dependency to price against the sub-$100/mo budget. |
| CCPA data-subject action screens (purge console) | The MVP model is redact-in-place with no hard deletes; the purge itself is a rare admin runbook, not a screen. |
| Card snooze / follow-up date (standalone) | The scheduled-callback activity is the honest version; a bare snooze lets a seller silence the alarm without committing to a next step. |
| Declarative stage rules engine (required fields, transitions, auto-set, SLA) | The one rule MVP needs — the server-side Closed-Won premium gate — ships inside the win gate; a DSL is not needed yet. |
| Board filters + saved views, column sort & pagination, list/table view | The needs-attention queues ship with the stale alert; the rest is scale hardening and a second rendering of board data. |
| Stage history / time-in-stage audit | The Earnings ledger already carries the evidence trail for the only disputed number that matters. |
| Manual recycle of cold and lost opportunities | A lost card can be re-created by hand in MVP; the linked recycle record is a refinement. |
| Duplicate-opportunity guard | Intake dedupe already catches the person; this is a second net. |
| Bulk actions (desktop multi-select) | Disposing of 30 dead leads one at a time is annoying, not blocking. |
| Cmd+K command palette that searches AND executes (all modules) | A proven accelerator, but every action it fires already exists as a button on the card — nothing in the chain breaks. |
| Ownership transfer with audit + activity reassignment on offboarding | Needed the first time a seller leaves, not week one — and it must never grow into the routing engine the architecture forbids. |
| Inbound call / reply clears cold and pins the card | The card still shows the touch through the timeline and the needs-reply row in My Day. |
| Dial attempt discipline (attempt counter, cadence and day-part rotation) | Real logic that deserves its own iteration; MVP shows the attempts on the timeline. |
| Aloware Power Dialer list push, fresh-lead auto-enroll and calendar-driven dialer lists | A second Aloware integration surface on top of the one-off dial path the chain needs first. |
| Timeline type filters + needs-review markers | Filters only matter once a record has hundreds of entries. |
| In-timeline recording player, transcript pane and AloAi summary card | A deep link to the Aloware recording covers MVP; these are coaching surfaces and add-on dependencies. |
| Multiple-opportunity rail on the contact | The schema separation ships in MVP; the UI rail matters once re-quotes and cross-sell volume exist. |
| Tags with a governed tag library | Nothing in the lead lifecycle depends on tags, and an admin-curated library is the brutal-to-administer pattern we rejected. |
| Bulk actions from the book view | It presupposes sequences and dialer lists that are themselves post-MVP, and a bulk action without a consent pre-flight is a bulk violation. |
| Guided merge with reversible window, duplicate review queue, owner reassignment with history transfer | Duplicates are rare enough at 50 sellers that exact-match prevention at creation covers MVP. |
| Attempt counter per contact + callback-window / do-not-call-before field | Derivable from the timeline, and a pinned note carries the callback window until dialer lists consume it as structured data. |
| Consent expiry sweeper, two-party recording-consent flag by state, per-number consent selection | Real exposure, but Aloware announces recording at dial time and MVP works one primary number per contact. |
| Contact access log | CCPA-by-design is satisfied in MVP by owner-scoped queries and the append-only audit log. |
| Month / week calendar grid + drag-to-reschedule | Desktop sugar on the module's least important surface; Quick Schedule and the one-tap reschedule chip carry the real path. |
| Two-way Google Calendar sync (+ sync-health banner, echo suppression, DST re-validation) | OAuth verification, quotas and echo loops are the module's largest technical risk, and nothing in the lifecycle stops without it. |
| Availability profile (hours, buffers, min notice, caps, blackouts) | A Calendly object model for a floor that runs on dial blocks; the client also deferred the availability/presence model. |
| Conflict / double-book detection | Low-frequency in phone sales, and the Quick Schedule sheet already shows the day's appointments. |
| Automatic call ↔ meeting linkage with recording and AI summary | Heuristic ±30-minute matching corrupts show-rate when wrong; manual outcome capture closes the loop in MVP. |
| Pre-call prep card | A deep link from the Today row to the contact record shows the same facts. |
| Appointment types & reminder template admin screen | Five seeded config rows do not need a merge-field editor with test-send. |
| No-show attempt ladder + automation-created meetings | MVP already lets the seller redial and mark no-show in one tap, and stage-bound scheduling depends on an engine that is post-MVP. |
| Team calendar lane view, meeting audit trail, show-rate / appointment-set metrics feed | A supervisor's questions are exception questions answerable by a list, and the client bound the product to ONE board and ONE number. |
| Cadence / sequence engine block (steps, TCPA-aware scheduler, template library, stage-bound triggers, bulk enroll, auto-pause, attempt ceilings, duplicate-activity suppression) | The single biggest complexity and compliance surface in the product; the lifecycle completes with manual follow-up driven from My Day. |
| Focus Mode (run-the-queue, one card at a time) | Its whole promise is a one-tap dial loop, and with no embeddable softphone that loop must be respecified before it is built. |
| Overdue triage & bulk reschedule + Snoozed & Waiting view | Only matters once a backlog and paused enrollments exist, which is weeks after launch. |
| Inbound-response SLA clock (second clock class) | The needs-reply state plus the reply row in My Day covers the behaviour in MVP. |
| Follow-up health report (leads with no next activity) | The 'no next step' flag on the board already puts this where the seller is looking. |
| Seller availability window that holds the SLA clock | The client explicitly deferred the availability/shift/presence model; MVP mitigates with a per-source delivery window. |
| Activity / enrollment audit trail beyond created_by and completed_by | Invisible in daily use; the platform audit log already covers consent, suppression, earnings and ownership. |
| Email channel (per-seller sender identity, inbound capture and reply threading) | SPF/DKIM/DMARC and reputation across 50 senders is heavy, and a channel that can talk but not listen is worse than none; call + SMS fully cover 'gets contacted'. |
| Click-to-call via the Aloware Talk Chrome extension | Two-legged Call now works on every device without a per-machine install across 50 sellers. |
| Recording attachment, player and retention policy | No link in the lifecycle depends on a playable recording, and it drags in two-party-consent and retention work. |
| AloAi call summary → prefilled note | Great demo material, but tier-dependent on Aloware and the quick-log note covers the need. |
| Disposition mapping admin screen | MVP ships a code-level map plus an unmapped-disposition alert; a config screen for a list that changes twice a year is bloat. |
| My Conversations inbox + conversation search | My Day's reply-waiting rows answer the same question, and search only pays off once there is history. |
| Send later / scheduled messages | A convenience that creates its own re-validation compliance surface; no link needs it. |
| A2P 10DLC status console | MVP only needs the gate to block SMS with a plain banner until registration completes. |
| Multi-number leads (number picker + per-number status) | MVP dials the primary number and marks it bad. |
| Inbound voicemail ingestion + sms.delivered / carrier-filtering handling | The missed-call alert already puts the seller on it, and delivery-state failures are silent-and-rare at MVP volume. |
| Supervisor conversation review + coaching notes | Supervisors get global read on threads for free; the coaching workflow is a separate surface. |
| Redaction / CCPA erasure executor + compliance audit export | The MVP model already permits erasure (redact-in-place); the executor and the packaged export can follow. |
| Lead-vendor attribution on comms events + per-lead language template routing | Nearly free and genuinely useful, but no link in the lifecycle breaks without either. |
| Rank delta vs yesterday / 7 days + nightly standings snapshot | On an all-time cumulative board the column is blank for ~45 of 50 rows every day; deltas can be replayed from the ledger later. |
| Gamification layer (7 secondary recognition categories, streaks, personal bests, badges & milestones) | Seven metric pipelines with windows, floors and tie-breaks is a module of its own; self-rank plus the dollar gap carries the anti-demotivation load in MVP. |
| Celebration tiers, mute / focus mode, floor-wide broadcast | Tiering and muting only matter once celebrations broadcast to everyone; MVP limits them to the closer's screen and the TV. |
| Kiosk unauthenticated access token + auto-rotating scenes | An unauthenticated URL publishing 50 named employees' earnings is the highest-risk artifact in the product; the today-ticker fills the screen more cheaply than rotation. |
| Public seller profile card (tappable leaderboard rows) | MVP rows are simply not tappable, which removes the silo-leak surface entirely rather than defending it. |
| Board ops (recompute & backfill with diff preview, standings & ledger CSV export, retire/anonymize a departed seller, accessibility as a separate pass) | A rebuild is a script before it needs a UI, exports start mattering at the first pay period, and contrast/reduced-motion are build rules applied while writing the kiosk. |
| Goal / quota attainment (% to goal, pace) | Every owner asks for it, but no goal model exists in the client's decisions and the lifecycle closes without it. |
| Automation engine & builder (trigger vocabulary, stage-bound automations, When/Only-if/Then editor, action catalog, business-hour waits, conflict resolution, frequency caps, dry run, test send, enrollment ledger & monitor, rule versioning, retry/DLQ console, org template publishing, send-rate smoothing) | MVP has exactly one scheduled outbound behaviour — the appointment reminder ladder — which carries its own idempotent runner and passes the one compliance gate; there is no engine left to build a builder for. |
| Speed-to-lead first-touch auto-SMS recipe | Automated outbound to a freshly purchased lead is the single largest TCPA/A2P surface in the product; MVP delivers speed-to-lead as a human motion (alert → Call now → live clock → fresh-card treatment). |
| Per-lead automation strip, do-not-automate flag, playbook gallery, three-level kill-switch console | They exist to control an engine that is not in MVP; a single reminder on/off switch ships in admin config. |
| Cold-lead nudge automation + unworked fresh-lead escalation | The stale badge plus a My Day row keeps the card alive, and escalation is the exact seam where round-robin routing would get smuggled in against the silo rule. |
| State-level calling/texting window table + enrollment handling on owner change | The conservative lead-local floor sits inside every state rule, and enrollment handoff only bites at the first departure. |

### V2 (14)

| Capability | Why it is not in the MVP |
|---|---|
| Vendor credit / return workflow for bad leads | Lead-vendor money reconciliation is a purchasing back-office, not a link in the lead's life. |
| Live / warm transfer intake bound to a concurrent inbound call | Race-condition-heavy and tied to one lead-buying model only. |
| Multiple typed pipelines (FE, IUL, future verticals) | Segmentation is out of scope and per-seller stage freedom already covers different motions. |
| Admin custom-field builder / curated field packs | A blank-canvas admin surface for a product shipping one authored field pack — the named anti-pattern. |
| Formatted compliance/timeline export + CCPA subject-request console | Expected volume at 50 sellers is near zero; a raw dump plus an admin runbook answers the obligation. |
| Custom field engine with vertical field packs | A blank-canvas field editor is the admin-surface anti-pattern; MVP seeds a handful of optional fields. |
| Booking links + public booking page | An entire second product with the only unauthenticated surface in the system. |
| Second attendee / decision-maker on the appointment; dial-block model | Doubles the reminder and consent logic, and presupposes dialer-session integration that does not exist. |
| State-level and Sunday/holiday calling-rule table | MVP ships a conservative 9am–8pm lead-local floor that sits inside every state rule. |
| Cadence performance analytics | Reporting on an engine that does not exist yet. |
| Transcript ingestion & search, template performance stats, comms cost meter, voicemail drop | Storage, volume or unverified API dependencies for value that only appears at scale — and ringless voicemail carries its own litigation profile. |
| Hall of Fame, positive-framing rank nudges, anomaly hold-before-public | Kiosk filler, an undecided social question, and a rule that would fire on every legitimate career-best close. |
| Board configuration admin surface | With one board, one metric and one period there is nothing to configure. |
| Closed-Won welcome & referral ask + playbook performance analytics | The lifecycle ends at won and measured; post-sale nurture and attribution analytics are a different product surface. |

### CUT — not built, and here is why (13)

| Capability | Why it is not in the MVP |
|---|---|
| Owner-jurisdiction (state license) check at intake | Licensing/appointment tracking is exactly the insurance-specialist machinery the recalibration puts out of bounds. |
| FE/IUL underwriting knockout fields on the intake card | Medical knockout modeling only makes sense to an insurance specialist; a free-text note covers it. |
| Post-sale pipeline machinery (won reversal for not-taken/lapse/chargeback, underwriting sub-status, multi-carrier re-shop, placement & persistency workflow, FE→IUL cross-sell trigger) | The client removed the submitted-vs-issued distinction and all placement machinery; Earnings is credited at the stage the seller configures, full stop. |
| Weighted pipeline value / forecasting | Enterprise forecasting imported from a 90-day B2B cycle; on a call-and-close cycle there is nothing to weight and it invites gaming. |
| Insurance-specialist record machinery (quoting/health profile, beneficiaries, existing coverage & replacement, draft-date + bank-on-file, post-sale policy lifecycle, licensing/appointment gate, household graph) | Exactly the vertical depth the scope recalibration removes; a loss reason and an optional descriptive field capture the same signal for free. |
| SSN capture field | Never build it — SSN is collected in the carrier portal; the product should warn against pasting it into notes. |
| Shared unmatched-call quarantine pool | A shared pool is a silo leak and the exact seam where a routing engine gets smuggled in; MVP routes unmatched inbound into the receiving seller's own book. |
| Read-only iCal subscription feed | A second calendar integration for the Outlook minority that never earns its maintenance cost. |
| Recurring / series appointments, carrier tele-app three-way scheduling, draft-date & persistency cadences | Policy reviews, tele-app calls and chargeback windows are named out-of-scope vertical machinery. |
| Persistency & policy-lifecycle follow-ups (post-sale) | Draft dates, free-look and persistency touches are out of bounds; a card is won and the story ends. |
| MMS, email open tracking, snippets as a separate surface, Aloware sequence mirror, caller-ID rotation / local presence, licensed-states dial guard | Each is either self-defeating (open-tracking pixels hurt deliverability), duplicated (snippets = personal templates), a double-engine risk (Aloware sequences), a product of its own (number reputation), or named out of scope (licensing). |
| Product-line boards (FE vs IUL) + manual chargeback / adjustment entry | The client bound the product to ONE leaderboard and ONE number, and chargeback reconciliation is removed placement machinery. |
| Multi-channel fallback ladder (call → voicemail drop → SMS), birthday & policy-anniversary touches, underwriting-stalled nudge, adoption recommendations | The ladder cannot execute as written without a server-initiated dial, and the rest is post-sale/underwriting machinery or SaaS growth-hacking on a single 50-seat tenant. |

---

## 7. Acceptance criteria & Definition of Done

- **User stories with Given/When/Then acceptance criteria:** [`03-mvp-stories.md`](03-mvp-stories.md)
- **Definition of Done + roadmap (V1.1, V2, path to SaaS):** [`03-dod-roadmap.md`](03-dod-roadmap.md)
