---
name: db-migration
description: Write and land a database migration safely. Use for any schema change — a table, column, index, policy, trigger or grant. In this project the database is the enforcer of both seller isolation and the money record, so a migration is the highest-consequence change type there is.
---

# Writing a migration

## 1 · Change the schema, then generate

Edit `app/db/schema/<module>.ts` and run `npm run db:generate`. **Never hand-write the migration file, and never edit a generated one after merge.**

What Drizzle will not generate for you — RLS policies, `FORCE`, grants, append-only triggers, partial uniques, `CHECK` constraints — goes in an explicit SQL block in the same migration. It is part of the schema, not an afterthought.

## 2 · The non-negotiables, every time

- `tenant_id` as the **leading primary-key column**; every foreign key **composite**.
- `ENABLE` **and** `FORCE ROW LEVEL SECURITY`.
- Every policy declares `USING` **and** `WITH CHECK`. This is the one that will bite: the public corpus is full of `USING`-only examples, and a `USING`-only policy lets a seller write a row owned by someone else with no error anywhere.
- New relation registered, and created in a **managed schema** — not the default one.
- Money columns are `bigint` cents or `numeric`, never a float, and any new money column gets `UPDATE` revoked from the app role plus a definer that appends to the ledger in the same transaction.
- Grants and hardening **re-applied by this migration**, including for any new partition.
- Natural keys get real `UNIQUE` constraints.

## 3 · Review before you land it

Run **`db-guardian`**. It reads for the failures that have no symptom. Do not skip it because the change looks small — the smallest diffs in this repository are the dangerous ones: a missing `WITH CHECK` is twelve characters.

## 4 · There is no down migration

Rollback is the previous image, not a reverse script. So:

- Additive first. A rename is add → backfill → switch reads → drop, across separate deploys.
- Never drop a column in the same deploy that stops writing it.
- A destructive statement needs an entry on the destructive allowlist with a written reason.

## 5 · Test it

Apply to a clean database · apply on top of the previous schema · assert the new policies actually deny (a policy that permits everything passes a naive test) · if it touches money, assert the engine refuses a direct update.

## Done when

Migration applies clean on both paths · `db-guardian` passes · `npm run verify` green · `CONTEXT.md` records the decision if the change alters a documented behaviour.
