import { sql as raw } from 'drizzle-orm'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { withTenant } from '~/db'

import { rejectionChain } from './setup/errors'
import { TEST_URL } from './setup/urls'

/**
 * The close gate.
 *
 * Both gates bind to `stage_type` and never to a stage NAME, because a gate
 * bound to a name is evaded by typing over the name — which is the single most
 * dangerous historical bug in the specification. And every assertion here has
 * a second form: the service function refuses, AND the database refuses, so a
 * route written next year that skips the service still cannot produce the row.
 */

const TENANT = '00000000-0000-7000-8000-0000000000f6'
const CLOSER = '00000000-0000-7000-8000-0000000000e5'
const RIVAL = '00000000-0000-7000-8000-0000000000e6'

const MONTHLY = 24_999n // $249.99/mo
const ANNUAL = 299_988n // $2,999.88/yr

let sql: postgres.Sql
let stageOpen = ''
let stageWon = ''
let stageLost = ''
let lostReasonId = ''
let contactId = ''

async function newOpportunity(owner = CLOSER): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO app.opportunity
      (tenant_id, owner_user_id, contact_id, pipeline_id, stage_id, current_stage_type, created_from)
    SELECT ${TENANT}, ${owner}, ${contactId}, p.id, ${stageOpen}, 'open', 'manual'
    FROM app.pipeline p WHERE p.tenant_id = ${TENANT} AND p.owner_user_id = ${owner}
    RETURNING id`
  return row?.id ?? ''
}

async function move(
  userId: string,
  opportunityId: string,
  toStageId: string,
  extra: { premium?: bigint; mode?: 'monthly' | 'annual'; reason?: string; key?: string } = {},
): Promise<{ transition_id: string; credited: boolean; was_duplicate: boolean } | undefined> {
  return withTenant({ tenantId: TENANT, userId }, async (tx) => {
    const rows = await tx.execute<{
      transition_id: string
      credited: boolean
      was_duplicate: boolean
    }>(
      raw`SELECT * FROM app.stage_move(
            ${opportunityId}::uuid, ${toStageId}::uuid, 'kanban_drag'::app.moved_via,
            'human'::app.actor_type,
            ${extra.key ?? null}::uuid,
            ${extra.premium?.toString() ?? null}::bigint,
            ${extra.mode ?? null}::app.premium_mode,
            ${extra.reason ?? null}::uuid,
            NULL)`,
    )
    return rows[0]
  })
}

beforeAll(async () => {
  sql = postgres(TEST_URL, { max: 1, onnotice: () => {} })

  await sql`
    INSERT INTO app.tenant (id, name, business_tz)
    VALUES (${TENANT}, 'Gate Agency', 'America/New_York')`
  await sql`
    INSERT INTO app.app_user (tenant_id, id, email, full_name, display_name, role) VALUES
      (${TENANT}, ${CLOSER}, 'closer@gate.test', 'Cleo Closer', 'Cleo', 'seller'),
      (${TENANT}, ${RIVAL},  'rival@gate.test',  'Rita Rival',  'Rita', 'seller')`

  for (const owner of [CLOSER, RIVAL]) {
    await sql`
      INSERT INTO app.pipeline (tenant_id, owner_user_id, name)
      VALUES (${TENANT}, ${owner}, 'My Board')`
  }

  const mk = async (name: string, type: string, order: number): Promise<string> => {
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO app.stage (tenant_id, pipeline_id, owner_user_id, name, stage_type, sort_order)
      SELECT ${TENANT}, p.id, ${CLOSER}, ${name}, ${type}::app.stage_type, ${order}
      FROM app.pipeline p WHERE p.tenant_id = ${TENANT} AND p.owner_user_id = ${CLOSER}
      RETURNING id`
    return row?.id ?? ''
  }
  stageOpen = await mk('New Lead', 'open', 0)
  stageWon = await mk('Closed Won', 'earning', 1)
  stageLost = await mk('Closed Lost', 'lost', 2)

  const [lr] = await sql<{ id: string }[]>`
    INSERT INTO app.lost_reason (tenant_id, code, label, sort_order)
    VALUES (${TENANT}, 'price', 'Too expensive', 0) RETURNING id`
  lostReasonId = lr?.id ?? ''

  const [c] = await sql<{ id: string }[]>`
    INSERT INTO app.contact (tenant_id, owner_user_id, full_name, created_via)
    VALUES (${TENANT}, ${CLOSER}, 'Ruth Alvarez', 'manual') RETURNING id`
  contactId = c?.id ?? ''
})

afterAll(async () => {
  await sql?.end()
})

describe('the gates bind to stage_type, never to a stage name', () => {
  it('refuses an earning move with no deal value', async () => {
    const opp = await newOpportunity()
    expect(await rejectionChain(move(CLOSER, opp, stageWon))).toMatch(/SM003/)
  })

  it('still refuses it after the stage is RENAMED — renaming is inert', async () => {
    // The historical bug this design exists to make impossible: a gate bound
    // to the literal "Closed Won" is evaded by typing over the column header.
    await sql`
      UPDATE app.stage SET name = 'Sold!! 🎉'
      WHERE tenant_id = ${TENANT} AND id = ${stageWon}`

    const opp = await newOpportunity()
    expect(await rejectionChain(move(CLOSER, opp, stageWon))).toMatch(/SM003/)

    await sql`
      UPDATE app.stage SET name = 'Closed Won'
      WHERE tenant_id = ${TENANT} AND id = ${stageWon}`
  })

  it('refuses a lost move with no reason', async () => {
    const opp = await newOpportunity()
    expect(await rejectionChain(move(CLOSER, opp, stageLost))).toMatch(/SM004/)
  })

  it('accepts the same move once a reason is supplied, and credits nothing', async () => {
    // The control for the assertion above: the gate must be passable, or it is
    // just a broken path rather than a gate.
    const opp = await newOpportunity()
    const result = await move(CLOSER, opp, stageLost, { reason: lostReasonId })

    expect(result?.credited).toBe(false)

    const [row] = await sql<{ t: string; n: string }[]>`
      SELECT o.current_stage_type::text AS t,
             (SELECT count(*)::text FROM app.earnings_ledger e
               WHERE e.tenant_id = ${TENANT} AND e.opportunity_id = ${opp}) AS n
      FROM app.opportunity o WHERE o.tenant_id = ${TENANT} AND o.id = ${opp}`
    expect(row?.t).toBe('lost')
    expect(row?.n).toBe('0')
  })

  it('refuses the row itself, even bypassing the service entirely', async () => {
    // The CHECK is the real gate. A raw API call, a CSV import, an automation
    // or a route written next year cannot produce this row at all.
    await expect(
      sql`
        INSERT INTO app.opportunity
          (tenant_id, owner_user_id, contact_id, pipeline_id, stage_id, current_stage_type, created_from)
        SELECT ${TENANT}, ${CLOSER}, ${contactId}, p.id, ${stageWon}, 'earning', 'manual'
        FROM app.pipeline p WHERE p.tenant_id = ${TENANT} AND p.owner_user_id = ${CLOSER}`,
    ).rejects.toThrow(/opportunity_win_gate/)
  })

  it('refuses a current_stage_type that disagrees with its stage', async () => {
    // The composite FK: the denormalised type cannot lie about the stage it
    // points at, without a trigger and without a join.
    //
    // Points at the EARNING stage while claiming to be 'open', so neither gate
    // fires and the foreign key is the only thing left to object. Claiming
    // 'lost' instead would trip the loss gate first and prove the wrong thing.
    expect(
      await rejectionChain(
        sql`
          INSERT INTO app.opportunity
            (tenant_id, owner_user_id, contact_id, pipeline_id, stage_id, current_stage_type, created_from)
          SELECT ${TENANT}, ${CLOSER}, ${contactId}, p.id, ${stageWon}, 'open', 'manual'
          FROM app.pipeline p WHERE p.tenant_id = ${TENANT} AND p.owner_user_id = ${CLOSER}`,
      ),
    ).toMatch(/opportunity_stage_type_fk/)
  })
})

describe('a qualified win credits exactly once, at the annual figure', () => {
  it('annualises a monthly premium and credits the ledger in one transaction', async () => {
    const opp = await newOpportunity()
    const result = await move(CLOSER, opp, stageWon, { premium: MONTHLY, mode: 'monthly' })

    expect(result?.credited).toBe(true)

    const [led] = await sql<{ delta: string; etype: string }[]>`
      SELECT delta_cents::text AS delta, entry_type::text AS etype
      FROM app.earnings_ledger
      WHERE tenant_id = ${TENANT} AND opportunity_id = ${opp}`

    // $249.99 x 12 = $2,999.88 exactly. Without the x12 the public board is
    // wrong by a factor of twelve and looks entirely plausible.
    expect(led?.delta).toBe(ANNUAL.toString())
    expect(led?.etype).toBe('sale')
  })

  it('treats a repeated sendBeacon move as a duplicate, not a second credit', async () => {
    const opp = await newOpportunity()
    const key = '00000000-0000-7000-8000-00000000d001'

    const first = await move(CLOSER, opp, stageWon, { premium: ANNUAL, mode: 'annual', key })
    const second = await move(CLOSER, opp, stageWon, { premium: ANNUAL, mode: 'annual', key })

    expect(first?.was_duplicate).toBe(false)
    expect(second?.was_duplicate).toBe(true)
    expect(second?.transition_id).toBe(first?.transition_id)

    const [row] = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM app.earnings_ledger
      WHERE tenant_id = ${TENANT} AND opportunity_id = ${opp}`
    expect(row?.n).toBe('1')
  })

  it('reverses when the card leaves the earning stage', async () => {
    const opp = await newOpportunity()
    await move(CLOSER, opp, stageWon, { premium: ANNUAL, mode: 'annual' })
    await move(CLOSER, opp, stageOpen)

    const rows = await sql<{ id: string; delta: string; etype: string; reverses: string | null }[]>`
      SELECT id::text AS id, delta_cents::text AS delta, entry_type::text AS etype,
             reverses_entry_id::text AS reverses
      FROM app.earnings_ledger
      WHERE tenant_id = ${TENANT} AND opportunity_id = ${opp}
      ORDER BY recorded_at`

    expect(rows.map((r) => r.etype)).toEqual(['sale', 'reversal'])
    expect(BigInt(rows[0]?.delta ?? '0') + BigInt(rows[1]?.delta ?? '0')).toBe(0n)

    // The reversal NAMES the credit it cancels. Without the link the public
    // board cannot tell a 3-second undo from a correction made next month, so
    // it treats the undo as a correction and republishes the cancelled sale for
    // the 500ms the two reveal clocks are apart. Migration 0019 has the case.
    expect(rows[1]?.reverses).toBe(rows[0]?.id)
  })

  it('refuses to reverse a credit that is not there', async () => {
    // A card can only sit in an earning stage by way of the gate, so an
    // unreversed credit always exists behind it. If that ever stops being true,
    // reversing anyway pushes the seller's public total NEGATIVE — and the
    // ledger has no recompute job that would ever notice.
    const opp = await newOpportunity()
    await move(CLOSER, opp, stageWon, { premium: ANNUAL, mode: 'annual' })
    await move(CLOSER, opp, stageOpen)

    // Second exit with the credit already reversed: nothing left to cancel.
    await sql`
      UPDATE app.opportunity SET stage_id = ${stageWon}, current_stage_type = 'earning'
      WHERE tenant_id = ${TENANT} AND id = ${opp}`

    expect(await rejectionChain(move(CLOSER, opp, stageOpen))).toMatch(/SM005/)
  })
})

describe('the move is one transaction or nothing', () => {
  it('leaves the card where it was when the credit cannot be written', async () => {
    const opp = await newOpportunity()

    // 50 cents a year is below the $1 floor, so the opportunity UPDATE fails
    // inside stage_move. Everything before it must roll back with it.
    expect(
      await rejectionChain(move(CLOSER, opp, stageWon, { premium: 50n, mode: 'annual' })),
    ).toMatch(/opportunity_premium_in_range/)

    const [card] = await sql<{ stage_id: string; t: string }[]>`
      SELECT stage_id, current_stage_type::text AS t FROM app.opportunity
      WHERE tenant_id = ${TENANT} AND id = ${opp}`
    expect(card?.stage_id).toBe(stageOpen)
    expect(card?.t).toBe('open')

    const [trans] = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM app.stage_transition
      WHERE tenant_id = ${TENANT} AND opportunity_id = ${opp}`
    expect(trans?.n).toBe('0')
  })
})

describe('the service cannot be bypassed by a plain UPDATE', () => {
  it('denies crm_app the columns that decide money', async () => {
    const grants = await sql<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.column_privileges
      WHERE grantee = 'crm_app' AND table_schema = 'app' AND table_name = 'opportunity'
        AND privilege_type = 'UPDATE'
        AND column_name IN ('stage_id', 'current_stage_type', 'premium_annual_cents')`

    // A card moved by a plain UPDATE would leave no stage_transition and no
    // ledger row: the board and the money would diverge, with no recompute
    // job to reconcile them.
    expect(grants).toEqual([])
  })

  it('still lets a seller edit the ordinary parts of their card', async () => {
    const opp = await newOpportunity()
    await expect(
      withTenant({ tenantId: TENANT, userId: CLOSER }, (tx) =>
        tx.execute(
          raw`UPDATE app.opportunity SET carrier = 'Mutual of Omaha'
              WHERE tenant_id = ${TENANT}::uuid AND id = ${opp}::uuid`,
        ),
      ),
    ).resolves.toBeDefined()
  })
})

describe('the rules that have no service layer at all', () => {
  it('refuses to change a stage_type, ever', async () => {
    // If a type can never flip, a per-seller board tweak can never move money
    // on a public leaderboard.
    await expect(
      sql`UPDATE app.stage SET stage_type = 'earning'
          WHERE tenant_id = ${TENANT} AND id = ${stageOpen}`,
    ).rejects.toThrow(/ST001/)
  })

  it('refuses an earning transition written by anything but a human', async () => {
    // A CSV import, a webhook, a reminder job or an API token physically
    // cannot write a row that credits money.
    await expect(
      sql`
        INSERT INTO app.stage_transition
          (tenant_id, opportunity_id, owner_user_id, to_stage_id, to_stage_type,
           to_stage_name_snapshot, actor_type, moved_via, stage_config_version)
        VALUES (${TENANT}, gen_random_uuid(), ${CLOSER}, ${stageWon}, 'earning',
                'Closed Won', 'automation', 'api', 1)`,
    ).rejects.toThrow(/stage_transition_earning_is_human/)
  })

  it('refuses to re-celebrate an opportunity', async () => {
    const opp = await newOpportunity()
    await sql`
      UPDATE app.opportunity SET celebrated_at = clock_timestamp()
      WHERE tenant_id = ${TENANT} AND id = ${opp}`

    await expect(
      sql`UPDATE app.opportunity SET celebrated_at = clock_timestamp()
          WHERE tenant_id = ${TENANT} AND id = ${opp}`,
    ).rejects.toThrow(/CE001/)
  })
})

describe('cross-silo moves are not-found, never forbidden', () => {
  it("tells a seller nothing about another seller's card", async () => {
    const theirs = await newOpportunity(RIVAL)

    // Not 403. A 403 confirms the record exists, which is the disclosure the
    // owner-scoped not-found rule exists to prevent. Rita owns the card but
    // not the target stage, which belongs to Cleo's board.
    expect(
      await rejectionChain(move(RIVAL, theirs, stageWon, { premium: ANNUAL, mode: 'annual' })),
    ).toMatch(/SM404/)
  })
})
