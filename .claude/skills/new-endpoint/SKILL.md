---
name: new-endpoint
description: Add a server endpoint to the CRM — a resource route under app/routes/api with validation, tenant and owner scoping, the correct denial shape, cache headers, events and tests. Use whenever a new API surface is needed, or when an existing handler is being extended with a new operation. Covers the four mistakes that leak data or money silently.
---

# Adding an endpoint

The highest-frequency task in this project, and the one where a small omission is a data leak with no symptom. Work the steps in order; do not reorder them, because each one closes a failure the previous one opens.

## 1 · Decide it belongs here

Server API lives **only** in `app/routes/api/**`. UI routes do not export loaders or actions — with exactly one whitelisted exception, the route that serves board data as SSR HTML. If you are adding a second, stop: that is an architectural change, not an endpoint.

## 2 · Declare it through the endpoint factory

Every module in `app/routes/api/**` exports the result of the factory, never a hand-written `loader` or `action`. The factory's metadata is what the generated route registry reads, and five CI suites iterate that registry — cache, silo, auth, topology, not-found. **A hand-written handler is invisible to all five.**

Declare: the HTTP method · the auth scope (`seller` / `supervisor` / `tenant_admin`) · the process role that may mount it (`web` / `ingest`) · the cache policy · whether it writes.

## 3 · Validate at the edge

Parse the input with a schema before anything else. Reject with a typed error, not a thrown string. Never trust a path parameter to be a well-formed id.

## 4 · Scope, and get the denial shape right

- Open a transaction and set the scope context as its **first statement**. Never rely on a context left behind by a previous request on the same pooled connection.
- **Cross-silo → owner-scoped not-found. Never 403.** A 403 confirms the record exists.
- The only legitimate 403 is a supervisor with real read access attempting a write.
- If this endpoint takes **no record id** — a list, the board, search — say so out loud in your summary. The registry silo suite cannot test it by id substitution, so it needs a purpose-built two-seller fixture asserting zero rows. Global search is the strictest case: it must never return, count, or hint at another seller's records.

## 5 · Cache headers

Owner-scoped responses are **private**. A shared cache header on an owner-scoped response serves one seller's data to another, and it produces no visible symptom anywhere. Pollable GETs use conditional requests with an ETag so the steady state is a 304 — that is what makes 5-second polling affordable.

## 6 · Money and events

- Money crosses as a **string of whole cents**. The client never receives a number for money and never computes with it.
- Emit only canonical event names. Register the consumers — an unregistered consumer never runs, by construction.
- Only the ledger and the gate consumers run inside the transaction. Everything else is post-commit, off the response path.

## 7 · Pagination

Keyset only, with an opaque cursor. No `OFFSET`, and no general-purpose filter grammar.

## 8 · Tests before you call it done

- The happy path.
- **Seller B requests Seller A's record → not-found, and the body reveals nothing.**
- Validation rejects malformed input with the typed error.
- If it writes: replaying the same natural key is accepted as **success**, not as an error.
- If it touches money: the amount is exact, and a direct write bypassing the definer is refused by the engine.

## Done when

`npm run verify` is green · `event-checker` passes · `security-auditor` passes if the endpoint touches auth, permissions, personal data or a compliance gate · the endpoint appears in the generated registry.
