import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'

import { pool } from './pool'

/**
 * The database access layer.
 *
 * There is exactly one way to reach the database from application code, and it
 * is `withTenant`. The pool lives in `./pool` and an ESLint rule fails the
 * build if anything outside `app/db/**` imports either file; `app/db/index.ts`
 * re-exports only the two entry points.
 *
 * The reason is not tidiness. Every unit of work must be a transaction whose
 * FIRST statement establishes session context, because that invariant is the
 * only thing that makes a transaction-mode pooler safe. A query issued outside
 * that envelope runs with no context — which, thanks to the policies, returns
 * zero rows rather than another seller's book, but a surface that silently
 * renders nothing is its own defect. Making the pool unreachable removes the
 * choice.
 */

const db = drizzle(pool)

export type ScopeMode = 'owner' | 'tenant_read' | 'tenant_admin' | 'system'

/** Who is acting. Note the absence of a scope: the caller cannot choose one. */
export interface SessionIdentity {
  readonly tenantId: string
  readonly userId: string
}

/** The transaction handle a unit of work receives. Never a pool. */
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

/**
 * Drops to the unprivileged role for the rest of the transaction, reverted at
 * COMMIT or ROLLBACK along with everything else `SET LOCAL`.
 *
 * Without this the silo depends on WHICH USER `DATABASE_URL` names, because a
 * superuser — or any role that owns the schema — bypasses row level security
 * entirely, FORCE included. The string `docker compose` hands out by default
 * is exactly such a user, so the development environment trains the broken
 * configuration with perfect fidelity, and the failure has no symptom: every
 * page renders, with every seller's rows.
 *
 * Found by the §7.7.1 canary fixture, which saw one seller's bytes in
 * another's search response the first time it ran.
 *
 * This is defence in depth, not the primary control — G4(a) still owes a boot
 * assertion that refuses to start when the connection user owns the schema.
 */
const dropPrivilege = sql`SET LOCAL ROLE crm_app`

/**
 * Runs `fn` inside one transaction, with session context established by the
 * engine before `fn` can issue a single statement.
 *
 * `app.begin_request` reads `app_user.role` and derives the scope itself. That
 * is why `SessionIdentity` has no `scopeMode` field — there is no argument for
 * it, in this signature or in the SQL one, so no route can grant itself
 * tenant-wide read by passing the wrong literal.
 *
 * It also raises `CTX001` if context is already set, which is what a leaked
 * pooled connection looks like from inside the database.
 */
export async function withTenant<T>(
  identity: SessionIdentity,
  fn: (tx: Tx, scope: ScopeMode) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    const rows = await tx.execute<{ scope: ScopeMode }>(
      sql`SELECT app.begin_request(${identity.tenantId}::uuid, ${identity.userId}::uuid) AS scope`,
    )
    const scope = rows[0]?.scope
    if (scope === undefined) {
      throw new Error('app.begin_request returned no scope')
    }

    await tx.execute(dropPrivilege)
    return fn(tx, scope)
  })
}

/**
 * The system scope, for the four enumerated cross-tenant paths: the outbox
 * relay, scheduled-job dispatch, intake token resolution and the purge job.
 *
 * Kept separate from `withTenant` on purpose. A request has no way to reach
 * this, because reaching it means importing a different function by a
 * different name — which is greppable, reviewable, and countable.
 */
/** One due job, with the tenant the caller must scope to before touching anything. */
export interface ClaimedJob {
  readonly tenantId: string
  readonly jobId: string
  readonly kind: string
  readonly subjectId: string
  readonly fireAt: Date
}

/**
 * Takes a lease on the next batch of due scheduled jobs, across all tenants.
 *
 * A FUNCTION, not a third door. The obvious shape here would be a generic
 * `withoutTenantContext(fn)`, and that would be safe — with no context every
 * policy evaluates `tenant_id = app.current_tenant()` against NULL and returns
 * zero rows, which the silo suite asserts directly. It would also be a
 * general-purpose escape hatch sitting in the one module that exists to make
 * sure there is not one. This runs a single statement and returns rows; there
 * is nothing to pass it.
 *
 * The claim TAKES A LEASE rather than reading — see migration 0020. Two
 * dispatchers ticking the same second used to receive the same jobs and both
 * fire them, and the side effect of a reminder is a message to a consumer's
 * phone.
 *
 * The rows carry ids and tenants only. The caller must open `withSystemWork`
 * per row before it reads a single domain column.
 */
export async function claimDueJobs(limit = 50): Promise<ClaimedJob[]> {
  return db.transaction(async (tx) => {
    await tx.execute(dropPrivilege)
    const rows = await tx.execute<{
      tenant_id: string
      job_id: string
      kind: string
      subject_id: string
      // The driver hands timestamps back as strings here, not Dates. Typing it
      // as a Date compiled cleanly and then threw `getTime is not a function`
      // on the first real job — which the dispatcher counted as one failure and,
      // until it started printing the reason, said nothing else about.
      fire_at: string
      // Rendered as explicit UTC ISO-8601 rather than left to `::text`, whose
      // output is a local-format string that `new Date` parses by engine
      // goodwill rather than by specification.
    }>(sql`SELECT tenant_id, job_id, kind::text AS kind, subject_id,
                  to_char(fire_at AT TIME ZONE 'UTC',
                          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS fire_at
             FROM app.scheduled_job_claim(${limit})`)

    return [...rows].map((r) => ({
      tenantId: r.tenant_id,
      jobId: r.job_id,
      kind: r.kind,
      subjectId: r.subject_id,
      fireAt: new Date(r.fire_at),
    }))
  })
}

/** One owed delivery. Coordinates only — the body is fetched per tenant, after. */
export interface ClaimedDelivery {
  readonly tenantId: string
  readonly createdDay: string
  readonly eventId: string
  readonly consumerName: string
  readonly eventName: string
}

/**
 * Takes a lease on the next batch of owed outbox deliveries, across all tenants.
 *
 * THE FIRST of the four sanctioned cross-tenant paths, and the same shape as
 * `claimDueJobs` for the same reason: a function that runs one statement and
 * returns rows, rather than a general-purpose `withoutTenantContext(fn)` escape
 * hatch sitting in the one module that exists to make sure there is not one.
 *
 * IT CARRIES NO PAYLOAD, and that is asserted over `pg_proc` rather than
 * trusted. The relay learns that consumer X owes event Y in tenant Z, then
 * opens `withSystemWork(Z)` before reading a single byte of the body. A claim
 * that returned the event body would be a cross-tenant read of every event in
 * the system wearing the costume of a queue.
 */
export async function claimOutbox(limit = 50, worker = 'relay'): Promise<ClaimedDelivery[]> {
  return db.transaction(async (tx) => {
    await tx.execute(dropPrivilege)
    const rows = await tx.execute<{
      tenant_id: string
      // `date` comes back as a string from this driver, and it stays one all
      // the way to `app.outbox_ack`. Parsing it into a Date would re-introduce
      // a timezone to a value that deliberately has none: it is a partition
      // key, not an instant.
      created_day: string
      event_id: string
      consumer_name: string
      event_name: string
    }>(sql`SELECT tenant_id, created_day::text AS created_day, event_id,
                  consumer_name, event_name::text AS event_name
             FROM app.outbox_claim(${limit}, interval '5 minutes', ${worker})`)

    return [...rows].map((r) => ({
      tenantId: r.tenant_id,
      createdDay: r.created_day,
      eventId: r.event_id,
      consumerName: r.consumer_name,
      eventName: r.event_name,
    }))
  })
}

/**
 * Creates the event and audit partitions that the next days and months need.
 *
 * 🔴 THIS IS NOT HOUSEKEEPING. `event_outbox` is partitioned by day with NO
 * default partition, and `app.event_emit` writes its fan-out rows inside the
 * EMITTING transaction. So the first insert past the last partition raises
 * 23514 and rolls back whatever was emitting — which, once `app.stage_move`
 * emits, is a seller's sale refusing to commit.
 *
 * Called at boot AND on the dispatch tick, because the constitution accepts
 * three kinds of guarantee and "a job somebody scheduled once" is none of them:
 * re-assertion at deploy and at boot is the one that applies here.
 */
export async function ensurePartitions(): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(dropPrivilege)
    await tx.execute(sql`SELECT app.ensure_event_partitions()`)
    await tx.execute(sql`SELECT app.ensure_audit_partitions()`)
  })
}

/**
 * Raises a PROCESS-health alert across every tenant.
 *
 * 🔴 NO TENANT ARGUMENT, AND NO SESSION. An event loop is a property of the
 * operating system process: when it saturates, every agency served by that
 * process is degraded at the same instant, and picking one to attribute it to
 * would be a lie that reads like data. `app.process_alert_raise` fans out one
 * row per tenant, and each of those rows is TRUE.
 *
 * A THIRD ENTRY POINT ON A SURFACE WHOSE COMMENT SAYS "TWO FUNCTIONS", and the
 * justification is the same as `ensureCapabilities` above: it touches the
 * driver, and only `app/db/**` may. What it cannot do is carry business data —
 * the function refuses any kind that is not process health, so this is not a
 * door into `admin_alert`.
 */
export async function raiseProcessAlert(kind: string, detail: string): Promise<number> {
  return db.transaction(async (tx) => {
    await tx.execute(dropPrivilege)
    const rows = await tx.execute<{ n: number }>(
      sql`SELECT app.process_alert_raise(${kind}, ${detail}) AS n`,
    )
    return rows[0]?.n ?? 0
  })
}

/**
 * Records a job that exhausted its retries, as a dead letter an operator reads.
 *
 * 🔴 GATE 8 EXISTS BECAUSE THIS WAS MISSING. `pgboss.queue.dead_letter` was NULL
 * on every queue, so a call-merge that threw three times was marked `failed`,
 * sat in `pgboss.job` until the deletion window, and nothing in the product
 * ever heard about it — §2559's failure "by ABSENCE", exactly.
 *
 * The tenant comes from the JOB PAYLOAD rather than a session, because there is
 * no session: this runs in the worker after pg-boss moved the job. That is the
 * same shape as every other handler here — ADR-077 has payloads carry the
 * tenant and the handler re-derive its scope from it.
 */
export async function recordJobDeadLetter(
  tenantId: string,
  subjectType: string,
  subjectId: string,
  reason: string,
): Promise<void> {
  await withSystemWork(tenantId, (tx) =>
    tx.execute(
      sql`SELECT app.dead_letter_record('job', ${subjectType}, ${subjectId}, NULL,
                                        ${reason.slice(0, 2000)})`,
    ),
  )
}

export async function withSystemWork<T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT app.begin_system_work(${tenantId}::uuid)`)
    await tx.execute(dropPrivilege)
    return fn(tx)
  })
}

/** What `app.webhook_ingest()` answers. §4.2's vocabulary, plus the only 401. */
export type IngestOutcome = 'accepted' | 'duplicate' | 'quarantined' | 'unknown_token'

/** What the edge extracted, and all of it may be null. */
export interface IngestInput {
  readonly endpointToken: string
  readonly body: Buffer
  readonly providerEvent: string | null
  readonly canonical: string | null
  readonly alowareCallId: string | null
  readonly parseStatus: 'parsed' | 'unparsed'
  readonly signatureValid: boolean | null
}

/**
 * Stores one provider delivery. A FUNCTION, for the same reason as
 * `claimDueJobs` — one statement, one value back, nothing to pass it that would
 * make it a general-purpose door.
 *
 * 🔴 IT ESTABLISHES NO SESSION CONTEXT, AND IT IS THE ONLY UNIT OF WORK IN THIS
 * FILE THAT DOES NOT. That looks like the invariant this module exists to
 * enforce being broken, so here is why it is the opposite.
 *
 * A webhook arrives with no session, no cookie and no user. There is no
 * identity to establish and nothing to derive a tenant from — the tenant is
 * produced by the endpoint token, INSIDE the definer, which is why
 * `app.webhook_ingest()` takes a credential and has no `tenant_id` parameter.
 * Passing one from here would let this file name the tenant it writes into;
 * as written it cannot, and neither can any caller of it.
 *
 * `SET LOCAL ROLE crm_app` still applies. Every table the definer touches is
 * unreachable to that role — `raw_payload_vault` and `inbound_webhook_event`
 * have SELECT and no INSERT, and `webhook_endpoint` is `definer_only` and reads
 * zero rows — so a bug that dropped the definer and issued the writes directly
 * fails closed rather than silently succeeding.
 */
export async function ingestWebhook(input: IngestInput): Promise<IngestOutcome> {
  return db.transaction(async (tx) => {
    await tx.execute(dropPrivilege)
    const rows = await tx.execute<{ outcome: IngestOutcome }>(sql`
      SELECT app.webhook_ingest(
        ${input.endpointToken},
        ${input.body},
        ${input.providerEvent},
        ${input.canonical},
        ${input.alowareCallId},
        ${input.parseStatus},
        ${input.signatureValid}
      ) AS outcome`)

    const outcome = rows[0]?.outcome
    if (outcome === undefined) {
      throw new Error('app.webhook_ingest returned no row')
    }
    return outcome
  })
}
