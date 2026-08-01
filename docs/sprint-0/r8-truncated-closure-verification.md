# R8 · Verification pass against the untruncated documents

> **Mandate.** `docs/05-architecture.md` §0.3 R8: *"Audit items §9.2/8–17 were judged on **truncated text**. Several are verified closed; §7.7.1/2/6, §10.5 and §10.16 are **not**. One pass against the untruncated documents before any is called closed."*
>
> **Scope.** Verify, do not redesign. Where this pass finds a defect it names it and proposes; adopting a fix is an architecture amendment and Jorge's call.
>
> Date: 2026-08-01. All five sections read in full in [`05c-closure-register.md`](../05c-closure-register.md).

## Verdict

| Item | Claim under test | Verdict |
|---|---|---|
| §7.7.1 | Id-less list endpoints are silo-testable | ✅ **Closed** — two qualifications below |
| §7.7.2 | `defineEndpoint()` is a build fact, not a convention | ✅ **Closed** — one unspecified input |
| §7.7.6 | `provider_capability` cannot be talked into `verified` | ❌ **NOT CLOSED as written** → closed by **errata E9**, signed 2026-08-01 |
| §10.5 | The 49-name coverage gate is satisfiable and honest | ✅ **Closed** — one stale command |
| §10.16 | `sms_enabled=false` is a tested axis | ✅ **Closed** — one doc drift |

Four of five hold up under full reading. The fifth does not, and its failure mode is the worst class this project has: **it is silent for about sixty days and then production refuses to boot.**

---

## ❌ §7.7.6 — the closure deletes its own evidence

**What it claims to fix.** `CHECK (status <> 'verified' OR (verified_at IS NOT NULL AND evidence_ref IS NOT NULL))` with free-text `evidence_ref` is satisfied by a migration seeding `evidence_ref='spike'`. Correct diagnosis.

**What it does.** Replaces free text with a foreign key to `ref.capability_probe`, which carries `http_status`, `response_digest` (sha256 of the stored body) and `raw_payload_id` pointing at the body in `raw_payload_vault`. Then:

> for every `tier='mvp_required'` capability **in production**, the linked probe must exist **and** its `response_digest` must equal `raw_payload_vault.body_sha256` for `raw_payload_id`. A fabricated verification has no probe row, no stored body and no matching digest, and **the process exits non-zero.**

**The defect.** `raw_payload_vault` is on a deliberately short retention clock, and that clock is mechanical and unforgettable by design:

- `raw_payload_vault.purge_after` is **`NOT NULL`, written at INSERT** — "a vault row without a retention clock cannot exist" (`05-architecture.md` §1870).
- `purge_after` **drives partition drop**, and an R2 lifecycle rule expires the objects, so that "there is no purge job anyone can forget" (`05b-data-model.md` §752).
- The illustrated value is `received_at + 60d` (`05-architecture.md` §1844); the window is formally unresolved at 30/45/90 days (§9.7).

The Aloware capability probes are captured during Sprint 0 G2. Between 30 and 90 days later — 60 on the illustrated setting — the vault partition holding those bodies is dropped. From that moment `raw_payload_vault.body_sha256` for `raw_payload_id` does not exist, the boot assertion cannot be satisfied by any value, and **the process exits non-zero on every subsequent start.**

**Why it is the worst class of defect here.** It is invisible in development and in CI, because the assertion is scoped to production. It is invisible on day one, because the vault row exists. It surfaces as a total outage roughly two months after go-live, triggered by a scheduled deletion nobody will connect to integration health. The two mechanisms are individually correct and were specified in different sections by different agents; neither is wrong on its own.

**Second-order collision.** The retention mechanism is *partition drop*. `dead_letter` already declares `FK (tenant_id, raw_payload_id) REFERENCES raw_payload_vault` (`05b-data-model.md` §758), and §7.7.6 adds a second referencing table. Dropping a partition that inbound foreign keys still reference either fails outright or requires the references to be gone first. **The vault's purge design and its two FK dependants have not been reconciled** — this is broader than §7.7.6 and is flagged here because this pass is where it surfaced.

### Resolution — adopted as errata E9 (2026-08-01)

**Option 1 below was signed and is now [`05-architecture.md` §0.2 E9](../05-architecture.md), precedence rank 1.** `ref.capability_probe` gains its own `response_body bytea NOT NULL` and drops `raw_payload_id`; the boot assertion compares `response_digest` against `sha256(response_body)` in the same row, depending on no other table's retention. Probes are captured against synthetic subjects only. The anti-forgery property is preserved exactly.

The `dead_letter` half of the FK/partition-drop collision is **not** resolved by E9 and is now declared as residual risk **R13**, closing in Sprint 0 alongside G1.

### The three options as evaluated

The root confusion is that **probe evidence and consumer payloads are on the same clock for no reason.** The vault's short window exists for CCPA minimisation of *consumer PII*. A capability probe is a record of what the provider's API answered — it is operational evidence, and it needs to outlive the thing it certifies.

Three options, in descending order of preference:

1. **Give probe bodies their own home with no retention clock** — a `ref.capability_probe_body` holding the body, with the boot assertion verifying `response_digest` against it. Requires the accompanying rule that probes are captured against synthetic subjects only, never a real consumer, so nothing PII-bearing lands on a permanent clock.
2. **Exempt probe-linked vault rows from purge.** Cheaper, but it puts a permanent-retention exception inside the one table whose entire purpose is guaranteed expiry — and it reopens the partition-drop problem rather than solving it.
3. **Drop the vault join and keep only `response_digest`.** Rejected: a hash with nothing to compare against is a word in a column wearing a hash's clothes, which is the original defect restored.

Option 1 also resolves the FK/partition-drop collision for the probe side, though not for `dead_letter`.

---

## ✅ §7.7.1 — closed, with two qualifications

The mechanism is sound and genuinely mechanical: `siloProbe` is a non-optional discriminated union on `defineEndpoint`, so **an id-less endpoint that declares nothing does not compile**; the `silo-collision` fixture is legal precisely because `contact` is unique on `(tenant_id, owner_user_id, email_norm)` — owner-scoped, because ping-post resells the same consumer twice; and assertion 1 is a **byte-level check over the entire serialized response**, which catches leaks through fields that do not exist yet. That last property is the strongest single test in the corpus: it does not need to know the schema to catch a schema mistake.

Two things this pass will not call closed silently:

- **`kind: 'none', reason` is an in-tree escape hatch with no rendered surface.** It "lands on the sealed exception table", but R10 already records that `ref.sealed_signature` seals result types, not bodies. Under NEW-7 — the actor who writes a migration nobody reads — adding an exception row is the walkable path, and §7.7.1 does not say the exception list renders anywhere Jorge would ever see it. Compare G4(d), which does require its RLS exception list to be *published with each entry's written reason*. The same treatment belongs here.
- **The canary fixture collides with the leaderboard by construction.** The canary token is seeded into `full_name`, and `/api/leaderboard` renders every seller's name and total — that is the product's headline feature, not a bug. Assertion 1 (`!responseBody.includes('ZZQA-')`) must therefore fail on the leaderboard, which forces the public money surface onto `kind: 'none'`. The highest-stakes endpoint ends up opted out of the strongest assertion. That is defensible, but it must be a *written* ruling with the leaderboard's own positive test, not a fixture accident discovered during implementation.

## ✅ §7.7.2 — closed, with one unspecified input

The three changes do convert a convention into a build fact, and the third is the one that matters: **the framework route table is generated from the registry**, so a module the generator refused is not routed and 404s in E2E. That is a screen symptom, which is the only property that survives NEW-7. The module-private `unique symbol` brand cannot be forged from outside the module.

**Unspecified:** the generator throws on "any `loader`/`action` in `routes/ui/**` whose path is not in `ref.ui_loader_whitelist`" — but `ref.*` is a **database table** and the generator is a **build step**. Where the build reads that whitelist is not stated. A build that needs live database access is a coupling nobody has agreed to, and CI builds will not have production credentials. This needs either a generated, drift-gated snapshot committed to the tree, or a plain constant with the table removed from the design. It is a small gap, but it is the difference between a gate that runs and a gate that cannot.

*(Related and consistent: `CLAUDE.md` already states exactly one UI route may serve board data as SSR HTML — that is the whitelist's real content, and it is one row.)*

## ✅ §10.5 — closed, with one stale command

Both defects are genuinely closed, and the two-sided gate is the elegant part: every `app` name must appear in `event_log`, and every `deferred_v1_1` name **must not** appear in `event_log` *and* must not appear as an emitter call site in the built bundle. Flipping a name to `deferred_v1_1` to green the build turns the other side red the instant any code emits it. The dishonest-satisfaction path is closed by walking the **production bundle's** module graph — a test helper is not in the production bundle. Set equality also enforces `CLAUDE.md`'s "an event outside the canonical 49 is a bug."

**Stale:** the text specifies `After pnpm build` and `pnpm gen:events && git diff --exit-code`. Phase 6 decided **npm, not pnpm** (`corepack enable` returns EPERM on this machine without an administrator console). Both commands need rewriting to npm when this gate is implemented. Trivial, and exactly the kind of detail that leaves a gate un-run.

## ✅ §10.16 — closed, with one doc drift

The ruling is right and the reasoning is the good kind: the product launches SMS-dark, so **dark is the baseline for every run and `sms_live` is the variant** — which costs zero extra minutes for the baseline instead of treating the launch configuration as an occasional rehearsal. The mechanisms are mechanical rather than procedural: `sms_enabled` is a **column on `tenant`** so the suite flips a row; ESLint bans `process.env.SMS*`; dependency-cruiser forbids `src/**` importing a flags module; a catalog gate greps `pg_proc.prosrc`; and `alowareSms.send()` requires a `GateVerdict<'allow'>` token only the gate can mint, so a route that skips the gate does not compile. The global assertion `count(terminal_reason = 'skipped: sms_disabled') > 0` is what stops "no path errored" from being satisfied by a suite that never reached the skip path.

The published budget — committed 1,680 of 2,000, reserve 320 (16 %) — is consistent with GitHub Free's 2,000 minutes on a private repository, which is the signed CI position.

**Drift:** `CONTEXT.md` and the session handoff describe the launch configuration as `SMS_ENABLED=false`, an **environment variable**. This ruling makes it a tenant column and *explicitly bans* `process.env.SMS*` anywhere in the tree. The ruling wins; the prose needs correcting so nobody implements the banned shape.

---

## What this pass changes

- **R8 is discharged for four of five items.** §7.7.1, §7.7.2, §10.5 and §10.16 may now be called closed, subject to the four small corrections listed above being carried when each is implemented.
- **§7.7.6 could not be called closed as written.** It carried a production-outage defect that no gate in the ladder would catch, because the assertion it breaks is production-scoped and time-delayed. **Closed by errata E9**, which puts probe evidence and consumer PII on separate clocks.
- **One new cross-cutting item, declared as residual risk R13:** `raw_payload_vault` purges by partition drop while `dead_letter` still holds a foreign key into it. E9 removes the probe's reference; the `dead_letter` side is owed and closes in Sprint 0 alongside G1.

**R8 is now fully discharged.** The one item that failed produced an errata at precedence rank 1 and a numbered residual risk, which is the outcome the residual register exists to produce.
