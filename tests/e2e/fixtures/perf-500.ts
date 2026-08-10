import postgres from 'postgres'

/**
 * `perf-500` — the fixed dataset the drag budget is measured against.
 *
 * `04b-design-system.md` §3.1: *1 seller · 500 open opportunities across 6
 * stages*. Budgets are meaningless without fixed data, so this is deterministic
 * and its shape is ASSERTED before any measurement runs (§3.6: "fixtures live in
 * fixtures/ with a checksum asserted at test start — an 'improvement' caused by
 * a smaller fixture fails"). A 60 fps drag across 200 cards is not a pass.
 *
 * IT GETS ITS OWN TENANT, and both reasons are load-bearing:
 *
 *   1. The board reads stages by `owner_user_id`, so stages belong to a SELLER
 *      (ruling D4 — the seller configures their own). Giving Renata the six
 *      stages this fixture needs would rewrite the demo board Jorge shows.
 *   2. `leaderboard_read` returns every seller in the tenant. A perf seller
 *      inside the demo tenant would appear on the public board at $0 forever.
 *
 * A separate tenant is invisible to both, which is what the silo is for.
 *
 * PERSISTENT, not created and destroyed per run: 500 cards is a second of
 * inserts and the rows are inert. It self-heals to exactly 500 instead, so a
 * previous run that died halfway cannot quietly shrink the fixture — which is
 * the failure the checksum exists to catch.
 */

const URL_ =
  process.env['MIGRATION_DATABASE_URL'] ??
  process.env['DEV_DATABASE_URL'] ??
  'postgresql://crm:crm@localhost:5432/crm_dev'

// Hex, and literal. A test uuid that is not valid hex has cost this project
// three separate debugging sessions.
export const PERF_TENANT = '00000000-0000-7000-8000-00000000ff01'
export const PERF_SELLER = '00000000-0000-7000-8000-00000000ff02'

export const PERF_SELLER_LOGIN = {
  email: 'perf500@perf.test',
  password: 'demo-password-1234',
} as const

/** §3.1 says six. Four open so a three-column drag never touches a gate. */
export const PERF_STAGES = [
  { name: 'Perf New', type: 'open', order: 0 },
  { name: 'Perf Working', type: 'open', order: 1 },
  { name: 'Perf Quoted', type: 'open', order: 2 },
  { name: 'Perf Pending', type: 'open', order: 3 },
  { name: 'Perf Won', type: 'earning', order: 4 },
  { name: 'Perf Lost', type: 'lost', order: 5 },
] as const

/** The number the budget is defined against. Not a target — a precondition. */
export const PERF_CARD_COUNT = 500

/** The open stages, in board order. The drag crosses the first three. */
export const PERF_OPEN_STAGES = PERF_STAGES.filter((s) => s.type === 'open').map((s) => s.name)

function client(): postgres.Sql {
  return postgres(URL_, { max: 1, onnotice: () => {} })
}

/**
 * Builds the fixture if it is absent and tops it back up to exactly 500 if it
 * is short. Safe to call on every run.
 */
export async function seedPerf500(): Promise<void> {
  const sql = client()
  try {
    await sql`
      INSERT INTO app.tenant (id, name, business_tz)
      VALUES (${PERF_TENANT}, 'Perf Fixture', 'America/New_York')
      ON CONFLICT (id) DO NOTHING`

    const [existingSeat] = await sql<{ id: string }[]>`
      SELECT id FROM app.app_user
      WHERE tenant_id = ${PERF_TENANT} AND id = ${PERF_SELLER}`

    if (!existingSeat) {
      // Dynamic import for the same reason `scripts/seed.ts` uses one:
      // better-auth's drizzle adapter opens a pool as crm_app at MODULE LOAD,
      // and a static import here would connect before this process meant to.
      const { auth } = await import('~/lib/auth/server')
      let authUserId: string
      try {
        const created = await auth.api.signUpEmail({
          body: {
            email: PERF_SELLER_LOGIN.email,
            password: PERF_SELLER_LOGIN.password,
            name: 'Perf Fivehundred',
          },
        })
        authUserId = created.user.id
      } catch {
        // Already signed up on an earlier run whose seat insert did not land.
        const [row] = await sql<{ id: string }[]>`
          SELECT id FROM auth."user" WHERE email = ${PERF_SELLER_LOGIN.email}`
        if (!row) throw new Error('perf-500: could not create or find the auth user')
        authUserId = row.id
      }

      await sql`
        INSERT INTO app.app_user
          (tenant_id, id, auth_user_id, email, full_name, display_name, role)
        VALUES (${PERF_TENANT}, ${PERF_SELLER}, ${authUserId},
                ${PERF_SELLER_LOGIN.email}, 'Perf Fivehundred', 'Perf', 'seller')
        ON CONFLICT (tenant_id, id) DO NOTHING`
    }

    const [pipeline] = await sql<{ id: string }[]>`
      WITH ins AS (
        INSERT INTO app.pipeline (tenant_id, owner_user_id, name)
        SELECT ${PERF_TENANT}, ${PERF_SELLER}, 'Perf Pipeline'
        WHERE NOT EXISTS (
          SELECT 1 FROM app.pipeline
          WHERE tenant_id = ${PERF_TENANT} AND owner_user_id = ${PERF_SELLER})
        RETURNING id
      )
      SELECT id FROM ins
      UNION ALL
      SELECT id FROM app.pipeline
      WHERE tenant_id = ${PERF_TENANT} AND owner_user_id = ${PERF_SELLER}
      LIMIT 1`
    if (!pipeline) throw new Error('perf-500: no pipeline')

    for (const stage of PERF_STAGES) {
      await sql`
        INSERT INTO app.stage
          (tenant_id, pipeline_id, owner_user_id, name, stage_type, sort_order)
        SELECT ${PERF_TENANT}, ${pipeline.id}, ${PERF_SELLER},
               ${stage.name}, ${stage.type}::app.stage_type, ${stage.order}
        WHERE NOT EXISTS (
          SELECT 1 FROM app.stage
          WHERE tenant_id = ${PERF_TENANT} AND owner_user_id = ${PERF_SELLER}
            AND name = ${stage.name})`
    }

    const [countRow] = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM app.opportunity
      WHERE tenant_id = ${PERF_TENANT} AND owner_user_id = ${PERF_SELLER}`
    const have = Number(countRow?.n ?? '0')
    const missing = PERF_CARD_COUNT - have

    // 🔴 THE ARRIVALS ARE RESET ON EVERY RUN, and this is not housekeeping.
    //
    // These rows are persistent, so `created_at` kept whatever value the first
    // seed gave it — and the fresh window is sixty minutes. An hour after the
    // fixture was first built, not one of the 500 cards was `fresh` any more,
    // so the NEW clock rendered on none of them and P6 measured a board with no
    // clocks on it. The gate that refused this feature twice would have gone
    // green WITHOUT MEASURING IT, and nothing would have said so.
    //
    // All 500 fresh is the fixture's documented worst case rather than a
    // convenience — a seller who has just imported their book has exactly that
    // — so this restores the shape the file already claims, instead of relaxing
    // it. `drag-perf.spec.ts` now asserts the clocks are on screen while it
    // measures, so this cannot quietly stop working again.
    await sql`
      UPDATE app.opportunity SET created_at = clock_timestamp()
       WHERE tenant_id = ${PERF_TENANT} AND owner_user_id = ${PERF_SELLER}`

    if (missing <= 0) return

    // Round-robin across the OPEN stages only, so the three columns the drag
    // crosses are all populated and none of them carries a gate.
    await sql`
      WITH open_stages AS (
        SELECT id, row_number() OVER (ORDER BY sort_order) - 1 AS idx,
               count(*) OVER () AS n
        FROM app.stage
        WHERE tenant_id = ${PERF_TENANT} AND owner_user_id = ${PERF_SELLER}
          AND stage_type = 'open' AND deleted_at IS NULL
      ),
      -- Explicitly cast: an untyped parameter leaves Postgres unable to pick an
      -- overload and it raises "generate_series(unknown, unknown) is not unique".
      -- No backticks in this comment: inside a template literal they close it.
      series AS (SELECT generate_series(${have + 1}::int, ${PERF_CARD_COUNT}::int) AS i),
      new_contacts AS (
        INSERT INTO app.contact (tenant_id, owner_user_id, full_name, created_via)
        SELECT ${PERF_TENANT}, ${PERF_SELLER}, 'Perf Lead ' || lpad(i::text, 4, '0'), 'manual'
        FROM series
        RETURNING id, full_name
      )
      INSERT INTO app.opportunity
        (tenant_id, owner_user_id, contact_id, pipeline_id, stage_id,
         current_stage_type, created_from)
      SELECT ${PERF_TENANT}, ${PERF_SELLER}, c.id, ${pipeline.id}, s.id, 'open', 'manual'
      FROM (SELECT id, full_name,
                   row_number() OVER (ORDER BY full_name) - 1 AS k
            FROM new_contacts) c
      JOIN open_stages s ON s.idx = c.k % s.n`
  } finally {
    await sql.end()
  }
}

export interface FixtureShape {
  readonly cards: number
  readonly openStages: number
  readonly stages: number
}

/** Reads the fixture's actual shape. The spec asserts it before measuring. */
export async function readPerf500Shape(): Promise<FixtureShape> {
  const sql = client()
  try {
    const [row] = await sql<{ cards: string; open_stages: string; stages: string }[]>`
      SELECT
        (SELECT count(*) FROM app.opportunity
          WHERE tenant_id = ${PERF_TENANT} AND owner_user_id = ${PERF_SELLER})::text AS cards,
        (SELECT count(*) FROM app.stage
          WHERE tenant_id = ${PERF_TENANT} AND owner_user_id = ${PERF_SELLER}
            AND stage_type = 'open' AND deleted_at IS NULL)::text AS open_stages,
        (SELECT count(*) FROM app.stage
          WHERE tenant_id = ${PERF_TENANT} AND owner_user_id = ${PERF_SELLER}
            AND deleted_at IS NULL)::text AS stages`
    return {
      cards: Number(row?.cards ?? '0'),
      openStages: Number(row?.open_stages ?? '0'),
      stages: Number(row?.stages ?? '0'),
    }
  } finally {
    await sql.end()
  }
}
