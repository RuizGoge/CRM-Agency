import postgres from 'postgres'

/**
 * Mints ONE authorisation for ONE protected change, as the OWNER.
 *
 *   npm run db:authorize -- "why this deploy may change seller isolation"
 *
 * 🔴 THIS SCRIPT IS THE DEVELOPMENT CONVENIENCE, NOT THE MECHANISM. In
 * production E1b's ruling is literal — "one statement in the provider's SQL
 * console" — and it matters that it stays a human at a console:
 *
 *     INSERT INTO authz.ddl_authorization (purpose)
 *     VALUES ('the deploy you are about to run, described so the next reader
 *              can tell it apart from the one after it');
 *
 * The moment this runs from CI with a credential in the environment, R3 is
 * realised and the grade drops to (a)+(c) — the token would live where the
 * model can reach it, which is the exact defect E1b is named after. So it
 * deliberately reads `OWNER_DATABASE_URL` rather than `MIGRATION_DATABASE_URL`,
 * and it refuses when the two are the same.
 */

const URL_ =
  process.env['OWNER_DATABASE_URL'] ??
  process.env['DEV_DATABASE_URL'] ??
  'postgresql://crm:crm@localhost:5432/crm_dev'

const purpose = process.argv.slice(2).join(' ').trim()

if (purpose === '') {
  console.error(
    '\nAUTHZ010: say what this authorises.' +
      '\n\n  npm run db:authorize -- "renaming the p_app policy on app.contact"' +
      '\n\nThe purpose is read by a person deciding whether the deploy in front of' +
      '\nthem is the one they authorised. It has to survive being read next month.\n',
  )
  process.exit(1)
}

/**
 * 🔴 THE REFUSAL THAT KEEPS THIS HONEST. If the minting credential and the
 * deploy credential are the same string, the deploy can authorise itself and
 * every guarantee below collapses to a comment. Cheap to check, and the
 * configuration mistake it catches is invisible otherwise: everything still
 * works, and nothing is protected.
 */
if (URL_ === process.env['MIGRATION_DATABASE_URL']) {
  console.error(
    '\nAUTHZ011: OWNER_DATABASE_URL and MIGRATION_DATABASE_URL are the same connection.' +
      '\n\nThen the deploy can mint its own authorisations, which is precisely what' +
      '\nE1b forbids — the row must be created by somebody the deploy is not.' +
      '\nPoint OWNER_DATABASE_URL at the owner.\n',
  )
  process.exit(1)
}

const client = postgres(URL_, { max: 1, onnotice: () => {} })

async function main(): Promise<void> {
  const [row] = await client<{ id: string; created_by: string }[]>`
    INSERT INTO authz.ddl_authorization (purpose) VALUES (${purpose})
    RETURNING id, created_by`

  const [pending] = await client<{ n: string }[]>`
    SELECT count(*) AS n FROM authz.ddl_authorization WHERE consumed_at IS NULL`

  console.log(
    `🔑 Authorisation ${row?.id ?? '?'} created by ${row?.created_by ?? '?'}.\n` +
      `   "${purpose}"\n` +
      `   ${pending?.n ?? '?'} unconsumed. The next protected change spends the oldest one.`,
  )
}

main()
  .then(() => client.end())
  .catch(async (err: unknown) => {
    console.error(err)
    await client.end()
    process.exit(1)
  })
