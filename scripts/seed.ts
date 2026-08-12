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

/**
 * The tenant admin, and until now the demo had none.
 *
 * 🔴 EVERY SEEDED USER WAS A `seller`, so `/admin/integration-health` was
 * unreachable by anybody. `app.dead_letter` and `app.admin_alert` are
 * `tenant_admin_only`, so their policies read `app.scope_is_admin()` — which
 * `begin_request` derives from `app_user.role` — and a database with no admin
 * row is a screen with no possible viewer. The surface has existed and been
 * tested since the alert work; nobody could open it.
 *
 * There is still NO WRITER for `app_user` anywhere in `app/`, so the product
 * cannot onboard or promote anyone. This closes the demo's half of that; the
 * other half is user management and is its own story.
 */
const ADMIN = {
  id: '00000000-0000-7000-8000-00000000ad01',
  // ⚠️ NOT 'Dana': `emailLocalPart` takes the first name, and Dana Reyes
  // already holds dana@demo.test. Caught by app_user_email_uidx on the first
  // run — the constraint doing its job on the seed itself.
  name: 'Valeria Sosa',
} as const

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
 * Where a backdated win lands, anchored to the TENANT BUSINESS timezone.
 *
 * Three timezone rules exist in this product and they are never merged: the
 * tenant's business zone stamps `period_key`, the user's display zone formats
 * what a human reads, and the lead's zone decides the legal calling window.
 * This is the first of the three, and computing these anchors in UTC would put
 * a 9 p.m. Eastern sale in the wrong day bucket — on the number a seller is
 * ranked by, on the board a room watches.
 *
 * Relative to the CURRENT period boundaries, never a fixed number of days ago:
 * "seven days back" spans a different set of buckets depending on which day
 * the seed runs, and a demo whose period selector works on Thursdays is worse
 * than one that never worked.
 */
function localAnchor(expression: string): string {
  return `(SELECT (${expression}) AT TIME ZONE t.business_tz
             FROM app.tenant t WHERE t.id = app.current_tenant())`
}

const LOCAL_NOW = `now() AT TIME ZONE t.business_tz`

function backdateFor(index: number): string {
  // Note what the calendar does to this and what it does not. On a Monday the
  // week starts today, so `this week` and `today` hold the same wins — that is
  // the calendar being honest, not the seed failing. What the seed guarantees
  // is that all-time is strictly bigger than a bounded board.
  if (index === 1) return localAnchor(`date_trunc('week', ${LOCAL_NOW}) + interval '10 hours'`)
  if (index === 2) return localAnchor(`date_trunc('month', ${LOCAL_NOW}) + interval '10 hours'`)
  return localAnchor(`date_trunc('month', ${LOCAL_NOW}) - interval '25 days'`)
}

/**
 * `Dana Reyes` becomes `Dana R.` — the name the floor sees.
 *
 * Found by looking at the rank-and-gap line, which rendered `$2,550.12 behind
 * Priya` because the seed wrote a bare first name into `display_name`. Every
 * example in the corpus is `First L.` — §7's demo seller is *Marcus T.*, its
 * gap line reads *behind Dana R.*, the celebration headline is *Carlos J. just
 * wrote $1,850*, and leaderboard feature 4 writes *passing Maria R. (#7)*.
 *
 * It is not only copy. `display_name` is what the PUBLIC board renders, and on
 * a floor of fifty producers two people share a first name — a board where two
 * rows both read `Maria` is a board nobody can read their own position off.
 * `full_name` stays whole; this is the public form of it.
 */
function publicName(name: string): string {
  const parts = name.trim().split(/\s+/)
  const first = parts[0] ?? name
  const initial = parts.length > 1 ? parts[parts.length - 1]?.[0] : undefined

  return initial ? `${first} ${initial}.` : first
}

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
/**
 * The one non-seller in the demo tenant.
 *
 * No pipeline and no wins: an admin is not a competitor, and giving them a
 * board would put a zero on the public leaderboard next to five people who
 * actually sell. Their reason to sign in is the admin surface.
 */
async function seedAdmin(): Promise<void> {
  const { auth } = await import('../app/lib/auth/server')
  const email = 'valeria@demo.test'

  let authUserId: string | null = null
  try {
    const created = await auth.api.signUpEmail({
      body: { email, password: PASSWORD, name: ADMIN.name },
    })
    authUserId = created.user.id
  } catch {
    // Already seeded. The tenant row is what matters, not a second login.
  }

  await client`
    INSERT INTO app.app_user
      (tenant_id, id, auth_user_id, email, full_name, display_name, role)
    VALUES (${TENANT}, ${ADMIN.id}, ${authUserId}, ${email}, ${ADMIN.name},
            ${publicName(ADMIN.name)}, 'admin')
    ON CONFLICT (tenant_id, id) DO NOTHING`
}

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
  // 🔴 THE SEED IS WHAT MAKES A DATABASE A DEVELOPMENT DATABASE, so it is what
  // says so — AND IT HAS TO SAY SO BEFORE THE IMPORTS BELOW. Migration 0032
  // derives the environment from the presence of a demo tenant and classifies
  // an unclassified database as `production`, which is the right default: a
  // real production database is unclassified on the day it is created.
  //
  // `db:migrate` runs BEFORE `db:seed` on a fresh setup, so at 0032 time there
  // is no demo tenant and the database correctly calls itself production.
  //
  // 🔴 THIS USED TO SIT THIRTY LINES LOWER AND IT NEVER RAN. `~/db` asserts the
  // MVP capabilities at module load, so the dynamic import below refuses with
  // `CAP200: call_list (unknown)` before any statement after it executes. The
  // documented chain — `db:reset && db:up && db:migrate && db:seed` — could not
  // complete on a genuinely fresh volume, and the note under the old line
  // described this exact failure while sitting on the wrong side of it.
  //
  // Found by running that chain: the seed died on CAP200, and setting this one
  // row by hand let it finish end to end. The dynamic imports were already here
  // for the sibling hazard documented above; this is the same lesson applied to
  // the row they depend on.
  await client`
    INSERT INTO ref.system_constant (key, value, reason)
    VALUES ('environment', 'development',
            'Set by scripts/seed.ts. This database holds the demo tenant, so it is a development database — 0032 could not see that yet because migrations run before the seed.')
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, reason = EXCLUDED.reason`

  const { withTenant } = await import('../app/db')
  const { auth } = await import('../app/lib/auth/server')

  // `is_demo` is the flag the shell renders its Demo chip from, and protected
  // item 10 names the failure it prevents: without it, a screenshot of the demo
  // is indistinguishable from a real customer's standings. The column carries a
  // unique partial index, so there can only ever be one demo tenant.
  await client`
    INSERT INTO app.tenant (id, name, business_tz, is_demo)
    VALUES (${TENANT}, 'Demo Agency', 'America/New_York', true)
    ON CONFLICT (id) DO UPDATE SET is_demo = true`

  // 🔴 BEFORE THE REFUSAL, DELIBERATELY, and the placement is the argument.
  // `refuseToSeedTwice` exists for the LEDGER — re-running would double-credit
  // an append-only record with no recompute job. A user row is idempotent
  // (`ON CONFLICT DO NOTHING`, and the sign-up is already wrapped), so seeding
  // the admin ahead of the refusal is what lets an already-seeded database
  // acquire one without a full reset — which the ledger makes expensive.
  await seedAdmin()

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
              ${publicName(seller.name)}, 'seller')
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

      if (i === 0) {
        // Through the real gate: monthly premium in, x12 applied server-side,
        // ledger appended, projection maintained. The FIRST win of every
        // seller goes this way, so the seed still proves the path it seeds.
        await withTenant({ tenantId: TENANT, userId: seller.id }, (tx) =>
          tx.execute(sql`
            SELECT app.stage_move(
              ${opp?.id ?? null}::uuid, ${wonStage}::uuid, 'kanban_drag'::app.moved_via,
              'human'::app.actor_type, NULL, ${monthly.toString()}::bigint,
              'monthly'::app.premium_mode, NULL, NULL)`),
        )
        continue
      }

      // The rest are BACKDATED, because protected item 10 requires the seed to
      // span all four periods and `stage_move` can only stamp now(). Without
      // this every bucket held the same number — measured, not assumed: day,
      // week, month and all_time all read $56,717.88 — so the period selector
      // demonstrated nothing at minute 0:30 and the four ratified empty
      // states were unreachable copy.
      //
      // `stage_move` is still the only path that WRITES A CARD; these move the
      // card and then append the money with a date, through the same definer
      // the real path calls. A seed that backfills history is backfilling
      // history, and saying so beats pretending now() is a business decision.
      await withTenant({ tenantId: TENANT, userId: seller.id }, (tx) =>
        tx.execute(sql`
          SELECT app.ledger_append(
            ${seller.id}::uuid, gen_random_uuid(), 'opportunity.won',
            'sale'::app.ledger_entry_type,
            app.annualize(${monthly.toString()}::bigint),
            ${sql.raw(backdateFor(i))},
            ${opp?.id ?? null}::uuid, ${contact?.id ?? null}::uuid,
            ${wonStage}::uuid, 'Closed Won', 1::bigint, NULL, NULL, NULL, NULL)`),
      )
    }

    console.log(`  ${seller.name}: ${seller.wins.length} closed`)
  }

  await seedReversedSale()
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
 * One sale that was credited and then taken back — protected item 10 asks for
 * exactly one, *"so corrections can be shown without faking one"*.
 *
 * Faking one live is the alternative, and it is the worse one in two ways: it
 * writes to a customer-facing demo's public board during the meeting, and it
 * asks the presenter to explain a reversal while performing it. A seeded pair
 * lets the reversal be READ instead — which is also the only way to show what
 * the ledger looks like afterwards, since there is no recompute job and the
 * correction is a compensating append, by design.
 *
 * Backdated, so it does not move any bounded board. A reversal on the Today
 * board mid-demo is a number moving down in front of a room.
 */
async function seedReversedSale(): Promise<void> {
  const seller = SELLERS[1]
  if (!seller) return

  const monthlyCents = 41_500n
  // Same deferred import as the win loop: `~/db` reads DATABASE_URL at module
  // load, and this script connects as the OWNER.
  const { withTenant } = await import('../app/db')

  const [contact] = await client<{ id: string }[]>`
    INSERT INTO app.contact (tenant_id, owner_user_id, full_name, created_via)
    VALUES (${TENANT}, ${seller.id}, 'Wanda Estes', 'manual')
    RETURNING id`

  // A deal is required, not decoration: `earnings_deal_context_present` refuses
  // any sale or reversal without an opportunity, a contact, a stage-name
  // snapshot AND a stage config version. Found by the constraint rejecting the
  // first version of this function, which is the check doing its job — a money
  // row with no deal behind it is a number nobody can ever explain.
  //
  // Left in an OPEN stage on purpose. That is what a reversed win looks like
  // afterwards: the card came back out, and the ledger carries both rows.
  const [openStage] = await client<{ id: string }[]>`
    SELECT id FROM app.stage
     WHERE tenant_id = ${TENANT} AND owner_user_id = ${seller.id} AND stage_type = 'open'
     ORDER BY sort_order LIMIT 1`

  const [opp] = await client<{ id: string }[]>`
    INSERT INTO app.opportunity
      (tenant_id, owner_user_id, contact_id, pipeline_id, stage_id, current_stage_type, created_from)
    SELECT ${TENANT}, ${seller.id}, ${contact?.id ?? null}, p.id, ${openStage?.id ?? null}, 'open', 'manual'
    FROM app.pipeline p
    WHERE p.tenant_id = ${TENANT} AND p.owner_user_id = ${seller.id}
    RETURNING id`

  await withTenant({ tenantId: TENANT, userId: seller.id }, async (tx) => {
    const rows = await tx.execute<{ entry_id: string }>(sql`
      SELECT entry_id FROM app.ledger_append(
        ${seller.id}::uuid, gen_random_uuid(), 'opportunity.won',
        'sale'::app.ledger_entry_type, app.annualize(${monthlyCents.toString()}::bigint),
        ${sql.raw(backdateFor(3))},
        ${opp?.id ?? null}::uuid, ${contact?.id ?? null}::uuid, NULL,
        'Closed Won', 1::bigint, NULL, NULL, NULL, NULL)`)

    const entryId = rows[0]?.entry_id
    if (!entryId) throw new Error('the sale to reverse was not appended')

    // NAMES the entry it cancels, which migration 0019 made a constraint
    // rather than a habit: without the link an undo is indistinguishable from
    // a correction, takes the correction path, and lands on the public board.
    await tx.execute(sql`
      SELECT app.ledger_append(
        ${seller.id}::uuid, gen_random_uuid(), 'opportunity.reopened',
        'reversal'::app.ledger_entry_type, -app.annualize(${monthlyCents.toString()}::bigint),
        ${sql.raw(backdateFor(3))},
        ${opp?.id ?? null}::uuid, ${contact?.id ?? null}::uuid, NULL,
        'Closed Won', 1::bigint, NULL,
        'Policy not taken — first premium never drafted', NULL, ${entryId}::uuid)`)
  })

  console.log(`  ${seller.name}: 1 sale reversed (net zero, both rows on the ledger)`)
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

  /**
   * ONE CARD PER HEALTH STATE, and the ages are FIXED rather than random.
   *
   * They used to be `random() * 12 days`, which meant the board looked
   * different on every seed and no card was guaranteed to be in any
   * particular state — so the health rail could not be demonstrated and could
   * not be asserted. A demo whose most-repeated screen is a dice roll is a
   * demo that shows something else the morning it matters.
   *
   * Every one of these also had `created_at` defaulting to now(), so with zero
   * attempts EVERY card computed as `fresh` and the decay states were
   * unreachable no matter what `last_activity_at` said.
   *
   *   ageDays      how long ago the lead arrived (the NEW clock's anchor)
   *   touchedDays  days since the last touch (the decay numerator)
   *   attempts     dial attempts, which is also what disqualifies `fresh`
   *   overdueHours an activity already past due, or null
   */
  const leads = [
    // Fresh: arrived minutes ago, never dialled. Blue rail, `NEW` in the slot.
    {
      name: 'Ruth Alvarez',
      stage: 'New Lead',
      ageDays: 0,
      touchedDays: 0,
      attempts: 0,
      overdueHours: null,
    },
    // Going cold: past the seven-day threshold. Full amber rail.
    {
      name: 'Curtis Vance',
      stage: 'New Lead',
      ageDays: 20,
      touchedDays: 9,
      attempts: 3,
      overdueHours: null,
    },
    // Decaying but not yet cold — the PARTIAL fill, which is the half of the
    // gradient a screenshot of a threshold-only design never shows.
    {
      name: 'Alma Betancourt',
      stage: 'Quoted',
      ageDays: 20,
      touchedDays: 4,
      attempts: 2,
      overdueHours: null,
    },
    // Overdue: red rail, and the one state where the rail and the slot say
    // different things on purpose.
    {
      name: 'Wendell Pike',
      stage: 'Quoted',
      ageDays: 20,
      touchedDays: 2,
      attempts: 5,
      overdueHours: 3,
    },
  ] as const

  for (const lead of leads) {
    const stage = stages.find((s) => s.name === lead.stage)
    if (!stage) continue

    const [contact] = await client<{ id: string }[]>`
      INSERT INTO app.contact (tenant_id, owner_user_id, full_name, created_via)
      VALUES (${TENANT}, ${seller.id}, ${lead.name}, 'lead_intake')
      RETURNING id`

    const [opp] = await client<{ id: string }[]>`
      INSERT INTO app.opportunity
        (tenant_id, owner_user_id, contact_id, pipeline_id, stage_id, current_stage_type,
         created_from, created_at, stage_entered_at, last_activity_at, attempt_count)
      SELECT ${TENANT}, ${seller.id}, ${contact?.id ?? null}, p.id, ${stage.id}, 'open',
             'lead_intake',
             clock_timestamp() - (${lead.ageDays} || ' days')::interval,
             clock_timestamp() - (${lead.ageDays} || ' days')::interval,
             clock_timestamp() - (${lead.touchedDays} || ' days')::interval,
             ${lead.attempts}
      FROM app.pipeline p WHERE p.tenant_id = ${TENANT} AND p.owner_user_id = ${seller.id}
      RETURNING id`

    if (lead.overdueHours !== null) {
      await client`
        INSERT INTO app.activity
          (tenant_id, owner_user_id, contact_id, opportunity_id, type, title, due_at, created_by)
        VALUES (${TENANT}, ${seller.id}, ${contact?.id ?? null}, ${opp?.id ?? null}, 'task',
                ${`Follow up with ${lead.name.split(' ')[0] ?? lead.name}`},
                clock_timestamp() - (${lead.overdueHours} || ' hours')::interval, 'human')`
    }
  }

  console.log(`  ${seller.name}: ${leads.length} open cards, one per health state`)

  await seedAlowareCapture(seller)
}

/**
 * The Aloware capture subject — a card that exists so the integration has a
 * place to be looked at.
 *
 * 🔴 IT IS A DUMMY, AND THAT IS THE POINT RATHER THAN A SHORTCUT. The Gate-2
 * capture dialled a real lead out of the client's production book, and their
 * name, phone, email, city and date of birth are in those bytes. Seeding the
 * real subject would copy a consumer's details into every developer's database
 * and into the demo, permanently, to illustrate a payload shape. The number
 * here is from the North American reserved fictional range (555-0100..0199) —
 * the same lawful-subject rule errata E9 imposes on capability probes.
 *
 * IT IS ALSO THE ONLY SEEDED CONTACT WITH A PHONE NUMBER, which is not an
 * oversight in the others: nothing in the product needed one until the dial
 * existed. Without it the Call control answers `no_phone` and stops one step
 * earlier than the state actually worth seeing, which is `no_number` — the
 * seller has a lead to call and no calling number of their own yet.
 */
async function seedAlowareCapture(seller: { id: string; name: string }): Promise<void> {
  const stage = await client<{ id: string }[]>`
    SELECT s.id FROM app.stage s
      JOIN app.pipeline p ON p.tenant_id = s.tenant_id AND p.id = s.pipeline_id
     WHERE s.tenant_id = ${TENANT} AND p.owner_user_id = ${seller.id} AND s.name = 'New Lead'
     LIMIT 1`

  const stageId = stage[0]?.id
  if (stageId === undefined) return

  const [contact] = await client<{ id: string }[]>`
    INSERT INTO app.contact (tenant_id, owner_user_id, full_name, created_via)
    VALUES (${TENANT}, ${seller.id}, 'Aloware Capture (demo)', 'lead_intake')
    RETURNING id`

  if (contact === undefined) return

  await client`
    INSERT INTO app.contact_phone (tenant_id, contact_id, owner_user_id, phone_e164, is_primary)
    VALUES (${TENANT}, ${contact.id}, ${seller.id}, '+12025550142', true)`

  await client`
    INSERT INTO app.opportunity
      (tenant_id, owner_user_id, contact_id, pipeline_id, stage_id, current_stage_type,
       created_from, created_at, stage_entered_at, last_activity_at, attempt_count)
    SELECT ${TENANT}, ${seller.id}, ${contact.id}, p.id, ${stageId}, 'open', 'lead_intake',
           clock_timestamp() - interval '2 days',
           clock_timestamp() - interval '2 days',
           clock_timestamp() - interval '2 days',
           1
    FROM app.pipeline p WHERE p.tenant_id = ${TENANT} AND p.owner_user_id = ${seller.id}`

  console.log('  Aloware Capture (demo): the card the integration panel hangs off')

  // The seller's outbound identity (§5). Without it `POST /api/calls` stops at
  // `no_number` and the Call control can only ever say one thing.
  //
  // The ids are the REAL ones Gate G2 read off the account — seat `120776`,
  // Test Line `63949`, `+1 737 427 3994` — because the demo tenant IS that
  // account and a demo that dials from an invented line teaches the wrong shape.
  // None of it is personal data: a business line and a seat id.
  //
  // ⚠️ `verified_at` IS SET HERE AND NO VERIFICATION HAPPENED. ADR-042's
  // three-way flow does not exist, and the column is what the dial reads, so a
  // NULL would make this row inert and the seed pointless. It is written ONLY on
  // the tenant carrying `is_demo = true` — the one the shell already labels
  // "Demo tenant — these numbers are seeded." A real tenant reaching this state
  // without the flow is the thing the column exists to prevent, and this is not
  // that.
  await client`
    INSERT INTO app.aloware_number_mapping
      (tenant_id, owner_user_id, aloware_user_id, aloware_line_id, from_number_e164, verified_at)
    VALUES (${TENANT}, ${seller.id}, 120776, 63949, '+17374273994', clock_timestamp())
    ON CONFLICT DO NOTHING`

  console.log('  outbound identity: +1 737 427 3994 (Test Line 63949, seat 120776)')
}

main()
  .then(() => client.end())
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error(err)
    process.exit(1)
  })
