---
name: demo-data
description: Generate or repair the seeded demo tenant used for development and for the ten-minute sales demo. Use when setting up an environment, when the demo data no longer supports a protected item, or before showing the product. The demo has hard mechanical requirements that were derived from real demo failures, not from taste.
---

# Seeding the demo tenant

This is not decorative. Two rehearsals of the Phase-4 demo failed on the data rather than the software, and the fixes are now requirements.

## The requirements, and why each exists

- **12–15 sellers.** With three there is no podium, no top-ten, and no self-row with neighbours — which is to say, the differentiator does not appear. The Phase-3 story said three; it was struck.
- **A lead outside its local calling window at whatever hour the demo runs.** This is a **seeding-time computation against the current clock**, never a fixed timestamp. The original demo could not show the compliance block between midday and 5pm Eastern, which is when demos happen.
- **A silo-proof URL.** The runbook includes opening another seller's record by direct URL and getting not-found. Isolation is the second thing a buyer asks about; showing it beats saying it.
- **Its own tenant**, never a flag on the real one.
- **Idempotent.** Re-running must converge, not duplicate. A demo that degrades every time it is run is a demo nobody re-runs.
- **Visibly marked**, so a demo record can never be mistaken for a real one.
- **Refuses to run against a live account.** Enforced by a database role, not by an environment-variable check — an environment check is a convention, and conventions are what this project does not rely on.

## What good demo data looks like

Realistic US names, real area codes matching real states, and a spread of lead sources that makes the source report say something. Enough history that the leaderboard has a shape and the podium has a gap worth narrating. At least one lead going cold, one meeting with a no-show, one recent win inside living memory. Money figures that are plausible for Final Expense — three digits monthly, four digits annualised — because a board full of round thousands reads as fake.

## Do not

Seed a value the product cannot produce · seed directly into the Earnings ledger by any path other than the real gate · use a fixed "now" · leave the demo tenant reachable from a real seller's session.

## Done when

The seeder runs twice with identical results · every one of the ten protected demo items has the data it needs · the calling-window lead is blocked at the current hour · the silo URL returns not-found.
