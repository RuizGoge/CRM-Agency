# G1 · Platform truth probe — what the managed database actually gives us

> **Status: 🟡 PARTIALLY CLOSED.** The half that is a property of **PostgreSQL 18 itself** is closed, with a planner proof. The half that is a property of **the provider** cannot be answered without a Render instance and stays open.
>
> Run 2026-08-01 against `postgres:18-alpine` (server **18.4**) in local Docker, the same major version as the production target.

## Verdict by assertion

G1 asserts six things. Here is where each stands.

| | Assertion | Status |
|---|---|---|
| **a** | Real `max_connections`, read not assumed | 🔴 **Open** — local reads **100**, which is the Docker default and says nothing about Render Basic-1gb |
| **b** | Rolling redeploy under load produces zero `too many connections` | 🔴 **Open** — needs the provider |
| **c** | Bundled PgBouncer in **transaction mode** preserves `SET LOCAL` inside a transaction and does not leak it between requests | 🔴 **Open** — needs the provider. **This is the one that matters most**: it is the silo's load-bearing assumption |
| **d** | Per-pool `max` pinned against the measured number with 2× headroom | 🔴 **Open** — derives from (a) |
| **e** | Extension availability: `pg_trgm`, `citext`, **`btree_gin` with a uuid opclass**, `uuidv7()` | ✅ **CLOSED — all present, with proof** |
| **f** | Whether `CREATE EVENT TRIGGER` is granted | 🔴 **Open** — the local role is superuser, so a local pass proves nothing. **E9 already removed the design's dependence on it**; it stays belt-and-braces |

---

## ✅ G1e — closed, and the deciding question answered YES

### Availability

| Extension | Version available | Installs cleanly |
|---|---|---|
| `pg_trgm` | 1.6 | ✅ |
| `citext` | 1.8 | ✅ |
| `btree_gin` | 1.3 | ✅ |
| `btree_gist` | 1.8 | (present, unused today) |
| `pgcrypto` | 1.4 | (present) |
| `uuid-ossp` | 1.1 | (present, not needed — see below) |

### The deciding probe: is there a GIN opclass for `uuid`?

This is the open question carried since §3215 and listed at §9.7 as *"decides whether the primary search index puts the ownership predicate inside the index or after retrieval."*

```
 index_method | opclass  | input_type | is_default
--------------+----------+------------+------------
 gin          | uuid_ops | uuid       | t
```

**Yes — and it is the default opclass.** The documented fallback (*plain trigram GIN plus an owner recheck, "acceptable at 25k contacts but it must be measured"*) is **not needed** and does not have to be built.

### The proof, because an opclass existing is not the same as the planner using it

A 20,000-row fixture across 50 sellers, indexed exactly as the architecture wants it — the ownership predicate **inside** the index key, alongside the trigram:

```sql
CREATE INDEX probe_contact_search_idx
  ON probe_contact USING gin (tenant_id, owner_user_id, full_name gin_trgm_ops);
```

The index builds, and the planner uses all three columns **as an index condition, not as a post-retrieval filter**:

```
Bitmap Heap Scan on probe_contact
  Recheck Cond: ((tenant_id = ...) AND (owner_user_id = ...) AND (full_name ~~* '%Contact 1007%'))
  ->  Bitmap Index Scan on probe_contact_search_idx
        Index Cond: ((tenant_id = ...) AND (owner_user_id = ...) AND (full_name ~~* '%Contact 1007%'))
```

All three conditions appear in `Index Cond`. Ownership filtering happens at the index level, which is precisely the property the 200 ms global-search budget was designed around. (The `Recheck Cond` line is the ordinary lossy-bitmap recheck of a Bitmap Heap Scan, not an ownership recheck.)

### `uuidv7()` is native

`uuidv7`, `uuidv4` and `gen_random_uuid` are all in `pg_catalog`. **No extension is required for v7 UUIDs** — `uuid-ossp` is available but unnecessary, and should not be added.

### The one caveat on this result

This was measured on the official `postgres:18-alpine` image. `uuid_ops` for GIN is a property of the `btree_gin` **extension**, so the result transfers to any PostgreSQL 18 that ships that extension. What still needs one line of confirmation on the real instance is whether **Render exposes `btree_gin`** at all — it is standard contrib and almost certainly yes, but "almost certainly" is not the standard this gate holds itself to. Confirm it in the same session that measures `max_connections`.

---

## 🔴 What is still open, and why it cannot be faked locally

**(c) is the important one.** The silo depends on `SET LOCAL app.tenant_id` surviving inside a transaction and *not* surviving between requests on a pooled connection. Docker gives us direct connections with no pooler, so a local pass would be a false green — it would test a configuration production does not run. This must be measured against Render's bundled PgBouncer in transaction mode, and G4(c) then asserts that a pg-boss job running immediately after a request on the same pooled connection inherits none of that request's context.

**(a), (b), (d)** are all downstream of the provider's real connection ceiling. The design sustains ~24 connections (3 roles × max 8) which transiently doubles to ~48 during a rolling redeploy; whether that fits is a fact about Basic-1gb, not about Postgres.

**(f)** is moot as a dependency. **E9 already removed the design's reliance on event triggers**, and `security.harden()` as the last statement of the pre-deploy migration remains the primary mechanism. If Render grants `CREATE EVENT TRIGGER`, it is added as belt-and-braces and never as the primary.

---

## Defect found and fixed: the Phase-6 compose file had never been run

`docker/docker-compose.yml` mounted the data volume at `/var/lib/postgresql/data`, which is the **PostgreSQL ≤ 17** convention. From 18 the official image stores the cluster in a major-version-specific subdirectory and **refuses to start** when a volume sits at the old path, entering a restart loop with this message:

> *"in 18+, these Docker images are configured to store database data in a format which is compatible with `pg_ctlcluster` … Counter to that, there appears to be PostgreSQL data in: `/var/lib/postgresql/data` (unused mount/volume)"*

Fixed by mounting the parent (`crm-pgdata:/var/lib/postgresql`), with a comment on the line saying why, because reverting it silently breaks `npm run db:up` for everyone.

**What this says about the Phase-6 gate.** `CONTEXT.md` recorded the repository foundation as verified green. That was true of what it covered — typecheck, lint, format, 14 tests, build, dev server. **It did not cover bringing the database up, and the compose file had therefore never been executed.** A configuration file that has never run is not verified infrastructure; it is a plausible-looking document. This is the same class of gap the whole gate ladder exists to find, and it was found on the first gate that actually needed a database.
