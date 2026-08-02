import postgres from 'postgres'

/**
 * Cards the suite creates for itself, instead of eating the demo's.
 *
 * THE FAILURE THIS FIXES: every spec that moves a card moves it FORWARD, and
 * the celebration spec moves one into an earning stage on purpose. Nothing
 * moved anything back, so each run left the demo tenant with fewer open cards
 * than the last — and after a handful of runs "New Lead" and "Quoted" were both
 * empty, the drag spec failed with "the demo needs a card in an open column",
 * and the celebration spec timed out with nothing to win. The suite had a
 * finite number of runs in it and nothing said so.
 *
 * The same lesson as pinning a starting column, one level up: a suite that
 * consumes shared state has an expiry date. So each spec that needs a card
 * makes one and removes it afterwards, and the demo tenant ends every run the
 * way it started.
 *
 * Connects as the MIGRATOR, like every other fixture in this repository: it is
 * writing rows before any session exists, which is exactly what RLS is there to
 * refuse.
 */

const URL_ =
  process.env['MIGRATION_DATABASE_URL'] ??
  process.env['DEV_DATABASE_URL'] ??
  'postgresql://crm:crm@localhost:5432/crm_dev'

/** The demo tenant and its first seller, as `scripts/seed.ts` writes them. */
const TENANT = '00000000-0000-7000-8000-00000000de01'
const SELLER = '00000000-0000-7000-8000-00000000ab01'

export interface FixtureCard {
  readonly opportunityId: string
  readonly contactId: string
  readonly contactName: string
}

function client(): postgres.Sql {
  return postgres(URL_, { max: 1, onnotice: () => {} })
}

/**
 * One open card in the demo seller's first open column.
 *
 * Named per test rather than shared: two specs holding the same card is the
 * race that made the first version of the drag suite flaky.
 */
export async function createOpenCard(label: string): Promise<FixtureCard> {
  const sql = client()
  try {
    const [contact] = await sql<{ id: string }[]>`
      INSERT INTO app.contact (tenant_id, owner_user_id, full_name, created_via)
      VALUES (${TENANT}, ${SELLER}, ${label}, 'manual')
      RETURNING id`

    const [opportunity] = await sql<{ id: string }[]>`
      INSERT INTO app.opportunity
        (tenant_id, owner_user_id, contact_id, pipeline_id, stage_id,
         current_stage_type, created_from)
      SELECT ${TENANT}, ${SELLER}, ${contact?.id ?? null}, p.id, s.id, 'open', 'manual'
      FROM app.pipeline p
      JOIN app.stage s
        ON s.tenant_id = p.tenant_id AND s.pipeline_id = p.id AND s.stage_type = 'open'
      WHERE p.tenant_id = ${TENANT} AND p.owner_user_id = ${SELLER}
      ORDER BY s.sort_order
      LIMIT 1
      RETURNING id`

    if (!contact || !opportunity) throw new Error('fixture card could not be created')
    return { opportunityId: opportunity.id, contactId: contact.id, contactName: label }
  } finally {
    await sql.end()
  }
}

/**
 * Removes the card and its contact.
 *
 * The LEDGER and the TRANSITIONS stay, and that is not an oversight: both are
 * append-only by statement trigger — to the owner and to a superuser, not only
 * to `crm_app` — so a fixture that could erase them would be the hole the whole
 * design exists to close. Attempting it raises IM001, which is the trigger
 * doing its job. What a test wrote there is history, exactly as a real sale
 * would be.
 *
 * The opportunity itself is deletable because nothing append-only references
 * it: `stage_transition` and `earnings_ledger` carry `opportunity_id` with no
 * foreign key, precisely so the record of what happened outlives the row it
 * happened to.
 */
export async function removeCard(card: FixtureCard): Promise<void> {
  const sql = client()
  try {
    await sql`DELETE FROM app.opportunity
              WHERE tenant_id = ${TENANT} AND id = ${card.opportunityId}`
    await sql`DELETE FROM app.contact
              WHERE tenant_id = ${TENANT} AND id = ${card.contactId}`
  } finally {
    await sql.end()
  }
}
