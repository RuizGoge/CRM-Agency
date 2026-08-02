import { sql as raw } from 'drizzle-orm'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { withTenant } from '~/db'
import { CelebrationToken } from '~/modules/earnings/celebration'
import { CELEBRATION_CLAIM_GRACE_MS, UNDO_WINDOW_MS } from '~/styles/tokens/timing'

import { rejectionChain } from './setup/errors'
import { TEST_URL } from './setup/urls'

/**
 * The celebration claim.
 *
 * Ruling P2.5: "once per opportunity, forever" and "not replayed if the tab
 * closed" are a database predicate and a non-serialisable type, NOT client
 * discipline. Both halves are asserted here.
 *
 * The four refusals are one conditional UPDATE, and the one that matters most
 * is `reversed` — Gate 10 names the failure directly: the whole office watching
 * confetti for a cancelled sale.
 */

const TENANT = '00000000-0000-7000-8000-0000000000b1'
const SELLER = '00000000-0000-7000-8000-0000000000b2'
const RIVAL = '00000000-0000-7000-8000-0000000000b3'

let sql: postgres.Sql
let contactId: string
let stageOpen: string
let stageWon: string

/** Moves through the real gate, so the ledger entry the claim reads is a real one. */
async function win(opportunityId: string, annualCents: bigint): Promise<void> {
  await withTenant({ tenantId: TENANT, userId: SELLER }, (tx) =>
    tx.execute(raw`
      SELECT app.stage_move(${opportunityId}::uuid, ${stageWon}::uuid,
        'move_sheet'::app.moved_via, 'human'::app.actor_type, NULL,
        ${annualCents.toString()}::bigint, 'annual'::app.premium_mode, NULL, NULL)`),
  )
}

async function claim(
  opportunityId: string,
  asUser = SELLER,
): Promise<{ celebrated: boolean; refused: string | null }> {
  return withTenant({ tenantId: TENANT, userId: asUser }, async (tx) => {
    const rows = await tx.execute<{ celebrated_at: string | null; refused: string | null }>(
      raw`SELECT celebrated_at, refused FROM app.celebrate_once(${opportunityId}::uuid)`,
    )
    const row = rows[0]
    return { celebrated: (row?.celebrated_at ?? null) !== null, refused: row?.refused ?? null }
  })
}

async function newOpportunity(): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO app.opportunity
      (tenant_id, owner_user_id, contact_id, pipeline_id, stage_id, current_stage_type, created_from)
    SELECT ${TENANT}, ${SELLER}, ${contactId}, p.id, ${stageOpen}, 'open', 'manual'
    FROM app.pipeline p WHERE p.tenant_id = ${TENANT} AND p.owner_user_id = ${SELLER}
    RETURNING id`
  if (!row) throw new Error('no opportunity')
  return row.id
}

beforeAll(async () => {
  sql = postgres(TEST_URL, { max: 1, onnotice: () => {} })

  await sql`
    INSERT INTO app.tenant (id, name, business_tz)
    VALUES (${TENANT}, 'Confetti Agency', 'America/New_York')`
  await sql`
    INSERT INTO app.app_user (tenant_id, id, email, full_name, display_name, role) VALUES
      (${TENANT}, ${SELLER}, 'seller@confetti.test', 'Sol Seller', 'Sol', 'seller'),
      (${TENANT}, ${RIVAL},  'rival@confetti.test', 'Rio Rival',  'Rio', 'seller')`

  const [contact] = await sql<{ id: string }[]>`
    INSERT INTO app.contact (tenant_id, owner_user_id, full_name, created_via)
    VALUES (${TENANT}, ${SELLER}, 'Wanda Winner', 'manual') RETURNING id`
  contactId = contact?.id ?? ''

  const [pipeline] = await sql<{ id: string }[]>`
    INSERT INTO app.pipeline (tenant_id, owner_user_id, name)
    VALUES (${TENANT}, ${SELLER}, 'Board') RETURNING id`

  const mk = async (name: string, type: string, order: number): Promise<string> => {
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO app.stage (tenant_id, pipeline_id, owner_user_id, name, stage_type, sort_order)
      VALUES (${TENANT}, ${pipeline?.id ?? null}, ${SELLER}, ${name},
              ${type}::app.stage_type, ${order})
      RETURNING id`
    return row?.id ?? ''
  }
  stageOpen = await mk('New Lead', 'open', 0)
  stageWon = await mk('Closed Won', 'earning', 1)
})

afterAll(async () => {
  await sql?.end()
})

describe('the claim refuses four ways, in one statement', () => {
  it('refuses a claim taken before the undo window closes', async () => {
    const opp = await newOpportunity()
    await win(opp, 240_000n)

    // Milliseconds old. The seller can still take it back, and confetti now
    // would be celebrating something that has not finished happening (R1.4).
    expect(await claim(opp)).toEqual({ celebrated: false, refused: 'too_early' })

    const [row] = await sql<{ c: string | null }[]>`
      SELECT celebrated_at::text AS c FROM app.opportunity WHERE id = ${opp}`
    expect(row?.c).toBeNull()
  })

  it('refuses a claim on a win that was undone', async () => {
    const opp = await newOpportunity()
    await win(opp, 500_000n)

    // The undo, through the same gated path a seller uses.
    await withTenant({ tenantId: TENANT, userId: SELLER }, (tx) =>
      tx.execute(raw`
        SELECT app.stage_move(${opp}::uuid, ${stageOpen}::uuid,
          'move_sheet'::app.moved_via, 'human'::app.actor_type, NULL,
          NULL, NULL, NULL, NULL)`),
    )

    // Gate 10 names this one directly: the whole office watching confetti for a
    // cancelled sale. Checked against the reversal's LINK to the entry it
    // cancels — migration 0019 — rather than by guessing from a total.
    await sql`UPDATE ref.timing_constant SET value_ms = 0 WHERE key = 'undo_deadline_ms'`
    try {
      expect(await claim(opp)).toEqual({ celebrated: false, refused: 'reversed' })
    } finally {
      await sql`UPDATE ref.timing_constant SET value_ms = ${UNDO_WINDOW_MS} WHERE key = 'undo_deadline_ms'`
    }
  })

  it('claims exactly once, and the second claim is refused rather than doubled', async () => {
    const opp = await newOpportunity()
    await win(opp, 360_000n)

    // Collapse the window instead of sleeping five seconds. This also proves
    // the predicate READS the constant rather than hard-coding a number.
    await sql`UPDATE ref.timing_constant SET value_ms = 0 WHERE key = 'undo_deadline_ms'`
    try {
      expect(await claim(opp)).toEqual({ celebrated: true, refused: null })
      expect(await claim(opp)).toEqual({ celebrated: false, refused: 'already' })
    } finally {
      await sql`UPDATE ref.timing_constant SET value_ms = ${UNDO_WINDOW_MS} WHERE key = 'undo_deadline_ms'`
    }

    const [row] = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM app.opportunity
      WHERE id = ${opp} AND celebrated_at IS NOT NULL`
    expect(row?.n).toBe('1')
  })

  it('refuses a claim past the grace window — the tab reopened tomorrow', async () => {
    const opp = await newOpportunity()
    await win(opp, 120_000n)

    // Window closed, grace already elapsed. "Not replayed tomorrow" is a WHERE
    // clause rather than something the client is trusted to remember.
    await sql`UPDATE ref.timing_constant SET value_ms = 0 WHERE key = 'undo_deadline_ms'`
    await sql`UPDATE ref.timing_constant SET value_ms = 0 WHERE key = 'celebration_claim_grace_ms'`
    try {
      expect(await claim(opp)).toEqual({ celebrated: false, refused: 'too_late' })
    } finally {
      await sql`UPDATE ref.timing_constant SET value_ms = ${UNDO_WINDOW_MS} WHERE key = 'undo_deadline_ms'`
      await sql`
        UPDATE ref.timing_constant SET value_ms = ${CELEBRATION_CLAIM_GRACE_MS}
        WHERE key = 'celebration_claim_grace_ms'`
    }
  })

  it('answers a rival with not-found, never a 403', async () => {
    const opp = await newOpportunity()
    await win(opp, 180_000n)

    // A 403 confirms the record exists. The seller next to you finding out you
    // closed something is the leak, not the write being refused.
    //
    // Through the chain: Drizzle wraps the driver error as `Failed query: ...`
    // and leaves PostgreSQL's on `cause`, so a matcher on the top-level message
    // passes or fails for reasons that have nothing to do with the code raised.
    expect(await rejectionChain(claim(opp, RIVAL))).toMatch(/CB404/)
  })
})

describe('the token cannot be persisted', () => {
  it('throws on JSON.stringify instead of quietly serialising to nothing', () => {
    // Ruling P2.5. A plain object would produce `{}` here and a reload three
    // hours later would fire confetti for a sale nobody just made. The failure
    // has to be loud at the moment someone tries to store it.
    const token = new CelebrationToken('019f-abc', 'Wanda Winner', '240000')

    expect(() => JSON.stringify(token)).toThrow(/CB002/)
    expect(() => JSON.stringify({ cached: token })).toThrow(/CB002/)
    expect(token.annualCents).toBe('240000')
  })
})

describe('the fourth representation of the undo window', () => {
  it('claims on undo_deadline_ms, never on the public projection guard', async () => {
    // E7 / NEW-1: one name meaning two durations refuses every celebration in
    // one branch and reveals an undoable win on a public board in the other.
    // The celebration is the fourth place the number lives, and Gate 10 asked
    // for exactly this assertion.
    const [row] = await sql<{ src: string }[]>`
      SELECT prosrc AS src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'app' AND p.proname = 'celebrate_once'`

    expect(row?.src).toContain('undo_deadline_ms')
    expect(row?.src).toContain('celebration_claim_grace_ms')
    expect(row?.src).not.toContain('projection_reveal_delay_ms')
  })

  it('keeps the grace window identical in TypeScript and SQL', async () => {
    const [row] = await sql<{ ms: number }[]>`SELECT app.celebration_claim_grace_ms() AS ms`
    expect(row?.ms).toBe(CELEBRATION_CLAIM_GRACE_MS)

    // Three intervals now, and no two of them share a name.
    const keys = await sql<{ key: string }[]>`
      SELECT key FROM ref.timing_constant ORDER BY key`
    expect(keys.map((k) => k.key)).toEqual([
      'celebration_claim_grace_ms',
      'projection_reveal_delay_ms',
      'undo_deadline_ms',
    ])
  })
})
