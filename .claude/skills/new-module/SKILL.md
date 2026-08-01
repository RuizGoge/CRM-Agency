---
name: new-module
description: Build out one of the thirteen domain modules end to end — schema, events, permissions, routes, UI, tests and docs. Use when starting work on a module that exists as a directory but has no implementation, or when adding a genuinely new domain area. Enforces module boundaries so the system stays an organism rather than a pile of screens.
---

# Building a domain module

The thirteen module directories under `app/modules/` come from the Phase-2 functional map. They are empty on purpose: each is built when its turn comes in the sprint order.

The principle that makes this worth a procedure: **modules do not share tables, they share events.** A module that reaches into another module's data is how a system becomes unmaintainable — and here it is also how the seller silo and the money record get bypassed.

## 1 · Read the module's own specification first

`docs/02-modules/NN-<module>.md` is the detailed spec, including the adversarial critique of it. `docs/03-mvp-definition.md` tells you which of its features are actually in the MVP — most are not. `docs/03-mvp-stories.md` has the Given/When/Then.

Then run **`precedence-checker`**. Several module specs contain statements Phase 5 struck; building from the older text is this project's most likely failure.

## 2 · Own your data, and only your data

Schema in `app/db/schema/<module>.ts`. The module owns its entities and **nothing else touches those tables directly**. If you need another module's data, you consume its events or call its public entry point.

Two ownerships that are absolute and were decided for good reasons: the **Earnings ledger** has a single owner and Pipeline only emits into it, never totals; **Contacts** is the single consent authority and every other module is an enforcer.

Run **`db-guardian`** on the schema before writing a line of application code.

## 3 · Declare the event contract

List what the module emits and what it consumes, from the canonical 49. Register consumers — an unregistered consumer never runs. Run **`event-checker`**.

## 4 · Permissions

Write the role × action matrix for this module: seller, supervisor (read-only global), admin. Enforce it **server-side**; the UI may hide, but hiding is not enforcement.

## 5 · Routes, then UI

Use the **`new-endpoint`** skill per endpoint and **`new-component`** per component. Do not invent a second way to do either.

## 6 · Tests

Domain logic gets real coverage — stage transitions, gates, dedupe, ledger writes, silo scoping. Use **`story-to-test`** to turn each Given/When/Then into an executable assertion. If the module touches a protected demo item, its assertion is named and may never be skipped.

## 7 · Update the record

`CONTEXT.md` gets the decisions taken and their reasons. Run **`context-keeper`**.

## Done when

Every MVP story for the module passes · all four UI states exist on every surface · permissions enforced server-side · events canonical and registered · `npm run verify` green · `ux-reviewer` passes on the finished surfaces.

## Do not

Reach into another module's tables · write to the timeline (it is derived) · let an automation close a deal or write to the leaderboard · add a feature that is in the functional map but out of the MVP, however small it looks.
