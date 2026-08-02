# CLAUDE.md — project constitution

Lead CRM for ~50 US sales reps: per-seller silos, Aloware calls/SMS, and a public real-time **Earnings** leaderboard. **This is a CRM for salespeople, not an insurance platform** — life insurance (Final Expense + IUL) is the current use case, not the design axis.

**State and history: [`CONTEXT.md`](CONTEXT.md). Read it first, every session.**

---

## The one rule that shapes everything else

**Jorge does not read code. He validates by behaviour on screen. There is no code reviewer and no reviewed pull request.**

So a rule is only a rule if it is one of these:

- a database constraint, a revoked privilege, or a trigger;
- a type that does not compile;
- a build that goes red;
- **a symptom on a seller's screen.**

Anything enforced by "remember to…", "a PR that only touches this file", or a comment is **documentation, not a guarantee** — say so plainly instead of presenting it as a mechanism. And note the corollary: _"only the migrator role can weaken this"_ means _"Claude writes a migration and nobody reads the diff."_ Only three properties survive that actor: **(a)** a symptom on screen, **(b)** a gate anchored outside the working tree, **(c)** re-assertion at deploy and at boot.

---

## Commands

```bash
npm run dev          # dev server on :3000
npm run verify       # typecheck + lint + format:check + test — run before every commit
npm run typecheck    # react-router typegen && tsc --noEmit
npm run lint         # eslint, zero warnings tolerated
npm run format       # prettier --write
npm run test         # vitest (unit + integration)
npm run test:e2e     # playwright, profiles desktop-ci and mobile-ci
npm run build        # production build

npm run db:up        # local Postgres 18 in Docker — same major as production
npm run db:down
npm run db:generate  # drizzle-kit generate (after editing app/db/schema/*)
npm run db:migrate
npm run db:seed
```

## Stack

TypeScript on **Node 24** · **React Router 8** (framework mode, SSR) · **Drizzle** over **PostgreSQL 18** · **pg-boss** for jobs _inside the same Postgres_ · **SSE + LISTEN/NOTIFY** for exactly two channels · **better-auth** · Vitest + Playwright · managed containers in a US region.

Deliberately **not** here, and each absence is a decision: no Redis, no message broker, no managed realtime service, no transactional email in the MVP, no ORM-generated `any`.

## Layout

```
app/
  routes/ui/**      document routes. Exactly ONE may serve board data as SSR HTML.
  routes/api/**     resource routes — the only server API. Every file goes
                    through the endpoint factory so the generated registry can
                    drive the cache, silo, auth and topology suites.
  modules/<domain>/ the 13 domain modules from Phase 2. Organised BY DOMAIN,
                    never by technical type. A module owns its data, declares
                    the events it emits and consumes, and is reachable only
                    through its own public entry point.
  db/schema/**      Drizzle schema, one file per module
  db/migrations/**  generated SQL. NEVER hand-edited after merge.
  lib/money/**      the ONLY place money arithmetic is allowed
  lib/events/**     the 49-event contract, generated from contracts/events/
  styles/tokens/**  the design token layers
contracts/          JSON Schema — the source the event and channel types generate from
tests/e2e|integration|fixtures
docker/             local Postgres
```

## Conventions

- **Code, schema, comments, commits and technical docs in English. UI strings in en-US.** Conversation with Jorge in Spanish.
- Named exports. `~/` maps to `app/`. `import type` for type-only imports (enforced).
- No `any`, implicit or explicit. `strict` plus `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` are on — index access is `T | undefined` and you must handle it.
- Errors: throw typed domain errors; the route boundary turns them into a status. **Never** `catch {}` to make a test pass.
- File names `kebab-case.ts`, React components `PascalCase.tsx`, one component per file.

## Money and time

- **Money is `bigint` cents behind the branded `Money` type.** `Number(`, `parseFloat(` and `Math.round(` are build errors outside `app/lib/money/**`. Money crosses JSON as a **string of whole cents**, never a JS number. The client performs no money arithmetic, ever.
- Annualisation is server-side only. Final Expense sells monthly, Earnings are annual: without the ×12 the public board is wrong by a factor of twelve.
- **The undo window is 5000 ms and lives in `app/styles/tokens/timing.ts`.** It has four representations (TS, CSS, the SQL predicate behind the public projection, the celebration scheduler) generated from that one source. Two intervals exist and they are **never** given one name: `undo_deadline` (5000 ms, the celebration claim) and `projection_reveal_delay` (5500 ms, the public predicate). Confusing them either kills every celebration or reveals an undoable win on a public board.
- Timestamps are `timestamptz`. Three timezone rules exist and they are distinct: **tenant business** (stamps `period_key`), **user display** (formats what a human reads), **lead-local** (decides the legal calling window).

## Data rules

- **Every table carries `tenant_id` as the leading primary-key column, and every foreign key is composite.** A cross-tenant reference is structurally impossible to write.
- **Every table has RLS with `FORCE`, and every policy declares `USING` _and_ `WITH CHECK`.** A `USING`-only policy scopes reads and leaves writes unscoped: a seller writes a row owned by someone else, the write succeeds, the row vanishes from their own view, and nobody ever finds out. The public corpus is full of `USING`-only examples — that is exactly why this is a build gate, not a convention.
- **Cross-silo access returns owner-scoped not-found. Never 403** — a 403 confirms the record exists.
- **`earnings_ledger`, `audit_log` and `consent_ledger` are append-only**, by trigger _and_ by revoked privilege. The ledger is forward-only: **there is no recompute job**, by design. Corrections are compensating appends through the admin void/adjust surface.
- The win and loss gates bind to **`stage_type`** (`open | earning | lost`), never to a stage name. Renaming a column must change nothing. Enforced server-side on every path: drag, move-sheet, keyboard, wrap-up, raw API.
- Migrations are never edited after merge. There are no down migrations — **rollback is the previous image.**

## UX rules that are not negotiable

- Every surface ships **empty, loading, error and no-permission** states. A feature without them does not exist.
- Optimistic UI with a 5-second undo instead of confirmation dialogs, where it is safe. **If the server disagrees with the optimistic state, the card corrects AND a visible message appears** — a silent correction is how a seller learns to distrust the board.
- Skeletons, not spinners. Drag on desktop only (`≥1024px` and `pointer: fine`); move-sheet everywhere else and for keyboard and assistive technology.
- Components read the **semantic** token layer only. A `--p-*` primitive outside `app/styles/tokens/` fails the build. Hex literals live in exactly one file.
- WCAG 2.1 AA is a gate: visible focus, keyboard reachable, axe-core with zero serious or critical findings.

## Definition of Done

A story is done when: all states are built · permissions enforced **server-side** · the Given/When/Then acceptance test passes · performance is inside budget · en-US microcopy reviewed · events emitted match the canonical catalog · `npm run verify` is green.

**An event outside the canonical 49 is a bug, not a feature.**

## Performance budgets — these break the build

API p95 < 300 ms · global search < 200 ms · LCP < 1.5 s with 500 leads · interaction feedback < 100 ms · drag at 60 fps with no long task over 50 ms.

The approved numbers (250 KB gzip and 2.0 s TTI) are **mutually unsatisfiable**, so errata E6 struck them: the measurement fixes the number, not the aspiration. **The gate that measures is Sprint-0 Gate 11**, not Gate 8 — G13 published that correction and this line used to carry the old one.

- **Bundle: MEASURED and enforced (2026-08-02).** `perf-budgets.json` carries P12 (initial JS, pipeline route) and P13 (initial CSS), checked by `npm run perf` inside `npm run verify`. The measurement was 108 KB gzip against a struck 250 KB.
- **TTI: still unset.** P20 is declared with a null value and blocked on the nightly Lighthouse tier and the `perf-500` fixture. **Gate 11 is half closed.**
- **A null budget in an enforced tier fails the build, and now that is true rather than merely written.** Until 2026-08-02 no such check existed anywhere in the tree — the build was green because nothing measured. Every row is `monotonic_down`: tighten freely, loosen deliberately. Moving the loosening refusal into Postgres (`ref.ci_ratchet`, `05c` §10.0.1) is **not built yet**, so today loosening a value is still a file edit.

## Workflow

1. Read `CONTEXT.md`. Check `docs/05-architecture.md` **§0.2 errata** and **Part I rulings** before designing anything — they outrank every other document, including Phase 2–4.
2. Build. Run `npm run verify` before committing.
3. Update `CONTEXT.md` when a decision is made, at the close of every session.
4. Phase gates are Jorge's. Never advance a phase without an explicit OK.

**Model and effort by task type:** implementing a specified story → Sonnet, medium · migrations and anything touching money, consent or the silo → Opus, high · architecture or a reversal of a signed decision → Opus, maximum · repetitive verification → Haiku.

**Never estimate person-hours, days, sprints or team effort.** This project is built by vibecoding; the only permitted notion of build cost is relative technical complexity (simple / medium / high) with its risks and dependencies.

## What NOT to do

- Do not add a push transport. SSE carries **exactly two** channels — live call state and tenant banners. Everything else is conditional-GET polling, and **the poller never stops when push is connected: push is a hint, the poll is the truth.**
- Do not let an automation close a deal or write to the leaderboard.
- Do not add a recompute job for the ledger.
- Do not return 403 for a record a seller does not own.
- Do not write to the timeline; it is a derived projection.
- Do not put money in a `number`, in a URL, or in a client-side calculation.
- Do not invent an event name. Do not add a table without RLS, a policy and a registry row.
- Do not weaken a budget, a ratchet or an exception list to make a build pass — that is the failure mode this whole design exists to prevent.
- Do not build a blank-canvas automation builder. Automations are a closed, curated catalog.
