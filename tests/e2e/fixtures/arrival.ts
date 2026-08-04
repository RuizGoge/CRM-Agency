import postgres from 'postgres'

/**
 * Re-arms the seeded `fresh` lead, because freshness EXPIRES.
 *
 * 🔴 THE DEFECT THIS EXISTS FOR IS IN THE DEMO, NOT IN THE TEST. `healthOf`
 * calls a card fresh when it has zero attempts and arrived less than SIXTY
 * MINUTES ago. The seed gives Ruth Alvarez `ageDays: 0`, which means "arrived
 * when the seed ran" — so the blue rail, the `NEW` slot and everything else
 * that depends on freshness are true for one hour after `npm run db:seed` and
 * false forever after.
 *
 * That is a demo property before it is a test property: a board shown the
 * morning after it was seeded has no fresh card on it at all, and the state
 * Jorge would be demonstrating is simply absent. It was invisible until now
 * because the demo tenant kept being reseeded.
 *
 * The test half is fixed here rather than by widening the window. Sixty minutes
 * is the product decision — a lead that arrived this morning is not the same
 * call as one that arrived while you were reading the board — and moving it so
 * a test can pass would be trading the definition for the convenience.
 */

const URL_ =
  process.env['MIGRATION_DATABASE_URL'] ??
  process.env['DEV_DATABASE_URL'] ??
  'postgresql://crm:crm@localhost:5432/crm_dev'

/**
 * Sets the arrival of one seeded contact's opportunity to now.
 *
 * Named by CONTACT rather than by id: the seed does not export ids, and a test
 * that reads "make Ruth Alvarez's card fresh again" says what it means. Returns
 * how many rows moved so the caller can assert it found the card — silently
 * touching nothing and then asserting a blue rail would fail somewhere far away
 * from the cause.
 */
export async function reArmArrival(contactName: string): Promise<number> {
  const sql = postgres(URL_, { max: 1, onnotice: () => {} })
  try {
    const moved = await sql`
      UPDATE app.opportunity o
         SET created_at = clock_timestamp()
        FROM app.contact c
       WHERE c.tenant_id = o.tenant_id
         AND c.id = o.contact_id
         AND c.full_name = ${contactName}`
    return moved.count
  } finally {
    await sql.end()
  }
}
