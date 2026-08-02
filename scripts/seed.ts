import { sql } from 'drizzle-orm'
import postgres from 'postgres'

import { withTenant } from '../app/db'
import { auth } from '../app/lib/auth/server'

/**
 * The development tenant.
 *
 * Deliberately built through the real paths: every figure on the board got
 * there by `app.stage_move` passing the win gate and appending to the ledger,
 * not by inserting ledger rows. A seed that writes the totals directly proves
 * the screen renders and nothing else — and the screen is the part least
 * likely to be wrong.
 *
 *   npm run db:up && npm run db:migrate && npm run db:seed
 */

const URL_ = process.env['DATABASE_URL'] ?? 'postgresql://crm:crm@localhost:5432/crm_dev'
const TENANT = '00000000-0000-7000-8000-00000000de01'
const PASSWORD = 'demo-password-1234'

/** Monthly premiums in cents. Annualised by the money path, never here. */
const SELLERS = [
  {
    id: '00000000-0000-7000-8000-00000000ab01',
    name: 'Renata Ochoa',
    wins: [24_999n, 31_500n, 18_750n],
  },
  { id: '00000000-0000-7000-8000-00000000ab02', name: 'Marcus Bell', wins: [45_000n, 22_400n] },
  {
    id: '00000000-0000-7000-8000-00000000ab03',
    name: 'Priya Nair',
    wins: [38_200n, 29_900n, 16_400n, 12_000n],
  },
  { id: '00000000-0000-7000-8000-00000000ab04', name: 'Dana Reyes', wins: [27_500n] },
  { id: '00000000-0000-7000-8000-00000000ab05', name: 'Tomás Guerra', wins: [] },
] as const

/**
 * Fold a display name into the local part of an email address.
 *
 * Found by signing in as Tomás Guerra and failing: the first seed produced
 * `tomás@demo.test`, better-auth accepted the sign-up, and then the login form
 * refused to submit it forever. `<input type="email">` validates against the
 * HTML5 grammar, which is ASCII-only before the `@`, so the account existed
 * and no human could ever reach it — `validity.typeMismatch` was true and the
 * browser simply declined to POST, with no error the page could show.
 *
 * The demo tenant is the one that runs in front of a customer, and a seat
 * nobody can sign into is the worst possible moment to discover that.
 */
function emailLocalPart(name: string): string {
  return (name.split(' ')[0] ?? 'user')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip combining accents
    .replace(/[^a-zA-Z0-9._-]/g, '')
    .toLowerCase()
}

const client = postgres(URL_, { max: 1, onnotice: () => {} })

async function main(): Promise<void> {
  console.log('Seeding development tenant…')

  await client`
    INSERT INTO app.tenant (id, name, business_tz)
    VALUES (${TENANT}, 'Demo Agency', 'America/New_York')
    ON CONFLICT (id) DO NOTHING`

  for (const seller of SELLERS) {
    const email = `${emailLocalPart(seller.name)}@demo.test`

    let authUserId: string | null = null
    try {
      const created = await auth.api.signUpEmail({
        body: { email, password: PASSWORD, name: seller.name },
      })
      authUserId = created.user.id
    } catch {
      // Already seeded. The tenant row is what matters, not a second login.
    }

    await client`
      INSERT INTO app.app_user
        (tenant_id, id, auth_user_id, email, full_name, display_name, role)
      VALUES (${TENANT}, ${seller.id}, ${authUserId}, ${email}, ${seller.name},
              ${seller.name.split(' ')[0] ?? seller.name}, 'seller')
      ON CONFLICT (tenant_id, id) DO NOTHING`

    await client`
      INSERT INTO app.pipeline (tenant_id, owner_user_id, name)
      VALUES (${TENANT}, ${seller.id}, 'My Board')
      ON CONFLICT DO NOTHING`

    const stages = new Map<string, string>()
    for (const [name, type, order] of [
      ['New Lead', 'open', 0],
      ['Quoted', 'open', 1],
      ['Closed Won', 'earning', 2],
      ['Closed Lost', 'lost', 3],
    ] as const) {
      const [row] = await client<{ id: string }[]>`
        INSERT INTO app.stage (tenant_id, pipeline_id, owner_user_id, name, stage_type, sort_order)
        SELECT ${TENANT}, p.id, ${seller.id}, ${name}, ${type}::app.stage_type, ${order}
        FROM app.pipeline p
        WHERE p.tenant_id = ${TENANT} AND p.owner_user_id = ${seller.id}
        RETURNING id`
      if (row) stages.set(name, row.id)
    }

    const openStage = stages.get('New Lead')
    const wonStage = stages.get('Closed Won')
    if (!openStage || !wonStage) continue

    for (const [i, monthly] of seller.wins.entries()) {
      const [contact] = await client<{ id: string }[]>`
        INSERT INTO app.contact (tenant_id, owner_user_id, full_name, created_via)
        VALUES (${TENANT}, ${seller.id}, ${`Lead ${i + 1} of ${seller.name}`}, 'manual')
        RETURNING id`

      const [opp] = await client<{ id: string }[]>`
        INSERT INTO app.opportunity
          (tenant_id, owner_user_id, contact_id, pipeline_id, stage_id, current_stage_type, created_from)
        SELECT ${TENANT}, ${seller.id}, ${contact?.id ?? null}, p.id, ${openStage}, 'open', 'manual'
        FROM app.pipeline p
        WHERE p.tenant_id = ${TENANT} AND p.owner_user_id = ${seller.id}
        RETURNING id`

      // Through the real gate: monthly premium in, x12 applied server-side,
      // ledger appended, projection maintained.
      await withTenant({ tenantId: TENANT, userId: seller.id }, (tx) =>
        tx.execute(sql`
          SELECT app.stage_move(
            ${opp?.id ?? null}::uuid, ${wonStage}::uuid, 'kanban_drag'::app.moved_via,
            'human'::app.actor_type, NULL, ${monthly.toString()}::bigint,
            'monthly'::app.premium_mode, NULL, NULL)`),
      )
    }

    console.log(`  ${seller.name}: ${seller.wins.length} closed`)
  }

  console.log(`\nDone. Sign in at /earnings with any of the demo addresses.`)
  console.log(`Password for all of them: ${PASSWORD}`)
}

main()
  .then(() => client.end())
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error(err)
    process.exit(1)
  })
