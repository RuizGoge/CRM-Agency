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

Setting `MIGRATION_DATABASE_URL` to a `crm_migrator` credential — which also needs `ALTER ROLE crm_migrator WITH LOGIN` and a password set out of band, since it is `NOLOGIN` today — makes `security.property_b_grade()` return `(b)`, and `property-b.test.ts` go red so the claim in `CLAUDE.md` gets updated in the same change. **That is the whole remaining distance.**
