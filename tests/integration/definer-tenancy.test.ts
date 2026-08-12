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
    'app.identity_seal',
    'It MINTS the proof the tenant context is made of, so requiring it to read that context would be circular in the same way begin_request is — it takes the tenant as a parameter. It also reaches no tenant-scoped relation at all: its only read is security.identity_secret, which has one row and no tenant dimension. Granted to nobody, so the only callers are the three definers that establish or elevate a session.',
  ],
  [
    'app.current_user_id',
    'It ANSWERS the question every other definer scopes by, and it is the hottest read path in the schema — every RLS policy calls it. It became a definer in 0067 so it could verify the session seal against security.identity_secret; that table has one row and no tenant dimension, and the function touches nothing else. Requiring it to establish a tenant would be requiring the answer to depend on itself.',
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
  [
    'app.webhook_ingest',
    'It IS the deriving call, the same shape as begin_request one layer out. A provider POST arrives with no session and no tenant — the endpoint token is the ONLY thing that produces one, and this function is what turns it into a tenant. Requiring it to read app.current_tenant() would be asking it to read the answer it exists to compute.',
  ],
  [
    'app.dead_letter_write',
    'Takes the tenant as a parameter because by the time it runs there may not be one to read. It records an ingest that FAILED — a body that could not be parsed, a token that resolved to nothing — and a failure whose tenant is unknown is exactly the failure that most needs recording. Writing the parameter is the point; scoping by a session that was never established is not possible.',
  ],
  [
    'app.inbound_webhook_dead_letter',
    'The trigger half of the same path, on the ingest table. It fires inside a transaction that has no session context by construction, because the request that opened it is a provider POST rather than a seller. It moves a row and sets no tenant of its own.',
  ],
  [
    'app.process_alert_raise',
    'The condition it reports belongs to the operating system PROCESS, not to an agency: when the event loop saturates, every tenant served by that process is degraded at the same instant, and there is no session because the caller is a monitor in the worker loop. It fans one row out per tenant because the statement is true for each of them. It reads nothing but app.tenant.id, writes one table, and refuses any kind that is not process health, so it cannot express a contact, a dollar or a name.',
  ],
  [
    'app.ensure_audit_partitions',
    'Cluster storage, exactly like app.ensure_event_partitions: a monthly partition of audit_log is shared by every agency at once, so there is no tenant whose session could scope its CREATE TABLE. Its entire body is CREATE TABLE IF NOT EXISTS, the per-partition dedupe index, and a call to security.harden(). It reads no tenant data and writes none.',
  ],
  [
    'app.ensure_event_partitions',
    'It operates on the CLUSTER, not on tenant data. A partition of event_log is storage shared by every agency at once, so there is no tenant whose session could scope a CREATE TABLE — asking it to read one would be asking which agency owns next month. It became a definer in 0051 because crm_app has no CREATE on schema app and no USAGE on schema security, so the invoker version could neither create the partition nor harden it. It reads and writes no tenant data of any kind: its only statements are CREATE TABLE IF NOT EXISTS and a call to security.harden().',
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
      // Added by 0067, and exempt for the FIRST reason in its purest form: they
      // are what the tenant context is MADE OF. `current_user_id` is the answer
      // every other definer scopes by; `identity_seal` mints the proof that
      // answer is genuine. Both read one row of `security.identity_secret`,
      // which has no tenant dimension, and nothing else.
      'app.current_user_id',
      // The ingest path, added when it merged. All three run BEFORE a tenant
      // exists, which is the one justification this list accepts: a provider
      // POST carries no session, and the endpoint token is what produces the
      // tenant rather than something that can be read from one.
      'app.dead_letter_write',
      // Added by 0051 and 0053. The only entries on this list exempt for the
      // SECOND reason rather than the first: they do not run before a tenant
      // exists, they run where no tenant is the right answer. A partition is
      // cluster storage, and both bodies are CREATE TABLE IF NOT EXISTS plus
      // security.harden() and nothing else.
      'app.ensure_audit_partitions',
      'app.ensure_event_partitions',
      'app.identity_seal',
      'app.inbound_webhook_dead_letter',
      'app.outbox_claim',
      // Added by 0055, and the third exempt for the "no tenant is the right
      // answer" reason rather than the "before a tenant exists" one. An event
      // loop belongs to the process.
      'app.process_alert_raise',
      'app.resolve_identity',
      'app.scheduled_job_claim',
      'app.webhook_ingest',
    ])
    for (const [name, reason] of EXEMPT) {
      expect(reason.length, `${name} is exempt with no usable reason`).toBeGreaterThan(40)
    }
  })
})
