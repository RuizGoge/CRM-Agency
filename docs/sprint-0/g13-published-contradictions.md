# G13 · The contradictions, published before anyone builds on them

> **Assert (gate ladder §9 G13):** one table of numbers; one status-code matrix; the calling-window hard block with no surviving attestation path; speed-to-lead with one stop point; `call.initiated` emitted before confirmation; `ARR-EVT-24` restated per channel; the nine Amendment-1 events; `contact.owner_changed` excluded from the ledger input set; `last_activity_at` under a deterministic `GREATEST()`; `integration.mapping_verified` as the canonical mapping event name; and §4 of `03-mvp-definition.md` marked a narrative appendix.
>
> **Fail:** a contradiction that reaches CI becomes a red build that someone "fixes" by weakening the assertion — which is how a gate silently becomes a comment.

**This document is the single authority for the eleven items below.** Where it disagrees with any Phase 2–4 document, it wins; where it disagrees with errata E1–E9, the errata win. Status: **published 2026-08-01**, with two values deliberately unset pending G11.

---

## 1 · The one table of numbers

Every number the build enforces, in one place. The right-hand column exists because each of these was published more than once, at more than one value.

| Metric | **Governing number** | What it displaced |
|---|---|---|
| API p95 | **< 300 ms** | `ARR-MVP-25` says ≤ 400 ms. The Phase-5 brief says < 300 ms and **all architecture arithmetic was computed against the tighter number**, so the tighter number ships. |
| Global search p95 | **< 200 ms** | — (uncontested) |
| Conditional-GET `304` p95 | **≤ 80 ms** | — (uncontested; it is the poll floor's cost, and the bulkhead's proof in G6) |
| LCP, 500-lead board | **< 1.5 s** | — |
| Interaction feedback | **< 100 ms** | — |
| Drag | **60 fps, no long task > 50 ms** | — |
| Initial JS, gzip | **NO VALUE — set by G11** | The approved 250 KB is struck by **E6**. The ratchet *name* is registered with `direction = monotonic_down` and **no value row**. A null budget **fails the build**; that failure is the only gate until G11 writes the first value. |
| TTI, `mobile-ci` profile | **NO VALUE — set by G11** | `ARR-MVP-25`'s 2.0 s and the 250 KB budget are **mutually unsatisfiable**: 250 KB gzip on Slow-4G is ~1.25 s of transfer plus ~0.9–1.2 s parse/execute at 4× CPU → ~2.4–3.0 s. Fitting 2.0 s needs ~120–150 KB. **G11 measures; the measurement sets the number, not the aspiration.** |
| Ledger write → re-rank visible on a second, non-focused client | **≈ 10.5 s** | **Five** published values for one fact — see below. |

### The re-rank number, because it was published five times

| Locator | Says | Status |
|---|---|---|
| `ARR-EVT-24` | drop-to-every-client p95 **< 2 s** | Impossible for this channel — see §6 |
| `03-dod-roadmap.md` §85 | **≤ 3 s** to a connected client | **Struck** |
| `04-ux-flows.md` §76 | **< 5 s** from ledger write to a second client | **Struck** (already recorded in §0.4) |
| `03-mvp-stories.md` §571 | board re-ranks **within 5 seconds** | **Struck** |
| `04-ux-flows.md` R4.4 | **~10 seconds**, and the presenter must narrate it | **Correct all along** |

**Ruling.** The honest number is **≈ 10.5 s**: the public projection excludes ledger rows younger than `projection_reveal_delay` (5 500 ms, so an undoable win is never on a public board), and the board polls every 5 000 ms. 5.5 + 5.0 = 10.5. This is not a performance defect to be optimised away — it is the undo guarantee and the public-board guarantee, expressed in seconds. R4.4 already wrote the demo choreography for it; the other four numbers were written by people who had not done the addition.

---

## 2 · The status-code matrix

**One rule, stated once:** a record the caller does not own returns **owner-scoped not-found, byte-identical to a genuine 404 — always, including on admin-only routes.** A 403 confirms the record exists, which is a disclosure. Never return 403 for a record the caller does not own.

**The one place 403 is correct:** a caller with a *legitimate, in-scope read* who attempts a **write** they are not permitted. The row is already visible to them, so there is nothing left to disclose, and the honest refusal is the useful one.

| Situation | Code | Why |
|---|---|---|
| Seller touches another seller's record (read or write) | **404** | Existence is not disclosed |
| Seller, admin-only route | **404** | The route's existence is not disclosed either |
| Supervisor reads tenant-wide (`tenant_read`) | **200** + `book.viewed` audit row | Legitimate, and audited in the same transaction |
| **Supervisor writes** into any seller's book | **403** | `supervisor_read_only`, SQLSTATE 42501 — they can already see it |
| **Admin writes** a seller's contact, note, activity, card or call | **403** | `admin_cannot_write_seller_records` — **an admin is not a super-seller** |
| Admin uses an enumerated admin command | **200** | Only through a named `SECURITY DEFINER` function that writes its own audit row |

**The counter-intuitive half is load-bearing.** The `WITH CHECK` clause on every owner-scoped table is `tenant_id = app.current_tenant() AND owner_user_id = app.current_user_id()` **with no admin escape hatch**. Without it, an admin dragging a card into an earning stage would pass `ARR-MVP-08`'s human-only check while crediting money to a seller who did not earn it. Admin power flows only through named definer functions.

---

## 3 · The calling window is a hard block with no attestation path

**Ruling.** Outside the lead-local calling window the dial is **refused**. There is no amber warning, no checkbox, no attestation, no "I confirm this is permitted" path — the flow ends at `blocked_calling_window` and emits `compliance.send_blocked` with reason `outside_window`. The only way through is the **audited admin break-glass**, which emits `compliance.override_started` / `compliance.override_ended`.

**Why the softer design was overruled (R3.1).** The product keeps an append-only log of every dial. A product that lets a seller dial at 8:40 PM lead-local *behind a checkbox* has not built a compliance feature — it has built the plaintiff's exhibit: a permanent record proving the system knew, warned, and proceeded anyway. The attestation made the legal position **worse** than having no gate at all.

Any surviving amber-attestation text in a Phase-2/3/4 document is **struck**.

---

## 4 · Speed-to-lead has exactly one stop point

**Ruling.** The clock stops on **`call.completed` with a `connected` or `voicemail` outcome** (`R1.1`, `02b` §4b correction 2).

**Struck:** `04-ux-flows.md` master flow step 10, *"the speed-to-lead clock stops on dial initiation."* Dialling is not reaching. A stop-on-dial clock reports a number the agency then optimises against, and the thing it rewards — pressing the button — is not the thing that sells.

**Also struck:** `speed_to_lead.stopped` as an event name. First-touch latency is a **field on the opportunity**, computed from `call.completed`. It is a derived value, not a business fact, and the 49-name catalog does not carry it.

---

## 5 · `call.initiated` is emitted before confirmation

**Ruling.** `call.initiated` is emitted **before** the provider confirms, inside the committing transaction: `BEGIN · INSERT call(state=initiated, aloware_call_id=NULL, gate_verdict, correlation_id) · app.event_emit(call.initiated) · COMMIT`. The Aloware dial is an **outbox row dispatched after commit**; `call.aloware_call_id` is nullable at insert.

**Struck:** `04-ux-flows.md` Flow 5 **D1**, *"`call.initiated` is emitted only on a 2xx from Aloware"* (superseded by `02b` §4b correction 1 and `ARR-EVT-18`).

Three consequences that are easy to get wrong and are therefore stated here:

- **P3.2** — the dial POST happens **after `COMMIT`** and outside any database transaction. The provider call holds a socket, never a Postgres connection.
- **P3.3** — `comms.aloware_dial` **does not exist** as a registry consumer. No row binds `call.initiated` to a dial-dispatching consumer, and **CI asserts that absence by name.**
- A `call.initiated` arriving *after* `call.completed` cannot regress the call: `call.state_ordinal` is guarded by a `BEFORE UPDATE` trigger that raises on regression, and field merges are `COALESCE(NEW.x, OLD.x)`.

---

## 6 · `ARR-EVT-24` restated per channel

`ARR-EVT-24` published one budget — **p95 < 2 s, drop to every client** — across every realtime surface. It is unsatisfiable for the surface that matters most, and it was never restated anywhere, which is how the one budget no transport can meet became the one budget nobody wrote down.

**Ruling.** The budget is per channel, and it is a **drop-to-client** measurement — not endpoint p95. Axiom's "p95 over the 14 real endpoints" measures a different thing and does not discharge this.

| Channel | Transport | Budget | Why this number |
|---|---|---|---|
| Live call state | SSE, with the poller running underneath | **p95 < 2 s** | `ARR-EVT-24` as written; achievable because nothing delays the emission |
| Tenant banners | SSE, same | **p95 < 2 s** | Same |
| **Leaderboard re-rank** | conditional-GET poll only | **≈ 10.5 s** | 5.5 s reveal delay + 5 s poll. Structural, not a defect — see §1 |
| Everything else | conditional-GET poll | **≤ 5 s + one poll interval** | The poll never stops when push is connected: **push is a hint, the poll is the truth** |

---

## 7 · The nine Amendment-1 events

The catalog is **49**. Designing the six end-to-end flows surfaced eleven names in use that were not on the list; nine were promoted, the rest rejected as derived or redundant. All nine carry the mandatory envelope (`event_id`, `tenant_id`, `owner_user_id`, `actor`, `occurred_at`/`recorded_at`, `schema_version`, `source_system`, `correlation_id`) and idempotency by natural key.

| Event | Emitter | Why it must exist |
|---|---|---|
| `lead.reposted` | Lead Intake | Without it a vendor re-post is invisible and duplicate rate cannot be measured |
| `compliance.send_blocked` | Compliance gate | **The number that proves the gate works** — refusals, not just sends and failures. Carries channel + reason (`outside_window`, `no_consent`, `stop`, `dnc`, `10dlc_pending`, `bad_number`) |
| `compliance.override_started` | Administration | Legally load-bearing: who opened the door, and when |
| `compliance.override_ended` | Administration | Duration is what an auditor asks for |
| `appointment.starting_soon` | Calendar (scheduler) | T-15m; the trigger both flows and stories assumed existed |
| `opportunity.gate_blocked` | Pipeline | Proves the 12× premium guard is firing rather than being bypassed |
| `contact.owner_changed` | Administration | Ownership moves leads **and** money between books; it cannot be silent — see §8 |
| `contact.bad_number_flagged` | Contacts 360 | Drives dial suppression and vendor data-quality reporting |
| `integration.mapping_verified` | Administration | The rollout guard — see §10 |

**Rejected, with reason:** `speed_to_lead.stopped` (derived → §4) · `earnings.credited`/`.reversed`/`.adjusted` (redundant — `earnings.updated` already carries a signed delta plus the triggering event; three names for one fact re-creates the drift the catalog prevents) · `notification.dispatched` (no MVP consumer) · `book.viewed`/`touch.recorded` (surveillance with no payoff; and a projection) · `conversation.needs_reply` (derived from `message.received`) · `meeting.outcome_recorded` (remapped to `appointment.completed`/`appointment.no_showed`).

---

## 8 · `contact.owner_changed` is excluded from the ledger input set

`contact.owner_changed` and `contact.merged` are one keystroke apart in the registry, and **one of them is a public-money mutation.** A payload literal `money_moved = false` plus a per-pair test is a good declaration and a line someone deletes.

**Ruling — the negative form lives in the ledger's own `CHECK`:**

```sql
ALTER TABLE app.earnings_ledger
  ADD CONSTRAINT ledger_source_is_a_declared_input CHECK (
        entry_type = 'manual_adjustment'
     OR source_event_name IN ('opportunity.won','opportunity.value_changed',
                              'opportunity.reopened','contact.merged'));
```

**A ledger row sourced from `contact.owner_changed` cannot be committed.** Adding a name is `ALTER TABLE` — a migration and a deploy gate, not a test edit. This is `ARR-MVP-22` and `US-9.12` (*"money does not move with the record"*) as an engine fact.

**And the positive form is a frozen ratchet.** `SELECT event_name FROM ref.event_consumer WHERE consumer_name = 'earnings.ledger'` must equal exactly `{opportunity.won, opportunity.value_changed, opportunity.reopened, contact.merged}`, stored as `events.ledger_input_set` in `ref.ci_ratchet` with `direction = 'frozen_set'`. Additions need a migration; **removals are refused by the trigger** — which is the direction that matters, because the real failure is a refactor quietly dropping `opportunity.value_changed` and silently corrupting the all-time board.

---

## 9 · `last_activity_at` under a deterministic `GREATEST()`

Five surfaces wanted to write `last_activity_at`: `call.completed`, `sms.received`/`sms.sent`, `email.sent`/`email.received`, `meeting.completed`, `activity.completed`, `note.created`. Five writers with last-write-wins semantics on a field fed by **out-of-order webhook delivery** produces a value that moves backwards.

**Ruling.** `last_activity_at` has **one writer** and the update is `GREATEST(old, new)` — monotonic, never last-write-wins. An Aloware webhook arriving 40 seconds late threads correctly by `occurred_at` and **cannot pull the field backwards**. This is the same principle as `call.state_ordinal`'s regression trigger, applied to a timestamp.

This is also why `touch.recorded` was rejected as an event: it is this projection wearing an event's name.

**Consequence.** The cold-episode key is stable, so `opportunity.went_cold` is idempotent per cold **episode** rather than per opportunity — the difference between a badge and a notification firehose.

---

## 10 · `integration.mapping_verified` is the canonical name

**Ruling.** The event emitted when a test call or SMS confirms an Aloware number resolves to the intended seller is **`integration.mapping_verified`**. Any other spelling in any document is not a synonym; it is a name outside the 49 and therefore a bug.

It is the rollout guard: **an unverified map silently routes leads into the wrong book** — the failure has no error, no warning, and no symptom until a seller notices leads they never worked. Acceptance surface `US-601`: an unverified mapping accepts **neither dial nor webhook**, and one E.164 maps to exactly one seller.

---

## 11 · §4 of `03-mvp-definition.md` is a narrative appendix

**Ruling.** Section 4 of `03-mvp-definition.md` is **narrative, not requirements.** It is marked as such so nobody mines it for scope. Requirements live in `03-mvp-stories.md` (the 43 Given/When/Then stories) and in the ARR identifiers; §4 describes and motivates them.

The concrete instance this prevents: §4's cadence-engine narrative reads as a commitment to `sequence.*` and `automation.executed`, which are **`deferred_v1_1`** in `ref.event_schema` — there is no cadence engine in the MVP, and the architecture registers `sequence_enroll` as `probe_only`. Mining §4 as requirements re-imports a cut feature through the back door.

---

## What G13 leaves open

**Two values, deliberately.** The initial-JS-gzip and TTI rows in §1 have no number until **G11** measures. Until then a null budget **fails the build**, and that failure is the gate. Do not write a number to make a build pass — weakening a budget to reach green is the precise failure this whole design exists to prevent (E6, R7).

When G11 returns, **one** of the two moves, and this document publishes which one and why.
