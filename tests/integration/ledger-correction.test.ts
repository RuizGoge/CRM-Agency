import { randomUUID } from 'node:crypto'

import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { APP_URL, OWNER_URL } from './setup/urls'

/**
 * `app.ledger_adjust` — the admin correction surface.
 *
 * 🔴 WHAT IT CLOSES. CLAUDE.md has always said corrections are "compensating
 * appends through the admin void/adjust surface". That surface did not exist:
 * no `ledger_void`, no `ledger_adjust`, no route, no screen — and
 * `app.ledger_append` has carried no grant since 0063, deliberately. So a wrong
 * number on the public board could not be corrected by ANYONE, by any path:
 * not by editing (the append-only trigger refuses, correctly) and not by a
 * compensating append (nothing could write one). The enum has known about
 * `manual_adjustment` since 0008 and the CHECKs have accepted it the whole time.
 *
 * ⚠️ THE HALF OF THIS FILE THAT MATTERS MOST IS THE LAST BLOCK. Adding a way to
 * correct the board is only safe if it did not quietly become a way to write the
 * board: `ledger_append` must still be ungranted and the ledger must still
 * refuse UPDATE and DELETE. A correction surface that weakened either would have
 * re-opened 0063's hole through a new door.
 */

const TENANT = '00000000-0000-7000-8000-000000710071'
const OTHER_TENANT = '00000000-0000-7000-8000-000000710072'
const ADMIN = '00000000-0000-7000-8000-0000007100a1'
const SELLER = '00000000-0000-7000-8000-0000007100a2'
const OUTSIDER = '00000000-0000-7000-8000-0000007100a3'

let owner: postgres.Sql
let app: postgres.Sql

async function asUser<T>(
  userId: string,
  work: (tx: postgres.TransactionSql) => Promise<T>,
  tenantId: string = TENANT,
): Promise<T> {
  const result = await app.begin(async (tx) => {
    await tx`SELECT app.begin_request(${tenantId}::uuid, ${userId}::uuid)`
    return work(tx)
  })
  return result as T
}

async function adjust(
  userId: string,
  opts: {
    target?: string
    cents?: bigint
    reason?: string
    key?: string
    tenantId?: string
  } = {},
): Promise<string | null> {
  return asUser(
    userId,
    async (tx) => {
      const rows = await tx<{ id: string | null }[]>`
        SELECT app.ledger_adjust(
          ${opts.target ?? SELLER}::uuid,
          ${String(opts.cents ?? 50_000n)}::bigint,
          ${opts.reason ?? 'Premium was keyed as monthly instead of annual.'},
          ${opts.key ?? randomUUID()}::uuid
        ) AS id`
      return rows[0]?.id ?? null
    },
    opts.tenantId ?? TENANT,
  )
}

const entryCount = async (): Promise<number> => {
  const [row] = await owner<{ n: string }[]>`
    SELECT count(*) AS n FROM app.earnings_ledger
     WHERE tenant_id = ${TENANT} AND entry_type = 'manual_adjustment'`
  return Number.parseInt(row?.n ?? '0', 10)
}

beforeAll(async () => {
  owner = postgres(OWNER_URL, { max: 1, onnotice: () => {} })
  app = postgres(APP_URL, { max: 1, onnotice: () => {} })

  await owner`
    INSERT INTO app.tenant (id, name, business_tz) VALUES
      (${TENANT}, 'Correction Agency', 'America/New_York'),
      (${OTHER_TENANT}, 'Neighbour Agency', 'America/Chicago')`
  await owner`
    INSERT INTO app.app_user (tenant_id, id, email, full_name, display_name, role) VALUES
      (${TENANT}, ${ADMIN}, 'admin@corr.test', 'Ada Admin', 'Ada A.', 'admin'),
      (${TENANT}, ${SELLER}, 'seller@corr.test', 'Sol Seller', 'Sol S.', 'seller'),
      (${OTHER_TENANT}, ${OUTSIDER}, 'out@corr.test', 'Otto Out', 'Otto O.', 'seller')`
})

afterAll(async () => {
  await owner?.end()
  await app?.end()
})

describe('an admin can correct a wrong number', () => {
  it('appends a manual_adjustment carrying the reason and the actor', async () => {
    const id = await adjust(ADMIN, {
      cents: 120_000n,
      reason: 'Annualisation missed on a Feb sale.',
    })
    expect(id).not.toBeNull()

    const [row] = await owner<
      {
        entry_type: string
        delta: string
        reason: string
        actor: string
        owner_user: string
        source_name: string | null
        reverses: string | null
      }[]
    >`
      SELECT entry_type::text AS entry_type, delta_cents::text AS delta, reason,
             actor_user_id AS actor, owner_user_id AS owner_user,
             source_event_name AS source_name, reverses_entry_id AS reverses
        FROM app.earnings_ledger WHERE tenant_id = ${TENANT} AND id = ${id}`

    expect(row?.entry_type).toBe('manual_adjustment')
    expect(row?.delta).toBe('120000')
    expect(row?.reason).toBe('Annualisation missed on a Feb sale.')
    // WHO ACTED IS READ FROM THE SESSION, never a parameter.
    expect(row?.actor).toBe(ADMIN)
    // The correction lands on the SELLER's total, not the admin's.
    expect(row?.owner_user).toBe(SELLER)
    // E5 and `earnings_source_is_a_declared_input` both exempt manual_adjustment
    // from naming a source event, because no event sourced it.
    expect(row?.source_name).toBeNull()
    // 🔴 NEVER a reversal link. `earnings_reverses_uidx` allows ONE reversal per
    // entry and that slot belongs to the seller's 5-second undo; an admin
    // correction consuming it would make an undo impossible afterwards.
    expect(row?.reverses).toBeNull()
  })

  it('moves the public projection', async () => {
    const before = await owner<{ total: string }[]>`
      SELECT total_cents::text AS total FROM app.leaderboard_projection
       WHERE tenant_id = ${TENANT} AND user_id = ${SELLER} AND period_type = 'all_time'`

    await adjust(ADMIN, { cents: 25_000n, reason: 'Correcting a duplicate credit from March.' })

    const after = await owner<{ total: string }[]>`
      SELECT total_cents::text AS total FROM app.leaderboard_projection
       WHERE tenant_id = ${TENANT} AND user_id = ${SELLER} AND period_type = 'all_time'`

    const delta = BigInt(after[0]?.total ?? '0') - BigInt(before[0]?.total ?? '0')
    expect(delta).toBe(25_000n)
  })

  it('takes a negative correction, which is the common case', async () => {
    // The reason the surface exists at all is usually "this number is too high".
    const id = await adjust(ADMIN, {
      cents: -30_000n,
      reason: 'Policy lapsed inside the free-look window.',
    })
    expect(id).not.toBeNull()
  })

  it('writes an audit row that a different person reads', async () => {
    const id = await adjust(ADMIN, { cents: 10_000n, reason: 'Reconciling against the carrier.' })
    const [row] = await owner<{ action: string; actor: string; reason: string }[]>`
      SELECT action, actor_user_id AS actor, reason FROM app.audit_log
       WHERE tenant_id = ${TENANT} AND subject_id = ${id}`
    expect(row?.action).toBe('ledger.adjusted')
    expect(row?.actor).toBe(ADMIN)
    expect(row?.reason).toBe('Reconciling against the carrier.')
  })
})

describe('what it refuses', () => {
  it('refuses a seller', async () => {
    await expect(adjust(SELLER)).rejects.toThrow(/LA002/)
  })

  it('refuses a correction with no reason worth reading', async () => {
    // 🔴 THE MANDATORY REASON IS THE DIFFERENCE between "an admin can fix the
    // number" and "an admin can change the number". This row is the only record
    // of why the board moved without a deal.
    await expect(adjust(ADMIN, { reason: 'oops' })).rejects.toThrow(/LA004/)
    await expect(adjust(ADMIN, { reason: '   ' })).rejects.toThrow(/LA004/)
  })

  it('refuses a correction of zero', async () => {
    await expect(adjust(ADMIN, { cents: 0n })).rejects.toThrow(/LA003/)
  })

  it('gives a neighbouring tenant’s user the not-found answer, and writes nothing', async () => {
    const before = await entryCount()
    // Same answer as an id that never existed — never an error that confirms the
    // user is real somewhere else.
    expect(await adjust(ADMIN, { target: OUTSIDER })).toBeNull()
    expect(await adjust(ADMIN, { target: randomUUID() })).toBeNull()
    expect(await entryCount()).toBe(before)
  })

  it('counts a resubmitted correction once', async () => {
    // 🔴 THE IDEMPOTENCY KEY RIDES IN AS `source_event_id`, reusing the index the
    // table calls "THE correctness mechanism, not a performance index". Money is
    // the one place where "two identical submissions are two real facts" — the
    // rule notes.ts states — is the wrong default.
    const key = randomUUID()
    const before = await entryCount()
    const first = await adjust(ADMIN, { key, cents: 7_700n, reason: 'Double submit under test.' })
    const second = await adjust(ADMIN, { key, cents: 7_700n, reason: 'Double submit under test.' })

    expect(first).not.toBeNull()
    expect(second).toBe(first)
    expect(await entryCount()).toBe(before + 1)
  })
})

describe('the ledger did not get weaker', () => {
  it('leaves app.ledger_append ungranted', async () => {
    // 🔴 THE PROPERTY THE WHOLE DESIGN HANGS ON. 0063 revoked it because that
    // function validates the tenant and NOTHING ELSE — reproduced then as a
    // seller session appending $999,999,999.99 under a colleague's name.
    // `ledger_adjust` reaches it as the OWNER, the same shape `stage_move` uses.
    // A grant here would re-open that hole through a new door.
    const [row] = await owner<{ can: boolean }[]>`
      SELECT has_function_privilege('crm_app', p.oid, 'EXECUTE') AS can
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'app' AND p.proname = 'ledger_append'`
    expect(row?.can).toBe(false)
  })

  it('still refuses UPDATE and DELETE on the ledger, for the owner too', async () => {
    // The append-only trigger is untouched by this migration and must stay that
    // way: the correction is a NEW ROW, so the board reads right while the
    // history of how it got there survives.
    await expect(
      owner`UPDATE app.earnings_ledger SET delta_cents = 1 WHERE tenant_id = ${TENANT}`,
    ).rejects.toThrow(/AP001|append-only/)
    await expect(
      owner`DELETE FROM app.earnings_ledger WHERE tenant_id = ${TENANT}`,
    ).rejects.toThrow(/AP001|append-only/)
  })

  it('did not add a recompute job', async () => {
    // E3 remains the reason: two steps that both move the number double-count
    // it. `ledger_adjust` appends and lets the existing projection writer move
    // the total; nothing here re-derives it by summing the ledger.
    const rows = await owner<{ proname: string }[]>`
      SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'app' AND p.proname IN ('leaderboard_rebuild', 'ledger_recompute')`
    expect(rows.length).toBe(0)
  })
})
