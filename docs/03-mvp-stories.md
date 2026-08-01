# 03 — MVP User Stories & Acceptance Criteria

> Companion to [`03-mvp-definition.md`](03-mvp-definition.md). Every story belongs to a feature inside the approved 68-item MVP.
> Acceptance criteria are **Given / When / Then** and must be verifiable — a tester can pass or fail each one. Each story names the canonical events it emits or consumes ([`02b-integration-map.md`](02b-integration-map.md)).
> Standing rules: every query is silo-scoped at the data layer; every outbound action passes the one compliance gate; every screen has empty / loading / error / no-permission states.

---

# MVP Acceptance Specification — Area 1: Lead intake, Contacts & Pipeline

Scope covered: the automatic and manual entry doors, dedupe, ownership binding into ONE seller's book, the contact/opportunity record and its unified timeline, My Book, the Kanban board and card anatomy, stage movement, the per-seller stage editor with the `counts as Earnings` flag, the Closed-Won premium gate, the typified loss reason, and the board's attention signals (fresh-lead clock, stale rot, no next step).

Conventions used by every story below:
- **Silo rule:** every read and write is row-level scoped by `owner_user_id` + `tenant_id`. A record belonging to another seller returns the **owner-scoped not-found** response (HTTP 404, copy: `We couldn't find that record.`) — never "belongs to another seller".
- **Three timezones, named:** `tenant_business_tz` for `period_key` stamping, `user_display_tz` for every rendered timestamp, `lead_local_tz` for calling-window checks only.
- **One gate:** every dial/SMS/automated send goes through the single outbound compliance gate; it fails closed and has an admin-only, audit-logged break-glass override.
- **Money spine:** nothing writes Earnings except the append-only ledger, single writer, exactly-once on `source_event_id`.
- Stage semantics are bound to `stage_type` (`open` | `earning` | `lost`), **never** to a stage name.

---

### US-LCP-01 · Vendor webhook drops a lead straight into one seller's book
**As a** seller, **I want** my lead vendor to POST leads to my own endpoint and have them appear in my book within seconds, **so that** I can dial a fresh lead before my competitor does.

**Acceptance criteria**
- **Given** a per-seller endpoint `POST /intake/{source_token}` with a valid token, **When** a vendor posts a body containing at least one phone or email, **Then** a Contact is created with `owner_user_id` = the seller bound to that token, `lead_source` = the source configured on that token, `lead_local_tz` resolved from zip (fallback area code), the **raw request body stored verbatim**, and `lead.created` is emitted within 5 seconds of the POST.
- **Given** the token's field map defines `first_name`, `last_name`, `phone`, `email`, `state`, `zip`, **When** the vendor sends extra unmapped keys, **Then** the record saves successfully and the unmapped keys remain retrievable in the stored raw body (no 400, no data loss).
- **Given** a POST with an unknown, revoked or malformed token, **Then** the API returns 401, nothing is written to Contacts, and no `lead.created` is emitted.
- **Given** a POST whose phone cannot be normalized to E.164 and whose email is absent, **Then** the API returns 422 with `{"error":"phone_or_email_required"}`, the raw body is still persisted to the intake error log, and an in-app notification `Lead rejected from {source}: no usable phone or email` is sent to the seller.
- **Given** the SAME vendor payload is delivered twice (vendor retry) with the same `provider_lead_id`, **Then** exactly one Contact exists, exactly one `lead.created` was emitted, and the second call returns 200 with `{"status":"duplicate_ignored"}`.
- **Given** a lead whose resolved `lead_local_tz` has confidence `low` (area-code fallback only), **Then** the record is flagged `tz_confidence=low` and the card shows the badge `Time zone unconfirmed` — the lead is still created (the flag never blocks intake).

**Notes:** Microcopy: `Lead rejected from {source}: no usable phone or email`, `Time zone unconfirmed`. Emits `lead.created`, `contact.created`, `audit.ownership_write`. Consumes vendor consent fields into the consent ledger (`vendor certificate URL` when present).

---

### US-LCP-02 · Deterministic dedupe at intake, shielded across silos
**As a** seller, **I want** a lead I already own to update in place instead of becoming a second card, **so that** I never call the same person twice from two records — and I never see another seller's lead.

**Acceptance criteria**
- **Given** an incoming lead whose E.164 phone (or lowercased email) exactly matches a contact **I already own**, **When** it is ingested, **Then** no new Contact is created; non-empty incoming fields update the existing record, a timeline entry `Re-posted from {source} on {date}` is written, and `lead.reposted` is emitted instead of `lead.created`.
- **Given** the same match, **When** the existing contact has an OPEN opportunity, **Then** no second opportunity is created; the existing card is marked fresh again (speed-to-lead clock restarts) and the seller is notified.
- **Given** the same match, **When** the existing contact's only opportunity is in a `lost` or `earning` stage, **Then** a NEW opportunity is opened on that same contact (one contact, second deal) and `opportunity.created` is emitted with `reason=repost`.
- **Given** an incoming lead whose phone matches a contact owned by **another seller** in the same tenant (ping-post sold twice), **Then** a separate Contact is created in MY book, the other seller's record is never read, referenced or surfaced, and no cross-owner merge is offered anywhere in the UI.
- **Given** I manually create a lead whose phone already exists in my book, **When** I hit save, **Then** I get an inline block `You already have {name} with this number.` plus an `Open existing` action — no duplicate is written.
- **Given** two records in MY book that are actually the same person, **When** I use `Merge into…` on the contact detail, **Then** timelines, notes, activities and opportunities are consolidated onto the surviving contact, the merged record is redacted-in-place (never hard-deleted), and Earnings ledger rows are untouched.

**Notes:** Microcopy: `You already have {name} with this number.`, `Re-posted from {source} on {date}`, `Merge into…`. Emits `lead.reposted`, `contact.merged`, `opportunity.created`. Match is exact-only (normalized phone / lowercased email) — no fuzzy name matching in MVP.

---

### US-LCP-03 · Every new lead auto-opens a card; existing contacts need an explicit deal
**As a** seller, **I want** a board card to exist the moment a lead arrives, **so that** nothing lives only in a list and my pipeline is the real status report.

**Acceptance criteria**
- **Given** `lead.created` fires from any source (webhook, quick-add), **Then** an Opportunity is created within the same transaction, owned by the same seller, placed in the FIRST stage of that seller's own stage set, with `value=null` and `source` copied from the contact, and `opportunity.created` is emitted.
- **Given** the seller's stage set has been customized, **Then** the new card lands in the seller's own first stage — never in a global/default stage the seller cannot see.
- **Given** a contact created by the onboarding import path, **Then** NO opportunity is auto-created (import is explicitly excluded) and the contact appears in My Book with the status chip `No open deal`.
- **Given** a contact with no open opportunity (imported, lost, or already won), **When** I tap `Start a deal`, **Then** a new opportunity is created on that same contact, appears on the board immediately, and the contact timeline shows `Deal started`.
- **Given** a contact that already has an open opportunity, **Then** `Start a deal` is disabled with the tooltip `This contact already has an open deal.` (one open deal per contact in MVP).
- **Given** opportunity creation fails (DB error), **Then** the contact write rolls back too — a lead never exists without either a card or an explicit `No open deal` chip.

**Notes:** Microcopy: `Start a deal`, `No open deal`, `This contact already has an open deal.`, `Deal started`. Emits `opportunity.created`.

---

### US-LCP-04 · Quick-add a lead in 15 seconds from my phone
**As a** seller, **I want** to capture a referral or a callback in under 15 seconds on mobile, **so that** the name I got in the field actually reaches the CRM.

**Acceptance criteria**
- **Given** I am on mobile and tap the persistent `+` in the app shell, **Then** a single-screen sheet opens with exactly four fields — `Name`, `Phone`, `Lead source` (defaulted to `Referral`), `Note` (optional) — with the phone keypad focused and no page navigation.
- **Given** I enter a name and a 10-digit US phone and hit `Save & call`, **Then** the contact + opportunity are created, the lead-local calling window is resolved, and the dial is attempted through the one gate — total taps from `+` to dial ≤ 4.
- **Given** the phone number is fewer than 10 digits or fails E.164 normalization, **Then** the save is blocked inline with `Enter a valid US phone number.` and the entered data is preserved (never cleared).
- **Given** the number already exists in my book, **Then** the sheet shows `You already have {name} with this number.` with `Open existing` and does not create a duplicate.
- **Given** the number is on the tenant suppression list (DNC/STOP), **Then** the lead IS created (capture is never blocked) but it is created with the red `Do not contact` badge, `Save & call` is replaced by `Save`, and the timeline records `Save & call blocked — number is on the do-not-contact list.`
- **Given** I lose connectivity mid-save, **Then** the sheet shows `Couldn't save — you're offline. Retry.` and my typed values remain on screen; no partial contact is written.

**Notes:** Microcopy: `Save & call`, `Enter a valid US phone number.`, `Couldn't save — you're offline. Retry.`, `Do not contact`. Emits `lead.created`, `opportunity.created`, and (when dialed) hands off to `call.initiated` through the compliance gate.

---

### US-LCP-05 · Bring my existing book in at onboarding
**As an** admin, **I want** to load a seller's existing book from a CSV at onboarding, **so that** the product does not launch empty and sellers stop working out of spreadsheets.

**Acceptance criteria**
- **Given** a CSV and a target `owner_user_id`, **When** the import is run, **Then** every row is created as a Contact owned by that seller, with `lead_source` set from the file or defaulted to `Imported`, `imported_at` stamped, and a consent attestation row written to the consent ledger naming the attesting admin.
- **Given** the import runs, **Then** NO opportunities are auto-created and NO Earnings ledger rows are written — the leaderboard starts at go-live and the board carries the label `Earnings tracked since {go_live_date}`.
- **Given** a row whose phone matches an existing contact in that seller's book, **Then** the row is skipped and reported in the run summary as `skipped_duplicate` (count + row numbers); it is never merged silently.
- **Given** a row whose phone cannot be normalized to E.164, **Then** the row is rejected and reported as `invalid_phone` with its line number; the rest of the file still commits.
- **Given** any imported phone is present on the tenant suppression list, **Then** the contact is created already carrying the `Do not contact` badge and every action-bar send button is blocked by the gate.
- **Given** the same file is run twice, **Then** the second run creates zero new contacts (all rows report `skipped_duplicate`).

**Notes:** No wizard UI in MVP — import is a script plus an onboarding runbook (per the too-big critic). Microcopy on the board: `Earnings tracked since {go_live_date}`. Emits `contact.created` (bulk), `consent.attested`, `audit.ownership_write`.

---

### US-LCP-06 · One screen of context before every dial
**As a** seller, **I want** the contact/opportunity screen to show who this is, whether I may contact them, what I can do, and everything that has ever happened — in one scroll, **so that** I am never dialing blind.

**Acceptance criteria**
- **Given** I open a record I own, **Then** I see, in this order: header (name, E.164 phone, email, state + lead-local time, lead source, stage, annualized premium), the compliance badge, the action bar, and the unified timeline — and the layout reflows to a single column below 768px with the action bar pinned to the bottom on mobile.
- **Given** the record has history, **Then** the timeline shows in one reverse-chronological stream: calls (direction, duration, outcome), SMS in/out, emails, notes, meetings and their outcomes, stage moves (`from → to`, who, when), suppressed sends **with the plain-English reason**, and consent events — each timestamped in `user_display_tz`.
- **Given** the contact has consent and the lead-local time is inside 9:00 a.m.–8:00 p.m., **Then** the badge reads `OK to contact` (green) and Call/Text are enabled.
- **Given** the contact is on the suppression list, **Then** the badge reads `Do not contact — STOP received {date}` (red), Call and Text are disabled, and hovering/tapping them shows the reason; Log, Note and Schedule remain enabled.
- **Given** the lead-local time is outside the calling window, **Then** the badge reads `Outside calling hours (9:00 a.m.–8:00 p.m. {lead_city_tz})` (amber), the dial is **hard-blocked** by default, and the block is written to the timeline as `Call not placed — outside the lead's calling window.`
- **Given** I add a note and pin it, **Then** the pinned note renders in a `Pinned` block above the timeline on every device, survives reload, and unpinning returns it to its chronological position; notes support no @mentions anywhere in the UI.
- **Given** I open a record owned by another seller by URL, **Then** I get the owner-scoped not-found page — never a partial header, never the contact's name.

**Notes:** Microcopy: `OK to contact`, `Do not contact — STOP received {date}`, `Outside calling hours (9:00 a.m.–8:00 p.m. {lead_city_tz})`, `Call not placed — outside the lead's calling window.`, `Pinned`. Consumes `call.completed`, `message.sent`, `message.received`, `meeting.outcome_recorded`, `opportunity.stage_changed`, `send.suppressed`. Emits `note.created`, `note.pinned`.

---

### US-LCP-07 · Keep the record correct — and move it when someone leaves
**As a** seller, **I want** to fix a name, number, email or state and flag a bad number; **as an** admin, **I want** to transfer a record to another seller, **so that** the book stays dialable and a departure doesn't strand leads.

**Acceptance criteria**
- **Given** I edit the phone number, **When** I save, **Then** the new number is re-normalized to E.164, re-checked against the tenant suppression list, `lead_local_tz` is re-resolved from the new area code, and a timeline entry `Phone updated {old} → {new}` is written.
- **Given** the newly entered number is on the suppression list, **Then** the record immediately shows `Do not contact` and Call/Text are disabled on the next render without a manual refresh.
- **Given** a number that rings dead or is wrong, **When** I toggle `Bad number`, **Then** the card and the book row show the chip `Bad number`, the record drops out of the fresh-lead and callback sections of My Day, and `contact.flagged_bad_number` is emitted; untoggling restores it.
- **Given** I try to save an email that fails format validation, **Then** the field shows `Enter a valid email address.` and nothing is saved.
- **Given** an admin uses `Transfer ownership`, **When** a destination seller is chosen and confirmed, **Then** the contact, its opportunities, activities, notes and timeline move to the new `owner_user_id` in one transaction, an append-only audit row records `actor / from / to / timestamp / reason`, and the record disappears from the old seller's book on their next query.
- **Given** a seller (non-admin) opens the same record, **Then** `Transfer ownership` is not rendered at all, and a direct API call to the transfer endpoint returns 403 with no state change.
- **Given** a transfer completes, **Then** existing Earnings ledger rows are **not** re-attributed — historical credit stays with the seller who earned it, and the leaderboard totals do not change.

**Notes:** Microcopy: `Bad number`, `Phone updated {old} → {new}`, `Transfer ownership`, `Enter a valid email address.` Emits `contact.updated`, `contact.flagged_bad_number`, `contact.ownership_transferred`, `audit.ownership_write`.

---

### US-LCP-08 · Find anyone in my book instantly
**As a** seller, **I want** to search my book by name, phone or email from anywhere in the app, **so that** when an unknown number calls back I can pull the record up while it is still ringing.

**Acceptance criteria**
- **Given** the search field (or `Cmd/Ctrl+K`) is open, **When** I type at least 2 characters, **Then** matching contacts appear within 500 ms showing name, phone, stage and last-touch age, ranked by exact phone/email match first, then name prefix.
- **Given** I type a phone in ANY format (`5551234567`, `(555) 123-4567`, `+15551234567`, `555-123-4567`), **Then** the same contact is returned — search normalizes the query to E.164 before matching.
- **Given** results exist in another seller's book, **Then** they are never returned to me, never counted in a result total, and no "0 results but exists elsewhere" hint is shown.
- **Given** I am a supervisor or admin, **Then** the same search returns records across all books with the owner's name shown on each result row (read-only).
- **Given** the query matches nothing, **Then** the empty state reads `No matches in your book.` with a `Quick-add this number` action prefilled with the digits I typed.
- **Given** I press Enter on a result, **Then** I land on the contact detail with the action bar in view, in one navigation.

**Notes:** Microcopy: `No matches in your book.`, `Quick-add this number`. Consumes the contact index; emits nothing. Supervisor scope is read-only and must never expose an action-bar send button on another seller's record.

---

### US-LCP-09 · My Book: everything I own, with one honest status chip
**As a** seller, **I want** one list of my whole book with a status chip and simple filters, **so that** no-answers and cold leads don't become invisible just because the Kanban only shows open deals.

**Acceptance criteria**
- **Given** I open My Book, **Then** I see every contact I own — including those with no open opportunity — as rows showing name, status chip, days since last human touch, next activity (or `No next step`), lead source and premium when set.
- **Given** the touch engine is the single source of truth, **Then** `last_touch_at` updates ONLY on human touches (completed call in either direction, sent or received SMS/email, logged manual call, note) and NOT on stage moves, automated reminders, page views or webhook re-posts; the value shown in My Book, on the card and on My Day is byte-identical because all three read the same computed field.
- **Given** the status chips, **Then** exactly one applies per contact from: `Uncalled`, `Callback due`, `No answer`, `Cold`, `Client`, `No open deal`, `Do not contact` — with `Cold` = no human touch in ≥ 14 days and an open opportunity, and `Uncalled` = zero outbound call attempts ever.
- **Given** I tap a chip, **Then** the list filters to that chip only and the filter is reflected in the URL so it survives reload and can be shared with myself across devices.
- **Given** a contact receives an inbound SMS, **Then** `last_touch_at` is updated and the `Cold` chip is dropped on the next render — recomputed, never cached to a stale value.
- **Given** my book is empty (day one, no import), **Then** the empty state reads `Your book is empty. Add your first lead or ask your admin to import your list.` with a `Quick-add lead` button — not a blank table.

**Notes:** Microcopy: chips above; `No next step`; empty state as quoted. Consumes `call.completed`, `message.sent`, `message.received`, `note.created`. Emits `touch.recorded`. Ordering default: `Callback due` first, then oldest-touch first.

---

### US-LCP-10 · My board, my columns, my cards
**As a** seller, **I want** a Kanban of only my own open opportunities with everything I need on the card face, **so that** the board is my status report and I never open a card just to know what to do.

**Acceptance criteria**
- **Given** I open the board, **Then** columns are MY configured stages in MY order, each column shows a count and the sum of annualized premium, and only opportunities where `owner_user_id = me` are returned by the query (verified at the API layer, not just the UI).
- **Given** a card, **Then** its face shows: annualized premium (or `No value yet`), days since last touch, next activity with its due time in `user_display_tz` (or the `No next step` flag), lead source chip, and the compliance badge (`OK to contact` / `Do not contact` / `Outside calling hours`).
- **Given** a card whose premium is stored monthly, **Then** the face displays the ANNUAL figure with the suffix `/yr` — the monthly number never appears on the card, the board totals or any public surface.
- **Given** a card's contact has a low-confidence timezone, **Then** the compliance badge renders in its unconfirmed state rather than green, and the tester can confirm the tooltip names the assumed timezone.
- **Given** I have zero open opportunities, **Then** each empty column renders its name with `Nothing here yet` and the board offers `Quick-add lead` — the board never renders as a blank page.
- **Given** a supervisor opens the board scoped to a seller, **Then** they see the same cards read-only: no move-sheet, no quick actions that send, and any move API call returns 403.
- **Given** the quick actions on a card (`Call`, `SMS`, `Schedule`, `Note`, `Log`), **Then** Call and SMS route through the one compliance gate exactly as the detail action bar does, and a blocked attempt writes the plain-English reason to the timeline without opening a dialer.

**Notes:** Microcopy: `No value yet`, `No next step`, `Nothing here yet`, `/yr`. Consumes `opportunity.created`, `opportunity.stage_changed`, `touch.recorded`, `activity.created`. Emits `call.initiated`, `note.created` via quick actions.

---

### US-LCP-11 · The board tells me what needs attention: fresh, rotting, or drifting
**As a** seller, **I want** the board to visibly mark leads that just arrived, leads I haven't touched in too long, and leads with no next step, **so that** speed-to-lead is measurable and leads stop dying quietly.

**Acceptance criteria**
- **Given** a lead created less than 60 minutes ago with zero outbound attempts, **Then** its card carries the `NEW` treatment (highlight + top-of-column pin) and a live counter `New — {mm:ss} since arrival` that ticks without a page reload.
- **Given** I initiate a dial on that card, **Then** the clock STOPS at the moment of dial initiation (not at answer), `first_touch_latency_seconds` is persisted once on the opportunity, and the counter is replaced by `First touch in {duration}`; a second dial does not overwrite the stored latency.
- **Given** a lead arrives and is never dialed, **Then** at 60 minutes the `NEW` treatment expires and the card falls back into normal ordering with `first_touch_latency_seconds` still null — the null is preserved as a real, reportable value.
- **Given** an open opportunity with no human touch for ≥ 7 days, **Then** the card shows the amber `Rotting — {n} days since last touch` flag; at ≥ 14 days the flag turns red and the contact chips to `Cold`.
- **Given** an open opportunity with no future-dated activity and no scheduled callback, **Then** the card shows `No next step` and it is counted in the board header as `{n} cards need a next step` with a one-tap filter.
- **Given** an opportunity sits in an `earning` or `lost` stage, **Then** rotting, `No next step` and the fresh clock never render on it — closed cards are never nagged.
- **Given** `attempt_count` and `last_attempt_at`, **Then** they increment on every `call.completed` (any outcome, including no-answer) and are visible on the card as `{n} attempts` — verifiable by placing two no-answer calls and reading `2 attempts`.

**Notes:** Microcopy: `New — {mm:ss} since arrival`, `First touch in {duration}`, `Rotting — {n} days since last touch`, `No next step`, `{n} cards need a next step`, `{n} attempts`. Consumes `lead.created`, `call.initiated`, `call.completed`, `touch.recorded`. Emits `speed_to_lead.recorded`.

---

### US-LCP-12 · Move a card — drag on desktop, move-sheet on mobile

> **CORRECTED 2026-07-31 (Phase 4 review).** This story was originally written as "move-sheet on every device, no drag-and-drop anywhere". That contradicted the binding ruling in [`03-mvp-definition.md`](03-mvp-definition.md) §2, where the proposal to cut drag was **rejected**: drag stays on desktop (it is the anchor's most visible demo moment), the move-sheet is the mobile path (a touch-drag must never write money by accident), and the undo-vs-celebration race is resolved by delaying the celebration until the 5-second undo window closes.

**As a** seller, **I want** to drag a card between stages on desktop and move it through an explicit sheet on mobile, **so that** the board feels immediate where I manage and safe where I contact.

**Acceptance criteria**
- **Given** desktop, **When** I drag a card to another column, **Then** the move is applied optimistically at 60fps, an undo affordance appears for 5 seconds, and the server confirms or rolls the card back visibly.
- **Given** mobile, **When** I tap `Move` on a card, **Then** a sheet lists my stages with the current one marked, each row labeled with its type (`Open`, `Counts as Earnings`, `Lost`). **There is no touch-drag on mobile.**
- **Given** either path targets a stage of type `earning`, **Then** the win gate opens **before** anything is committed, and the optimistic move is not applied until the gate is satisfied.
- **Given** I select a target stage of type `open`, **Then** the move is committed server-side first, the card renders in the new column only after the 200 response, and `opportunity.stage_changed` is emitted with `from_stage`, `to_stage`, `actor_user_id`, `source=manual`.
- **Given** I select a stage of type `earning`, **Then** the win gate (US-LCP-14) opens BEFORE the move commits; cancelling the gate leaves the card in its original stage with nothing written to the ledger.
- **Given** I select a stage of type `lost`, **Then** the loss-reason gate (US-LCP-15) opens before the move commits, with the same cancel behavior.
- **Given** the server rejects the move (403, validation, or a stale version), **Then** the card visibly returns to its original column, and a toast reads `Couldn't move that card — nothing was changed.`
- **Given** I am offline, **Then** the `Move` action is disabled with `You're offline — moves are paused.` and no local-only stage state is retained after reload (the board never lies about a move the server never saw).
- **Given** a move into an `earning` stage is attempted by any non-human origin (import, webhook, automation, API job), **Then** the move is rejected and no ledger row is written — transitions into Earnings are human-only, enforced server-side.

**Notes:** Microcopy: `Move`, `Counts as Earnings`, `Couldn't move that card — nothing was changed.`, `You're offline — moves are paused.` Emits `opportunity.stage_changed`; downstream `opportunity.won` / `opportunity.lost` are emitted only by the gates.

---

### US-LCP-13 · I configure my own stages — and which ones count as Earnings
**As a** seller, **I want** to build my own pipeline stages and mark which ones count as Earnings, **so that** the board matches how I actually sell — without silently rewriting the public leaderboard.

**Acceptance criteria**
- **Given** a new seller, **Then** a seeded default board already exists (`New`, `Contacted`, `Appointment set`, `Presented`, `Closed-Won` [`earning`], `Closed-Lost` [`lost`]) — a blank canvas is never presented.
- **Given** the stage editor, **When** I add, rename, reorder or delete a stage, **Then** each stage requires a `stage_type` of `open`, `earning` or `lost`, and renaming a stage NEVER changes its type or its gate behavior (verifiable: rename `Closed-Won` to `Cerrado` and confirm the premium gate still fires).
- **Given** I flag an existing stage as `counts as Earnings`, **Then** a confirmation reads `New wins moved into this stage will count toward your Earnings. Cards already in this stage will not be re-scored.` — and after confirming, cards already sitting in that stage produce **zero** new ledger rows.
- **Given** I un-flag a stage that has already credited Earnings, **Then** existing ledger rows are **immutable and not voided** (forward-only), the leaderboard total does not drop, and the confirmation states `Past Earnings already credited from this stage stay on the leaderboard.`; only future entries stop crediting.
- **Given** any flag or type change, **Then** `stage_config_changed` is emitted with before/after, an audit row is written, and the seller's derived rank/aggregate caches are recomputed from the immutable ledger (recompute of derived views only — never of history).
- **Given** I try to delete a stage that contains cards, **Then** the delete is blocked with `Move the {n} cards out of this stage first.`
- **Given** I try to leave zero `earning` stages or zero `lost` stages, **Then** the save is blocked with `You need at least one stage that counts as Earnings and one for lost deals.`

**Notes:** Microcopy exactly as quoted above — these two sentences are the written-down answer to "what happens to Earnings when a stage flag changes". Emits `stage_config_changed`, `audit.earnings_write`. Consumed by US-LCP-12, US-LCP-14, US-LCP-15 and the leaderboard.

---

### US-LCP-14 · The win gate: annual or monthly, asked once, converted server-side
**As a** seller, **I want** to be asked "monthly or annual?" the moment I win, **so that** my number on the public board is right and I am never publicly credited 12x what I sold.

**Acceptance criteria**
- **Given** an opportunity enters ANY stage of type `earning` — from the move-sheet, the card quick action, the after-call log-the-sale path, or the API — **Then** the win gate is enforced **server-side** and the move fails with `422 premium_required` if premium data is absent.
- **Given** the gate, **Then** it asks for a premium amount and requires an explicit choice between `Monthly` and `Annual` with **no preselected default**; `Save win` stays disabled until both are provided.
- **Given** I enter `150` and select `Monthly`, **Then** `premium_monthly=150.00` and `premium_annual=1800.00` are both stored, the card, the board totals, the ledger row and the leaderboard all display `$1,800.00/yr`, and the live preview in the gate reads `Counts as $1,800.00 per year` before I save.
- **Given** premium is `0`, negative, non-numeric, or above the sanity ceiling `$100,000/yr`, **Then** the gate blocks with `Enter a premium between $1 and $100,000 per year.` and nothing is written.
- **Given** a valid save, **Then** `opportunity.won` is emitted with a `source_event_id`, exactly ONE ledger row is written (a replay of the same `source_event_id` writes nothing), `period_key` is stamped in `tenant_business_tz`, and `earnings.updated` reaches the leaderboard within 5 seconds.
- **Given** I later correct the premium via `Edit deal value`, **Then** I must supply a reason, a `value_correction` delta row is appended to the ledger (the original row is never mutated), an audit row is written, the leaderboard re-ranks, and the timeline shows `Deal value corrected {old} → {new} — {reason}`.
- **Given** the card is moved OUT of an `earning` stage into an `open` or `lost` stage, **Then** a reversal delta is appended, the seller's total drops accordingly, and no floor-wide notification or celebration is emitted for the reversal.
- **Given** the optional descriptive fields (`product_type`, `carrier`, `policy_number`, `draft_date`), **Then** they are editable and displayable on the record but NONE of them is required by the gate and none of them affects Earnings.

**Notes:** Microcopy: `Monthly`, `Annual`, `Counts as $X per year`, `Save win`, `Enter a premium between $1 and $100,000 per year.`, `Edit deal value`, `Deal value corrected {old} → {new} — {reason}`. Emits `opportunity.won`, `earnings.credited`, `earnings.updated`, `opportunity.value_corrected`, `earnings.reversed`.

---

### US-LCP-15 · Lost means lost, with a reason from the list
**As a** seller, **I want** to pick a loss reason from a short list when I close a card lost, **so that** the chain ends with something countable instead of 400 unusable free-text strings.

**Acceptance criteria**
- **Given** an opportunity enters ANY stage of type `lost`, **Then** a required, single-select reason picker is enforced **server-side**; the move fails with `422 loss_reason_required` if absent.
- **Given** the picker, **Then** it shows the seeded tenant list — `Not interested`, `Price`, `Couldn't reach`, `Bought elsewhere`, `Not qualified`, `Wrong number`, `Do not contact`, `Other` — and free text is available ONLY as an optional note alongside the selected reason, never as a substitute for it.
- **Given** I choose `Other`, **Then** the note field becomes required with `Tell us briefly what happened.` (max 280 chars).
- **Given** I choose `Do not contact` or `Wrong number`, **Then** the contact is flagged accordingly (suppression entry / bad-number flag) and the timeline records the link between the loss and the flag.
- **Given** I cancel the picker, **Then** the card stays in its previous stage and nothing is written.
- **Given** a lost card, **Then** it leaves the open board columns, the contact remains in My Book with its chip, and `Start a deal` becomes available for a future re-attempt — a lost lead that calls back has a path that does not require creating a duplicate.
- **Given** an opportunity that had already credited Earnings is moved to a `lost` stage, **Then** the reason is still required AND the reversal delta from US-LCP-14 is appended — both fire, in that order.

**Notes:** Microcopy: reasons exactly as listed; `Tell us briefly what happened.` Emits `opportunity.lost` with `loss_reason_code`, plus `suppression.added` or `contact.flagged_bad_number` where applicable.

---

## Cross-cutting test notes for this area
- **Silo regression suite:** for every endpoint in this area (intake, contact read/write, board read, move, gates, search), a request authenticated as seller B against seller A's record must return owner-scoped 404 (or 403 on writes) with no record data in the body.
- **Replay suite:** vendor webhook re-delivery, gate double-submit, and duplicate `source_event_id` must each produce exactly one row — the public number is the thing most likely to be corrupted by a retry.
- **Premium display suite:** no surface anywhere (card, board totals, book row, ledger view, leaderboard, celebration toast) may render a monthly figure.
- **SMS-dark launch:** if 10DLC is not approved on go-live, every SMS entry point in this area (quick action, action bar) renders disabled with `Texting turns on once carrier registration is approved.` — visible and explained, never silently missing.


---

# MVP Acceptance Specification — Area 2: Communications, Calendar & My Day

Scope covered: Aloware identity map and dial path, one-tap Call now, the outbound compliance gate on comms surfaces, zero-effort call logging from webhooks, the after-call wrap-up, 1:1 SMS and inbound threading, the SMS-dark launch contingency, Quick Schedule from the card, the single T-1h reminder, meeting outcome and no-show capture, the scheduled-callback Activity, My Day, and owner-scoped notifications.

Applied critic rulings (binding for this section):
- Reminder ladder reduced to **exactly one send at T-1h**. No confirm/reschedule keyword parsing. STOP belongs to the suppression list, not the calendar.
- Template library cut → **4–6 seeded message constants + the merge renderer**. No segment counter, no personal template storage.
- PWA push and SMS-to-seller deep links cut → **in-app live + desktop Web Notifications only**.
- Snooze cut → **the scheduled-callback activity is the only deferral mechanism**.
- My Day absorbs the Today agenda strip, the Needs Outcome queue, needs-reply and at-risk cards as **sections of one surface**.
- Aloware disposition map is **enrichment, not the source of semantic outcome**; the after-call wrap-up sheet is the source.
- The dial path is **hard-blocked outside the lead-local calling window**; the only key is an admin break-glass override, audit-logged.
- The Aloware integration ships as a **spike first**; US-601 is the spike's acceptance surface.

Timezone vocabulary used throughout (three, never interchangeable):
- **tenant business timezone** — period_key stamping only.
- **user display timezone** — every surface, every timestamp shown to a human.
- **lead-local timezone** — the calling window and only the calling window.

---

### US-601 · Aloware identity map with a verified test call
**As an** admin, **I want** to bind each seller to their Aloware user and phone number and prove the binding works before leads reach it, **so that** every dial, webhook and auto-logged call resolves to exactly one seller's book.

**Acceptance criteria**
- **Given** I am an admin on the Aloware wiring surface, **When** I map seller `S` to Aloware user id `U` and number `+1XXXXXXXXXX`, **Then** the mapping is saved with status `unverified`, and no dial or webhook is accepted for that pair until verification completes.
- **Given** a mapping in status `unverified`, **When** I press **Verify number**, **Then** the system places a two-legged test dial to the admin's own number, and only a webhook whose `agent_id` resolves to `U` flips the mapping to `verified` (emits `aloware.mapping_verified`).
- **Given** an Aloware webhook arrives carrying a number that matches no mapping, **When** it is ingested, **Then** the payload is stored raw, no Contact/Activity is created in any seller's book, an admin-only `unmapped_number` alert row is written, and the event is NOT silently dropped.
- **Given** two mappings would claim the same E.164 number in the same tenant, **When** the second is saved, **Then** it is rejected with `This number is already mapped to <seller name>.` — one number, one seller, no shared inbound.
- **Given** a seller whose mapping is `unverified`, **When** they open any surface with a Call or Text button, **Then** the buttons are disabled with the tooltip `Your calling number isn't verified yet. Ask your admin to finish setup.`

**Notes:** Microcopy: **Verify number**, `This number is already mapped to <seller name>.` Emits `aloware.mapping_created`, `aloware.mapping_verified`. Consumed by every webhook handler in US-604 and US-607 for owner resolution. This story is the acceptance surface of the Aloware spike: signature verification, real disposition vocabulary and 10DLC status must be observed here before US-602/604/606 are built.

---

### US-602 · One-tap Call now via the Aloware Two-Legged Call API
**As a** seller, **I want** to call a lead in one tap from the card, the contact detail, My Day or an appointment, **so that** I never leave the CRM to dial and never lose the call from my history.

**Acceptance criteria**
- **Given** I tap **Call** on a card, **When** the compliance gate passes (US-603), **Then** the app calls the Aloware Two-Legged Call API, my own phone rings first, the lead is dialed on answer, and a `call.initiated` Activity appears on the lead timeline within 2 seconds of the API 2xx — before any webhook arrives.
- **Given** a dial is in progress, **When** I look at any surface, **Then** a persistent call-state banner shows `Calling <first name> — ringing your phone…` → `Connected` → `Wrap up`, with the lead's name, number and elapsed timer, and it survives navigation between screens.
- **Given** the lead's `speed_to_lead` clock is still running (fresh lead, never dialed), **When** the API returns 2xx, **Then** the clock stops on dial-initiated (not on connect), `first_touch_latency_seconds` is persisted once and never overwritten.
- **Given** every dial attempt, **When** the API returns 2xx, **Then** `attempt_count` is incremented and `last_attempt_at` is set on the opportunity, and both render on the card.
- **Given** the Aloware API returns 5xx, times out after 10s, or my mapping errors, **When** I tap **Call**, **Then** a red degraded-mode banner appears — `Aloware is unavailable. Dialing from your phone; log this call manually.` — a `tel:` link is offered, and the **Log a call** form (US-605) is opened pre-filled with the contact, so the attempt is never lost.
- **Given** I am on mobile, **When** I tap **Call** from My Day, **Then** the same two-legged path is used (no `tel:` unless degraded), so the call still produces webhooks and auto-logging.

**Notes:** Microcopy: **Call now**, `Calling <first name> — ringing your phone…`, `Aloware is unavailable. Dialing from your phone; log this call manually.` Emits `call.initiated`, `speed_to_lead.stopped`. Consumes the verified mapping from US-601. Recording announcement must be verified on the Two-Legged path during the spike, or recording is disabled at the Aloware account level for MVP.

---

### US-603 · The one outbound compliance gate on every dial, text and reminder
**As a** seller, **I want** the product to stop me before I contact someone I am not allowed to contact, **so that** a busy Tuesday cannot turn into a TCPA claim against the agency.

**Acceptance criteria**
- **Given** a contact whose phone is on the tenant suppression list (STOP or DNC), **When** I tap **Call** or **Text**, **Then** the action is hard-blocked, a plain-English reason is shown — `Blocked: this number opted out on Mar 4. Texting and calling are off.` — and a `message.suppressed` / `call.suppressed` entry with that reason is written to the lead timeline.
- **Given** the lead-local time resolves to 8:12 PM (outside the conservative 9:00 AM–8:00 PM lead-local floor), **When** I tap **Call**, **Then** the dial is hard-blocked (not warned), the banner reads `It's 8:12 PM for this lead. Calling window is 9 AM–8 PM their time.`, and the card offers **Schedule a callback** as the only forward action.
- **Given** the timezone lookup fails or the resolver returns a low-confidence result with no state/zip, **When** any send or dial is attempted, **Then** the gate **fails closed** and shows `We can't confirm this lead's time zone. Add their state to continue.`
- **Given** the gate is failing closed across the tenant because of a bad lookup, **When** an admin activates **Break-glass override** for the tenant, **Then** dials are permitted for a bounded window, every permitted action writes an `audit.compliance_override` row naming the admin, and a persistent amber banner reads `Compliance override is ON.` — sellers can never activate it themselves.
- **Given** an automated send (the T-1h reminder), **When** the gate evaluates it, **Then** automated sends are hard-blocked with no attestation path — the amber warn-and-attest path exists only for a manual dial with a documented inbound/consent event.
- **Given** any gate decision, **When** it resolves, **Then** exactly one gate function produced it (single choke point), and its input snapshot + verdict is written to the append-only audit log.

**Notes:** Microcopy: `Blocked: this number opted out on <date>. Texting and calling are off.`, `It's <time> for this lead. Calling window is 9 AM–8 PM their time.`, **Break-glass override**, `Compliance override is ON.` Emits `call.suppressed`, `message.suppressed`, `audit.compliance_override`. Consumes the consent ledger, the suppression list and the calling-window resolver.

---

### US-604 · Zero-effort auto call logging from Aloware webhooks
**As a** seller, **I want** every call — outbound, inbound and missed — to log itself on the right lead, **so that** my timeline, my no-answer list and every number downstream are real instead of whatever I remembered to type.

**Acceptance criteria**
- **Given** an Aloware `call.completed` webhook with a valid signature, **When** it is ingested, **Then** a call Activity is upserted by `provider_call_id` onto the contact owned by the mapped seller, carrying direction, duration, recording URL (if present) and raw disposition, and it appears on the unified timeline without any human action.
- **Given** the exact same webhook is delivered twice (provider retry or replay), **When** the second delivery arrives, **Then** the idempotency key short-circuits it, no second Activity exists, `attempt_count` is not double-incremented, and no notification is re-fired.
- **Given** webhooks arrive out of order (`call.completed` before `call.started`), **When** both are processed, **Then** the final Activity state is identical to in-order processing, and the earlier event never overwrites richer later data.
- **Given** a webhook fails signature verification or throws on processing after N retries, **When** processing ends, **Then** the envelope lands in the dead-letter queue with the raw body retained, and an admin-visible counter increments — nothing is discarded.
- **Given** an inbound call to a seller's mapped number from an unknown number, **When** it is ingested, **Then** a contact is created in that seller's book via the intake dedupe path (never assigned to another seller), the call is logged, and a missed inbound fires the notification in US-803.
- **Given** a raw disposition code that is not in the map, **When** it is ingested, **Then** the call still logs with `outcome = unknown`, the card still shows the attempt, and an admin `unmapped_disposition` alert is written — an unknown code never blocks the log.

**Notes:** Emits `call.completed`, `call.logged`, `activity.created`. The disposition map is **enrichment only** — on Two-Legged API dials the disposition frequently arrives null, so semantic outcome comes from US-605. Feeds the canonical touch engine (`last_touch_at`, days-since-touch) and the no-answer working list.

---

### US-605 · After-call wrap-up sheet with a required next step
**As a** seller, **I want** a wrap-up sheet to open by itself when the call ends, **so that** every call produces a structured outcome and a next step instead of a dead card.

**Acceptance criteria**
- **Given** a call ends (webhook `call.completed`, or I close the call-state banner), **When** the wrap-up sheet opens automatically on desktop and mobile, **Then** it shows the outcome taxonomy (Connected / No answer / Voicemail / Wrong number / Not interested / Callback requested / **Sold**), a note field, and a **required** next step.
- **Given** I choose **No answer** or **Voicemail**, **When** the sheet renders retry chips (`+2 hours`, `Tomorrow AM`, `Tomorrow PM`, `Pick a time`), **Then** one tap creates a scheduled-callback Activity with a hard due time (US-802) and closes the sheet — that single tap satisfies the required next step.
- **Given** I try to dismiss the sheet without a next step, **When** I tap outside or press **Close**, **Then** the sheet stays open with `Pick a next step before you close this.`, except when I choose **Not interested** or **Wrong number**, which route to the Closed-Lost typified loss reason instead.
- **Given** I choose **Sold**, **When** I confirm, **Then** the win gate opens directly from the sheet (annual premium required, monthly-or-annual question), and Earnings is only credited when the gate is completed server-side — never by the wrap-up sheet itself.
- **Given** I choose **Wrong number**, **When** I save, **Then** the number is flagged `bad_number`, it is excluded from future dials with `Marked as a wrong number.`, and the flag is reversible from the contact.
- **Given** I took a call on my personal phone, off platform, **When** I use **Log a call** from the action bar, **Then** the same sheet is available manually with a date/time picker, it writes the same Activity shape and outcome taxonomy, and the entry is stamped `Logged manually`.

**Notes:** Microcopy: `Pick a next step before you close this.`, **Log a call**, `Logged manually`, `Marked as a wrong number.` Emits `activity.completed`, `call.outcome_recorded`, and hands off to `opportunity.won` via the win gate (which emits `earnings.updated`). This is the source of semantic outcome; the Aloware disposition only enriches it.

---

### US-606 · 1:1 SMS from the lead thread
**As a** seller, **I want** to text a lead from their thread with compliant wording already in place, **so that** I answer the way US leads actually respond without writing my own opt-out language.

**Acceptance criteria**
- **Given** an eligible contact, **When** I open the thread and tap **Text**, **Then** the composer offers 4–6 seeded messages (first-touch, missed you, appointment confirmation, reschedule, doc request), merge tags render live against the real contact (`Hi {{first_name}}` → `Hi Maria`), and the opt-out footer is appended and **not editable**.
- **Given** I send a message, **When** it is accepted by Aloware, **Then** it appears in the thread as `Sending…` → `Delivered` (or `Failed`), lands on the unified timeline, updates `last_touch_at` as a human touch, and emits `message.sent`.
- **Given** the contact has no valid consent for SMS, or is suppressed, or it is outside the lead-local window, **When** I tap **Send**, **Then** the gate (US-603) hard-blocks the send, the composer shows the plain-English reason, and a suppressed entry with that reason is written to the timeline — the message body is never transmitted.
- **Given** a merge tag has no value (`{{first_name}}` empty), **When** I preview, **Then** the send is blocked with `This lead has no first name. Fix the contact or edit the message.` — no `Hi ,` ever goes out.
- **Given** Aloware returns a delivery failure webhook, **When** it is ingested, **Then** the bubble flips to `Failed — <carrier reason>` with a **Retry** action, and the failure is on the timeline.
- **Given** SMS is disabled tenant-wide (US-608), **When** I open the thread, **Then** the composer is disabled with the launch banner and no send is possible.

**Notes:** Microcopy: `Sending…`, `Delivered`, `Failed — <carrier reason>`, `This lead has no first name. Fix the contact or edit the message.` Emits `message.sent`, `message.failed`. No segment counter, no personal template storage (both cut). Seeded messages are constants, editable only by the builder.

---

### US-607 · Inbound SMS threading, needs-reply and STOP handling
**As a** seller, **I want** every inbound text to land in the lead's thread and raise a needs-reply flag, **so that** half the conversation does not live in a phone I cannot search.

**Acceptance criteria**
- **Given** an inbound SMS webhook to my mapped number, **When** it is ingested, **Then** it threads onto the matching contact in **my** book (matched on E.164), sets `needs_reply = true`, surfaces in the My Day *Needs reply* section, and fires the in-app notification (US-803).
- **Given** the inbound number matches no contact in the owning seller's book, **When** it is ingested, **Then** a contact is created in that seller's book with `source = inbound_sms`, never in another seller's book, and never merged across silos.
- **Given** a lead replies `STOP` (case-insensitive, with or without surrounding text per the parsed keyword set), **When** it is ingested, **Then** the number is added to the tenant-wide suppression list, every Call/Text button for that number is disabled immediately, and a timeline entry reads `Lead sent STOP on <date>. All outbound is blocked.`
- **Given** a lead replies `START`/`UNSTOP`, **When** it is ingested, **Then** the suppression entry is closed with a re-opt-in row (append-only, prior row preserved) and the buttons re-enable.
- **Given** a lead replies anything else, **When** it is ingested, **Then** it is **not** parsed for confirm/reschedule intent — it is only a needs-reply item for a human. (Keyword parsing beyond STOP/START is out of MVP.)
- **Given** I reply in the thread, **When** the send succeeds, **Then** `needs_reply` clears and the item leaves the My Day section without a page reload.
- **Given** the same inbound webhook is delivered twice, **When** the duplicate arrives, **Then** it is deduped on provider message id — one bubble, one notification.

**Notes:** Microcopy: `Lead sent STOP on <date>. All outbound is blocked.` Emits `message.received`, `conversation.needs_reply`, `suppression.added`, `suppression.reopened`. Suppression is tenant-scoped and keyed on E.164 — ping-post resells the same consumer, so a STOP must protect every seller.

---

### US-608 · SMS-dark launch mode (10DLC contingency)
**As an** admin, **I want** the product to launch cleanly with SMS switched off if 10DLC registration is not approved on go-live day, **so that** no-show mitigation and the daily loop still function call-only.

**Acceptance criteria**
- **Given** the tenant flag `sms_enabled = false`, **When** any seller opens a contact, a card or a thread, **Then** every SMS entry point is **visible but disabled** (never hidden), with the banner `Texting is pending carrier registration (10DLC). Calls and email work normally.`
- **Given** `sms_enabled = false`, **When** an appointment is booked, **Then** the T-1h reminder job is still scheduled but resolves to `skipped: sms_disabled`, the reason is written to the timeline, and the appointment shows `Reminder off — texting is pending registration.`
- **Given** `sms_enabled = false`, **When** any code path attempts an SMS send, **Then** the compliance gate blocks it at the same single choke point — the flag is enforced in the gate, not in the UI only.
- **Given** an admin flips `sms_enabled = true` after approval, **When** the change is saved, **Then** SMS entry points enable for all sellers within one page load, previously skipped reminders are **not** back-sent, and an audit row records who flipped it and when.
- **Given** SMS is dark, **When** a seller opens My Day, **Then** the *Needs reply* section renders its empty state (`Nothing waiting on a reply.`) instead of erroring.

**Notes:** Microcopy: `Texting is pending carrier registration (10DLC). Calls and email work normally.`, `Reminder off — texting is pending registration.` Emits `admin.sms_flag_changed`. This is a launch-day contingency, written before build, not discovered.

---

### US-701 · Two-click Quick Schedule from the card
**As a** seller, **I want** to book a phone appointment from the pipeline card or the call wrap-up in two clicks, **so that** booking never costs a page navigation and the card always has a next activity.

**Acceptance criteria**
- **Given** I tap **Schedule** on a card, **When** the sheet opens, **Then** it defaults to type `Phone appointment`, shows today and the next 6 days with my existing appointments already blocked out, and every slot is labeled in both my display timezone and the lead-local time (`2:00 PM (11:00 AM their time)`).
- **Given** I pick a slot, **When** I confirm, **Then** a Meeting is created linked to **both** the Contact and the Opportunity, a linked Activity is auto-created on the same beat, the card's next-activity chip updates immediately, and `meeting.created` is emitted — total interactions from card to booked: two.
- **Given** the chosen slot falls outside the lead-local 9 AM–8 PM window, **When** I confirm, **Then** it is blocked with `That's <time> for this lead — outside the 9 AM–8 PM calling window.` and the nearest valid slot is suggested.
- **Given** the opportunity already has an upcoming appointment, **When** I try to book a second one, **Then** the duplicate-appointment guard warns `<Name> already has an appointment Thu 2:00 PM.` and offers **Reschedule that one** or **Book anyway** — the default is Reschedule.
- **Given** the lead verbally agreed to a reminder text, **When** I confirm the booking, **Then** the sheet captures consent at that moment as a consent-ledger row (`captured_at = booking`, channel = SMS, source = verbal on call), which is what authorizes the T-1h reminder.
- **Given** I book from the call wrap-up sheet while the call is still connected, **When** I confirm, **Then** the appointment is linked to that call Activity, and the wrap-up's required next step is satisfied.

**Notes:** Microcopy: **Schedule**, `2:00 PM (11:00 AM their time)`, `<Name> already has an appointment Thu 2:00 PM.`, **Reschedule that one** / **Book anyway**. Emits `meeting.created`, `activity.created`, `consent.captured`. Consumes the calling-window resolver.

---

### US-702 · Single T-1h appointment reminder on a durable job runner
**As a** seller, **I want** one automatic text an hour before each appointment, **so that** fewer leads forget without me building a text-message machine.

**Acceptance criteria**
- **Given** a Meeting is created more than 1 hour ahead, **When** `meeting.created` is emitted, **Then** exactly **one** reminder job is enqueued for T-1h with an idempotency key of `(meeting_id, 'T-1h')` — no second job can ever be enqueued for the same meeting.
- **Given** the job runs, **When** it executes, **Then** it re-evaluates the compliance gate at send time (not at enqueue time); if consent, suppression, the lead-local window or `sms_enabled` fails, the send is skipped, the plain-English reason is written to the lead timeline, and the appointment shows `Reminder skipped: <reason>.`
- **Given** the job runner restarts, crashes or the worker is redeployed between enqueue and fire time, **When** it comes back up, **Then** the reminder still fires (durable store, not in-memory), and a job whose fire time has already passed by more than 15 minutes is dropped with `Reminder skipped: too late to be useful.` rather than sent late.
- **Given** a meeting is rescheduled or canceled, **When** the change is saved, **Then** the pending reminder job is canceled and, for a reschedule, exactly one new T-1h job is enqueued for the new time.
- **Given** the lead sent STOP at any point, **When** the job runs, **Then** it is skipped and the appointment reads `Reminder skipped: lead opted out.`
- **Given** an admin sets the reminder kill switch (env flag) to off, **When** any job runs, **Then** all reminders are skipped tenant-wide with a logged reason and no partial sends.

**Notes:** Microcopy: `Reminder skipped: <reason>.`, `Reminder skipped: too late to be useful.`, `Reminder skipped: lead opted out.` Emits `reminder.sent`, `reminder.skipped`. Exactly one send — the ladder and confirm/reschedule keyword parsing are cut; a lead who replies "move it" is a needs-reply item for a human (US-607).

---

### US-703 · Mandatory meeting outcome, one-tap no-show and reschedule
**As a** seller, **I want** to be forced to say what happened to every appointment, **so that** show-rate is a fact and a no-show spawns a recovery callback instead of a silent dead card.

**Acceptance criteria**
- **Given** an appointment's end time passes with no outcome, **When** the clock crosses it, **Then** the Meeting enters `needs_outcome`, appears in the My Day *Needs outcome* section within 60 seconds, and remains there until an outcome is recorded — it cannot be dismissed.
- **Given** I open a `needs_outcome` item, **When** I record an outcome, **Then** I must pick from the fixed set (Held / No-show / Canceled by lead / Rescheduled / Sold), and `meeting.outcome_recorded` is emitted with that value — free text is not an outcome.
- **Given** I tap **No-show**, **When** it is saved in one tap, **Then** the outcome is recorded AND a scheduled-callback Activity is auto-created for a recovery attempt with a proposed hard due time (default +2 hours, editable in the same sheet), and the card's next-activity chip updates.
- **Given** I tap **Reschedule**, **When** the Quick Schedule sheet opens pre-filled with the same contact and opportunity, **Then** confirming records the original meeting as `Rescheduled`, links the new Meeting to the old one, and cancels the old reminder job (US-702).
- **Given** I tap **Sold** from the outcome sheet, **When** I confirm, **Then** the win gate opens; Earnings is credited only on server-side completion of the gate, never by the outcome itself.
- **Given** three appointments are awaiting outcomes, **When** I open My Day on mobile, **Then** the section header shows `Needs outcome (3)` and each row is actionable without opening the full contact record.

**Notes:** Microcopy: **No-show**, **Held**, `Needs outcome (3)`. Emits `meeting.outcome_recorded`, `activity.created` (recovery callback), and hands off to `opportunity.won`. This is the "the meeting happened or no-showed" link in the chain; without it show-rate is self-reported fiction.

---

### US-801 · My Day — one sectioned, urgency-ranked surface
**As a** seller, **I want** one screen that tells me who to work right now and why, **so that** in a silo with no routing engine I still start the day with a list instead of a blank board.

**Acceptance criteria**
- **Given** I open My Day, **When** it renders, **Then** it shows exactly these sections in this fixed order: **Due now**, **Today's appointments**, **Needs outcome**, **Needs reply**, **Fresh leads** — each with a count, each collapsible, none of them a separate screen.
- **Given** items inside a section, **When** they are ordered, **Then** the published ordering rule is applied and is visible to the seller via **How this list is ordered**: (1) fresh leads under the speed-to-lead SLA, (2) overdue hard-due callbacks by how overdue, (3) appointments by start time, (4) needs-outcome by how long overdue, (5) needs-reply by inbound recency. Two testers sorting the same data by that rule must produce the same list.
- **Given** any row, **When** it renders, **Then** it carries a "why this is here" chip in plain English — `Fresh lead · 4 min old`, `Callback was due 25 min ago`, `Appointment at 2:00 PM`, `Replied 8 min ago`, `Outcome missing since 11:00 AM` — timestamps in my display timezone.
- **Given** I am on mobile, **When** I open My Day, **Then** each row exposes tap-to-call using the two-legged dial (US-602) without opening the contact first, and the compliance gate still runs on that tap.
- **Given** I complete a call, book an appointment, or reply, **When** the underlying state changes, **Then** the item leaves its section live (no manual refresh), and the section count decrements.
- **Given** I have nothing due, **When** My Day renders, **Then** each empty section shows its own state — `You're clear. Nothing due right now.` — and the surface never shows another seller's items under any section (owner-scoped queries only).
- **Given** a supervisor opens My Day, **When** it renders, **Then** it shows *their own* items; global visibility lives on the supervisor read-scoped board, not here.

**Notes:** Microcopy: **Due now**, **Today's appointments**, **Needs outcome**, **Needs reply**, **Fresh leads**, **How this list is ordered**, `You're clear. Nothing due right now.` Consumes `activity.created`, `meeting.created`, `conversation.needs_reply`, `lead.created`, `meeting.outcome_recorded`. Absorbs the Today agenda strip, the Needs Outcome queue, needs-reply and at-risk cards — one surface, sections only.

---

### US-802 · Scheduled-callback activity with a hard due time
**As a** seller, **I want** to promise "I'll call you Thursday at 2" and have the system hold me to it, **so that** the most common commitment in phone sales does not depend on my memory.

**Acceptance criteria**
- **Given** any contact, card, wrap-up sheet or no-show outcome, **When** I create a callback, **Then** it requires a **hard due date and time** (no "someday", no priority-only), it is stored as an Activity linked to Contact and Opportunity, and it becomes the card's next-activity chip.
- **Given** the due time is entered, **When** it is saved, **Then** it is entered and displayed in **my** timezone, the lead-local equivalent is shown beneath it, and a due time outside the lead-local 9 AM–8 PM window is rejected with `That's <time> for this lead — pick a time inside the calling window.`
- **Given** the due time arrives, **When** the clock crosses it, **Then** the item moves to the My Day **Due now** section and fires one in-app/desktop notification (US-803) — exactly one, not repeated every minute.
- **Given** a callback is overdue, **When** it renders, **Then** it shows `Due 25 min ago` in red, it stays in **Due now** until completed or rescheduled, and it clears the opportunity's "No next step" flag while it exists.
- **Given** I complete the callback (a dial or an explicit **Mark done**), **When** it resolves, **Then** `activity.completed` is emitted, `last_touch_at` updates through the canonical touch engine, and the card's next-activity chip goes empty — raising "No next step" if nothing replaces it.
- **Given** I want to push a callback, **When** I edit it, **Then** I must name a new hard time — there is no snooze-with-presets (cut) and no way to defer without a time.

**Notes:** Microcopy: `Due 25 min ago`, **Mark done**, `That's <time> for this lead — pick a time inside the calling window.` Emits `activity.created`, `activity.completed`. Snooze was deliberately cut in favor of this single mechanism; the wrap-up retry chips (US-605) are shortcuts that create this same object.

---

### US-803 · Owner-scoped notifications: in-app live + desktop Web Notifications
**As a** seller, **I want** to be told the second a fresh lead, a missed call, an inbound text or an imminent appointment needs me, **so that** speed-to-lead is measured in seconds instead of whenever I next look at the tab.

**Acceptance criteria**
- **Given** a `lead.created` event in **my** book, **When** the router dispatches, **Then** I receive an in-app toast within 5 seconds and a desktop Web Notification if I granted permission — and **no other seller** receives it under any circumstance (owner-scoped routing, verified by a test with two logged-in sellers).
- **Given** the trigger events, **When** any of these occur, **Then** exactly one notification is dispatched per event: fresh lead assigned, missed inbound call, inbound SMS (needs-reply), callback now due, appointment starting in 15 minutes.
- **Given** I have not granted browser notification permission, **When** an event fires, **Then** the in-app live toast still appears and a one-time non-blocking prompt offers `Turn on desktop alerts so you don't miss a fresh lead.` — the product never depends on the permission being granted.
- **Given** my phone browser is closed, **When** a fresh lead arrives, **Then** I learn about it when I next open the app. This is an accepted MVP limitation (PWA push and SMS deep-link alerts are cut) and it is stated in the product's known-limits copy, not buried: `Alerts reach you in the app and on your desktop. Close the app and you'll see it when you're back.`
- **Given** the same webhook is replayed and produces a duplicate event, **When** the router evaluates it, **Then** deduplication on source event id prevents a second notification for the same underlying fact.
- **Given** it is inside my configured quiet window (per-seller, in my display timezone), **When** a non-urgent event fires, **Then** the notification is suppressed and only surfaces in My Day — fresh-lead alerts are the one category that may be configured to ignore the quiet window.
- **Given** I click any notification, **When** it opens, **Then** it deep-links to the exact object (contact, thread, appointment or callback), and clicking a notification for a record I do not own returns the owner-scoped not-found — never `belongs to another seller`.

**Notes:** Microcopy: `Turn on desktop alerts so you don't miss a fresh lead.`, `Alerts reach you in the app and on your desktop. Close the app and you'll see it when you're back.` Consumes `lead.created`, `call.missed`, `message.received`, `activity.due`, `meeting.starting_soon`. Emits `notification.dispatched`, `notification.suppressed_quiet_hours`.

---

## Cross-cutting test conditions for this area

1. **Silo integrity:** every story above must be executed with two sellers logged in simultaneously; no event, notification, thread, appointment or My Day row may cross books. Attempting to open another seller's record returns owner-scoped not-found.
2. **Single choke point:** a code-level test must prove that every dial, SMS and reminder path calls exactly one gate function. A new send path that bypasses it fails the build.
3. **Idempotency sweep:** replay every Aloware webhook type twice and out of order; assert exactly one Activity, one notification, one `attempt_count` increment, and — where a sale is involved — one Earnings credit.
4. **SMS-dark rehearsal:** the full acceptance suite must pass a second time with `sms_enabled = false`; only SMS-specific criteria may change state, and no path may error.
5. **Degraded Aloware rehearsal:** with the Aloware API returning 500, a seller must still be able to place a call by `tel:`, log it manually with a structured outcome, book an appointment, and see it on My Day.


---

# Area 3 — Earnings, Leaderboard, Dashboard, Notifications & Admin

**Scope:** the Earnings ledger, the public all-time leaderboard (podium + self-rank), the closer celebration, the seller home, the supervisor/admin global view, per-seller stage configuration including the "counts as Earnings" flag, users & roles, admin corrections, notifications, demo data.

---

## 0 · Binding decisions written down before any code

These resolve the critic findings that would otherwise leave the public number undefined on day two. Every story below assumes them.

| # | Decision | Rule |
|---|---|---|
| D-1 | Gates bind to **stage_type**, never to a stage name | Every stage row carries a required `stage_type ∈ {open, earning, lost}`. The win gate fires server-side on entry to ANY `earning` stage from any origin; the typified loss reason fires on any `lost` stage. Renaming a column changes nothing. |
| D-2 | Un-flagging or deleting an Earnings stage is **non-retroactive** | The ledger is immutable and forward-only. Rows already written stay written. No recompute job exists. Corrections happen through the admin void/adjust surface (US-9.13), never through config. |
| D-3 | Flagging a stage does **not** re-score cards already sitting in it | Only a move *into* an `earning` stage, made *after* the flag change, credits. |
| D-4 | One credit per opportunity at a time | `opportunity.earnings_credited` is a boolean; earning→earning moves do not double-credit; reversal clears it; re-entry re-credits with a fresh `source_event_id`. |
| D-5 | Three timezones, named | `period_key_day/week/month` stamped in the **tenant business timezone**; all UI dates in the **user display timezone**; **lead-local** is used only by the calling-window resolver and never touches Earnings. |
| D-6 | The ledger starts at go-live | CSV-imported history never writes ledger rows. The board carries a permanent footnote saying so. |
| D-7 | Money is always **annualized USD**, whole dollars on public surfaces | The monthly-or-annual question is answered at the gate; the board can never show a monthly figure. |

**Cut from this area per the too-big critic (recorded, not silently dropped):** kiosk/TV route, TV takeover, SSE, freshness chip, the separate today/this-week ticker, the admin runtime-config screen. The board polls every 5 s (up to 5 s stale). The ticker's value is delivered by the period selector (US-9.7). Loss reasons, lead sources, the seeded stage template and the reminder kill switch ship as seed rows plus one env flag; admin keeps only user create + role assign + ledger corrections.

---

### US-9.1 · Per-seller stage editor with the "counts as Earnings" flag
**As a** seller, **I want** to configure my own pipeline columns and declare which ones count as Earnings, **so that** the board reflects the way I actually sell without asking anyone for permission.

**Acceptance criteria**
- **Given** a newly created seller **When** they open Stage Settings for the first time **Then** they see a seeded board (New Lead, Contacted, Appointment Set, Presented, Closed Won, Closed Lost) — never a blank canvas — with `Closed Won` pre-set to `stage_type = earning` and `Closed Lost` to `stage_type = lost`.
- **Given** a seller renames `Closed Won` to `Money` **When** they save and later move a card into it **Then** the win gate still fires and the credit is still written, because the gate reads `stage_type`, not the label (D-1).
- **Given** a seller adds a new column and leaves the type unset **When** they press Save **Then** the save is rejected inline with *"Pick what this column means: Open, Counts as Earnings, or Lost."* and no stage row is written.
- **Given** a seller tries to save a board with zero `earning` stages (or zero `lost` stages) **Then** the save is rejected: *"You need at least one column that counts as Earnings, or you'll never show on the leaderboard."*
- **Given** a stage holds 4 open cards **When** the seller deletes it **Then** deletion is blocked with *"Move the 4 deals in this column first."*
- **Given** seller A changes their stages **Then** seller B's board is byte-for-byte unchanged, and A's change writes one audit row.

**Notes:** emits `stage_config.changed` (actor, stage_id, before/after JSON). Consumed by the audit log and by US-9.4's confirmation copy. Reachable from the board header: *"Stages & Earnings"*.

---

### US-9.2 · Earnings credited on entry to an Earnings stage
**As a** seller, **I want** my sale to hit the public board the moment I move the card into my Earnings column, **so that** the floor sees it while the call is still warm.

**Acceptance criteria**
- **Given** a seller moves a card into an `earning` stage via the move-sheet **When** the win gate is submitted with premium `250` and mode `monthly` **Then** the opportunity stores `premium_monthly = 250` and `premium_annual = 3000`, exactly one ledger row is written (`delta = +3000`, `entry_type = sale`, `currency = USD`, `period_key_*` stamped in tenant business timezone, `stage_name_snapshot`), and the board shows the new total within 5 seconds.
- **Given** the same `opportunity.stage_changed` event id is delivered twice (double-tap, retry, replayed webhook) **When** the ledger writer processes it **Then** the unique constraint on `(tenant_id, source_event_id)` rejects the second insert, the seller's total is unchanged, and the duplicate is logged, not surfaced as an error to the seller.
- **Given** the seller dismisses or cancels the win gate **Then** the card remains in its previous stage, no ledger row exists, and nothing appears on the board — the move and the credit are one transaction.
- **Given** a non-human actor (CSV import, webhook, reminder job, dedupe merge, API token) attempts to move a card into an `earning` stage **Then** the transition is refused with `actor_type must be human`, an admin alert row is written, and no ledger row is created.
- **Given** a card already credited is moved from one `earning` stage to another `earning` stage **Then** no second row is written and the seller's total does not move (D-4).
- **Given** the ledger insert fails **Then** the stage move is rolled back and the seller sees *"Couldn't record this sale — nothing was saved. Try again."*

**Notes:** consumes `opportunity.stage_changed`; emits `opportunity.won` then `earnings.credited` then `earnings.updated{seller_id, period_keys}`. Win-gate microcopy: *"Is this premium monthly or annual?"* / *"We show annual on the leaderboard."*

---

### US-9.3 · Reversal on reopen and explicit deal-value correction
**As a** seller, **I want** a mis-dropped card or a wrong premium to correct itself on the board, **so that** my first typo isn't permanently public.

**Acceptance criteria**
- **Given** a credited card is moved out of the `earning` stage back to an open stage **Then** a `entry_type = reversal` row of `-3000` is written against a fresh `source_event_id`, `earnings_credited` is cleared, the board re-ranks within 5 seconds, and the timeline reads *"Earnings reversed — moved from Closed Won to Presented."*
- **Given** that reversal fires **Then** no toast, no desktop notification and no floor-wide broadcast are produced — reversals are silent by design.
- **Given** the seller later moves the same card back into an `earning` stage **Then** it re-credits once, and the opportunity's net contribution equals exactly one credit.
- **Given** a seller opens **Edit deal value** on a credited opportunity and changes `$3,000` to `$1,800` **Then** a `entry_type = value_correction` row of `-1200` plus one audit row are written, the opportunity total reads `$1,800`, and both rows are visible in the seller's own ledger view.
- **Given** the value is corrected from mode `monthly` to mode `annual` **Then** the converter re-runs and the correction delta equals exactly the difference between the two annualized figures — the board is never allowed to display a monthly number.
- **Given** a seller opens the edit-value URL for an opportunity they do not own **Then** the response is an owner-scoped not-found — never *"belongs to another seller."*

**Notes:** emits `opportunity.reopened`, `earnings.reversed`, `deal_value.corrected`, then `earnings.updated`. Edit action is reachable from the opportunity detail header AND from the row in **My Earnings**.

---

### US-9.4 · Changing stage settings never rewrites history
**As a** seller, **I want** to know exactly what happens to my number when I change my columns, **so that** I can use my configuration freedom without fearing the public board.

**Acceptance criteria**
- **Given** a seller un-flags a stage that has already credited `$40,000` **When** they open the confirmation dialog **Then** the rule is stated before they can confirm: *"Past sales stay counted. This only changes what happens the next time you move a card here."* — and on confirm, all existing ledger rows are untouched and the seller's total remains `$40,000`.
- **Given** 6 cards are sitting in a stage **When** the seller flags that stage as counts-as-Earnings **Then** zero cards are retro-credited, and the dialog says *"Deals already in this column won't be counted. Move them out and back in to count them."* (D-3).
- **Given** a seller deletes a stage that produced credits **Then** the ledger rows survive with the historical stage name preserved on each row, and the seller's ledger view still renders them.
- **Given** `stage_config.changed` is emitted **Then** no recompute job is enqueued (verify: job queue is empty after the change), an audit row records actor + timestamp + before/after, and the seller's ledger view shows a marker line *"Stage settings changed"* at that timestamp.
- **Given** a seller toggles the Earnings flag on and off 5 times on a stage holding one already-credited card **Then** their total after the fifth toggle is identical to their total before the first.

**Notes:** consumes `stage_config.changed`. This story exists specifically to make D-2/D-3 testable.

---

### US-9.5 · The public all-time Earnings leaderboard
**As a** seller, **I want** one public board with one number, updating on its own, **so that** I always know where I stand against the whole floor.

**Acceptance criteria**
- **Given** any authenticated user (seller, supervisor or admin) opens **Leaderboard** **Then** every active seller in the tenant is listed, ranked descending by the sum of their Earnings ledger deltas for the selected period, showing full name and annualized USD total in whole dollars.
- **Given** the ranking is displayed **Then** a *"How this is ranked"* link states the published rule: sum of the Earnings ledger; ties broken by whoever reached the amount first (earliest ledger timestamp); a seller with `$0` is shown at the bottom, never hidden.
- **Given** another seller writes a credit **When** at most 5 seconds pass **Then** the viewer's board reflects it without a manual refresh (polling every 5 s while the tab is visible; polling stops when the tab is hidden and fires immediately on refocus).
- **Given** the polling request fails 3 consecutive times **Then** the last known values stay on screen with a muted line *"Reconnecting…"* — the board never blanks and never renders a false `$0`.
- **Given** it is go-live day and no ledger rows exist **Then** the empty state reads *"No earnings yet. First sale of the day owns the top spot."* with the permanent footnote *"The board starts at go-live — imported history isn't counted."* (D-6).
- **Given** a seller taps another seller's row **Then** nothing opens: the leaderboard exposes name and total only, and there is no path from it into another seller's contacts, opportunities or activities.

**Notes:** consumes `earnings.updated`. Read endpoint is tenant-scoped and role-agnostic; it is the ONLY surface where a seller sees data outside their own silo.

---

### US-9.6 · Board layout — top 3, top 10, and a self-row that is always visible
**As a** mid-pack seller, **I want** to find myself and the exact dollar gap to the person above me, **so that** I keep opening the board instead of ignoring it.

**Acceptance criteria**
- **Given** the board renders **Then** ranks 1–3 are visually emphasized (rank badge, larger row) and ranks 4–10 render as a plain list below them.
- **Given** the viewer is rank 27 of 50 **Then** their row is pinned and always visible while scrolling, labeled **You**, with exactly one neighbor above and one below for context.
- **Given** the viewer is rank 27 with `$8,760` and rank 26 has `$10,000` **Then** the pinned row reads *"$1,240 to pass Dana R."*; **given** the viewer is rank 1 **Then** it reads *"Leading by $3,100"*; **given** an exact tie **Then** it reads *"Tied with Dana R."*
- **Given** the viewer is inside the top 10 **Then** their row is highlighted in place and no duplicate pinned row is rendered.
- **Given** the viewer has `$0` in the selected period **Then** the pinned row still renders with `$0` and a gap to the next seller above — the self-row is never hidden and never collapsed.
- **Given** a supervisor or admin views the board **Then** no self-row is rendered (they don't sell); the header shows the tenant total for the selected period instead.

**Notes:** pure presentation over the US-9.5 payload; no additional events. Verify on a 375 px viewport that the pinned row does not cover the last list item.

---

### US-9.7 · Period selector over the one board
**As a** seller, **I want** to switch the same board between Today, This week, This month and All time, **so that** a great day is visible even when I'm 40th all-time.

**Acceptance criteria**
- **Given** the board loads for the first time **Then** the period defaults to **All time** (the client's headline board), with Today / This week / This month available as filters on the same metric, the same ledger and the same ranking rule — no product-line tabs, no second metric.
- **Given** a sale is credited at 11:50 pm in the tenant business timezone **Then** it counts to that business day for every viewer, regardless of the viewer's own display timezone (D-5), and the row's `period_key_day` proves it.
- **Given** the viewer switches from All time to Today **Then** the list re-ranks from the same ledger using `period_key_day`, and the pinned self-row recomputes its gap against the Today totals.
- **Given** **Today** is selected before anyone has sold **Then** the empty state is distinct from the all-time one: *"Nothing on the board yet today."*
- **Given** the viewer selects **This week** and reloads the page or returns tomorrow **Then** the selection is reflected in the URL and restored per user across sessions.

**Notes:** replaces the cut today/this-week ticker. Reads the `period_key_day/week/month` columns already stamped by US-9.2.

---

### US-9.8 · Closed-Won celebration (closer only, once per opportunity)
**As a** seller, **I want** a moment when I close, **so that** working alone in my own book still feels like being on a floor.

**Acceptance criteria**
- **Given** a seller completes the win gate **Then** within 2 seconds a toast appears for that seller only: *"Boom. $3,000 added. You're #4 — $1,240 behind Dana R."*
- **Given** the same opportunity is reopened and closed again **Then** no second toast fires, because `opportunity.celebrated_at` is already set (once per opportunity, forever).
- **Given** a celebration fires **Then** no other seller receives a notification, no sound plays by default, and nothing is broadcast floor-wide.
- **Given** a reversal or a downward value correction is written **Then** no toast of any kind is produced.
- **Given** the seller's browser is offline or the tab is closed when the credit resolves **Then** the toast is not queued or replayed on next login, while the ledger row and the board total are still correct.

**Notes:** consumes `opportunity.won`; reads the rank/gap from the same payload as US-9.6.

> **CORRECTED 2026-07-31 (Phase 4 review).** The original note claimed there was no undo-vs-celebration race because drag had been cut. Drag was **not** cut (see US-LCP-12). The race is real and is resolved by two binding rules: **(a)** the celebration fires only after the 5-second undo window closes, and **(b)** the public leaderboard projection **excludes ledger entries younger than the undo window**, so no viewer ever sees a number that later corrects itself. The seller's own *My Earnings* view may show the pending row immediately, marked as such.

---

### US-9.9 · Seller home — My Day entry, My Earnings ledger, at-risk, rank & gap
**As a** seller, **I want** one home screen that tells me what to do next and lets me audit my own money, **so that** I never have to ask a supervisor whether my number is right.

**Acceptance criteria**
- **Given** a seller signs in **Then** the home screen shows, in order: the My Day entry (due now / today's appointments / needs outcome / needs reply / fresh), an at-risk section (stale + no-next-step cards), and an Earnings block with period total, current rank and dollar gap.
- **Given** the seller opens **My Earnings** **Then** every ledger row for them is listed with date (display timezone), contact name, opportunity, `entry_type` rendered in plain English (Sale / Reversed / Value corrected / Adjusted by admin), signed delta, and a running total.
- **Given** the seller filters My Earnings to **This month** **Then** the sum of the visible deltas equals, to the dollar, the number shown for them on the leaderboard's This-month view.
- **Given** an admin adjustment exists on their ledger **Then** the row displays the admin's typed reason text — the seller is never shown an unexplained change to their own money.
- **Given** a seller requests another seller's ledger URL directly **Then** they get an owner-scoped not-found.
- **Given** a brand-new seller with no credits **Then** the Earnings block reads *"No earnings yet. Your first Closed Won lands here."* and still renders their rank and the gap to the seller above.

**Notes:** consumes `earnings.updated` (live total refresh), `activity.*` for the queue counts. This is the surface that makes the ledger auditable to the person it belongs to.

---

### US-9.10 · Supervisor / admin global read-only view
**As a** supervisor, **I want** to see every seller's board and book through the same screens, **so that** I can spot unworked fresh leads without breaking the silo.

**Acceptance criteria**
- **Given** a supervisor opens the pipeline or the book **Then** the same queries run with the ownership filter lifted (global read scoping — no separate reports built), every card and every row shows an owner chip, and a seller filter is available in the header.
- **Given** a supervisor attempts any write — stage move, note, edit, dial, win gate **Then** the action is blocked with `403` and the message *"Supervisors have read-only access to seller books."*, and no ledger, activity or audit-write side effect occurs.
- **Given** a supervisor needs the exception views **Then** they are produced by sorting/filtering the existing surfaces (fresh-lead age, missing outcome, no next step) — verify each filter returns the correct set on seeded data.
- **Given** a supervisor opens a seller's book **Then** an audit row records who viewed whose book and when (CCPA hygiene).
- **Given** a seller's role is changed to supervisor **Then** the global scope applies on their next request with no redeploy, and their own historical ledger rows and leaderboard total are untouched.
- **Given** a plain seller requests a global-scope endpoint **Then** they receive their own owner-scoped result set, never another seller's rows, and never a 403 that reveals the endpoint exists.

**Notes:** emits `book.viewed{viewer_id, owner_id}`. Deliberately ships without a dedicated exception-list screen.

---

### US-9.11 · Owner-scoped notification router
**As a** seller, **I want** to be told the second a fresh lead lands or a call is missed, **so that** speed-to-lead is decided by my reaction time and not by whether I happened to be looking.

**Acceptance criteria**
- **Given** an event fires for a record a seller owns (`lead.created`, `call.missed`, `sms.inbound`, `meeting.starting_soon` at T-15m) **Then** that seller — and only that seller — gets an in-app live entry plus a desktop Web Notification, within 5 seconds of the event.
- **Given** a fresh lead lands in seller A's book **Then** seller B receives nothing, and the notification payload contains no data from another seller's silo.
- **Given** the seller has never granted browser notification permission **Then** the permission prompt is triggered by an explicit user gesture only, and if it is denied or unsupported the in-app center keeps working under a one-line banner: *"Desktop alerts are off. You'll only see new leads while this tab is open."* — the known speed-to-lead cost, stated on screen.
- **Given** the current time is inside the seller's quiet window (default 8:00 pm–8:00 am in their display timezone) **Then** the notification is stored and badged but no desktop popup is raised; nothing is dropped, and the item is visible when they return.
- **Given** the same event id is delivered twice **Then** exactly one notification is rendered and one row stored.
- **Given** a seller opens a notification **Then** it deep-links to the contact/opportunity/meeting and is marked read; the badge count decrements by exactly one.

**Notes:** consumes `lead.created`, `call.missed`, `sms.inbound`, `meeting.starting_soon`; emits `notification.dispatched`. PWA push and SMS-to-seller are explicitly out of MVP (budget < $100/month).

---

### US-9.12 · Users, roles, Aloware number verification and ownership transfer
**As an** admin, **I want** to create sellers, assign fixed roles, verify their Aloware number and move a single record between books, **so that** week-one rollout doesn't require the builder.

**Acceptance criteria**
- **Given** an admin creates a user with email + role (`seller` / `supervisor` / `admin`) **Then** the account exists with that fixed role — no self-signup, no SSO, no role builder, no custom permissions.
- **Given** an admin maps a seller to their Aloware user id and phone number **Then** the mapping shows **Not verified — leads won't route here yet** until a test call or SMS resolves back to that seller, and the seller's ping-post endpoint rejects payloads while unverified.
- **Given** an admin deactivates a seller **Then** no record is hard-deleted, their ledger rows survive, they disappear from the Today/Week/Month boards, and on the All-time board they remain with an **Inactive** chip.
- **Given** an admin transfers one record to another seller **Then** the record leaves the source book and appears in the target book immediately, an `ownership.transferred` audit row is written, and any Earnings already credited stay with the ORIGINAL seller — money does not move with the record.
- **Given** a seller or supervisor requests an admin route **Then** they receive an owner-scoped not-found (not a 403 that confirms the route exists).
- **Given** an admin changes a user's role **Then** the change is audit-logged with before/after and takes effect on that user's next request.

**Notes:** emits `user.created`, `user.role_changed`, `user.deactivated`, `aloware_map.verified`, `ownership.transferred`. Loss reasons, lead sources, the stage template and the reminder kill switch are seed rows / one env flag — there is no runtime config screen.

---

### US-9.13 · Admin ledger correction, break-glass override and the audit trail
**As an** admin, **I want** to void a bad credit with a reason and to unblock the floor if the compliance gate misfires, **so that** the public number can be fixed without touching the database and one bad lookup can't stop 50 sellers.

**Acceptance criteria**
- **Given** an admin voids a ledger row **Then** a typed reason is required (Duplicate credit / Wrong amount / Test data / Other + free text), an offsetting `entry_type = manual_adjustment` row is written, and the original row is never deleted or edited.
- **Given** an adjustment is written **Then** the affected seller's total and their leaderboard position update within 5 seconds, and the reason text is visible to that seller in **My Earnings** (US-9.9).
- **Given** an admin activates the break-glass compliance override **Then** a reason is required, the override is tenant-scoped, expires automatically after 60 minutes, is audit-logged, and a persistent banner is shown to every signed-in user while it is active: *"Compliance override is on — dials are not being pre-checked."*
- **Given** the override expires or is turned off **Then** the compliance gate returns to fail-closed with no further action, and the banner disappears for all users.
- **Given** any write in this area (credit, reversal, value correction, void/adjust, stage-flag change, role change, ownership transfer, break-glass on/off) **Then** an append-only audit row records actor, timestamp, entity and before/after, and no API path exists to update or delete an audit row.
- **Given** a non-admin attempts the void action or the override endpoint **Then** the action is unavailable in the UI and the endpoint returns owner-scoped not-found.

**Notes:** emits `earnings.adjusted`, `compliance.override_started`, `compliance.override_ended`. This is the only sanctioned way to change a number that is already public.

---

### US-9.14 · Seeded demo data and the first-run checklist
**As an** admin, **I want** a populated demo tenant and a checklist that gets a new seller productive, **so that** the product can be shown before it has customers and a seller's first session doesn't start on six empty screens.

**Acceptance criteria**
- **Given** the demo seed is run **Then** it creates a tenant with 3 sellers, ~40 contacts spread across every stage, ~15 credited opportunities dated so that Today, This week, This month and All time are each non-empty, timelines containing calls / SMS / notes, 2 no-shows, and 1 reversal — so the board, the periods and the ledger view all demo without manual setup.
- **Given** the seed is run twice **Then** it is idempotent: seller totals and ledger row counts are identical after the second run.
- **Given** the environment is production **Then** the demo seed refuses to run (env flag), and any demo tenant is labeled **Demo** in the app shell.
- **Given** a brand-new seller signs in **Then** the home screen shows a 4-item first-run checklist: (1) verify your Aloware number with a test call, (2) set up your stages and pick which count as Earnings, (3) import your book, (4) turn on desktop alerts.
- **Given** the seller completes an underlying condition (e.g., the Aloware map is verified) **Then** that checklist item checks off automatically without a manual "mark done" click.
- **Given** all 4 items are complete **Then** the checklist collapses and does not reappear on subsequent sign-ins.

**Notes:** consumes `aloware_map.verified`, `stage_config.changed`, `contact.created`, `notification.permission_granted`. The checklist is the onboarding runbook's on-screen half; CSV import ships as a script plus runbook, not a wizard.
