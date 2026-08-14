import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { assertProtectedSurfaceUnchanged } from '~/db/boot-assert'

import { TEST_URL } from './setup/urls'

/**
 * `05c` §11.11.4 — the digest chain, which needs no superuser and is THE
 * PRIMARY.
 *
 * 🔴 WHY THIS FILE EXISTS SECOND, WHICH IS THE WRONG ORDER AND WORTH SAYING.
 * `scripts/ddl-guard.sql` built §11.11.3, the event triggers. That section of
 * the corpus is titled "Platform reality, and it is why this cannot be the
 * primary": `CREATE EVENT TRIGGER` requires superuser, four places in the
 * approved documents record that the managed provider may not grant it, and R2
 * is still unmeasured. So the half that was built first is the half production
 * may not have.
 *
 * 🎯 AND THE TWO ARE NOT REDUNDANT — the test below proves it with the sharpest
 * case available. `ALTER TABLE app.earnings_ledger DISABLE TRIGGER
 * t_immutable_earnings_ledger` switches off the append-only enforcement on the
 * money record. The event-trigger guard does NOT stop it: the command tag is a
 * bare `ALTER TABLE`, row level security is untouched, and the object identity
 * it reports is the TABLE rather than the trigger. The digest catches it,
 * by name, because `tgenabled` is part of what is hashed.
 */

let sql: postgres.Sql

beforeAll(async () => {
  sql = postgres(TEST_URL, { max: 1, onnotice: () => {} })

  // 🔴 THE BASELINE IS LEVELLED HERE, AND THE REASON IS THE SIGNATURE THIS
  // PROJECT KEEPS PAYING FOR: these assertions passed alone and failed inside
  // the full suite. Nothing was wrong with them. `crm_test` is shared across
  // files and several of them change the schema ON PURPOSE — `silo.test.ts`
  // creates unclassified tables to prove `harden()` refuses them — so by the
  // time this file runs, the surface genuinely differs from what migration 0076
  // recorded. Asserting against the migration's baseline would be asserting
  // about whichever files vitest happened to run first.
  //
  // So the file levels the baseline against the world it actually finds, and
  // then measures only the changes IT makes. That is the honest scope: this
  // file tests the mechanism, not whether some other file left a table behind.
  try {
    await sql`SELECT security.assert_protected_objects()`
  } catch {
    // Something earlier removed or changed a protected object, which PO001
    // refuses without an authorisation — exactly as it should. Mint one so the
    // levelling can proceed, rather than teaching the suite to skip the check.
    await sql`INSERT INTO authz.ddl_authorization (purpose)
              VALUES ('protected-objects.test.ts levelling the baseline against schema changes other test files committed')`
    await sql`SELECT security.assert_protected_objects()`
  }
  await sql`SELECT security.record_protected_digest()`
})

afterAll(async () => {
  await sql?.end()
})

const ROLLED_BACK = 'protected-objects-test-rollback'

/** Runs `work` as `crm_migrator` in a transaction that ALWAYS rolls back. */
async function asMigrator(
  work: (tx: postgres.TransactionSql) => Promise<unknown>,
  setup?: (tx: postgres.TransactionSql) => Promise<unknown>,
): Promise<string | undefined> {
  try {
    await sql.begin(async (tx) => {
      if (setup !== undefined) await setup(tx)
      // `SET LOCAL`, never a bare SET: a role that outlives its transaction on a
      // one-connection pool poisons whatever test runs next.
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
     VALUES ('protected-objects.test.ts authorising one surface change')`

/**
 * Calls the boot predicate with this database claiming to be `development`,
 * inside a transaction that always rolls back. Returns the refusal or
 * `undefined`.
 *
 * 🔴 THE CLAIM IS NECESSARY OR EVERY ASSERTION BELOW IS VACUOUS.
 * `assertProtectedSurfaceUnchanged` exempts `environment = 'test'` on purpose:
 * `crm_test` is shared and several files change the schema deliberately, so an
 * unconditional check killed eight vitest workers with `process.exit(1)` while
 * the suite still reported every test passing. The exemption is exactly the
 * shape `capability-boot.test.ts` already works around — assert the environment
 * you want to test, call the real predicate, roll back.
 */
async function atBoot(
  arrange: (tx: postgres.TransactionSql) => Promise<unknown>,
): Promise<string | undefined> {
  let refusal: string | undefined
  await sql
    .begin(async (tx) => {
      await tx`UPDATE ref.system_constant SET value = 'development' WHERE key = 'environment'`
      await arrange(tx)
      refusal = await assertProtectedSurfaceUnchanged(tx).then(
        () => undefined,
        (err: unknown) => (err instanceof Error ? err.message : String(err)),
      )
      throw new Error(ROLLED_BACK)
    })
    .catch((err: unknown) => {
      if (!(err instanceof Error) || err.message !== ROLLED_BACK) throw err
    })
  return refusal
}

describe('the baseline exists and describes something real', () => {
  it('records all four classes', async () => {
    // A registry holding only one kind would pass every refusal below while
    // watching a quarter of what it claims to watch.
    const rows = await sql<{ kind: string; n: number }[]>`
      SELECT kind, count(*)::int AS n FROM security.protected_object GROUP BY kind ORDER BY kind`

    const byKind = Object.fromEntries(rows.map((r) => [r.kind, r.n]))
    expect(Object.keys(byKind).sort()).toEqual(['definer', 'policy', 'rls', 'trigger'])
    expect(byKind['policy'] ?? 0).toBeGreaterThan(50)
    expect(byKind['definer'] ?? 0).toBeGreaterThan(20)
    expect(byKind['rls'] ?? 0).toBeGreaterThan(20)
    // The append-only triggers on the ledger, the audit log and consent.
    expect(byKind['trigger'] ?? 0).toBeGreaterThan(5)
  })

  it('excludes partitions, which is what keeps the gate from firing nightly', async () => {
    // 🔴 THE ONE THAT WOULD HAVE KILLED IT. `event_outbox` gains a partition
    // every day and drops one every fourteen, each carrying policies and
    // t_immutable_ triggers that harden() generated. Included, the surface
    // would change every night, PO001 would fire on a schedule, and the gate
    // would be switched off within a week — the exact way a gate becomes a
    // comment.
    const [row] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM security.protected_object
       WHERE identity ~ '_[0-9]{4}_[0-9]{2}(_[0-9]{2})?$'`
    expect(row?.n, 'a partition got into the protected surface').toBe(0)
  })

  it('agrees with the digest every process checks at boot', async () => {
    const [row] = await sql<{ live: string; recorded: string }[]>`
      SELECT ref.protected_surface_digest() AS live,
             (SELECT value FROM ref.system_constant WHERE key = 'protected_surface_digest')
               AS recorded`
    expect(row?.recorded).toBe(row?.live)
    // And the predicate agrees, asked as a non-test environment would ask it.
    expect(await atBoot(() => Promise.resolve())).toBeUndefined()
  })
})

describe('PO001 refuses a weakening the event-trigger guard cannot see', () => {
  it('catches DISABLE TRIGGER on the ledger, which the guard lets through', async () => {
    // 🎯 THE CASE THAT JUSTIFIES BUILDING BOTH. This switches off the
    // append-only enforcement on `earnings_ledger` — the money record. The
    // event triggers do not fire on it in any useful way: the tag is a bare
    // ALTER TABLE, RLS is untouched, and the reported object identity is the
    // table. Nothing about any screen would change.
    const refusal = await asMigrator(async (tx) => {
      await tx.unsafe('ALTER TABLE app.earnings_ledger DISABLE TRIGGER t_immutable_earnings_ledger')
      await tx`SELECT * FROM security.assert_protected_objects()`
    })

    expect(refusal).toMatch(/PO001/)
    expect(refusal, 'the refusal must name the object, or nobody can act on it').toMatch(
      /CHANGED\s+trigger:app\.earnings_ledger\.t_immutable_earnings_ledger/,
    )
  })

  it('catches a policy that vanished', async () => {
    // Dropping a policy needs an authorisation from the guard first, so this
    // spends one there and finds PO001 waiting with none left — which is the
    // shape a real weakening has: each enforcement point is paid for separately.
    const refusal = await asMigrator(
      async (tx) => {
        await tx.unsafe('DROP POLICY p_app ON app.contact')
        await tx`SELECT * FROM security.assert_protected_objects()`
      },
      (tx) => authorise(tx),
    )
    expect(refusal).toMatch(/PO001[\s\S]*REMOVED\s+policy:app\.contact\.p_app/)
  })

  it('says nothing about ordinary work', async () => {
    // Adding a column and an index moves no protected object. A gate that
    // fired here would be one every migration learned to route around.
    const refusal = await asMigrator(async (tx) => {
      await tx.unsafe('ALTER TABLE app.contact ADD COLUMN po_probe text')
      const [row] = await tx<{ added: number; changed: number; removed: number }[]>`
        SELECT * FROM security.assert_protected_objects()`
      expect(row).toEqual({ added: 0, changed: 0, removed: 0 })
    })
    expect(refusal).toBeUndefined()
  })

  it('lets a new table in for free, and records it as added', async () => {
    // Additions cost nothing: a policy that appears describes a table that did
    // not exist a moment ago and cannot weaken isolation that was never there.
    // Gate this and every migration adding a table needs a hand-typed
    // authorisation — a rule that gets automated away, and an automated
    // authorisation is R3, the defect E1b is named after.
    let added = 0
    const refusal = await asMigrator(async (tx) => {
      await tx.unsafe(`CREATE TABLE app.po_widget (
        tenant_id uuid NOT NULL, id uuid NOT NULL, PRIMARY KEY (tenant_id, id))`)
      await tx.unsafe(`INSERT INTO security.table_registry
        (schema_name, table_name, policy_class, app_can_insert, registered_in_migration)
        VALUES ('app','po_widget','tenant_scoped_read',false,'protected-objects.test.ts')`)
      await tx.unsafe('SELECT security.harden()')
      const [row] = await tx<{ added: number; changed: number; removed: number }[]>`
        SELECT * FROM security.assert_protected_objects()`
      added = row?.added ?? 0
      expect(row?.changed).toBe(0)
      expect(row?.removed).toBe(0)
    })
    expect(refusal).toBeUndefined()
    // Two policies, the RLS row, and the append-only trigger class as harden()
    // applies it — more than zero is the assertion that matters.
    expect(added).toBeGreaterThan(2)
  })

  it('lets the weakening through when an authorisation was minted for it', async () => {
    // The positive control. A gate that refuses everything passes its own test
    // for ever and gets deleted the first time it blocks real work.
    let history: { identity: string; change: string; authorization_id: string | null } | undefined
    const refusal = await asMigrator(
      async (tx) => {
        await tx.unsafe(
          'ALTER TABLE app.earnings_ledger DISABLE TRIGGER t_immutable_earnings_ledger',
        )
        await tx`SELECT * FROM security.assert_protected_objects()`
        const [row] = await tx<
          { identity: string; change: string; authorization_id: string | null }[]
        >`
          SELECT identity, change, authorization_id
            FROM security.protected_object_history
           WHERE change <> 'added' ORDER BY changed_at DESC LIMIT 1`
        history = row
      },
      (tx) => authorise(tx),
    )

    expect(refusal).toBeUndefined()
    expect(history?.identity).toBe('trigger:app.earnings_ledger.t_immutable_earnings_ledger')
    expect(history?.change).toBe('changed')
    // 🔴 THE HISTORY NAMES THE AUTHORISATION THAT PAID FOR IT. Without this the
    // count on the admin screen would say a protected object moved and nothing
    // would connect it to the row somebody typed to allow it.
    expect(history?.authorization_id).not.toBeNull()
  })
})

describe('the history cannot be walked back', () => {
  it('refuses UPDATE and DELETE', async () => {
    // Append-only for the same reason `earnings_ledger` and `audit_log` are:
    // this is the count rendered to Jorge, and a count that can be edited is a
    // count that proves nothing.
    expect(
      await asMigrator((tx) =>
        tx.unsafe(`UPDATE security.protected_object_history SET change = 'added'`),
      ),
    ).toMatch(/PO003/)

    expect(
      await asMigrator((tx) => tx.unsafe('DELETE FROM security.protected_object_history')),
    ).toMatch(/PO003/)
  })

  it('will not record a weakening with no authorisation behind it', async () => {
    // The CHECK, asserted directly: a row claiming something was removed or
    // changed without naming the authorisation is the shape a forged history
    // would take.
    expect(
      await asMigrator((tx) =>
        tx.unsafe(`INSERT INTO security.protected_object_history (identity, change, new_sha256)
                   VALUES ('policy:app.contact.p_app', 'removed', 'deadbeef')`),
      ),
    ).toMatch(/protected_history_weakening_is_authorised/)
  })
})

describe('the boot refusal, both arms', () => {
  it('refuses to start when the surface drifted', async () => {
    // 🔴 THE ENFORCEMENT POINT THAT WORKS WHERE NOTHING ELSE DOES. The guard
    // needs superuser to exist; PO001 needs a deploy to happen. This fires on
    // every process, including one that comes up hours after somebody changed a
    // policy by hand.
    const refusal = await atBoot((tx) =>
      tx.unsafe('ALTER TABLE app.earnings_ledger DISABLE TRIGGER t_immutable_earnings_ledger'),
    )

    expect(refusal).toMatch(/BOOT018/)
    expect(refusal, 'the refusal must point at the command that names the object').toMatch(
      /db:migrate/,
    )
  })

  it('says MISSING rather than DRIFTED when no baseline was ever recorded', async () => {
    // 🎯 THE LIKELIER FAILURE, AND IT MUST NOT READ AS A BREACH. A database
    // restored from a backup taken before 0076, or migrated by something that
    // skipped the deploy step, has no baseline at all. Reporting that as "a
    // policy changed" would send somebody hunting for an attack that did not
    // happen.
    const refusal = await atBoot((tx) =>
      tx.unsafe(`DELETE FROM ref.system_constant WHERE key = 'protected_surface_digest'`),
    )

    expect(refusal).toMatch(/BOOT017/)
    expect(refusal).not.toMatch(/BOOT018/)
  })
})

describe('the suite left the surface exactly as it found it', () => {
  it('still matches the recorded digest', async () => {
    // Every test above rolls back. This is the control that says so — a suite
    // that disabled the ledger's append-only trigger for real would pass every
    // assertion above and leave the money record writable for every file after.
    expect(await atBoot(() => Promise.resolve())).toBeUndefined()

    const [row] = await sql<{ enabled: string }[]>`
      SELECT tgenabled AS enabled FROM pg_trigger
       WHERE tgname = 't_immutable_earnings_ledger' AND NOT tgisinternal`
    expect(row?.enabled, 'the ledger trigger was left disabled').toBe('O')
  })
})
