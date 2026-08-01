# 01 — Market Benchmark: Learning From the Best

> **Phase 1 deliverable.** Status: **complete, pending GATE 1.**
> Method: 9 parallel research subagents (Sonnet) using live web search, synthesized here on Opus. Every claim traces to a cited URL (see §11). Where a subagent could not verify something, it is flagged — **nothing is invented**. Read through our lens: a web CRM for ~50 US life/final-expense insurance sellers, per-seller silos, Aloware for calls/SMS, a public motivational leaderboard, and radical simplicity vs GoHighLevel's bloat.

---

## 1. Systems researched

| # | System | Category | Why it's here |
|---|---|---|---|
| 1 | **GoHighLevel (GHL)** | CRM | Primary reference; pipeline/opportunities, calendars, unified inbox, workflows — and its bloat |
| 2 | **Close** | CRM | Calling-first, inside-sales CRM — closest to our phone-heavy, silo model |
| 3 | **Pipedrive** | CRM | Cleanest pipeline-first UX; per-user pipelines, card anatomy, deal-rotting |
| 4 | **HubSpot Sales Hub** | CRM | Market leader; record timeline + sequences worth stealing, tiering to avoid |
| 5 | **Kommo** | CRM | Messaging-first; unified inbox + stage-bound automation (Digital Pipeline) |
| 6 | **Attio** | CRM | AI-native; speed, Cmd+K, "pipeline = a view over data" |
| 7 | **Aloware** | Integration | Our contracted dialer — real integration depth + compliance |
| 8 | **US insurance CRMs / dialers** (Ricochet360, VanillaSoft, AgencyBloc, DigitalBGA, NowCerts) | Domain | Speed-to-lead, TCPA/DNC, quoting, licensing — Life/FE domain patterns |
| 9 | **Leaderboards & gamification** (Spinify, Ambition, SalesScreen) | Domain | Our star feature — what actually motivates, and what demotivates |

---

## 2. Comparison matrix (decision-relevant capabilities)

| Capability | GHL | Close | Pipedrive | HubSpot | Kommo | Attio |
|---|---|---|---|---|---|---|
| **Native calling/dialer** | Sequential/manual power dialer (LC Phone) | ✅ Power + Predictive (native) | ❌ (killed 2022; marketplace) | Weak <Enterprise | Telephony via providers | ❌ (Aircall/Allo only) |
| **Native SMS** | ✅ | ✅ | ❌ marketplace | Add-on | ✅ (in inbox) | ❌ |
| **Unified per-lead inbox** | ✅ Conversations | ✅ Inbox (calls+SMS+email+tasks) | ❌ | ✅ record timeline | ✅ (WhatsApp/IG/etc.) | Email/calendar sync only |
| **Native sales leaderboard** | ❌ (only likes in Memberships) | ✅ Activity Overview (top10+2) | ❌ (3rd-party) | ❌ | ❌ | ❌ |
| **Per-user pipelines** | ✅ | ✅ multiple typed (Active/Won/Lost) | ✅ | ✅ | ✅ | ✅ (as views) |
| **Stale-lead alert on board** | ❌ (build via workflow) | ✅ Pipeline Guidance | ✅ deal-rotting | via reports | ❌ (task-overdue only) | via reports |
| **Native dedupe** | ✅ phone/email + merge tool | ❌ (CSV + support merge) | Strict, 1-by-1 | Auto on email/domain | ✅ intake + import | ✅ unique-attr + review list |
| **Booking → linked activity** | ✅ per-user cal sync | ✅ (Google) | ✅ Scheduler | ✅ Meetings | ✅ native module | ✅ auto-created Meetings |
| **Automation model** | Deep visual workflow builder | Growth+ tier | Simple trigger+action | Visual + AI (Breeze) | Stage-bound (Digital Pipeline) + Salesbot | Trigger→action + "Ask Attio" NL |
| **Cmd+K command palette** | Partial (per-module) | ✅ search + execute | ❌ verified | ❌ verified | ❌ verified | ✅ everywhere |
| **Permissions granularity** | ❌ binary (all vs mine) | Role-based (Scale tier) | ✅ roles | ✅ | Same-tier for all seats | Tiered |
| **Pricing model** | Flat tier + heavy usage overage | Per-seat, dialer gated to top tier | Per-seat, base hollowed | Per-seat + onboarding fees | 6-mo min, per-user lead caps | Per-seat + usage credits |

Legend: ✅ native/strong · ❌ absent/weak. Cells reflect what subagents could verify; see per-system detail and uncertainty notes.

**The single most important cell:** the entire **"Native sales leaderboard"** row is ❌ except Close — and even Close's is a report, not a motivational public podium. This is our whitespace.

---

## 3. Per-system findings (condensed)

### 3.1 GoHighLevel — the reference and the cautionary tale
**What it is:** all-in-one agency platform (CRM + funnels + sites + calendars + unified inbox + workflows + memberships), built for marketing agencies to **resell via white-label sub-accounts**.
**Steal:** Opportunity object decoupled from Contact — one kanban drag both updates the deal *and* fires a workflow (`Pipeline stage moved`); plain-English trigger vocabulary; per-user calendar connection with buffers/round-robin; single aggregated contact timeline; cheap dedupe (phone/email match + manual merge); flat automation access on every tier (no per-seat upsell).
**Avoid:** agency/multi-tenant surface is dead weight for one sales team; **permissions are binary** (all-data vs only-mine, no manager tier — a multi-year open request on GHL's own ideas board); 60–90 days to competence; **unreliable mobile app** (crashes during calls); usage billing adds **30–50%** over base; power dialer is manual, not predictive; **no sales leaderboard anywhere** (the only "leaderboard" is post-likes in the separate Memberships product).

### 3.2 Close — the closest fit to our operation
**What it is:** calling-first inside-sales CRM; reps never leave the app to call/text/email.
**Steal:** native **Power + Predictive dialer**; **unified Inbox** threading calls+SMS+email+tasks per lead; auto call recording/transcription/AI summary; **Sequences that auto-pause on reply**; **multiple typed Opportunity Pipelines (Active/Won/Lost)**; **Cmd+K that searches *and executes*** ("Create lead"); Pipeline Guidance surfaces stalled/overdue deals as daily nudges; **leaderboard display rule = top 10 + the 2 reps bracketing your own rank** (keeps mid-pack motivated).
**Avoid:** **no native dedupe** (API export → support-assisted CSV merge); no native web-form builder (99Inbound/Zapier); automation and predictive dialer gated to expensive tiers; dialer not on mobile.

### 3.3 Pipedrive — the pipeline UX benchmark
**Steal:** the **cleanest kanban card** — shows company, contact, value, expected close, **days-since-last-activity**, and **next scheduled activity** without opening the card; **deal-rotting alert on the board itself**; a single unified **Activity** object (call/meeting/task/email) that produces a real "what do I do next" list; Meeting Scheduler that **auto-creates a linked activity** on the deal; trigger+action automation with templates and if/else.
**Avoid:** no native calling (since 2022) or SMS — both marketplace; **no native leaderboard/gamification at all**; kanban can't filter by rep in-board (bad for our supervisor view); base plan intentionally hollowed to drive upgrades.

### 3.4 HubSpot Sales Hub — patterns to steal, tiering to reject
**Steal:** **per-record activity timeline** with type-filter toggles (one scroll = full context); **Sequences auto-unenroll on reply/booked meeting**; **stage-transition gating via required properties** (can't advance without required data — perfect to force an annual-premium value before a Closed stage); Meetings tool auto-sends confirmation+reminder emails to cut no-shows; ready-made funnel/velocity/weighted-forecast reports; NL-to-workflow AI (Breeze).
**Avoid:** cliff-edge tiering (Sequences/workflows/reporting locked to Professional ~$100/seat + ~$1,500 onboarding); weak native calling below Enterprise; reviewers call it "overwhelming/oversized" for small teams; no gamified leaderboard.

### 3.5 Kommo — messaging-first, stage-bound automation
**Steal:** genuine **unified inbox** (WhatsApp/IG/Telegram/SMS/calls/email in one thread — proof of concept for our future WhatsApp beside Aloware); **Digital Pipeline** binds automation triggers **directly to kanban stages** (move card → fire message/task/bot); **ready-made Salesbot templates** (not a blank canvas); **per-pipeline customizable card face** (choose visible fields — supports vertical-agnostic cards); dedupe at both intake *and* import; native booking module with 2-way Google sync.
**Avoid:** simple to *use*, steep to *administer* (bots/integrations/config); **6-month minimum**, all seats same tier, **per-user lead caps** (2,500/5,000/10,000); no leaderboard.

### 3.6 Attio — speed and the "view over data" model
**Steal:** **pipelines are a saved View over Lists/Objects** — same records power kanban + table + report with zero re-modeling (clean path to our Closed→Earnings rollup and to adding a 2nd vertical later); **Cmd+K + single-letter shortcuts everywhere** (n=note, t=task, ?=list shortcuts); real-time calendar sync auto-creates linked Meeting records; **CSV import matches on unique attribute to update not duplicate**, plus a dedupe review list; **named single-purpose report types** (Funnel, Time-in-Stage) instead of a generic BI builder.
**Avoid:** **no native phone/dialer** (no Aloware app — custom glue needed); blank-canvas model → "steep learning curve, feel lost without a template"; usage-credit automation pricing; thin native-integration catalog pushes you to Zapier.

### 3.7 Aloware (our integration) — what's actually achievable
**Reality of integration depth (important):** Aloware reserves its **embedded screen-pop softphone** for a short list of **native partners** (HubSpot, Salesforce, GHL, Pipedrive, Zoho). **We are not on that list**, and there is **no documented embeddable iframe/SDK softphone for arbitrary custom apps.** For our custom CRM, realistic depth = **(a)** the **Aloware Talk Chrome extension** for click-to-call on any page; **(b)** token-authenticated, single-purpose **APIs** we call server-side (Two-Legged Call, Lead/Form push, Contact Lookup, SMS, Sequence, Power Dialer list); **(c)** **outbound webhooks** we subscribe to (call disposition, recording, transcription, **AloAi call summary**, SMS). Building "native-partner-grade" depth is **our engineering project**, not a plug-in.
**Compliance is native and concrete (big win for Life):** STIR/SHAKEN attestation, A2P 10DLC, DNC suppression, **TCPA-approval gating before SMS**, STOP/opt-out handling. Aloware **deliberately omits a predictive dialer** (TCPA abandonment risk) in favor of an **agent-paced Power Dialer** — which fits our silo model (each seller works their own queue).
**Cost watch:** per-minute overage (~$0.02–0.04/min) + metered add-ons on top of per-seat tiers.

### 3.8 US insurance CRMs / dialers — the domain layer
The domain value is in the **dialer + compliance + quoting** layer, not the pipeline UI:
- **Ping-post / ping-tree intake:** purchased FE/life leads arrive via real-time bidding and are **shopped to competitors in parallel** → **sub-second speed-to-lead is the #1 conversion lever** (Ricochet360 auto-dials ~1s after entry; VanillaSoft "next best lead" queue).
- **Compliance inside the dialer:** triple-layer DNC (federal + state + internal), STIR/SHAKEN, branded caller ID ("Spam Guru") to protect answer rates; **store the lead-vendor consent certificate at intake**.
- **One-click FE quoting + live bank-draft verification** embedded in the lead record during the call (DigitalBGA, FEX Quotes) — catches insufficient-funds before submission, cuts lapses.
- **Licensing:** multi-state producer license/CE tracking (AgencyBloc, AgentSync) — a real insurance-only need (not MVP, flag for expansion).
- **Validation of our bet:** **DigitalBGA markets a public ranked agent leaderboard (daily/weekly/monthly)** in exactly the FE telesales space — proof the leaderboard motivates *this* audience, not just generic SaaS.
- **Architecture confirmation:** "GHL-for-insurance" is unofficial **3rd-party snapshot templates** ($997–1,697, drift-prone) — reinforces our choice to **build the Life layer ourselves on a vertical-agnostic core**.

### 3.9 Leaderboards & gamification — how to do the star feature right
**The core lesson (repeated across sources):** a naive **"rank everyone by revenue, forever, no reset" board demotivates ~60–70% of the team** because the same 2–3 reps always win. Proven fixes:
- **Period resets** with a predictable cadence (default **This Month**, toggle All-Time) — Earnings lands in bursts, so monthly fits.
- **Secondary categories** beyond total $ (Most Improved, Highest Conversion, Most Consistent, Personal Best) so more people can "win."
- **Event-driven celebration** the instant a deal hits a Closed stage (toast/confetti/podium re-sort) — same event that updates Earnings, no extra plumbing.
- **Dedicated no-chrome kiosk/TV view** (ambient visibility) + **mobile parity** with push.
- **Keep it to 1–3 controllable metrics**; if a 2nd is added, prefer an activity metric (calls/appointments) over a second revenue-like number.
- Every gamification product is a **paid bolt-on** ($9–75/seat, some with 30-seat minimums / 2-yr contracts) on top of the CRM — building it **in** is the differentiator.

---

## 4. TOP 20 PATTERNS TO ADOPT

Each: **pattern — where seen — why it works → how we apply it.**

1. **Opportunity decoupled from Contact; drag-to-stage updates the record *and* fires the automation in one gesture** — *GHL, Attio* — collapses data entry + automation into the natural motion → dropping a card into a **Closed** column is the single action that updates status **and** recomputes the seller's Earnings + re-ranks the leaderboard.
2. **Kanban card shows value, days-since-last-touch, and next activity inline** — *Pipedrive* — the board *is* the status report, zero clicks to triage → our card: annual premium, days-stale, next call/appointment, lead source.
3. **Stale/"deal-rotting" alert on the board itself, not a separate report** — *Pipedrive, Close (Pipeline Guidance)* — ambient nudge where the rep already looks → flag a card when no activity in N days (default 7, configurable).
4. **One unified per-lead timeline threading calls + SMS + email + notes + stage changes**, with type filters — *Close, HubSpot, GHL, Kommo* — one scroll = full context before a call → the lead detail screen is the one place a seller calls, texts, notes, and moves stage.
5. **A single "Activity" object (call/meeting/task/email) that yields a real "My Day" list** — *Pipedrive* — one mental model, one list of "what's next" → seller dashboard = My Day feed sorted by due time, in each seller's own silo.
6. **Sequences/cadences that auto-pause the moment a lead replies or books** — *HubSpot, Close* — stops automation talking over a live human → build reply-detection pause-logic from day one for Life follow-up cadences.
7. **Cmd+K command palette that searches *and executes* actions** ("log call", "new lead", "move stage") — *Attio, Close* — kills multi-click navigation, discoverable (?=shortcuts) → one palette covers global search + quick actions, hitting our "radically simple & fast" goal.
8. **Pipelines as a view/config over the same underlying deal data; multiple typed pipelines (Active/Won/Lost)** — *Attio, Close* — display decoupled from data; clean extension path → Life now, add Medicare/IUL/P&C later without redesigning the engine.
9. **Stage-transition gating via required fields** (can't enter a stage without required data) — *HubSpot* — enforces process without a rules engine → **require an annual-premium value before a card can enter a Closed stage** so Earnings/leaderboard math is never blank.
10. **Cheap dedupe at intake *and* import (phone/email match) + a manual merge/review queue** — *GHL, Kommo, Attio* — solves the real pain without a fuzzy-matching subsystem → per-silo dedupe at the point of entry (critical since there's no central routing).
11. **Booking auto-creates a linked activity on the deal; per-user self-service calendar connection** — *Pipedrive, GHL, Kommo, HubSpot* — closes the calendar↔pipeline loop, no admin wiring → seller connects own Google Calendar; a booked call auto-attaches to that lead card.
12. **Automated appointment reminders (SMS+email) + a no-show follow-up triggered off an "appointment status changed" event** — *GHL, HubSpot* — cuts no-shows passively → reminders via Aloware SMS; no-show auto-creates a reschedule task.
13. **Automation triggers bound directly to pipeline stages** (not a separate workflow module) — *Kommo (Digital Pipeline)* — configure behavior where you already look → stage-entry triggers for Earnings update, leaderboard re-rank, welcome SMS.
14. **A short, plain-English, named trigger vocabulary** (lead created, stage moved, missed call, appointment no-showed) instead of a generic condition builder — *GHL, Kommo* — reps read automations "like a sentence" → keep our automation list named after real sales events.
15. **Ready-made automation templates, not a blank canvas** — *Kommo (Salesbot), Pipedrive, HubSpot* — most teams need 3–5 flows → ship opinionated Life templates ("no answer after 3 calls → SMS", "idle 48h → reminder").
16. **Zero-effort auto call logging: disposition + recording + transcript + AI summary sync to the record via webhooks** — *Aloware, Close, GHL* — kills the #1 cause of CRM data rot (reps not logging calls) → our timeline auto-populates from Aloware webhooks; nothing manual.
17. **Leaderboard display rule: podium (top 3) + always show the viewer's own rank with neighbors when off-podium** — *Close (top10+2)* — a #27 rep still sees a next target instead of feeling invisible → our public board: podium + ranked list, and pin the viewer's own row.
18. **Period resets (default This Month, All-Time toggle) + at least one secondary "win" category** — *Spinify, SalesScreen, SPOTIO* — prevents the same-3-always-win demotivation → Earnings leaderboard defaults monthly; add a light "Most Improved this week" badge.
19. **Event-driven celebration + a dedicated no-chrome kiosk/TV view** — *SalesScreen, gamification vendors* — ambient recognition sustains daily motivation → a Closed-stage event fires a celebration; expose a full-screen leaderboard URL for an office TV.
20. **Sub-second "Call now" on a new lead + agent-paced Power Dialer queue** — *Ricochet360, VanillaSoft, Aloware* — purchased Life/FE leads decay in minutes → a one-tap click-to-call (Aloware) surfaces the instant a lead lands in a seller's silo.

*(Runner-up worth keeping: reserve a WhatsApp "channel slot" in the automation/action model now — GHL — so adding WhatsApp later needs no restructuring; and ship named single-purpose reports — Attio/Pipedrive — instead of a generic BI builder.)*

---

## 5. ANTI-PATTERNS / BLOAT TO AVOID

1. **Agency/multi-tenant surface as dead weight** — GHL's funnels/websites/memberships/reputation are irrelevant clutter for one sales team. *Keep the app to sales, nothing else.*
2. **Binary permissions with no manager tier** — GHL's "all vs mine" has no supervisor middle layer (multi-year open request). *We need exactly that middle tier: seller=own, supervisor/admin=global.*
3. **Feature-gated, hollowed base plans** — HubSpot/Pipedrive/Close/Kommo/Ricochet lock the useful parts behind upper tiers. *Our internal tool is single-tier: the base product is the whole product.*
4. **Usage-billing surprises (30–50% over base)** — GHL SMS/email/AI; Aloware per-minute overage. *Track and surface our own comms cost; no hidden meter that shocks users.*
5. **Simple to use, brutal to administer** — Kommo/Attio/GHL: base UI is friendly but bots/automations/config have a steep curve. *Admin config must be as simple as daily use.*
6. **Blank-canvas data model** — Attio's flexibility means users "feel lost without a template". *Ship an opinionated Life/Final-Expense config out of the box.*
7. **Static, revenue-only, never-reset leaderboard** — demotivates 60–70% of the team. *Resets + secondary categories + self-rank visibility, from v1.*
8. **Dedupe as a manual chore** — Close's export→support-CSV→merge is clunky. *Dedupe at the point of entry, automatically.*
9. **Predictive dialer** — TCPA call-abandonment risk; Aloware deliberately avoids it. *Use agent-paced Power Dialer per seller.*
10. **Mobile as an afterthought** — GHL's app crashes during calls. *Sellers use mobile for contact; treat responsive/mobile as first-class, not a port.*
11. **Third-party "snapshot" templates that drift** — GHL-for-insurance's 50+ unmaintained automations. *Build the Life layer natively and own it.*
12. **Rigid commercial terms** — Kommo's 6-mo minimum / same-tier-for-all / per-user lead caps; Ambition's 30-seat min + 2-yr contract. *N/A internally, but do not replicate these when we productize for SaaS.*

---

## 6. DIFFERENTIATION HYPOTHESES (≥5)

> Concrete opportunities to be clearly better for an agency like ours. Each is anchored to verified evidence above.

**H1 — Native, first-class, motivational Earnings leaderboard.** *Evidence:* the "native leaderboard" row is ❌ across GHL/Pipedrive/HubSpot/Kommo/Attio; it's always a paid bolt-on (Spinify/Ambition $9–75/seat) or absent — yet **DigitalBGA proves a ranked public board motivates FE telesales specifically.** *Our edge:* build it in — podium + off-podium self-rank (Close's top10+2 idea) + monthly reset + "Most Improved" + event-driven celebration + kiosk TV view. **This is the sharpest wedge.**

**H2 — Radical simplicity for one sales team.** *Evidence:* every incumbent is either agency-bloated (GHL: 60–90 days to competence) or hollowed by tiering (HubSpot/Pipedrive/Close). *Our edge:* single-tier, no-upsell, opinionated Life CRM where the whole product is available on day one, time-to-value in **minutes not weeks**, Cmd+K speed.

**H3 — Silo-native architecture with a real manager tier.** *Evidence:* GHL literally lacks a "Teams" concept and a manager-visibility permission (open request for years). *Our edge:* per-seller isolation by design + supervisor/admin global view + **no lead-routing engine to configure** — the exact shape we already committed to in Phase 0.

**H4 — Aloware-native, zero-effort call intelligence.** *Evidence:* we're not an Aloware native partner, but its **APIs + webhooks (disposition/recording/transcript/AloAi summary)** are documented and simple. *Our edge:* purpose-built webhook consumer + click-to-call so **every call/SMS auto-logs into the per-lead timeline** — the thing that kills CRM data rot — with no Zapier hop, tuned to our stack.

**H5 — Life speed-to-lead + compliance baked in.** *Evidence:* purchased FE/life leads decay in minutes (ping-post); TCPA fines are $500–1,500/call; Aloware provides STIR/SHAKEN + DNC + TCPA gating natively. *Our edge:* one-tap "Call now" the instant a lead lands + a **TCPA-consent flag carried from intake into every Aloware call/SMS** — domain value generic CRMs can't match without heavy config.

**H6 — Vertical-agnostic core, Life layer shipped first.** *Evidence:* insurance-only tools (NowCerts) are overkill; blank-canvas tools (Attio) have a learning curve; GHL-for-insurance is drift-prone snapshots. *Our edge:* Attio-style "pipeline = view over data" gives a clean path to Medicare/IUL/P&C later, while shipping an **opinionated Life/Final-Expense config now** — configurable card faces (Kommo) so FE vs IUL sellers see the right fields.

**H7 — Speed as a measured feature.** *Evidence:* GHL is heavy/slow; Attio's whole reputation is speed. *Our edge:* explicit, CI-enforced performance budgets (from Phase 4) + optimistic UI + inline card actions so the daily workflow feels instant.

---

## 7. What this resolves about our open questions

- **OQ-3 (leaderboard period):** research strongly favors **default monthly reset + All-Time toggle + a secondary "Most Improved" category + viewer-self-rank**. Recommendation to confirm in Phase 3/4.
- **Aloware depth:** confirmed **API + webhooks + Chrome click-to-call**, **no embeddable softphone** for custom apps → the comms module is our build. Native compliance (STIR/SHAKEN, DNC, TCPA gating) means **we carry a consent flag, Aloware enforces**.
- **Intake reality:** purchased leads arrive by **ping-post**; store the **vendor consent certificate** at intake; **speed-to-lead** is the top conversion lever → design intake + "Call now" around it.
- **Still open for Jorge:** OQ-1 (is the investment product IUL/annuity vs commercial P&C), OQ-2 (real channels/volumes), OQ-4 (current tooling/stages).

---

## 8. Sources (by system)

**GoHighLevel:** profunnelbuilder.com/gohighlevel-pipelines-and-opportunities · help.gohighlevel.com (workflow actions, dedup, linked calendars, unified tasks, universal search, gamification) · ideas.gohighlevel.com (permissions request, keyboard shortcuts) · netpartners.marketing/gohighlevel-disadvantages-2026 · ciela.ai/blogs/is-gohighlevel-worth-it-2026-reddit · automatethejourney.com/blog/gohighlevel-pricing-plans-2026 · g2.com/sellers/highlevel
**Close:** close.com (pricing, calling, automation, reporting, chloe) · help.close.com (activity-overview-report, opportunity-statuses, keyboard-shortcuts, mobile, inbox, merging-duplicates) · close.com/changelog/multiple-pipelines · marketbetter.ai/blog/close-crm-pricing-2026
**Pipedrive:** findmycrm.com/blog/pipedrive-crm-review · pipedrive.com/en/features (activities-goals, activity-calendar, workflow-automation, scheduling-tool) · support.pipedrive.com (activities, automations, insights-report-types, merge-duplicates) · pipedrive.com/en/marketplace/app/gamifier · plecto.com/blog/gamification
**HubSpot:** docket.io/resources/research/hubspot-sales-hub-pricing · breakcold.com/blog/hubspot-saleshub-review · knowledge.hubspot.com (deals, sequences, activities/timeline, dedup, search) · zeeg.me/en/blog/hubspot-meeting-scheduler-review · hubspot.com/products/workflow-automation-guide
**Kommo:** kommo.com (pricing, whatsapp-crm, tour/analytics, support: appointment-scheduling, import-advanced, salesbot, tasks, card-layout) · developers.kommo.com/docs/salesbot-dp · g2.com/products/kommo/pricing · capterra.com/p/120048/Kommo
**Attio:** attio.com (pricing, help: workflows, workspace navigation, email-calendar syncing, pipeline reports; apps: aircall, allo, duplicates) · docs.attio.com/docs/objects-and-lists · crm.org/news/attio-review · trustradius.com/products/attio/pricing
**Aloware:** support.aloware.com (CRM integrations, webhooks, two-legged call API, lead API, SMS API, sequence API, power dialer API, contact lookup, TCPA gating, HighLevel mapping/feature guide, Talk Chrome extension, Salesforce embed, AloAi webhooks) · aloware.com/products (compliant-calling, power-dialer, click-to-dial) · aloware.com/blog/auto-dialer-vs-power-dialer-vs-predictive-dialer · pricingsaas.com/companies/aloware
**Insurance CRMs:** ricochet360.com (insurance-dialer, insurance-crm, new-pricing) · vanillasoft.com/industries/insurance · agencybloc.com (home, what-is-an-ams, pricing) · demo.nowcerts.com/features · digitalbga.com/final-expense-telesales · phonexa.com/lms-sync/ping-post-software · astoriacompany.com/tcpa-compliance-for-life-and-final-expense-insurance-calls · fexquotes.com · ipipeline.com/products/lifepipe
**Leaderboards/gamification:** kixie.com/sales-blog (real-time-leaderboard-for-gohighlevel, ghl-has-no-teams-feature) · spinify.com/blog (leaderboard-best-practices, harm-than-good, insurance-gamification) · spotio.com/blog/sales-leaderboards · salesscreen.com/blog (sales-competition, insurance-industry) · ambition.com/d/gamification-leaderboard · leaderboarded.com/sales-leaderboard

*(Full URL list preserved in the research journal: `subagents/workflows/wf_fca098cc-249/journal.jsonl`.)*

---

## 9. Uncertainty / what we could NOT verify

- **Exact current pricing** for most vendors came partly from third-party aggregators (Pipedrive/HubSpot/Kommo/Aloware/Close price points) — treat as **directional**, re-check before any external comparison.
- **GHL trigger/action counts** ("50+/100+") and "probability-weighted forecasting" are marketing-adjacent, not confirmed against GHL's own changelog.
- **Our actual Aloware tier / per-minute rate** is unknown; whether a private embeddable softphone exists beyond public docs is unconfirmed.
- **No hands-on testing** of any product (no logins/trials) — mechanics are from docs + reviews, not live verification.
- **A "My Day" named view** in GHL and **Outlook sync in Close** were not confirmed either way.
- Gamification vendor **fairness/handicap math** is undocumented publicly; the "Allstate/MetLife use leaderboards" claim was single-source, uncorroborated.

---

## 10. Bottom line for design (feeds Phase 2)

Build a **sales-only, single-tier, silo-native** CRM whose **daily surface is a fast kanban + a unified per-lead timeline + a My-Day list**, whose **Closed stage is the one event** that updates **Earnings** and re-ranks a **native public leaderboard done right**, whose **comms are Aloware-native and auto-logged**, whose **intake is built for ping-post speed-to-lead with a TCPA-consent flag**, and whose **core is vertical-agnostic** with an opinionated **Life/Final-Expense** config shipped first. Everything GHL is, minus the bloat, plus the one thing no major CRM ships natively: motivation.
