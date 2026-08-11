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
 * Moves a card's arrival back by `seconds`, so a test can stand at a chosen
 * point in the sixty-minute fresh window.
 *
 * RELATIVE TO NOW, never an absolute timestamp, and that is the whole reason
 * this exists rather than a seeded card. `card-anatomy.spec.ts` has twice been
 * red because the seed stamps an absolute age and the assertion was relative:
 * Ruth's `fresh` chip was true for one hour after `db:seed` and false forever
 * after, and Curtis's `9d` became `13d`. A test that backdates from
 * `clock_timestamp()` at the moment it runs cannot acquire an expiry date.
 */
export async function backdateArrival(card: FixtureCard, seconds: number): Promise<void> {
  const sql = client()
  try {
    await sql`UPDATE app.opportunity
                 SET created_at = clock_timestamp() - make_interval(secs => ${seconds})
               WHERE tenant_id = ${TENANT} AND id = ${card.opportunityId}`
  } finally {
    await sql.end()
  }
}

/**
 * Waits until nothing is still in flight for this contact.
 *
 * 🔴 THE TIMELINE MADE THIS NECESSARY, and the failure it prevents is worth
 * stating because it caught six specs at once. `app.stage_move` emits inside
 * the move transaction and the relay picks the delivery up on its next
 * one-second tick; `removeCard` used to run in between. The projector then
 * called `timeline_upsert` for a contact that no longer existed, the FK refused
 * it, and the delivery retried its full eight attempts before dead-lettering —
 * on every affected run, forever, for work whose subject was already gone.
 *
 * Waiting rather than deleting the outbox rows is deliberate. A fixture that
 * reaches into the transport to clear its own mess would hide exactly the class
 * of relay defect this suite exists to catch; waiting asserts the transport
 * really did the work before the fixture takes the row away.
 *
 * `crm_app` HAS NO DELETE ON `app.contact` — the privilege is revoked, so no
 * production path can reach this state at all. Only the migrator can, which is
 * what this fixture connects as.
 */
async function settleOutboxFor(sql: postgres.Sql, contactId: string): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const [row] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n
        FROM app.event_outbox o
        JOIN app.event_log e
          ON e.tenant_id = o.tenant_id AND e.event_id = o.event_id
       -- 🔴 'claimed' COUNTS, and leaving it out is what made the first version
       -- of this wait useless. A row the relay has claimed is precisely the one
       -- in flight: the handler is running against it right now. Polling only
       -- for 'pending' returns zero at the exact moment it is least safe to
       -- delete the contact, which is how a delivery still got poisoned after
       -- the wait was added. 'delivered' and 'dead' are the terminal two.
       WHERE o.tenant_id = ${TENANT}
         AND o.status IN ('pending', 'claimed')
         AND e.payload ->> 'contact_id' = ${contactId}`

    if ((row?.n ?? 0) === 0) return
    await new Promise((resolve) => setTimeout(resolve, 250))
  }

  // LOUD, not silent. Giving up quietly is what leaves a delivery retrying for
  // a contact that is about to vanish; the backoff runs {1,5,25,125,…} seconds,
  // so anything still moving after fifteen is stuck rather than slow, and the
  // suite should say so instead of cleaning up on top of it.
  throw new Error(
    `outbox never settled for contact ${contactId}: a delivery is stuck, and deleting the contact now would poison it`,
  )
}

/**
 * Removes the card, its projected history and its contact.
 *
 * The LEDGER and the TRANSITIONS stay, and that is not an oversight: both are
 * append-only by statement trigger — to the owner and to a superuser, not only
 * to `crm_app` — so a fixture that could erase them would be the hole the whole
 * design exists to close. Attempting it raises IM001, which is the trigger
 * doing its job. What a test wrote there is history, exactly as a real sale
 * would be.
 *
 * `timeline_entry` is different and goes, because it is a DERIVED PROJECTION
 * rather than a record: 05b's rule is that a corrupt projection is repaired by
 * rebuilding, and it carries no append-only trigger. A projection of a contact
 * that no longer exists is not history, it is a dangling row — which is also
 * why its foreign key stays strict instead of gaining an `ON DELETE CASCADE`
 * nothing in the product would ever fire.
 *
 * The opportunity itself is deletable because nothing append-only references
 * it: `stage_transition` and `earnings_ledger` carry `opportunity_id` with no
 * foreign key, precisely so the record of what happened outlives the row it
 * happened to.
 */
export async function removeCard(card: FixtureCard): Promise<void> {
  const sql = client()
  try {
    await settleOutboxFor(sql, card.contactId)

    await sql`DELETE FROM app.timeline_entry
              WHERE tenant_id = ${TENANT} AND contact_id = ${card.contactId}`
    await sql`DELETE FROM app.opportunity
              WHERE tenant_id = ${TENANT} AND id = ${card.opportunityId}`
    await sql`DELETE FROM app.contact
              WHERE tenant_id = ${TENANT} AND id = ${card.contactId}`
  } finally {
    await sql.end()
  }
}
