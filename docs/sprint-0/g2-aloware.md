# G2 · Aloware, against the real account

> **Status: 🔴 OPEN. Not one of the eleven assertions is answered.** What exists as of 2026-08-05 is the *apparatus* — two instruments, both executed against themselves and proven to detect what they claim to detect, plus the durable evidence table errata **E9** specifies, applied to a database and proven by mutation. No provider traffic has been observed, because the account credentials, the panel session and the public receiver URL are all still pending.
>
> This file is the destination for the findings. It is written first, in red, so that the gap between "we built the measuring device" and "we measured something" cannot be quietly crossed.

## 🚨 The account is scheduled for suspension on 2026-08-15

Read off the panel on 2026-08-05, in Aloware's own banner:

> *"It looks like we did not receive a payment for your most recent invoice … otherwise your Aloware account will be suspended on 08/15/2026."*

**This gate runs against that account.** If it suspends, G2 is not "pending" — it is **impossible to run**, and with it module 9, four DEMO assertions, the board's `blocked` health state, the recent-contact signal and every compliance gate stay blocked by an invoice rather than by a technical limit. The window is ten days *minus* what the measurement itself needs: the retry/backoff probe may require hours of observation, and the disposition vocabulary needs several calls driven deliberately to answered / no-answer / busy / voicemail.

Compounding it, the Two-Legged Call tab carries Aloware's own notice: *"Two-Legged Call API usage is considered **automated & paid**. You are agreeing to our billing terms by using the API."* Every dial this spike places is billable against an account already in arrears.

⚠️ **The word `automated` is flagged for a second reason and no conclusion is drawn here.** In a US TCPA context, whether a dialer is an automated telephone dialing system carries legal weight, and this is the provider classifying its own two-legged path that way for billing purposes. It is an owner question, not an architecture question.

*Nothing in this repository touches the payment flow.*

---

## Precedence, read before anything below

Three pieces of text in the corpus point somewhere this gate must not follow.

| Stale text | Where | What actually governs |
|---|---|---|
| `ref.capability_probe` with `raw_payload_id uuid NOT NULL` and a boot assertion comparing the digest against `raw_payload_vault.body_sha256` | `05c-closure-register.md` §7.7.6 | **Errata E9** (rank 1). The probe carries its **own** `response_body bytea NOT NULL`, **drops `raw_payload_id` entirely**, and the digest is compared against `sha256(response_body)` **in the same row**. The vault purges by partition drop on a 30–90 day window; the struck design would have made production exit non-zero on every start one to three months after this spike, while development and CI stayed green the entire interval. |
| *"…is a **Puerta 7** measurement"* — the synchronous-response question and the delivery guarantees | `05-architecture.md` §784, §1751, §2073 | §9's ladder **consolidated** `thesis.md` Puertas 0–12 with `verdict-v1.md` Puertas 1–12. Aloware is **G2** there. Reading the old number is how somebody concludes this gate is closed, or looks for it after G6. |
| *"Gate 11 of the Sprint-0 ladder establishes whether webhooks are signed"* | `.env.example` (**fixed 2026-08-05**) | Gate 11 is bundle and first paint, closed 2026-08-03 with P20 measured at 2251 ms. Nothing about Aloware was ever in it. |

E9 also imposes a rule on how this spike is **run**, not merely on what it stores: **probes are captured against synthetic subjects only, never a real consumer.** The probe row is never purged, so a real lead's number captured here would acquire a permanent clock — precisely the CCPA minimisation the vault's short window exists to provide.

---

## Verdict by assertion

G2 asserts eleven things. Every one is open.

| | Assertion | Status | How it gets answered | Blocked on |
|---|---|---|---|---|
| **a** | Two-legged dial, end to end | 🟢 **CLOSED — IT WORKS.** `202` in 882 ms, agent leg answered in Talk, lead leg bridged, **63 s talk time**, recording produced | Probe `019fd3b8-a866-796d-955a-af7e4b7cf429` in `ref.capability_probe` | — |
| **b** | Are webhooks **signed**, and with what scheme | 🟢 **CLOSED — NO SIGNATURE.** Confirmed on the wire: six headers, none of them a signature, timestamp or nonce | Every header captured **verbatim, in order, with duplicates preserved**, then read | — |
| **c** | Do they **retry**, and with what backoff | 🚨 **CLOSED — THEY DO NOT.** Six deliveries answered `500` across two event families and 3+ hours; none redelivered. There is no backoff because there is no retry | The receiver's `status` arm returns 500; repeat deliveries of the same `body_sha256` are diffed by monotonic arrival time | — |
| **d** | Duplicate and out-of-order delivery observed | 🟡 **Neither observed in 17 captures.** No `body_sha256` and no `(event, id)` pair ever repeated, and arrival order matched provider order throughout. Consistent with (c): retries are the usual source of both | Same capture. Duplicates are equal `body_sha256`; disorder is provider timestamp order vs. `seq` order | more volume would strengthen it |
| **e** | The **real** disposition vocabulary | 🟡 **Half closed** — the 11 configured names are read (below); what a webhook actually *carries* is still unobserved | The literal strings in captured bodies, from calls deliberately driven to answered / no-answer / busy / voicemail / rejected | a real dial |
| **f** | Missed-call events | 🟢 **CLOSED — `InboundPhoneCall-DispositionMissed`.** A disposition on the inbound family, not a separate event type — which is exactly what §4.3 already rules | Placed and not answered; observed on the wire | — |
| **g** | Does the recording announcement fire on the two-legged path | 🚨 **CLOSED — NOT ON TWO-LEGGED.** The announcement **exists and plays on inbound** (*"la llamada va a ser grabada"*), and does **not** play on the outbound two-legged path. Recording is `Always Record` both directions, retention `Indefinite`. Failure criterion met — but the remedy is likely configuration, not disabling recording | Recording played back for outbound; live inbound call for the contrast | whether an outbound announcement is configurable |
| **h** | The actual **10DLC** status | 🟢 **CLOSED** — Business Registration, A2P Brand and A2P Campaigns all **Approved**, under the agency's own entity | Read off the panel. Not inferable from the API | — |
| **i** | The **burst shape** (OQ-2) | 🟡 **The multiplier is MEASURED: 6 webhooks per completed call, 2 per failed call.** The daily figure is now arithmetic over the agency's real call volume rather than a Phase-0 guess | Measured as a per-call **fan-out multiplier**, not as a day of traffic | the agency's calls/day |
| **j** | Existence of a **call-list API** for ARR-INT-08 | 🔴 **Not documented and not discoverable** — see below. The compensating control applies | A declared `GET`; a 2xx is `verified`, a 404 from a **sourced** path is `absent` | provider support could still confirm |
| **k** | Does the provider require a **synchronous response below ~1 s** | 🟢 **CLOSED — NO.** A delivery was held **110 023 ms** and Aloware **never hung up** (`client_aborted: false`), then accepted the 204. At least 110 s of tolerance; the admission bound does not move | The receiver's `delay` arm held the response until our own ceiling | — |

**Assertion (i) is reframed, and this is a correction to the gate's own wording.** OQ-2's *10 000–20 000 webhooks/day* has been an assumption since Phase 0, and a spike cannot observe a day of real traffic on an account with no sellers on it. What a spike **can** measure exactly is the **fan-out**: how many webhooks one call produces, and their inter-arrival spacing. The daily figure is then that multiplier times the agency's real call volume — arithmetic over a measured number instead of a number nobody measured. Stating this now, rather than later reporting a modelled figure as if it had been observed.

---

## What is built, and what each piece actually guarantees

### The receiver — `scripts/spike/aloware-receiver.ts`

A disposable instrument, **not** the ingest process. It never parses: bodies are stored as raw bytes plus a sha256, because the payload's shape is one of the things being learned. It captures **every** path except `/_spike/*`, so a webhook configured against a path nobody anticipated is evidence rather than a 404 in someone's log.

Four arms drive the measurements: `ok` (204), `status` (an arbitrary code — the retry probe), `delay` (hold N ms — the synchronous-response probe), `hang`.

**Self-test, executed 2026-08-05.** Four synthetic deliveries:

```
seq=1 arm=ok     resp=204  lat=1ms     aborted=false  sha=faf180511ef1
seq=2 arm=status resp=500  lat=0ms     aborted=false  sha=29a93ef45314
seq=3 arm=ok     resp=204  lat=0ms     aborted=false  sha=29a93ef45314
seq=4 arm=delay  resp=null lat=1003ms  aborted=true   sha=5db3396d8997
```

- `seq=4` is the one that matters: the client gave up at **1003 ms** while the receiver was still holding, and that is recorded as `client_aborted: true` with `response_status: null`. **Assertion (k)'s answer will have exactly this shape.**
- `seq=2` and `seq=3` carry the **same digest** — the mechanical form of "this is the same delivery twice", which is how (d) is answered.
- Headers survive verbatim and in order, including a duplicate-capable flat pair array: `["Host","…","User-Agent","curl/7.82.0","content-type","application/json","x-fake-signature","sha256=deadbeef",…]`. A normalised header object would have destroyed exactly the evidence assertion (b) needs.

**A capture hole found by re-reading and closed:** the abort handler was originally registered inside the body-complete handler, so a client that hung up **mid-body** would have left no trace at all. It is now registered before the body is read, with a single-write guard so no delivery is ever recorded twice — a double-written capture would read as a duplicate delivery and corrupt the very question the instrument answers.

**It refuses to start without `SPIKE_CONTROL_SECRET` (≥16 chars).** The control plane can make the endpoint return 500 or hang; on a public URL that is not a debug toggle, it decides what the gate observes.

### The prober — `scripts/spike/aloware-probe.ts` + `aloware-probes.json`

**Every `request` in the declaration file starts `null`, and that is the design.** This project's signature failure is implementing from superseded text; the version of it that applies here is probing a **remembered** vendor endpoint. An invented path returns a 404 that is *indistinguishable from the capability being absent* — and `absent` on an `mvp_required` row is the finding that stops the MVP.

Three refusals, all proven by mutation:

| Refusal | Proven by |
|---|---|
| **SPIKE010** — a probe with no `source` (where the path was read on the real account) does not run | Gave `two_legged_call` an invented path and no source → `✖ SPIKE010: no source`, **exit 1**. Adding a source made the same probe actually attempt the request. |
| **SPIKE011** — nothing declared, nothing runs | Current state of the file: `declared 7 · with request 0 · ready to run 0`, exit 1 |
| **SPIKE012** — the prober **never** writes `ref.provider_capability` | By construction. Promotion to `verified` is a migration citing probe ids |

A **transport failure is never written as a probe.** `absent` must mean the provider answered and said no — not that our DNS blinked. Verified in the same mutation run: a sourced probe against an unreachable host logged `TypeError: fetch failed (NOT written as a probe)`.

The bearer token travels in a header, is never stored and never printed; secret-bearing query parameters are redacted before the URL reaches a row that outlives every retention window in the system.

### The evidence table — migration `0029_provider_capability_probe`

**Applied and proven, not merely written.** The full chain `0000 → 0029` applies clean to a **brand-new database** (dev volume dropped and rebuilt), and `tests/integration/capability-probe.test.ts` adds **15 assertions** against the engine — inside `npm run verify`, therefore inside the pre-commit hook. Suite: **243 → 258**.

🎯 **Three mutations, each red on exactly one test and on nothing else:**

| Mutation | Result |
|---|---|
| Disable the `CAP002` trigger arm (`IF false THEN`) | 🔴 `CAP002 · refuses a probe captured for a DIFFERENT capability` |
| Delete the `capability_probe_digest_matches` CHECK — E9's central property | 🔴 `refuses a digest that does not match the body it sits next to` |
| Flip the registry row to `immutable = false` | 🔴 `is append-only to the OWNER, not merely to the app role` |

The suite also asserts the **happy path is reachable** — a well-formed verification is accepted. A gate that only ever denies is a gate nobody can tell apart from a broken one.

And the first assertion in the file is structural rather than behavioural: `capability_probe` **has** `response_body` and **does not have** `raw_payload_id`. It exists because `05c` §7.7.6 still carries the struck DDL, and a test is the only thing that can notice a document being followed.

E9 implemented. `ref.capability_probe` carries its own `response_body`, its own digest, no `raw_payload_id`.

- `CHECK (response_digest = sha256(response_body))` — E9's in-row comparison as an **engine refusal at INSERT**, not a boot check months later.
- `CHECK (length(response_body) > 0 OR http_status IN (204, 304))` — the carve-out is by status and nothing else. Without it a provider answering `204 No Content` could not be recorded at all, and a prober that cannot store what it received is a prober under pressure to invent something it can. An empty body under a `200` stays refused.
- Trigger `t_capability_needs_proof` with four refusals: **CAP001** no probe · **CAP002** the probe is for a *different capability* · **CAP003** the probe is not 2xx · **CAP004** `verified_at` ≠ the probe's `observed_at`. §7.7.6 specifies two of these; **CAP002 is added here**, because `capability_verified_needs_probe` proves a probe is *attached* and cannot prove it is the *right* one — `two_legged_call` verified against the `contact_lookup` probe passes every constraint in the file.
- Classified `reference` + `immutable`, so `harden()` grants `crm_app` **SELECT and nothing else** and installs the statement-level immutability trigger that binds the owner and a superuser too.

⚠️ **What this is NOT, said rather than implied: it is not unforgeable.** Anyone who can write the table can invent a body and store `sha256()` of their invention beside it. What the digest buys is that fabricating a verification now costs a fabricated *document* instead of the word `'spike'` in a free-text column — which is the specific failure §7.7.6 names. The property carrying real weight is upstream of the hash: **no application code path can mint a probe**, because the `reference` class grants the app role no write at all.

---

## The failure criteria, restated

Already written, and repeated here so nobody has to go find them:

- **`two_legged_call` or `webhook_subscription` absent** → the MVP is not shippable and this **escalates immediately**.
- **Call-list absent** → ARR-INT-08 has no implementation. Record the compensating control and make `admin_alert(kind='reconciliation_unavailable')` permanent and un-acknowledgeable.
- **Recording announcement does not fire on the two-legged path** → disable recording at the **account** level for the MVP (ARR-CMP-10 / D9). **That is a legal risk acceptance and it is Jorge's, not the architecture's.** CA, FL, PA, IL, WA and MA require all-party consent.

---

## Blocked on

| # | Needed | Why the gate cannot move without it |
|---|---|---|
| 1 | `ALOWARE_API_BASE` + `ALOWARE_API_TOKEN` in `.env` | Nothing outbound runs. (a), (e), (j) and the whole probe table stay empty |
| 2 | Panel session | The **only** source for (h) 10DLC, for whether recording is on at all, for how webhooks are subscribed, and for the API reference that fills `source` in the declaration file |
| 3 | A public receiver URL | (b), (c), (d), (i), (k) are all inbound. Nothing is observable until Aloware can reach us |
| 4 | Two answerable phone numbers, both Jorge's | (a), (e), (f), (g). E9 forbids a real consumer as the subject |

~~5 · Docker Desktop~~ — **done 2026-08-05.** Migration 0029 is applied, its refusals are proven by mutation, and `npm run verify` is green end to end.

---

## First panel reading — 2026-08-05

Read off the real account (Integrations screen). **Documented on the account's own panel is stronger than vendor marketing and still weaker than a captured exchange:** every capability below stays `unknown` in `ref.provider_capability` until a probe row exists. That distinction is the entire point of E9 and it is not relaxed because the evidence got better.

### `two_legged_call` — the API exists, with a contract nobody would have guessed

```
POST https://app.aloware.io/api/v1/webhook/two-legged-call

Required:  api_token
           user_id | ring_group_id
           contact_phone_number | contact_id
           line_phone_number | line_id
Optional:  user_phone_number   (when user_id is used)
```

Three consequences, each of which changes something already written:

1. 🔴 **AUTH IS A FIELD IN THE BODY, NOT AN `Authorization: Bearer` HEADER.** The prober shipped assuming Bearer. Against this endpoint that returns a 401 — and a 401 from a *sourced* path is exactly what this gate reads as **`absent`**, on the one capability whose absence makes the MVP unshippable. **The single most consequential thing this spike has found so far is a defect in the spike's own instrument.**
2. **The path is under `/webhook/`** — an outbound API namespaced as if it were inbound. No amount of careful guessing produces that. It is the concrete vindication of SPIKE010: probes run only from a path someone *read*.
3. **`line_phone_number` / `line_id` is per call.** That answers a Phase-2 open question that had been carried unresolved: *"Does the Two-Legged Call API let each seller present their own assigned number as caller ID, or does it dial from a shared line?"* — **per-call**, so per-seller caller ID is reachable, provided the account holds more than one line. The identity map (`aloware_number_mapping`, seller ↔ Aloware user ↔ outbound E.164) is buildable as specified.

The declaration in `aloware-probes.json` now carries this contract with its source. It still refuses to run: `RING_GROUP_ID`, `LINE_E164` and `DESTINATION_E164` are unresolved.

### ✅ FIRST REAL EXCHANGES CAPTURED — the E9 mechanism works end to end

Four probes against the live account, all read-only, all free, no phone rang.

**`contact_lookup` — `GET /api/v1/webhook/contact/phone-number`**, token in the **query string** (a *third* auth placement: the body for two-legged, the query here — there is no single scheme, which is the concrete vindication of SPIKE010 a second time).

Subject: `2025550100`, from the North American reserved fictional range (555-0100..0199). Guaranteed not to belong to a person and guaranteed not to be in the account's contacts — which is what makes it a lawful subject for a row **E9 never purges**.

The stored row, read back from `ref.capability_probe`:

```
capability     | contact_lookup
http_status    | 404
request_url    | …/contact/phone-number?api_token=%5BREDACTED%5D&phone_number=2025550100
body           | {"error":"Contact not found."}
digest_ok      | t
probe_run      | g2-token-smoketest
```

- **The token did not reach the permanent row** — `api_token=[REDACTED]`. That redaction was written *before* this endpoint was known to exist, and this is the exact case it protects: `request_url` outlives every retention window in the system.
- **The digest CHECK held against a real provider body.**
- **The token is valid.** A 404 in the documented shape proves authentication was accepted; a bad token answers 401/403.
- ⚠️ **A 404 here is NOT evidence of `absent`.** The endpoint answered in its own documented form. `contact_lookup` stays `unknown`, and the reason it cannot yet be `verified` is worth stating: **CAP003 requires a 2xx, and a 2xx here would mean a real consumer's record written into a row that is never purged.** Verifying this capability lawfully needs a synthetic contact that does not exist yet, and creating one is an account change — the owner's call, not the architecture's.

### ⚠️ A LATENCY FLOOR THAT PUTS **N10** IN DOUBT

| Run | Round trip |
|---|---|
| 1 | 1 447 ms |
| 2 | 1 506 ms |
| 3 | 1 388 ms |
| 4 | 1 278 ms |

**A trivial contact lookup costs 1.3–1.5 s, consistently.** Four consecutive calls with a 228 ms spread is not handshake noise.

N10 rules `POST /api/calls` total (gate + dial ack) at **p95 ≤ 300 ms + a G2-measured Aloware ack**, and P3 put the dial back **inside** the request. If the provider's floor from any client is seconds rather than milliseconds, that budget cannot hold as written, and `ARR-MVP-26`'s 10 s client-visible timeout stops being generous headroom.

**Two things this measurement is NOT, said before anyone quotes it:**

1. **It is not the dial.** The two-legged endpoint returns `202` on establishment, not on answer, so it may be much faster. Unknown until measured.
2. 🔴 **It was measured from Chile, not from the production region — and that is now evidence, not a hunch.** The tunnel's own `Cf-IPCountry` header reads **`CL`**. G0 fixed production in **Ohio or Virginia**, i.e. the same country as Aloware's infrastructure, so most of this 1.3–1.5 s is very plausibly intercontinental round trip that production will not pay. This is a **ceiling and an alarm, not the production number** — the same machine-dependence caveat P20 carries, on a number nobody had thought to attach it to. **The number that decides N10 must be measured from a US-region host.**

### The receiver is live behind a public URL

`cloudflared` was already installed, so nothing was downloaded. Chain verified end to end — public URL → tunnel → receiver → evidence file — with a 204 in 117 ms and the body captured verbatim.

⚠️ **A methodological trap this immediately created, recorded before it can bite the signature analysis.** The tunnel injects headers of its own:

```
Cdn-Loop · Cf-Connecting-Ip · Cf-Ew-Via · Cf-Ipcountry · Cf-Ray
Cf-Visitor · Cf-Warp-Tag-Id · Cf-Worker · X-Forwarded-For · X-Forwarded-Proto
```

**None of these are Aloware's.** Assertion (b) is answered by reading the headers on a delivery, and a `Cf-*` or `X-Forwarded-*` name read as a provider header would corrupt exactly that answer. The capture stores every header verbatim on purpose; the **exclusion happens at analysis time and is written down here so it is not rediscovered later.**

### 🔴 (j) `call_list` — not documented, not discoverable, and the probe that looked for it found a hole in this gate instead

**Not documented:** absent from all 14 Integrations tabs and all 22 Account items, both read end to end.

**Not discoverable:** four plausible paths were probed blind — `/api/v1/webhook/calls`, `/api/v1/calls`, `/api/v1/webhook/call`, `/api/v1/communications`. **Every one returned `HTTP 200`.** And every one returned `<!DOCTYPE html>` — the single-page app's catch-all, which serves its shell for any unmatched route.

🔴 **THAT IS A DEFECT IN THIS GATE'S OWN MECHANISM, and it found itself.** `CAP003` only asserts the linked probe is **2xx**. An SPA catch-all is 2xx, with a non-empty body and a digest that validates against it. **A capability could have been promoted to `verified` against a web page.**

What saved it was `SPIKE012` — the prober never writes `ref.provider_capability`, and promotion is a hand-written migration citing probe ids, so a human would have seen the HTML. **The safeguard that reads as bureaucracy is the one that held.** But a guarantee resting on somebody noticing is the kind this project refuses to rest on, so:

✅ **`SPIKE015` added and mutation-tested:** a 2xx whose `content-type` is `text/html` is reported by name and the run **exits 1** (verified directly, not inferred from a pipeline's status). *"A 2xx carrying HTML is an SPA catch-all, NOT a working endpoint."*

⚠️ **The blind probe is deliberately NOT a declared probe.** `SPIKE010` refuses paths with no source, and a guessed path has none by definition — so this discovery ran outside the prober, with `curl`, and its result is written here rather than into `ref.capability_probe`. Recording a guess as evidence is exactly what that refusal exists to prevent.

**Verdict:** `call_list` cannot be confirmed to exist. That is **not** the same as proven absent — the two-legged page ends with *"If you need more API functions, please contact our support"*, so a support answer could still change it. Under G2's own criterion the consequence is already written and now applies:

> *"Call-list absent → ARR-INT-08 has no implementation; record the compensating control and the permanent alert."*

Concretely: the webhook DLQ alert threshold goes to zero-tolerance, and `admin_alert(kind='reconciliation_unavailable')` becomes permanent and un-acknowledgeable. **This does not stop the MVP** — it removes the safety net under a dropped webhook, which then silently deletes a call from history and corrupts `last_activity_at`, the 7-day cold rule and the decay rail.

### 📩 `sms_send` — the endpoint works, the message did not arrive, and the gap between those two is the finding

`POST /api/v1/webhook/sms-gateway/send` from the Test Line, `user_id: 120776`, to a colleague who had been notified in advance and whose consent the owner authorised explicitly (recorded in the probe declaration, because a consent basis that lives only in a chat log is not one).

```
HTTP 202 in 1 293 ms · {"message":"Message sent."}
```

Then, by webhook: **`OutboundSMS-DispositionInvalid`**. `current_status2: 19`, `disposition_status2: 7`. **The message was never delivered.**

🔴 **`202 {"message":"Message sent."}` MEANS ACCEPTED, NOT SENT.** The provider's own wording says "sent" and it is not true. The real outcome arrives asynchronously and can be a failure. Consequences for the design, both concrete:

- **`sms.sent` must never be emitted on the 202.** §4.3 maps SMS delivery failure to `message.delivery_failed`, and this is the shape it takes on the wire. A CRM that logs "sent" on the acknowledgement tells fifty sellers their text went out when it did not.
- **The compliance gate cannot rely on the API's acceptance as proof of anything.** Acceptance is not delivery.

✅ **Per-seller attribution works, and this is what the MCP surface cannot do.** The payload carries `user_id: 120776` **and** `owner_id: 120776` — the send is attributed to the seller, not to the company. The panel documents the three-way behaviour (`-1` = company with no owner, omitted = contact owner, an id = that user), and it holds. **The silo is buildable on the REST path.**

🔴 **THERE IS NO SEPARATE `provider_message_id`.** The SMS carries the same `id` field as calls (`941089133`) — Aloware has **one id space for all "communications"**. §4.4's ladder lists a call rung keyed on `aloware_call_id` and a message rung keyed on `provider_message_id`; on this provider they are **the same column**. Simpler than the design assumed, and worth writing down before someone builds two.

🔴 **`text_authorized = 0` on the contact, and the API sent anyway.** Aloware carries the flag and does **not** enforce it on the REST path. That is the empirical case for `24` — the pre-send compliance gate has to be **ours** and server-side, because the provider's flag is data, not a control. It also means an integration that trusted Aloware to refuse unauthorised texts would be trusting nothing at all.

⚠️ **Why the delivery failed is not established.** The contact shows `lrn_type: 1`, which commonly denotes a landline, and an SMS to a landline is invalid — but `text_authorized: 0` is an equally available explanation and the payload names neither. Aloware's **Number Lookup (LRN) API** exists to answer exactly this and would settle it. Recorded as unresolved rather than guessed, because the two explanations lead to different product behaviour: one is "check line type before offering SMS", the other is "the provider refuses unauthorised sends after all".

**Fan-out for a failed SMS: 1 webhook.** No contact was created — the destination already existed, so the silent-contact-creation hazard flagged on the MCP surface remains untested on the REST path.

### 🟢 (k) THE QUESTION NOBODY ASKED — answered, and the answer is "no deadline worth the name"

G2 singles this one out: *"and the question no candidate asked: does the provider require a synchronous response below ~1 s, because that number decides whether write-first/respond-fast is comfortable or tight."*

The receiver was armed to accept a real inbound delivery and **simply not answer it**.

```
seq 18 · InboundPhoneCall · held for 110 023 ms
client_aborted: false        ← Aloware never hung up
response_status: 204         ← accepted when we finally answered, after 1 min 50 s
```

**Aloware waited one minute and fifty seconds without giving up.** §4.2's ruling 5 framed the two outcomes: *"if Aloware demands sub-second and our edge p99 is 40 ms, write-first is comfortable; if it demands sub-100 ms, the ingest role's admission bound moves."* Neither applies — the provider imposes no deadline in any range that constrains the design. **The admission bound does not move.**

⚠️ *110 s is **our** ceiling, not their limit — the receiver's own `HANG_CEILING_MS`. The finding is a lower bound: "at least 110 s", not an exact timeout.*

### 🔗 The two delivery findings combine into a rule that inverts the usual instinct

Read together, (c) and (k) say something neither says alone:

> **No retry, ever — and a response deadline of at least 110 seconds.**

One shot per event, with an enormous window to take it. The correct posture at the ingest edge is therefore the opposite of the reflex:

- **Never fail fast.** A `500` returned in 2 ms is permanent data loss; there is no retry and no call-list to reconcile from.
- **Being slow is nearly free.** Taking five seconds to make the bytes durable costs nothing the provider objects to.
- So when the edge is under pressure, the right behaviour is **queue, block, and take the time** — never shed load, never return non-2xx, never rate-limit. `ADR-SEC-06` already said *"webhooks are admitted, not rate-limited"* on the reasoning that limiting converts a burst into a longer retried burst. That reasoning turns out to be **too generous to the provider**: there is no retried burst to worry about, because a refused delivery simply never comes back. The ruling is right; its justification is now stronger than the one written for it.

### ✅ (f) Missed-call events exist

The same call produced **`InboundPhoneCall-DispositionMissed`** — a distinct disposition on the inbound event family, not a separate event type. That maps onto §4.3's row, which already rules that a missed inbound is *"not a separate event — `call.completed` with `direction=inbound`, `disposition_canonical=missed`"*. **The provider's shape and the canonical model agree.**

Note the contrast with the earlier inbound call, which the AloAi agent answered (`talk_time: 17`): whether an inbound is *missed* depends on whether the AI picks up first. The AI is between every inbound lead and the missed-call state.

### 🚨 (c) ALOWARE DOES NOT RETRY — and this is the worst finding in the gate

The receiver was armed to answer **`HTTP 500` to everything** and left that way. Three real provider deliveries hit it:

| Delivery | Arrived | We answered | Redelivered? |
|---|---|---|---|
| `OutboundAppointment` id 940968066 | 22:40:58Z | **500** | ❌ never |
| `OutboundAppointment` id 941049357 | 23:55:32Z | **500** | ❌ never |
| `OutboundAppointment` id 941081975 | 01:53:26Z | **500** | ❌ never |

**Over a window of more than three hours: no body arrived twice, and no `(event, id)` pair arrived twice.** Three independent events, each explicitly rejected with a server error, none ever redelivered.

`ARR-INT-02` instructed the architecture to *"assume at-least-once, out-of-order, possibly unsigned delivery until the Sprint-0 spike says otherwise."* **The spike says otherwise, and the truth is the opposite of the assumption in the direction that hurts.** Assembled with everything else measured here:

> **no signature · no event id · no retry · no call-list API**

That is **at-most-once delivery with no recovery path of any kind.** A webhook lost because our ingest was down for thirty seconds is lost permanently: the provider will not resend it, and there is no list endpoint to reconcile against.

**What this does to the design, concretely:**

- **`ARR-INT-07`'s "nothing is ever discarded" now has to hold at the *edge*, absolutely.** The write-first design was already right; this makes it load-bearing in a way it was not before. Any condition under which the ingest endpoint returns non-2xx — a deploy, a restart, a full disk, a saturated event loop — is **permanent data loss**, not a delay.
- **The DLQ stops being a safety net and becomes an autopsy.** It can only hold what we already received. There is nothing to replay from the provider's side.
- **The compensating control recorded for (j) is no longer a mitigation of a missing convenience — it is the only control there is.** Zero-tolerance DLQ alerting and a permanent `reconciliation_unavailable` admin row are the entire recovery strategy.
- **Ingest availability becomes a correctness property, not a performance one.** That argues for the ingest bulkhead being real (its own process, Escalón 2) sooner rather than later, and against ever folding it behind something that can be slow.

**The one caveat this had is now gone.** The three above were `OutboundAppointment` events, leaving open whether *call* events retry under a different policy. A real inbound call was then placed with the same 500 arm still active, producing three more rejected deliveries — `InboundPhoneCall`, `InboundPhoneCall-DispositionCompleted`, `Recording-Saved`, all id `941083416`. **None was redelivered either.**

**Six deliveries rejected with `HTTP 500`, across two event families and a window of more than three hours. Zero retries.**

⚠️ *"No retry observed" is not mathematically "no retry ever" — but a redelivery arriving hours after a merge has already run would be useless anyway, so the practical conclusion does not move.*

### ⚠️ The `Skip lines` filter does not isolate what it appears to

All three of those deliveries were **real production appointment events**, not test traffic. The subscription was filtered with `Skip lines → Local Presence` on the belief that this confined it to the Test Line.

It does not. **An appointment has no line**, so a line-based exclusion cannot apply to it, and it arrives anyway — via `communication.disposed`, because in Aloware's model an appointment is a *communication* like a call or a text.

Two consequences, and the first is the one that matters: **production data reached the spike receiver despite a filter I had described as sufficient.** The claim was wrong when it was made, and it is corrected here rather than left standing. Second, for the product: **a line filter cannot be relied on to scope a webhook subscription** — anything that is a "communication" without a line escapes it.

### ✅ The dial fails FAST and says why — `422` when no agent is available

With Talk closed, the same request that had returned `202` twice returned:

```
HTTP 422 in 2 187 ms
{"errors":{"user":["Oops! Looks like we can not find any available inbox users. Please try again later."]}}
```

**`two_legged_call` validates agent availability synchronously and refuses.** No call is created and no webhooks are emitted.

This is good news for the design and it resolves an ambiguity in it. `ARR-INT-03` requires a synchronous return within budget or a fall into degraded mode, and `ARR-MVP-26` gives the client-visible timeout 10 s before opening a pre-filled Log-a-call form. The provider supplies a **clean, immediate, specific** failure branch: a seller whose app is not connected gets *"no available inbox users"* in ~2 s rather than a call that dies silently after 30 s. The pipeline's Call-now surface can name the actual cause.

It also reinterprets the first dial: that one returned `202` and then failed after 30 s, so availability is **dynamic** — an inbox user existed at request time and never picked up. Two distinct failure modes, two distinct responses, and only one of them is discoverable before the call exists.

⚠️ **And it closes the harmless path to (c) and (k).** The plan was to let a call die at the agent leg to generate webhooks without ringing anyone. With no agent, **no call is created at all**, so there is nothing to deliver. Webhooks require a real communication.

**The replacement costs one phone call and it is the owner's own:** an **inbound** call from his mobile to the Test Line `+1 737 427 3994`, left unanswered. That creates a real communication — so its webhooks flow into the armed receiver and answer (c) retry/backoff and (d) ordering — **and it is simultaneously the missed-call scenario that (f) needs.** One action, three assertions, and the only phone that rings is his.

### ⚠️ `Test & Validate` does not deliver — the cheap path to (c), (d) and (k) is closed

The webhook's `…` menu offers **Edit · Test & Validate · Disable · Delete**, and `Test & Validate` looked like a way to trigger deliveries on demand and measure retry, ordering and the response deadline **without billable calls**.

It does not send one. With the receiver armed to hold a response for 60 s, the action completed and the webhook stayed `VALID & ACTIVE`, and **no request ever arrived** — checked for 75 s across two independent polls of the receiver's own counter.

**The tunnel was verified alive in the same minute**, so this is not a plumbing failure: a manual `POST` through the public URL landed and incremented the capture counter (10 → 11). `Test & Validate` re-validates the stored configuration; it does not emit an event.

**Consequence:** assertions (c) retry/backoff, (d) duplicate/out-of-order and (k) the synchronous-response deadline all require **real provider events**, i.e. real calls. The plan that follows from it:

- **One call with `status=500` armed** answers (c) *and* (d) at once — a completed call produces 6 webhooks, so failing the first and watching for its redelivery gives both the backoff schedule and any reordering against the five that follow.
- **One call with `delay` armed at a value above any plausible timeout** answers (k) exactly: the moment the provider hangs up is the deadline, recorded as `client_aborted: true` with the latency.
- **(f)** needs an *inbound* call to `+1 737 427 3994` that nobody answers in Talk.

✅ **`Disable` exists alongside `Delete`**, which resolves the owner's question about teardown: the subscription can be switched off with its configuration intact rather than destroyed and rebuilt.

### 🚨 (g) THE RECORDING ANNOUNCEMENT DOES NOT FIRE — the failure criterion is met

A second dial connected: **63 s talk time, `has_recording: true`**. The owner was on the agent leg and reports **no announcement was played**, to him or (to his knowledge) to the other party.

G2's failure criterion for this is pre-written and now applies:

> *"Recording announcement does not fire on the two-legged path → **disable recording at the Aloware account level for the MVP** (ARR-CMP-10 / D9); that is a legal risk acceptance and it is Jorge's, not the architecture's."*

🔴 **But the exposure found here is larger than the MVP, and it exists today.** Account settings read `Inbound Call Recordings: Always Record`, `Outbound Call Recordings: Always Record`, `Call records retention duration: Indefinite`. The agency dials all fifty states from a 58-number local-presence pool. **CA, FL, PA, IL, WA and MA require all-party consent.** So this is not a decision about what our MVP will do — it is a description of what the current operation is already doing, discovered while measuring something else. It is the owner's to resolve, and it is not the architecture's to resolve for him.

✅ **Confirmed against the recording itself, not against a recollection.** The owner played it back: one ring, then speech. **No announcement of any kind is present in the audio** — on the two-legged outbound path.

> 🔴 **CORRECTION — the announcement EXISTS, and this section first said the wrong thing about it.**
>
> A later **inbound** call to the Test Line, placed with Talk offline, was answered with a greeting the owner reported verbatim: *"gracias por la llamada, la llamada va a ser grabada"* — **followed by an AloAi virtual assistant that said it would collect his details.**
>
> So the correct finding is not *"there is no announcement"*. It is:
>
> | Path | Announcement |
> |---|---|
> | **Inbound** to a line | ✅ **Plays** — the caller is told the call is recorded |
> | **Outbound, two-legged** | ❌ **Does not play** |
>
> **This is a materially better outcome than the one first recorded, and it changes the remedy.** D9's blunt instrument — *disable recording at the account level for the MVP* — assumed the capability was absent. It is not absent; it is **not applied to the outbound path**. The first thing to establish is therefore whether an outbound announcement is configurable, because a configuration change is a far smaller decision than switching recording off for the whole business.
>
> The exposure is unchanged in the meantime: outbound dials to all-party-consent states are recorded with no disclosure. But the shape of the fix is different, and G2's failure criterion should be applied to the corrected fact rather than to the first one.
>
> ⚠️ **And one more turn of the screw, checked rather than assumed: the account's Calling Settings contain no announcement, disclosure, whisper or greeting option at all** — only the three recording selects. So the inbound disclosure is most likely **the line's own greeting**, configured by the agency ahead of the AloAi agent, and *not* an Aloware recording-announcement feature.
>
> If that is right, there is **no switch to flip for outbound** — the disclosure would have to be built. **This is stated as the open question it is**, not as a conclusion: confirming it means opening the Test Line's own settings and reading its greeting configuration. It is the single highest-value follow-up left on this assertion, because it decides whether the remedy is a checkbox or a project.

⚠️ **Second finding inside the same observation: an AloAi voice agent answers inbound calls when no human is available, and states that it will collect the caller's information.** That explains a `talk_time` of 17 s on a call nobody picked up. It is live in production today. `06-conversations.md` **CUT** AI autopilot replies — *"an unsupervised bot texting insurance prospects is a compliance and brand risk we would be inventing for ourselves"* — a ruling made about SMS and made without knowing an AI voice agent was already speaking to inbound leads and gathering their data. Recorded as a fact about the operation the CRM must model; not reopened here.

⚠️ **The one limit that remains, stated rather than glossed:** the recording captures the **agent** leg. An announcement played only to the *called* party would not appear in it, and the called party is the one a two-party-consent state requires to be notified. Three independent observations now point the same way — the owner heard none, the other party reported none, and the audio contains none — so there is **no positive evidence that any announcement exists**. Compliance does not get to assume a disclosure happened; the absence of evidence is the finding.

### 🚨 A RECORDING URL IS A BEARER CAPABILITY, AND IT TRAVELS IN THE WEBHOOK

`Recording-Saved` carries `direct_recording_url: https://app.aloware.io/static/recording/<uuid>`. A `HEAD` with **no credentials of any kind**:

```
HTTP/2 302
location: https://aloware-prod-new.s3.us-west-2.amazonaws.com/9478/calls/recordings/<uuid>.mp3
          ?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Expires=3600&X-Amz-Signature=…
```

**The endpoint is unauthenticated.** Anyone holding the UUID gets a one-hour pre-signed S3 link to the call audio. The UUID is a v4 — unguessable, so this is a capability URL, and the capability is the whole of the access control.

**And that capability is inside the webhook body**, which changes what two things in our design actually are:

- **`raw_payload_vault` stops being merely a PII store and becomes a store of bearer tokens to call audio.** Anyone with read access to the vault, to a database backup, or to a `dead_letter` row can pull recordings. The vault's 30–90 day purge, adopted for CCPA minimisation, now also bounds this — which is a reason not to lengthen it.
- **`call_detail.recording_url` inherits the same property.** A CCPA erasure that deletes our row does not revoke anything: the URL works until Aloware deletes the file. `06-conversations.md` already carries the open question *"Is there an API to delete recordings on Aloware's side?"* — it is no longer a nice-to-have for erasure completeness, it is the **only** revocation mechanism that exists.

*No recording was downloaded. A `HEAD` established the access-control property without retrieving any audio.*

⚠️ **Also observed and worth confirming: `call_disposition_id = 31227`, which is `No Answer` — on a call with 63 seconds of talk time.** Nobody set it manually. If Aloware auto-assigns dispositions, and assigns them wrongly, that is direct vindication of US-604's ruling that the semantic outcome comes from **our** wrap-up sheet with the provider disposition as *enrichment only*. Worth confirming before it is treated as established.

### 📞 FIRST REAL DIAL — `two_legged_call` answers `202`, and the payload settles the idempotency question

`POST /api/v1/webhook/two-legged-call` with `ring_group_id=29109`, `line_id=63949` (Test Line) and the subject number held in `.env` as `SPIKE_DESTINATION_E164` — never written into a committed file, because a subject is a real person and a git history is a longer clock than the one E9 forbids for PII:

```
HTTP 202 in 1 737 ms · {"message":"Two legged call established."} · digest_ok = true
```

**The call itself failed** — nobody was available on the agent leg — and that is itself a structural finding:

> 🔴 **The two-legged call rings the AGENT first, and if that leg is never answered the lead's number is never dialled at all.** `customer_leg_status`, `legc_uuid` and `user_id` all came back `null`; it waited **30 s** (`wait_time: 30`, `talk_time: 0`) and gave up. The seller's leg is not a courtesy notification before the real call — it is a precondition of it. Good for compliance (no unattended call ever reaches a lead) and it reshapes the UI problem: the "5–15 second silence" §1.1 describes is *agent-leg wait first, lead ring second*.

**Fan-out for a failed call: exactly 2 webhooks, 31.7 s apart.**

| # | `event` | `current_status2` | `duration` / `talk` / `wait` |
|---|---|---|---|
| 1 | `OutboundPhoneCall` | 1 | 0 / 0 / 0 |
| 2 | `OutboundPhoneCall-DispositionFailed` | 9 | 30 / 0 / 30 |

🔴 **TWO EVENT VOCABULARIES, AND THEY DO NOT MATCH.** The subscription form's checkboxes are `communication.initiated`, `call.disposed`, `recording.saved`… The payloads' own `event` field says `OutboundPhoneCall` and `OutboundPhoneCall-DispositionFailed`. **What you subscribe to and what arrives are named differently**, so §4.3's mapping table must key on the *payload* vocabulary, and the subscription names are only a filter. A mapping built from the checkbox list would match nothing.

### 🔴 THE IDEMPOTENCY KEY DOES NOT EXIST — and here is what replaces it

The envelope is `{ "body": {...}, "event": "..." }`. **There is no `event_id`, no `delivery_id`, no `webhook_id` — anywhere, in headers or body.** What exists is `body.id` (the *communication* id — `940864662` here, i.e. `aloware_call_id`) and the `event` name.

§4.4's first rung is a unique index on `(tenant_id, provider, provider_event_id)`, and the no-signature finding already made that index **the only replay defence**. So the column has to be populated from something:

- **`(aloware_call_id, event)` is not safe.** Both webhooks above share `id = 940864662`; only `event` differs. But the payload carries `updated_at`, `current_status2`, `disposition_status2` — mutable state — so the same event name can legitimately recur for one call with different content, and a composite of the two would silently drop a real state change as a "duplicate".
- ✅ **`sha256(raw body)` is the honest key.** A byte-identical retry collides and is rejected in under a millisecond, exactly as designed; a genuinely new state hashes differently and passes. It requires no field the provider does not send, and **the ingest edge already computes it** — the vault stores `body_sha256` regardless.

**Proposed ruling for §4.4:** where a provider supplies no delivery id, `provider_event_id := encode(sha256(raw_body),'hex')`. This is a design decision that belongs to Phase 5, not to the spike; recorded here with its evidence.

### 🔎 What the payload revealed about the business, unasked

The destination is contact `155091981` in their production book, and its fields are a migration briefing:

- **`intake_source: "gohighlevel"`** — GHL confirmed as the system of record, from the data rather than from a disposition's description.
- `initial_campaign_id: 65123` — it arrived through the **Local Presence** line.
- `contact_source: "Lead IUL - 2 Pasos"`, plus custom fields named in Spanish: `rango_edad`, `edad`, `gender`, `coverage_requested`.
- **Aloware already carries consent-adjacent flags**: `is_dnc`, `is_opted_out`, `text_authorized`, `text_authorized_at`. The consent ledger has something to mirror from.
- `date_of_birth: "2026-06-22"` — a future date. Their book contains junk data today.

⚠️ **This payload is PII and it lives only in the gitignored evidence file — never in `ref.capability_probe`.** The probe row for this dial holds the 202 acknowledgement and nothing else, which is E9 working as designed rather than by luck.

### 🟢 (b) CONFIRMED ON THE WIRE — and a second finding nobody was looking for

A subscription was created (filtered to skip the Local Presence line) and `Save and Test Webhook` fired a delivery. Aloware reports the endpoint **VALID & ACTIVE**. The capture:

```
POST /hooks/aloware  ->  204 in 1 ms   ·   21 bytes   ·   {"test_payload":true}

Host: techrepublic-discharge-attitude-globe.trycloudflare.com
User-Agent: GuzzleHttp/7
Content-Length: 21
Accept-Encoding: gzip
Connection: keep-alive
Content-Type: application/json
```

Those six are **everything Aloware sent**. The remaining ten headers on the capture (`Cf-*`, `X-Forwarded-*`, `Cdn-Loop`) are the tunnel's, excluded per the note above — which is exactly the trap that note exists to prevent, and it was live on the very first delivery.

**(b) is answered: there is no signature.** No `X-Aloware-Signature`, no `X-Hub-Signature-256`, no timestamp, no nonce. The panel said it and the wire confirms it.

🔴 **AND THE FINDING NOBODY WENT LOOKING FOR: there is no delivery id and no event id in the headers either.**

§4.4's idempotency ladder has, as its **first rung**, a transport-dedupe unique index on `(tenant_id, provider, provider_event_id)` — the thing that *"lets a 20 000-webhook replay storm land without touching the domain at all."* And the finding above already promoted that same index from a performance measure to **the only replay defence we have**, precisely because nothing proves freshness.

So the entire rung now rests on `provider_event_id` being present **in the body**, and the test body is `{"test_payload":true}` — it carries no id of any kind. **Until a real event body is captured, it is unknown whether that column can be populated at all.** If it cannot:

- transport dedupe has no key, and duplicate suppression has to move down to the call/message rungs, which merge rather than reject — more expensive per delivery, on the exact path a retry storm hits hardest;
- **replay has no defence left**, because the index that was standing in for one cannot be built.

This is now the highest-value unknown in the gate, and it is answered by one real call.

**Two smaller facts worth keeping:**

- **`User-Agent: GuzzleHttp/7`** — Aloware's sender is PHP/Guzzle, and the UA is generic. We cannot identify the provider by user agent.
- **`Cf-Connecting-Ip: 35.93.153.75`** — the real sender address, in **AWS `us-west-2` (Oregon)**. An IP allowlist is therefore *possible* in principle, though a cloud range is a weak control. It also refines the latency picture: the provider is on the US **west** coast, while G0 put production in Ohio or Virginia.

### 🔴 (b) The panel evidence that predicted it — and `webhook_subscription` exists

`/integrations/webhooks` → **Add Webhook**. The capability is real. Today: *"You don't have any webhooks integration setup yet"*, and the integration's own toggle is **off**.

The form settles the signature question outright:

> **Authentication Method** — `None` · `Basic` · `Bearer`

**There is no HMAC option, no signing secret, no signature header.** What Aloware offers is a **static credential we supply and it echoes back**. The distinction is load-bearing and must not be blurred in either direction:

| | A signature (HMAC) | What Aloware actually offers |
|---|---|---|
| Binds the **body** to the secret | ✅ | ❌ |
| Detects a tampered payload | ✅ | ❌ |
| Survives replay | ✅ (with a nonce/timestamp) | ❌ — a captured request replays forever |
| Proves the caller holds the secret | ✅ | ✅ |

So the honest characterisation is **authenticated but unsigned**, not "unsigned and unauthenticated". `ARR-INT-02` required assuming *"at-least-once, out-of-order, possibly unsigned delivery until the Sprint-0 spike says otherwise."* **The spike says otherwise, and it says the worse half is true.**

Consequences, each of which lands on something already written:

- **§4.2 ruling 3 was designed for exactly this and holds.** `signature_valid boolean NULL` is *"deliberately nullable because the spike has not established whether Aloware signs at all, and a `NOT NULL` column would force us to record a lie."* The column now has a permanent meaning: with `Bearer` configured it records **credential** validity, which is a weaker claim than the name suggests. Either the column is renamed or its comment carries this paragraph — a field called `signature_valid` holding a bearer check is how a future reader over-trusts a payload.
- **`ADR-SEC-05` survives unchanged in shape:** a failed check still returns `204`, still vaults the body, still writes a `dead_letter` row and raises the admin counter. Substitute "credential" for "signature".
- **The permanent *"we cannot verify"* line on `/admin/integration-health` stops being provisional.** It is now a true and permanent property of this integration.
- 🔴 **Replay is not defensible at the edge.** Nothing in the request proves freshness, so the transport-dedupe unique index on `(tenant_id, provider, provider_event_id)` is not merely an idempotency convenience — **it is the only thing standing between a captured request and unlimited replay.** That elevates it from performance measure to security control, and it should be documented as one.

**12 subscribable events**, which is the real §4.3 vocabulary:

`Contact Created` · `Contact Updated` · `Contact Disposed` · `Contact DNC Updated` · `Communication Initiated` · `Communication Disposed` · `Appointment Saved` · **`Call Disposed`** · **`Voicemail Saved`** · **`Recording Saved`** · **`Transcription Saved`** · **`Call Summarized`**

⚠️ **Two absences to verify against a real call, not to conclude from this list:**

1. **No event named for SMS.** Aloware's data model appears to call calls and texts alike "communications", so inbound SMS probably arrives as `Communication Initiated` — but §4.3 maps inbound SMS to `message.received` keyed on `provider_message_id`, and that binding is unproven.
2. 🔴 **No `Call Answered`. Only `Communication Initiated` and `Call Disposed` / `Communication Disposed`.** If the provider pushes at the start and at the end and nothing between, then **live call state — one of the exactly two channels SSE is permitted to carry — has no webhook source.** The 5–15 second two-legged silence is precisely the interval with no event in it. This is the most consequential thing on this page after the signature finding.

**Also on the form, and both useful:** a **Delay** toggle (*"the delay in seconds before sending the webhook"*), and **Filters** — `Direction`, `Type`, `Communication Disposition Status`, `Contacts`, **`Skip lines`**, `Duration`.

✅ **`Skip lines` is what makes a safe subscription possible.** The account is live production; a subscription pointed at our receiver would otherwise copy real consumer traffic to it. Skipping line `65123` (Local Presence, 58 numbers) leaves only line `63949` (Test Line) — synthetic subjects only, which is E9's requirement rather than a preference.

**And `Save and Test Webhook` sends a test delivery** — the header shape and body form are observable **without placing a billable call**. That is the cheapest possible first measurement, and it is the natural next step.

### 🟢 (h) 10DLC — CLOSED, and it is the best available answer

| Step | Status |
|---|---|
| Business Registration | ✅ **Approved** |
| A2P Brand | ✅ **Approved** |
| A2P Campaigns | ✅ **Approved** |
| Unregistered lines registered | ✅ Done |
| Voice Integrity | *"Your phone numbers are registered for Voice Integrity."* |

**The brand is registered to the agency's own entity, "Tu Familia Protegida", and it is already approved.** That closes G2's instruction to *"start the 10DLC filing in parallel — it is external, third-party-approved and rejectable"* — there is nothing to start. It also settles `06-conversations.md`'s open question *"Who owns the A2P 10DLC brand registration — the client's agency entity or ours?"*

Consequence for the launch posture: the A2P gate that made **SMS-dark** a hard dependency on an external approval is **satisfied**. SMS-dark remains a decision, but it is no longer a constraint.

### 🎯 (e) The real disposition vocabulary — 11 names, and it is not a telephony taxonomy

Read off Account → Call Dispositions. **4 511 communications across 11 dispositions.**

| Disposition | Communications | Note |
|---|---|---|
| **No Answer** | **4 066 (90.1 %)** | |
| Call back | 166 | |
| Not interested | 131 | |
| Demo completed | 36 | |
| Voicemail | 32 | *"Cayó a buzón de voz (con o sin mensaje dejado)"* |
| Wrong number | 23 | |
| **Closed deal** | **22** | |
| Disconnected | 18 | |
| Out of range | 14 | |
| DNC - Do not call | 2 | *"Pidió no ser contactado. **Marcar DNC en GHL** y no volver a llamar."* |
| Interested - follow up | 1 | *"Interesado, requiere seguimiento (aún sin cita)"* |

Four findings, none of which the corpus predicted correctly:

1. **The list mixes two different questions into one field.** `No Answer`, `Voicemail`, `Wrong number`, `Disconnected`, `Out of range` are *telephony* results. `Closed deal`, `Demo completed`, `Interested - follow up`, `Not interested`, `Call back` are *sales* outcomes. `06-conversations.md`'s adversarial review demanded exactly this split — `connection_result` (mapped from the provider) and `sales_outcome` (ours, vertical-configurable) — and called shipping one field *"an argument about semantics where every downstream automation fires on the wrong thing"*. **The real account proves the review right.**
2. **These are agency-authored and bilingual**, with descriptions in Spanish. `09`'s mapping table cannot be a fixed code-level enum of provider strings; the raw values are tenant data.
3. 🔴 **`DNC - Do not call` documents a manual cross-system process: *"Marcar DNC en GHL."*** The agency runs **GoHighLevel** today (its integration toggle is enabled on the Integrations screen). A compliance-critical suppression currently depends on a human remembering to mirror it into a second product — which is precisely the failure `26` (DNC/suppression, unoverridable by any role) exists to remove. It is also a migration fact nobody had recorded: **this CRM replaces GHL.**
4. **90.1 % no-answer is the real shape of the work**, and it is what makes the `RVM API` finding material rather than curious.

⚠️ **Every one of these 11 shows `Synced with CRM: No`.**

### API surface visible on the Integrations tab strip

| Tab | Bears on |
|---|---|
| Lead API · Form Connect | intake |
| **Contact Lookup API** · Number Lookup API | `contact_lookup` (mvp_optional) |
| **Sequences API** | `sequence_enroll` / `sequence_disenroll` (probe_only) |
| **SMS API** | `sms_send` (mvp_optional) |
| **Two-Legged Call API** | `two_legged_call` (**mvp_required**) — contract captured above |
| **RVM API** | **Ringless voicemail.** `06-conversations.md` carried this as an open question with the explicit warning *"was not verified in Phase 1 and must not be assumed"*. It exists. 60–70 % of FE dials hit an answering machine, so this is a material finding for attempt economics — and it is **not** in the MVP scope today |
| Power Dialer API | feature 30 (non-MVP) |
| Users API | the identity map's `aloware_user_id` |
| Inbox Availability API · AloAi Outbound Call API · MCP (BETA) | not in the design. **MCP appears nowhere in the corpus** — Phase 1 did not record it |

**The strip is now read end to end — 14 tabs, and that is all of them:** Integrations · MCP (BETA) · Form Connect · Lead API · Contact Lookup API · Sequences API · Number Lookup API · SMS API · RVM API · Two-Legged Call API · AloAi Outbound Call API · Power Dialer API · Users API · Inbox Availability API.

🔴 **Neither `call_list` nor webhook subscription appears there, and neither appears in the 22-item Account menu.** Both are `mvp_required`. This is now a *searched* absence rather than an unread one, but it is still not a conclusion: webhook configuration may live per-Line, inside the Integrations cards, or be support-provisioned only, and the two-legged page ends with *"If you need more API functions, please contact our support at support@aloware.com."* **`absent` is not recorded until those are checked.**

### The account, as it actually is

| Fact | Value | Why it matters |
|---|---|---|
| Lines | **2 active** | `63949` **"Test Line"**, one number `+1 737 427 3994` · `65123` "Local Presence", **58 numbers** |
| Inboxes (ring groups) | **2** | `29109` Default Inbox (Test Line + Local Presence attached, 1 user) · `29696` "IUL – Live Transfers" (3 users) |
| Logged-in user | `120776`, Company Admin | supplies `user_id` for the dial |
| Traffic | **~150 calls+texts/day** over the last week | **this is a live production account, not a sandbox** |

**A "Test Line" with a single number already exists**, routed to the Default Inbox. The spike dials from `line_id=63949` and never from the Local Presence pool, so nothing it does can touch production traffic.

🔴 **The 58-number Local Presence pool contradicts the identity map as specified.** §5's `aloware_number_mapping` carries `UNIQUE (tenant_id, from_number_e164) WHERE revoked_at IS NULL` — *one number, exactly one seller* — and US-601 asserts it. A rotating pool of 58 numbers has no stable number-to-seller binding at all. Two things soften it and neither resolves it: the two-legged call takes an explicit `user_id`, so **outbound** attribution need not come from the number; and `06-conversations.md` explicitly **CUT** local presence (*"the regulatory and carrier-reputation risk is not ours to take"*) — a decision taken without knowing the client already runs it. What remains genuinely open is **inbound** attribution: a callback to a pool number has no owner under the current index. Recorded here, not designed around yet.

---

## Appendix · Aloware MCP — researched because it appears nowhere in the corpus

The Integrations strip carries an **`MCP BETA`** tab and Account carries **MCP Integrations**. Phase 1 predates it, so it was researched from the provider's own documentation. **Verdict: do not re-plan around it.** Recorded here so the question is closed rather than rediscovered.

**It is two different things, and only one is interesting.**

**As a server (Aloware exposes tools to AI clients)** it publishes **14 tools** at `app.aloware.io/mcp` — and they are **exact 1:1 parity with the REST APIs already mapped**: Two-Legged Call, SMS/MMS, RVM, AloAi Outbound Call, Create Lead, Contact Lookup, Sequence enroll/disenroll, Number Lookup, Get Users, Inbox Availability, and four power-dialer operations.

🔴 **There is no call-history or call-list tool.** The gap that forces (j)'s compensating control is **not** closed by MCP. The count cross-checks independently — the product page and the admin guide both list 14, and they are the same 14.

**As a client (AloAi agents call OUR tools)** it is genuinely new and has no REST equivalent: an agent can be pointed at an MCP URL and call our tools **mid-call**, with a `Relay through Dashboard` toggle that keeps credentials server-side.

**Three properties rule the server direction out for production traffic:**

1. 🔴 **No per-seller attribution.** Everything is tagged `Creator Type: MCP` and nothing finer. **That is incompatible with the silo** — an MCP-originated call or message cannot be assigned to a rep, so it cannot be owned, scoped or credited.
2. 🔴 **Silent contact creation.** If the number is not in the account, Aloware creates the contact *before* communicating. A model can mint a contact and message it in one step with **no consent gate anywhere in the path** — the exact hazard `23`–`26` exist to make impossible.
3. **No sandbox.** Documented plainly: AI assistants can execute paid operations autonomously and every test is a real, billed call.

**Auth** is OAuth 2.1 with PKCE and dynamic client registration (verified against the live `.well-known` metadata), or a bearer token that is **the account's existing Form Capture API token**. One scope, `mcp:use`, covers sending SMS, placing calls and clearing power dialers. **There is no read-only mode and no per-tool scoping.**

⚠️ **Two notes on the documentation itself.** The word *"beta"* appears in **none** of the four support articles — the in-app tab is the only beta signal, so the label should be trusted over the prose. And the troubleshooting article advises switching from HTTPS to HTTP if a local client hits certificate issues; that connection carries an account-wide token with authority to send SMS and place calls, and **that advice must not be followed**.

**If MCP is ever revisited, the question is the client direction:** a narrow, read-only MCP server exposed *by* the CRM for AloAi agents to query during a call. It lands directly on the seller silo and the compliance gates, so it is a security review before it is a feature.

---

## Method note: two ways a probe lies, both hit during instrument testing

**A 2xx from the wrong listener is indistinguishable from success.** While proving the token-redaction path against a local mirror, the receiver failed to start with `EADDRINUSE` — and the probe still reported `HTTP 204 in 42 ms`. The run looked perfect. `source` protects against a wrong *path*; nothing protected against a wrong *listener*, and the only reason it surfaced was that the evidence file the receiver should have written did not exist.

> 🔴 **Correction, made two hours later when the port was needed again.** This paragraph first said the port was owned by *"an unrelated Node process"*. **That was wrong.** Reading the process command line showed it was **this same receiver, orphaned from an earlier backgrounded run that never died** — `TaskStop` had killed the `npm` wrapper and left the `node` child listening.
>
> The corrected lesson is sharper than the one it replaces: it was not a stranger's process answering, it was **another instance of our own instrument**. Everything about that `204` was exactly what a correct run produces — same status, same latency class, same shape — because it *was* a correct run, of the wrong build, writing its evidence somewhere nobody was looking. A foreign process would have answered oddly and been noticed. **Ours answered perfectly.**
>
> Two operational consequences: a backgrounded `tsx` script must be killed **by PID**, not by stopping its shell; and before trusting any local measurement, confirm the listener is the process you just started.

**A check that reads the wrong path passes vacuously.** The first leak check ran `grep` over a directory that did not exist on that side of the Git-Bash/Windows path split, so *"the secret does not appear"* was true of nothing at all. It was re-run with absolute paths and a byte count printed alongside the verdict, so the assertion cannot be green against an absent file again.

Both are the same failure in different clothes: **an assertion that cannot distinguish success from having never run.**

### The redaction, proven rather than described

The token substitution mechanism is `[API_TOKEN]` — Aloware's own placeholder from its example body — replaced only in the copy handed to `fetch`. Against a local mirror:

| | Content |
|---|---|
| What the provider received | `{"api_token":"SUPERSECRET-TOKEN-XYZ", …}` |
| What the evidence file holds | `{"api_token":"[API_TOKEN]", …}` |

The declared body is what gets logged, and it physically cannot contain the secret. There is no "remember to strip the token" step to forget.

---

## Method note: a gate that fails for a reason that has nothing to do with it

`npm run verify` was **red at the `perf` stage before any of this work**, and the same red appeared on a clean `HEAD` — checked by stashing, not assumed.

`PERF003` refused with *"the client manifest has no chunk `node_modules/@react-router/dev/dist/config/defaults/entry.client.tsx`"*. The real key in the built manifest was `../../../node_modules/…`. The cause: **this session runs in a git worktree whose `node_modules` directory was empty**, so every dependency resolved from the parent checkout three levels up and Vite wrote the key relative to that.

The tempting fix was to make the checker tolerant of a `../` prefix. That is precisely the move the constitution forbids — *"do not weaken a budget, a ratchet or an exception list to make a build pass"* — and the checker was not wrong: it refused rather than measuring a smaller graph than the browser actually loads, which is exactly its job. **The environment was fixed instead** (`npm ci` inside the worktree), and the gate then passed on its own terms: P12 **111 068 / 128 000 bytes**, P13 **2 462 / 16 384**.

Worth carrying forward: **any future worktree session hits this**, and it looks like a defect in the tree rather than an empty directory.
