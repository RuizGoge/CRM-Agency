import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { TEST_URL } from './setup/urls'

/**
 * Every SECURITY DEFINER function establishes the tenant, or it is on this list
 * with a reason.
 *
 * 05b asks for exactly this, in one sentence: "every SECURITY DEFINER
 * function's body must contain app.current_tenant(), asserted by a CI query
 * over pg_proc.prosrc — a grep-level gate that catches the one way a definer
 * function can become a cross-tenant hole." It did not exist.
 *
 * WHY THIS CLASS OF FUNCTION AND NO OTHER. A definer runs as its owner, which
 * here is crm_migrator, whose p_sys policy is USING (true) WITH CHECK (true).
 * So inside a definer body the row-level security that scopes every other read
 * in this system IS SWITCHED OFF. The tenant boundary stops being structural
 * and becomes whatever the function body says — and a body that forgets to say
 * it is not a bug that surfaces as an error. It surfaces as one agency reading
 * another's rows, silently, forever.
 *
 * This is a grep and it is honest about being one: it proves the call is
 * PRESENT, never that it is used correctly. What it catches is omission, which
 * is the failure that actually happens.
 */

const SCHEMAS = ['app', 'ref', 'security']

/**
 * Functions that legitimately have no tenant to establish.
 *
 * Every entry is a function that runs BEFORE a tenant exists, or that operates
 * on the cluster rather than on tenant data. Adding a name here is a decision;
 * the count below is pinned so that growing the list is an edit somebody makes
 * on purpose rather than a line that drifts.
 */
const EXEMPT: ReadonlyMap<string, string> = new Map([
  [
    'app.begin_request',
    'It IS the establishing call. Every other definer reads the GUC this one writes, so requiring it to read app.current_tenant() would be circular — it takes the tenant as a parameter and sets the session.',
  ],
  [
    'app.begin_system_work',
    'The job-runner counterpart of begin_request: takes the tenant a claimed job belongs to and establishes the session for it. Same circularity, same reason.',
  ],
  [
    'app.resolve_identity',
    'Runs BEFORE a tenant exists. It maps a better-auth user id to its tenant and app_user row, which is the answer begin_request then needs — there is nothing to scope by yet, and that is the login path.',
  ],
  [
    'app.outbox_claim',
    'A SANCTIONED cross-tenant path, and the second of the four. The outbox dispatcher has to find work across every agency BEFORE it knows whose work it is, so there is no tenant to establish yet. It returns four columns and no payload — tenant, event, consumer, name — and dispatch sets the per-row context before touching anything else.',
  ],
  [
    'app.scheduled_job_claim',
    'A SANCTIONED cross-tenant path, not an omission. It fans over every tenant on purpose — DISTINCT ON (tenant_id) is fairness, so one busy agency cannot starve the rest — and returns tenant_id so the worker can establish that tenant before touching a row. It returns job coordinates only: no contact, lead or money column is reachable through it.',
  ],
])

interface Fn {
  readonly schema: string
  readonly name: string
  readonly args: string
  readonly establishes: boolean
}

let sql: postgres.Sql
let definers: readonly Fn[]

beforeAll(async () => {
  sql = postgres(TEST_URL, { max: 1, onnotice: () => {} })

  // COMMENTS ARE STRIPPED BEFORE MATCHING, and that is not a refinement.
  //
  // `prosrc` is the raw body text, comments included, so the first version of
  // this gate was satisfied by a function that merely MENTIONED the call —
  // and the mention that satisfied it was the comment explaining this very
  // rule, sitting at the top of a body that had been mutated to read the GUC
  // directly. A gate defeated by its own documentation passes forever.
  definers = await sql<Fn[]>`
    WITH body AS (
      SELECT p.oid,
             n.nspname AS schema,
             p.proname AS name,
             regexp_replace(
               regexp_replace(p.prosrc, '/\\*.*?\\*/', ' ', 'gs'),  -- block comments
               '--[^\\n]*', ' ', 'g'                                -- line comments
             ) AS src
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE p.prosecdef
         AND n.nspname = ANY(${SCHEMAS})
    )
    SELECT b.schema,
           b.name,
           pg_get_function_identity_arguments(b.oid) AS args,
           (b.src ~ 'app\\.current_tenant\\s*\\(') AS establishes
      FROM body b
     ORDER BY b.schema, b.name`
})

afterAll(async () => {
  await sql?.end()
})

describe('a definer function cannot forget the tenant', () => {
  it('is reading a real set of functions', () => {
    // The mutation guard. An empty scan passes forever, and this assertion is
    // the difference between "nothing violates the rule" and "nothing was
    // looked at".
    expect(definers.length).toBeGreaterThan(10)
  })

  it('establishes the tenant in every definer that is not exempt', () => {
    const offenders = definers
      .filter((fn) => !fn.establishes)
      .filter((fn) => !EXEMPT.has(`${fn.schema}.${fn.name}`))
      .map((fn) => `${fn.schema}.${fn.name}(${fn.args})`)

    expect(
      offenders,
      `SECURITY DEFINER without app.current_tenant():\n  ${offenders.join('\n  ')}\n` +
        'Inside a definer the RLS that scopes every other read is switched off. ' +
        'Either call app.current_tenant() and scope on it, or add the function to ' +
        'EXEMPT with the reason it has no tenant.',
    ).toEqual([])
  })

  it('holds the exemption list at exactly the functions justified today', () => {
    // Pinned, like every other exception list here. The failure mode this
    // closes is a definer added later whose author "fixes" a red build by
    // appending a name instead of a predicate.
    expect([...EXEMPT.keys()].sort()).toEqual([
      'app.begin_request',
      'app.begin_system_work',
      'app.outbox_claim',
      'app.resolve_identity',
      'app.scheduled_job_claim',
    ])
    for (const [name, reason] of EXEMPT) {
      expect(reason.length, `${name} is exempt with no usable reason`).toBeGreaterThan(40)
    }
  })
})
