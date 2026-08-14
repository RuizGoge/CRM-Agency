import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { assertDdlGuardIsArmed } from '~/db/boot-assert'

import { TEST_URL } from './setup/urls'

/**
 * E1b's PROTECTION half — a protected change must spend an authorisation.
 *
 * 🔴 WHAT THIS FILE IS ABOUT, MEASURED ON 2026-08-14 BEFORE ANY OF IT EXISTED:
 *
 *     SET ROLE crm_migrator; DROP POLICY p_app ON app.contact;      -- succeeded
 *     SET ROLE crm_migrator; ALTER TABLE app.contact NO FORCE ROW LEVEL SECURITY;
 *                                                                   -- succeeded
 *     SET ROLE crm_migrator; DROP TABLE app.contact CASCADE;        -- succeeded
 *
 * Migration 0075 made the deploy role unable to CREATE an authorisation, and the
 * credential switch made that role the one that actually deploys. Neither made
 * anything cost an authorisation. Seller isolation was one statement away from
 * the role that runs migrations, and no screen anywhere would have changed.
 *
 * 🎯 EVERY TEST RUNS AS `crm_migrator`, VIA SET ROLE FROM THE OWNER. That is the
 * threat actor named in CLAUDE.md — "Claude writes a migration and nobody reads
 * the diff" — and asserting against any other role would be asserting about
 * somebody who was never the danger.
 *
 * ⚠️ AND HALF THIS FILE ASSERTS THAT THINGS STILL WORK, which is the half that
 * would have shipped a broken product. `security.harden()` issues DROP POLICY
 * and CREATE POLICY on every managed relation, and 0057 wired it to partition
 * CREATION — so a guard without the exemption below demands an authorisation
 * from the worker the night a new `event_outbox` day first appears. The event
 * transport would stop, at midnight, silently.
 */

let sql: postgres.Sql

beforeAll(() => {
  sql = postgres(TEST_URL, { max: 1, onnotice: () => {} })
})

afterAll(async () => {
  await sql?.end()
})

/** Thrown to roll back work that succeeded. Never escapes `asMigrator`. */
const ROLLED_BACK = 'ddl-guard-test-rollback'

/**
 * Runs `work` as `crm_migrator` inside a transaction that ALWAYS rolls back.
 *
 * Returns `undefined` when the work succeeded and the refusal message when it
 * did not — so a test reads as "this was allowed" or "this was refused, saying
 * X" rather than as exception plumbing.
 */
async function asMigrator(
  work: (tx: postgres.TransactionSql) => Promise<unknown>,
  setup?: (tx: postgres.TransactionSql) => Promise<unknown>,
): Promise<string | undefined> {
  try {
    await sql.begin(async (tx) => {
      // Minting happens as the OWNER, before the role drops — which is E1b's
      // shape: the authorisation is created by somebody the deploy is not.
      if (setup !== undefined) await setup(tx)
      // 🔴 `SET LOCAL`, NEVER A BARE `SET`, and this cost a red run to find.
      // A plain `SET ROLE` inside a COMMITTED transaction outlives it, and the
      // pool holds one connection — so the one test below that commits left the
      // session stuck as `crm_migrator`, and the next test's owner-only INSERT
      // came back "permission denied for table ddl_authorization". The failure
      // named the table, so it read as a missing grant rather than a leaked
      // role. `SET LOCAL` cannot escape its transaction.
      await tx.unsafe('SET LOCAL ROLE crm_migrator')
      await work(tx)
      throw new Error(ROLLED_BACK)
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return message === ROLLED_BACK ? undefined : message
  }
  return undefined
}

const authorise = (tx: postgres.TransactionSql): Promise<unknown> =>
  tx`INSERT INTO authz.ddl_authorization (purpose)
     VALUES ('ddl-guard.test.ts authorising exactly one protected change')`

describe('the guard is armed at all', () => {
  it('has three event triggers and the registry trigger, all enabled', async () => {
    // If this fails, every refusal below fails with it — so it is asserted
    // first and separately, to keep "not armed" from reading as "not enforced".
    const [row] = await sql<{ armed: number; registry: number }[]>`
      SELECT (SELECT count(*)::int FROM pg_event_trigger
               WHERE evtname IN ('authz_guard_policy', 'authz_guard_alter', 'authz_guard_drop')
                 AND evtenabled <> 'D') AS armed,
             (SELECT count(*)::int FROM pg_trigger
               WHERE tgname = 't_authz_guard_registry' AND NOT tgisinternal
                 AND tgenabled <> 'D') AS registry`
    expect(row?.armed).toBe(3)
    expect(row?.registry).toBe(1)
  })

  it('boots when armed, and REFUSES TO BOOT when it is not', async () => {
    // 🔴 BOTH ARMS, because a check that never refuses passes its test for ever.
    // This is the (c) half: the guard is installed out of band, so a database
    // that was migrated perfectly can simply not have it — restored from a
    // backup, moved to a new region, a fresh clone — and nothing in the
    // pipeline, the diff or `verify` would notice. It would work perfectly, with
    // seller isolation one statement from the deploy role.
    await expect(assertDdlGuardIsArmed(sql)).resolves.toBeUndefined()

    // Disabled inside a transaction and rolled back: event trigger DDL is
    // transactional, so the refusal can be exercised against the real objects
    // without leaving the database disarmed for the files that run next.
    let refusal: string | undefined
    await sql
      .begin(async (tx) => {
        await tx.unsafe('ALTER EVENT TRIGGER authz_guard_policy DISABLE')
        refusal = await assertDdlGuardIsArmed(tx).then(
          () => undefined,
          (err: unknown) => (err instanceof Error ? err.message : String(err)),
        )
        throw new Error(ROLLED_BACK)
      })
      .catch((err: unknown) => {
        if (!(err instanceof Error) || err.message !== ROLLED_BACK) throw err
      })

    // 🎯 AND IT SAYS *DISABLED*, NOT *MISSING*. Absent is "nobody ran
    // db:guard"; disabled needs superuser, so it is "somebody turned the
    // protection off". Those are different conversations and the message has to
    // pick the right one.
    expect(refusal).toMatch(/BOOT016.*DISABLED/s)
  })

  it('cannot be dropped or disabled by the deploy role', async () => {
    // 🔴 THE ANCHOR. An event trigger can only be created, altered or dropped by
    // a superuser, and `crm_migrator` is not one — measured, not assumed. This
    // is what makes the guard a gate the deploy cannot reach rather than one
    // more object in a schema it owns.
    expect(await asMigrator((tx) => tx.unsafe('DROP EVENT TRIGGER authz_guard_policy'))).toMatch(
      /must be owner/,
    )
    expect(
      await asMigrator((tx) => tx.unsafe('ALTER EVENT TRIGGER authz_guard_policy DISABLE')),
    ).toMatch(/must be owner/)
    expect(await asMigrator((tx) => tx.unsafe('SET event_triggers = off'))).toMatch(
      /permission denied to set parameter/,
    )
  })

  it('will not let the deploy role replace the guard functions', async () => {
    // They live in `authz`, where crm_migrator holds USAGE and not CREATE — the
    // schema 0075 put outside `own_to_migrator()`'s reach for this exact reason.
    expect(
      await asMigrator((tx) =>
        tx.unsafe(
          `CREATE OR REPLACE FUNCTION authz.consume_authorization(p_reason text)
           RETURNS void LANGUAGE plpgsql AS $$ BEGIN END; $$`,
        ),
      ),
    ).toMatch(/permission denied for schema authz/)
  })
})

describe('the three measured attacks, unauthorised', () => {
  it('refuses to drop a policy', async () => {
    expect(await asMigrator((tx) => tx.unsafe('DROP POLICY p_app ON app.contact'))).toMatch(
      /AUTHZ001/,
    )
  })

  it('refuses to switch off FORCE row level security', async () => {
    // 🎯 THE ONE A TAG LIST DOES NOT CATCH, and the reason the guard reads STATE
    // instead of parsing commands. The tag here is a bare `ALTER TABLE`,
    // indistinguishable from adding a column until you look at the result.
    expect(
      await asMigrator((tx) => tx.unsafe('ALTER TABLE app.contact NO FORCE ROW LEVEL SECURITY')),
    ).toMatch(/AUTHZ001.*row level security/s)
  })

  it('refuses to drop a registered table', async () => {
    expect(await asMigrator((tx) => tx.unsafe('DROP TABLE app.contact CASCADE'))).toMatch(
      /AUTHZ001.*app\.contact/s,
    )
  })

  it('refuses to ADD a policy that opens everything', async () => {
    // Dropping isolation and adding `USING (true)` are the same attack: policies
    // are OR'd, so one permissive policy makes every other one irrelevant. A
    // guard that only watched DROP would have been half a guard.
    expect(
      await asMigrator((tx) =>
        tx.unsafe(
          'CREATE POLICY p_wide ON app.contact FOR ALL TO crm_app USING (true) WITH CHECK (true)',
        ),
      ),
    ).toMatch(/AUTHZ001/)
  })

  it('refuses to reclassify a live table in the registry, which is not DDL at all', async () => {
    // 🔴 THE ROUTE AROUND EVERY EVENT TRIGGER. `security.table_registry` decides
    // what `harden()` generates: flip `contact` to `tenant_scoped_read` and the
    // next harden gives every seller every seller's leads, with no DDL written
    // anywhere. An event trigger cannot see an UPDATE, so this one is an
    // ordinary row trigger.
    expect(
      await asMigrator((tx) =>
        tx.unsafe(
          `UPDATE security.table_registry SET policy_class = 'tenant_scoped_read'
            WHERE table_name = 'contact'`,
        ),
      ),
    ).toMatch(/AUTHZ001.*table_registry/s)

    // And the delete-then-reinsert way around it.
    expect(
      await asMigrator((tx) =>
        tx.unsafe(`DELETE FROM security.table_registry WHERE table_name = 'contact'`),
      ),
    ).toMatch(/AUTHZ001.*table_registry/s)
  })

  it('refuses to replace security.harden(), which is how the exemption would be defeated', async () => {
    // 🎯 THE SEAM THIS CLOSES. `harden()` is exempt because the product needs it
    // to run unattended; so the way in is to make `harden()` do something else.
    // Replacing it costs an authorisation, which puts the seam behind the same
    // door as everything else.
    expect(
      await asMigrator((tx) =>
        tx.unsafe(
          'CREATE OR REPLACE FUNCTION security.harden() RETURNS void LANGUAGE plpgsql AS $$ BEGIN END; $$',
        ),
      ),
    ).toMatch(/AUTHZ001.*harden/s)
  })
})

describe('the product keeps working, which is the half that would have broken it', () => {
  it('lets security.harden() run with no authorisation', async () => {
    expect(await asMigrator((tx) => tx.unsafe('SELECT security.harden()'))).toBeUndefined()
  })

  it('lets the midnight tick create a partition and harden it', async () => {
    // 🔴 THE PRODUCT-BREAKING CASE. `app.ensure_event_partitions()` is what the
    // worker calls; 0057 made it harden only when it actually created something.
    // Drop a partition first so this run has work to do — otherwise it returns 0
    // and proves nothing, which is exactly what the first version of this test
    // did.
    const [part] = await sql<{ relname: string }[]>`
      SELECT c.relname FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'app' AND c.relispartition
         AND c.relname LIKE 'event_outbox_%' AND c.relkind = 'r'
       ORDER BY c.relname DESC LIMIT 1`
    expect(part?.relname, 'no outbox partition to exercise the tick with').toBeDefined()

    let made = 0
    const refusal = await asMigrator(async (tx) => {
      await tx.unsafe(`DROP TABLE app.${part?.relname ?? ''}`)
      const [row] = await tx<{ made: number }[]>`SELECT app.ensure_event_partitions() AS made`
      made = row?.made ?? 0
    })
    expect(refusal).toBeUndefined()
    expect(made, 'the tick did no work, so the harden path was never exercised').toBeGreaterThan(0)
  })

  it('lets retention drop a partition', async () => {
    // 🎯 `table_registry` IS THE PARTITION TEST, AND IT IS NOT A NAMING RULE.
    // Measured: 44 registry rows, 58 partitions, zero partitions carrying a row
    // of their own — `harden()` resolves a partition to its parent on purpose.
    // A pattern match on the table NAME would have been the obvious shape and
    // would have broken the first time somebody put a date in a table name.
    const [part] = await sql<{ relname: string }[]>`
      SELECT c.relname FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'app' AND c.relispartition
         AND c.relname LIKE 'event_outbox_%' AND c.relkind = 'r'
       ORDER BY c.relname LIMIT 1`
    expect(part?.relname).toBeDefined()
    expect(
      await asMigrator((tx) => tx.unsafe(`DROP TABLE app.${part?.relname ?? ''}`)),
    ).toBeUndefined()
  })

  it('lets an ordinary migration add a column and an index', async () => {
    expect(
      await asMigrator(async (tx) => {
        await tx.unsafe('ALTER TABLE app.contact ADD COLUMN guard_probe text')
        await tx.unsafe('CREATE INDEX guard_probe_idx ON app.contact (created_at)')
      }),
    ).toBeUndefined()
  })

  it('lets a migration add a NEW table, register it and harden it', async () => {
    // 🔴 INSERT ON THE REGISTRY IS DELIBERATELY FREE, AND THE FIRST DRAFT HAD IT
    // GATED. A new row describes a table that did not exist a moment ago, so it
    // cannot weaken isolation that was never there — while gating it would put a
    // hand-typed authorisation in front of every migration that adds a table.
    // Reclassifying a LIVE table is the dangerous one, and that is an UPDATE.
    let policies = 0
    const refusal = await asMigrator(async (tx) => {
      await tx.unsafe(`CREATE TABLE app.guard_widget (
        tenant_id uuid NOT NULL, id uuid NOT NULL, label text NOT NULL,
        PRIMARY KEY (tenant_id, id))`)
      await tx.unsafe(`INSERT INTO security.table_registry
        (schema_name, table_name, policy_class, app_can_insert, registered_in_migration)
        VALUES ('app', 'guard_widget', 'tenant_scoped_read', false, 'ddl-guard.test.ts')`)
      await tx.unsafe('SELECT security.harden()')
      const [row] = await tx<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_policy p
          JOIN pg_class c ON c.oid = p.polrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'app' AND c.relname = 'guard_widget'`
      policies = row?.n ?? 0
    })
    expect(refusal).toBeUndefined()
    expect(policies, 'harden() did not generate policies for the new table').toBe(2)
  })
})

describe('spending an authorisation', () => {
  it('lets the protected change through and records who spent it', async () => {
    let consumedBy: string | undefined
    const refusal = await asMigrator(
      async (tx) => {
        await tx.unsafe('DROP POLICY p_app ON app.contact')
        const [row] = await tx<{ consumed_by: string | null }[]>`
          SELECT consumed_by FROM authz.ddl_authorization WHERE consumed_at IS NOT NULL`
        consumedBy = row?.consumed_by ?? undefined
      },
      (tx) => authorise(tx),
    )
    expect(refusal).toBeUndefined()
    // Not the owner who minted it. The row records who SPENT it, which is the
    // half that tells you which deploy went through.
    expect(consumedBy).toBe('crm_migrator')
  })

  it('covers the whole transaction, not one statement', async () => {
    // 🔴 PER STATEMENT WOULD HAVE BEEN THE OBVIOUS SHAPE AND WOULD HAVE BEEN
    // AUTOMATED AWAY WITHIN A WEEK. A migration touching four policies needing
    // four hand-typed rows is a rule nobody keeps — and an automated
    // authorisation is R3, the exact defect E1b is named after.
    let remaining = -1
    const refusal = await asMigrator(
      async (tx) => {
        await tx.unsafe('DROP POLICY p_app ON app.contact')
        await tx.unsafe('DROP POLICY p_sys ON app.contact')
        await tx.unsafe('ALTER TABLE app.contact NO FORCE ROW LEVEL SECURITY')
        const [row] = await tx<{ n: number }[]>`
          SELECT count(*)::int AS n FROM authz.ddl_authorization WHERE consumed_at IS NULL`
        remaining = row?.n ?? -1
      },
      (tx) => authorise(tx),
    )
    expect(refusal).toBeUndefined()
    // One row minted, one spent, none left — three protected statements later.
    expect(remaining).toBe(0)
  })

  it('is spent once, and a spent row cannot be revived to authorise a second deploy', async () => {
    // 🔴 THIS TEST COMMITS, AND IT HAS TO. "Already spent" is a fact about a
    // PREVIOUS transaction, so it cannot be shown inside one — the first draft
    // of this test tried, and what it actually proved was "no authorisation ⇒
    // refused", which two other tests already cover. A test whose name
    // overclaims is the failure this project keeps paying for. `crm_test` is
    // dropped and rebuilt every run, and the policy is restored below.
    await sql`INSERT INTO authz.ddl_authorization (purpose)
              VALUES ('ddl-guard.test.ts: one authorisation, spent for real, then not again')`

    await sql.begin(async (tx) => {
      await tx.unsafe('SET LOCAL ROLE crm_migrator')
      await tx.unsafe('DROP POLICY p_app ON app.contact')
    })

    // A second deploy finds nothing to spend.
    expect(await asMigrator((tx) => tx.unsafe('DROP POLICY p_sys ON app.contact'))).toMatch(
      /AUTHZ001/,
    )

    // 🔴 AND THE WAY AROUND IT THAT I BUILT BY ACCIDENT AND MEASURED ON
    // 2026-08-14. `authorised_in_this_transaction()` asks whether this
    // transaction wrote a consumed row (`age(xmin) = 0`), and the deploy role
    // must hold UPDATE or it could not consume anything. So re-touching an
    // ALREADY SPENT row satisfied it — and spent rows are never deleted, so from
    // the first authorisation onward the deploy authorised itself for ever,
    // with every refusal above still passing its test.
    expect(
      await asMigrator((tx) =>
        tx.unsafe('UPDATE authz.ddl_authorization SET consumed_at = clock_timestamp()'),
      ),
    ).toMatch(/AUTHZ002.*already spent/s)

    // Restore. `harden()` regenerates what it generated, and it is exempt, so
    // this costs no authorisation.
    await sql`SELECT security.harden()`
    const [row] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_policy WHERE polrelid = 'app.contact'::regclass`
    expect(row?.n, 'the restore did not put both policies back').toBe(2)
  })

  it('will not let a spend be erased, or a purpose rewritten under it', async () => {
    // Append-only for the same reason `earnings_ledger` and `audit_log` are: a
    // spend that can be erased is a spend nobody can audit. And `purpose` is
    // what a person reads to decide whether the deploy in front of them is the
    // one that was authorised — a deploy that could rewrite it could be
    // authorised for one thing and do another.
    expect(await asMigrator((tx) => tx.unsafe('DELETE FROM authz.ddl_authorization'))).toMatch(
      /permission denied for table ddl_authorization/,
    )

    expect(
      await asMigrator(
        (tx) =>
          tx.unsafe(
            `UPDATE authz.ddl_authorization SET purpose = 'something else entirely'
              WHERE consumed_at IS NULL`,
          ),
        (tx) => authorise(tx),
      ),
    ).toMatch(/AUTHZ004/)
  })

  it('cannot be minted by the deploy role, which is the whole property', async () => {
    // 0075's REVOKE, asserted from inside the guard's own file: placement and
    // protection are two halves and each is worthless alone. A deploy that can
    // mint its own authorisation walks through every refusal above.
    expect(
      await asMigrator((tx) =>
        tx.unsafe(
          `INSERT INTO authz.ddl_authorization (purpose)
           VALUES ('forged by the deploy role, which is the thing E1b forbids')`,
        ),
      ),
    ).toMatch(/permission denied for table ddl_authorization/)
  })
})

describe('the guard leaves the database exactly as it found it', () => {
  it('still has both policies on app.contact, RLS enabled and forced', async () => {
    // Every test above rolls back. This is the control that says so — a suite
    // that dropped a policy for real would pass every assertion above and leave
    // the silo open for every file that runs after it.
    const [row] = await sql<{ policies: number; enabled: boolean; forced: boolean }[]>`
      SELECT (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = 'app.contact'::regclass)
               AS policies,
             c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced
        FROM pg_class c WHERE c.oid = 'app.contact'::regclass`
    expect(row?.policies).toBe(2)
    expect(row?.enabled).toBe(true)
    expect(row?.forced).toBe(true)
  })

  it('holds no UNCONSUMED authorisation for the next test file to spend', async () => {
    // Not "holds no rows": the spend committed above is a permanent record, by
    // design. What must be zero is what a later transaction could still use.
    const [row] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM authz.ddl_authorization WHERE consumed_at IS NULL`
    expect(row?.n).toBe(0)
  })
})
