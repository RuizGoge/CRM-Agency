# CRM Leads

A lead pipeline and a public **Earnings** leaderboard for a US sales team of ~50 reps.

Each seller works an isolated book — their own leads, their own board, their own calls. Calls and SMS run through Aloware. The differentiator is the leaderboard: a shared, real-time Earnings board that no major CRM ships natively.

Built with Claude Code. Specification-first: Phases 0–5 produced the requirements, the MVP scope, the experience and the architecture before a line of code existed. All of it is in [`docs/`](docs/).

## Requirements

- Node **24+**
- Docker (local PostgreSQL 18)

## Setup

```bash
npm install
cp .env.example .env     # fill in SESSION_SECRET
npm run db:up            # PostgreSQL 18 on :5432
npm run db:migrate
npm run dev              # http://localhost:3000
```

Development costs **nothing**: everything runs locally, with no provider account and no free-tier terms to comply with. Production starts at ~USD 26/month.

## Quality

```bash
npm run verify           # typecheck + lint + format + tests — green before every commit
npm run test:e2e         # Playwright, profiles desktop-ci and mobile-ci
```

## Architecture in ten lines

TypeScript end to end on React Router 8 (SSR), Drizzle over PostgreSQL 18. Background jobs are pg-boss **inside the same database** — no Redis, no broker. The app ships as one image running up to three processes (`web`, `worker`, `ingest`); the split is a single environment variable, so a cheap single-process launch can separate later without a redesign.

Seller isolation is enforced at the row level in the database, not in the application: every table carries `tenant_id` as its leading key, every policy declares both `USING` and `WITH CHECK`, and a cross-silo request returns not-found rather than forbidden. The Earnings ledger is append-only by trigger _and_ by revoked privilege, forward-only, with no recompute path — corrections are compensating entries. Money is integer cents behind a branded type that the linter refuses to let become a float.

Modules communicate through a canonical catalog of 49 events with a mandatory envelope; a name outside that catalog fails to compile.

| Document                                                       |                                                                         |
| -------------------------------------------------------------- | ----------------------------------------------------------------------- |
| [`docs/05-architecture.md`](docs/05-architecture.md)           | Rulings, errata, declared residual risk, and the six architecture parts |
| [`docs/05b-data-model.md`](docs/05b-data-model.md)             | 45 tables, ER diagram, isolation design                                 |
| [`docs/05c-closure-register.md`](docs/05c-closure-register.md) | What the reviewers found and how it was closed                          |
| [`docs/adr/`](docs/adr/README.md)                              | 92 architecture decision records                                        |
| [`docs/02b-integration-map.md`](docs/02b-integration-map.md)   | The 49-event catalog                                                    |
| [`docs/03-mvp-definition.md`](docs/03-mvp-definition.md)       | The 68 MVP items, scored out of 549                                     |
| [`docs/04-ux-flows.md`](docs/04-ux-flows.md)                   | Normative UX rulings and the end-to-end flows                           |
| [`CLAUDE.md`](CLAUDE.md)                                       | Conventions and the rules that are not negotiable                       |
| [`CONTEXT.md`](CONTEXT.md)                                     | Living project memory — current state and every decision                |

## Status

Foundation. The repository is scaffolded and the quality pipeline is green; no product feature is built yet.

**Sprint 0 runs before any cloud resource is created.** Its first gate verifies that the hosting provider offers a US region on the plan we intend to buy — if it does not, the stack decision reverses. Its other gates measure what cannot be known from a document: how Aloware actually behaves, whether the front-end budgets are reachable, and how the system survives a webhook retry storm.
