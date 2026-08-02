import { sql } from 'drizzle-orm'
import postgres from 'postgres'

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

/**
 * The OWNER credential, not the application's. Seeding writes rows that RLS
 * would refuse — a tenant before any user exists, a user before any session —
 * so it goes through the migrator policy, exactly as migrations do.
 */
const URL_ =
  process.env['MIGRATION_DATABASE_URL'] ??
  process.env['DEV_DATABASE_URL'] ??
  'postgresql://crm:crm@localhost:5432/crm_dev'

/** Dev-only, and set here rather than in a migration on purpose. */
const APP_ROLE_PASSWORD = 'crm_app_dev_only'
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

/**
 * A second seed run is not a no-op, and it cannot be made into one.
 *
 * Found by running `npm run db:seed` on an already-seeded database — which is
 * the literal restart procedure written in CONTEXT.md. The tenant, users and
 * pipeline carry natural keys and were already `ON CONFLICT DO NOTHING`;
 * stages, contacts and opportunities have none, so the board came back with
 * every column and every card twice. Worse, and invisible on the board: each
 * duplicate went through `stage_move`, so a second full set of ledger entries
 * was appended and every seller's PUBLIC total doubled. The demo tenant is the
 * one that runs in front of a customer.
 *
 * There is no cleanup path, by design. `earnings_ledger` refuses UPDATE,
 * DELETE and TRUNCATE by statement trigger — to the owner and to a superuser,
 * not only to `crm_app` — so no `DELETE FROM` this script could run would work,
 * and one that did would be the hole the append-only record exists to close.
 * The only reset for a ledger is a new database, and that is what this says.
 */
async function refuseToSeedTwice(): Promise<void> {
  const [row] = await client<{ n: string }[]>`
    SELECT count(*)::text AS n FROM app.earnings_ledger WHERE tenant_id = ${TENANT}`

  if (row && row.n !== '0') {
    console.error(
      `\nThis database is already seeded — ${row.n} ledger entries for the demo tenant.` +
        `\nSeeding again would append a SECOND set and double every public total.` +
        `\n\nThe ledger is append-only and cannot be cleaned up, so the reset is a new database:` +
        // db:reset, not db:down. `down` leaves the named volume in place, so
        // the cluster comes back with every row still in it and this message
        // prints again — advice that does not work is worse than none.
        `\n\n  npm run db:reset && npm run db:up && npm run db:migrate && npm run db:seed\n`,
    )
    process.exitCode = 1
    await client.end()
    process.exit(1)
  }
}

async function main(): Promise<void> {
  console.log('Seeding development tenant…')

  // The out-of-band step the migration deliberately leaves undone. Production
  // does this in the provider's console; a credential in a migration is a
  // credential in the repository and in every clone.
  await client.unsafe(`ALTER ROLE crm_app WITH PASSWORD '${APP_ROLE_PASSWORD}'`)

  // Imported AFTER the password exists, not at the top of the file. `~/db`
  // opens its pool and runs the G4(a) boot assertion at module load, so a
  // static import here would connect as crm_app before crm_app could log in —
  // and the boot guard would take the seed down for the right reason at the
  // wrong moment.
  //
  // `auth` has the SAME hazard and was a static import until a genuinely fresh
  // volume proved it: better-auth's drizzle adapter opens its own pool as
  // crm_app at module load, so `npm run db:seed` died with `password
  // authentication failed for user "crm_app"` before reaching the line that
  // sets the password. Invisible until now because every run since migration
  // 0018 landed on a database that already had one.
  const { withTenant } = await import('../app/db')
  const { auth } = await import('../app/lib/auth/server')

  await client`
    INSERT INTO app.tenant (id, name, business_tz)
    VALUES (${TENANT}, 'Demo Agency', 'America/New_York')
    ON CONFLICT (id) DO NOTHING`

  await refuseToSeedTwice()

  await seedLostReasons()

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

  await seedMyDay()
  await seedOpenPipeline()

  console.log(`\nDone. Sign in at /earnings with any of the demo addresses.`)
  console.log(`Password for all of them: ${PASSWORD}`)
}

/**
 * The tenant's loss reasons.
 *
 * WITHOUT THESE, CLOSED LOST IS UNUSABLE. The move sheet's "Why?" select is
 * populated from this table, the win/loss gate is a CHECK constraint
 * (`current_stage_type <> 'lost' OR lost_reason_id IS NOT NULL`), and an empty
 * select means the database refuses every move into a lost stage. Nothing was
 * broken in the product — a whole column of the demo simply could not be used,
 * which is the kind of hole that only shows up when somebody clicks.
 *
 * TENANT-SCOPED, not per seller: sellers configure their own stages (ruling D4),
 * but reporting compares loss reasons across the agency, so a per-seller list
 * would make the one number an owner actually wants uncomparable.
 *
 * `code` is the reporting key and `label` is what a human reads. Renaming a
 * label must never move a number, which is the same rule that binds the win and
 * loss gates to `stage_type` rather than to a stage's name.
 */
const LOST_REASONS = [
  { code: 'price', label: 'Premium too high', order: 1 },
  { code: 'competitor', label: 'Bought from another agent', order: 2 },
  { code: 'underwriting', label: 'Declined in underwriting', order: 3 },
  { code: 'unresponsive', label: 'Stopped responding', order: 4 },
  { code: 'not_interested', label: 'Not interested', order: 5 },
  { code: 'timing', label: 'Not the right time', order: 6 },
  { code: 'bad_contact', label: 'Wrong or disconnected number', order: 7 },
] as const

async function seedLostReasons(): Promise<void> {
  for (const reason of LOST_REASONS) {
    await client`
      INSERT INTO app.lost_reason (tenant_id, code, label, sort_order)
      VALUES (${TENANT}, ${reason.code}, ${reason.label}, ${reason.order})
      ON CONFLICT (tenant_id, code) DO NOTHING`
  }
  console.log(`  ${LOST_REASONS.length} loss reasons`)
}

/**
 * One seller's day, covering all four sections including the one that must
 * never be empty by accident: a meeting whose end time has passed with no
 * outcome recorded.
 */
async function seedMyDay(): Promise<void> {
  const seller = SELLERS[0]
  if (!seller) return

  const [contact] = await client<{ id: string }[]>`
    INSERT INTO app.contact (tenant_id, owner_user_id, full_name, created_via)
    VALUES (${TENANT}, ${seller.id}, 'Doris Whitfield', 'manual')
    RETURNING id`

  const [stage] = await client<{ id: string }[]>`
    SELECT id FROM app.stage
    WHERE tenant_id = ${TENANT} AND owner_user_id = ${seller.id} AND name = 'New Lead'`

  const [opp] = await client<{ id: string }[]>`
    INSERT INTO app.opportunity
      (tenant_id, owner_user_id, contact_id, pipeline_id, stage_id, current_stage_type, created_from)
    SELECT ${TENANT}, ${seller.id}, ${contact?.id ?? null}, p.id, ${stage?.id ?? null}, 'open', 'manual'
    FROM app.pipeline p WHERE p.tenant_id = ${TENANT} AND p.owner_user_id = ${seller.id}
    RETURNING id`

  // Ended ninety minutes ago and still has no outcome — the undismissable row.
  await client`
    INSERT INTO app.meeting
      (tenant_id, owner_user_id, contact_id, opportunity_id, starts_at_utc, duration_minutes,
       contact_timezone, created_via)
    VALUES (${TENANT}, ${seller.id}, ${contact?.id ?? null}, ${opp?.id ?? null},
            clock_timestamp() - interval '2 hours', 30, 'America/New_York', 'wrap_up')`

  // Still ahead of them today.
  await client`
    INSERT INTO app.meeting
      (tenant_id, owner_user_id, contact_id, opportunity_id, starts_at_utc, duration_minutes,
       contact_timezone, created_via)
    VALUES (${TENANT}, ${seller.id}, ${contact?.id ?? null}, ${opp?.id ?? null},
            clock_timestamp() + interval '3 hours', 30, 'America/New_York', 'quick_schedule')`

  await client`
    INSERT INTO app.activity (tenant_id, owner_user_id, contact_id, opportunity_id, type, title,
                              due_at, created_by)
    VALUES
      (${TENANT}, ${seller.id}, ${contact?.id ?? null}, ${opp?.id ?? null}, 'task',
       'Call back Doris about the quote', clock_timestamp() - interval '40 minutes', 'human'),
      (${TENANT}, ${seller.id}, ${contact?.id ?? null}, ${opp?.id ?? null}, 'task',
       'Send the IUL illustration', clock_timestamp() + interval '4 hours', 'human')`

  console.log(`  ${seller.name}: My Day seeded (2 meetings, 2 callbacks)`)
}

/**
 * Live cards for the pipeline board.
 *
 * Deliberately includes one with no deal value: that is the card the win gate
 * refuses, and a board where every card is already qualified demonstrates the
 * gate never firing.
 */
async function seedOpenPipeline(): Promise<void> {
  const seller = SELLERS[0]
  if (!seller) return

  const stages = await client<{ id: string; name: string }[]>`
    SELECT id, name FROM app.stage
    WHERE tenant_id = ${TENANT} AND owner_user_id = ${seller.id} AND stage_type = 'open'
    ORDER BY sort_order`

  const leads = [
    ['Ruth Alvarez', 'New Lead'],
    ['Curtis Vance', 'New Lead'],
    ['Alma Betancourt', 'Quoted'],
    ['Wendell Pike', 'Quoted'],
  ] as const

  for (const [name, stageName] of leads) {
    const stage = stages.find((s) => s.name === stageName)
    if (!stage) continue

    const [contact] = await client<{ id: string }[]>`
      INSERT INTO app.contact (tenant_id, owner_user_id, full_name, created_via)
      VALUES (${TENANT}, ${seller.id}, ${name}, 'lead_intake')
      RETURNING id`

    await client`
      INSERT INTO app.opportunity
        (tenant_id, owner_user_id, contact_id, pipeline_id, stage_id, current_stage_type,
         created_from, stage_entered_at, last_activity_at)
      SELECT ${TENANT}, ${seller.id}, ${contact?.id ?? null}, p.id, ${stage.id}, 'open',
             'lead_intake',
             clock_timestamp() - (random() * 12 || ' days')::interval,
             clock_timestamp() - (random() * 9 || ' days')::interval
      FROM app.pipeline p WHERE p.tenant_id = ${TENANT} AND p.owner_user_id = ${seller.id}`
  }

  console.log(`  ${seller.name}: ${leads.length} open cards on the board`)
}

main()
  .then(() => client.end())
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error(err)
    process.exit(1)
  })
