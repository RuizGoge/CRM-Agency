# Which migrations actually need superuser — measured

**2026-08-13.** Closes the investigation R4 names ("deploy-credential isolation, audited at Sprint 0") and the one thing standing between this tree and property (b).

## The question

`security.property_b_grade()` reports `(a)+(c)` because migrations run as `crm`, a superuser. Running them as `crm_migrator` instead would make the grade read `(b)`. The objection was that some migrations might need superuser and the failure mode is a broken deploy — so: **which ones, exactly?**

## The answer

**72 of the 75 migrations apply cleanly as `crm_migrator`.** Three do not, and none of them needs superuser for its *schema* work — all three want authority over roles or ownership:

| migration | statement | what it needs |
|---|---|---|
| `0018:18` | `ALTER ROLE crm_app WITH LOGIN` | `CREATEROLE` |
| `0056:34` | `ALTER ROLE crm SET idle_in_transaction_session_timeout` | superuser — `crm` **is** one, and only a superuser may alter one |
| `0056:39` | `ALTER ROLE crm_ci SET idle_in_transaction_session_timeout` | `CREATEROLE` |
| `0075:108` | `ALTER TABLE authz.ddl_authorization OWNER TO crm` | membership in `crm` |

`0000_bootstrap` is excluded by construction: it creates the roles and installs `citext`, `pg_trgm` and `btree_gin`. Bootstrapping a cluster is a one-time superuser act and every design here already assumes one.

## Why the switch is viable anyway

**All three are already applied.** A deploy replays nothing — drizzle runs only migrations the journal has not recorded — so switching the credential today costs nothing for 0018, 0056 and 0075. What it constrains is the future: **a migration that alters a role can no longer be part of the ordinary chain.** That is a small price and arguably a correction, since altering a cluster role is not schema work.

A **fresh install** — a new environment, or a restore drill — still needs the superuser bootstrap plus those three statements run out of band. That is the same shape E1b already mandates for the authorisation row itself.

## The finding about 0075, stated rather than quietly fixed

The migration that *grades* property (b) is one of the three an isolated deploy cannot apply. `ALTER TABLE … OWNER TO crm` requires membership in `crm`, and `crm_migrator` has none — which is the entire point of the table.

That is not a bug so much as the property showing up honestly: **the authorisation infrastructure cannot bootstrap itself under the credential it exists to constrain.** E1b says the same thing about the row.

It is **not fixed here, deliberately.** 0075 is merged, and this project's rule is that migrations are never edited after merge — rollback is the previous image. Making it conditional would mean dev and any future environment holding different versions of an applied migration, which is the failure that rule exists to prevent. The options, for Jorge:

1. **Leave it.** On a fresh install run that one `ALTER TABLE … OWNER TO crm` out of band, beside the bootstrap. Consistent with E1b, costs one line in a runbook.
2. **A new migration** that re-asserts the ownership conditionally, so a fresh install under `crm_migrator` skips it and the grade honestly reports `(a)+(c)` until somebody runs the line. Self-consistent, and adds a migration whose only job is to tolerate its own absence.

## How this was measured

Four passes, because the first three were confounded and the data said so each time:

1. **Every file as `crm_migrator` from an empty database.** 0000 failed (it creates roles), so `crm` owned the schemas and 27 later files failed with `permission denied for schema security` — a cascade of the first failure, not a finding.
2. **Bootstrap as `crm`, then hand over the schemas.** Still cascaded: `table_registry`, `schema_policy` and `harden()` are objects *inside* those schemas and were still owned by `crm`.
3. **Full handover — schemas, tables and functions.** 45 files still reported failing, all with an empty error string. They had not failed: `psql` writes `NOTICE` to stderr, and the probe treated any stderr output as an error.
4. **Counting only lines starting with `ERROR:`.** 72 ok, 3 real.

The reproducible version is pass 4. Worth keeping as method: three of the four passes produced a confident, wrong answer, and each was caught by the shape of the result rather than by re-reading the script.

## What it unblocks

Setting `MIGRATION_DATABASE_URL` to a `crm_migrator` credential — which also needs `ALTER ROLE crm_migrator WITH LOGIN` and a password set out of band, since it is `NOLOGIN` today — makes `security.property_b_grade()` return `(b)`, and `property-b.test.ts` go red so the claim in `CLAUDE.md` gets updated in the same change.

~~**That is the whole remaining distance.**~~ **It was not, and the sentence was wrong the day it was written (struck 2026-08-14).** Isolating the credential is the *placement*: the deploy can consume an authorisation it cannot create. It makes nothing *cost* one. Measured the morning after the switch, under the isolated credential, with the grade reading `(b)`:

```
SET ROLE crm_migrator; DROP POLICY p_app ON app.contact;                    -- succeeded
SET ROLE crm_migrator; ALTER TABLE app.contact NO FORCE ROW LEVEL SECURITY; -- succeeded
SET ROLE crm_migrator; DROP TABLE app.contact CASCADE;                      -- succeeded
```

## The fourth out-of-band statement (2026-08-14)

The three statements above are things a migration *wants* and cannot have. This is the opposite: something the deploy must never be able to run at all.

`scripts/ddl-guard.sql`, applied by `npm run db:guard` **as the owner**. It installs three event triggers and two row triggers; a protected change must then spend a row in `authz.ddl_authorization`, which `crm_migrator` can read and consume and cannot create.

**It cannot be a migration, and that is the property rather than a gap.** `CREATE EVENT TRIGGER` requires superuser and the deploy is no longer one. The authorisation infrastructure cannot bootstrap itself under the credential it exists to limit.

Measured, all as `crm_migrator`:

| attempt | result |
|---|---|
| `DROP EVENT TRIGGER` / `ALTER EVENT TRIGGER … DISABLE` | `must be owner of event trigger` |
| `SET event_triggers = off` | `permission denied to set parameter` |
| `CREATE OR REPLACE` any `authz.*` function | `permission denied for schema authz` |
| `INSERT INTO authz.ddl_authorization` | `permission denied for table` |
| re-touching an already-spent authorisation | `AUTHZ002: already spent` |

That last row was **a hole I built and then measured.** The guard asks "did this transaction consume an authorisation?" with `age(xmin) = 0`, and the deploy must hold `UPDATE` or it could not consume anything — so re-touching any spent row satisfied it, and spent rows are never deleted. From the first authorisation onward the deploy authorised itself for ever, with every other refusal still passing its test. Closed by making a spent row immutable.

## The fifth statement, and the credential switch had silently broken the deploy (2026-08-14)

`drizzle-kit migrate` under `crm_migrator` fails with **`permission denied for schema drizzle`** on any database whose `drizzle` schema was created by `crm` — which is every database bootstrapped before the switch. **No migration could be applied at all.**

Three things hid it simultaneously, and each will hide the next one:

1. **`drizzle-kit migrate` exits 1 and prints nothing.** No message, no cause, just a spinner and a status code. The error above came from drizzle-orm's migrator, called by hand.
2. **`npm run verify` does not run the deploy.** It typechecks, lints, tests and measures budgets; the one command that would have failed is the one it never calls.
3. **The grade read `(b)` throughout.** Credential isolation was real — the deploy genuinely could not authorise itself. It also could not deploy, and the grade has no opinion about that.

Fixed by `scripts/deploy-credential.sql`, applied by `npm run db:guard`: the `drizzle` schema and its bookkeeping table are handed to `crm_migrator`. It cannot be a migration — drizzle opens that table *before* applying anything, so the fix could never be recorded.

## The primary enforcement point, built second (2026-08-14)

`05c` §11.11.3 is titled *"Platform reality, and it is why this cannot be the primary"*; §11.11.4 is *"the digest chain, which needs no superuser and is the primary."* The guard above is §11.11.3. Migration **0076** is §11.11.4, and none of it existed.

It hashes the protected surface **by class** — every RLS policy, every `t_immutable_*` trigger, every SECURITY DEFINER body, every RLS flag, partitions excluded — and refuses the deploy (`PO001`) when one is removed or changed without an authorisation. Every process re-checks the digest at boot (`BOOT017`/`BOOT018`). No superuser anywhere.

**The two are not redundant**, and the sharpest case proves it: `ALTER TABLE app.earnings_ledger DISABLE TRIGGER t_immutable_earnings_ledger` switches off the append-only enforcement on the money record. The event-trigger guard lets it through — bare `ALTER TABLE`, RLS untouched, the reported identity is the table. PO001 names it.

### What it still does not close

- **R4 is untouched.** A superuser disables the event trigger in one statement. What changed is that the *deploy* is no longer a superuser, so R4's actor is a human at a console rather than every migration.
- **R2 decides whether this exists in production at all, and it is still unmeasured.** If Render grants no superuser, the guard cannot be installed there. `npm run db:guard` refuses under a non-superuser credential rather than half-installing, and the grade records `(a)+(c)` for a database that was migrated but never armed.
- **`DROP TRIGGER` on `security.table_registry` is not gated.** `crm_migrator` owns that table, so it can remove the row trigger that protects the registry. Two statements instead of one, and the first is visible in a diff — not `(b)` on its own.
- **The circular attack, which §11.11.4 names and this tree cannot close.** The deploy role owns `security.protected_object`, so a migration that weakens something *and* rewrites its own baseline in the same deploy produces a self-consistent digest and passes PO001. The corpus closes it with the seal chain of §7.6.2 — `ci/seal-manifest.jsonl`, `security.seal`, boot comparing manifest heads. **Measured 2026-08-14: none of it exists.** What holds is every weakening that does not also rewrite its own baseline — which is every accidental one — plus, where the event triggers are installed, an in-transaction refusal that does not consult the baseline at all.
