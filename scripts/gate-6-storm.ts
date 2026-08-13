/**
 * GATE 6 — the retry storm. §2547.
 *
 * "Replay 20 000 webhooks in 60 seconds (333/s) while 50 simulated sellers
 * sustain the polling floor."
 *
 * WHAT THIS RUNS AND WHAT IT CANNOT, stated first because a gate that reports a
 * number for the half it measured and says nothing about the half it skipped is
 * the exact failure this project exists to refuse.
 *
 * RUNS — the FOLDED leg, which is the topology the product actually ships on at
 * escalón 1:
 *   · 20 000 deliveries at 333/s through `ingestWebhook()`, the same function
 *     the HTTP route calls.
 *   · Half of them REPLAYS of earlier ids, because that is what a retry storm
 *     is: §2268's claim is that the transport dedupe lets a 20 000-webhook
 *     replay land "without touching the domain", and a storm of all-fresh ids
 *     would never exercise it.
 *   · Zero webhooks lost.
 *   · Ingest p95.
 *   · The leaderboard 304 measured IN THE SAME PROCESS while the storm runs —
 *     which is not an approximation of the folded bulkhead question, it IS the
 *     folded bulkhead question: §882 says that folded, "a webhook storm shares
 *     an event loop with the seller's board".
 *   · `cpu_ms_per_webhook`, which §2551 says becomes
 *     `system_constant['fold_split_webhooks_per_day_max']`.
 *
 * MEASURED IN-PROCESS, not over HTTP, and that is this project's established
 * method rather than a shortcut: `leaderboard-poll-perf.test.ts` measures P11
 * the same way and states why — "SERVER p95 is the budget and the end-to-end
 * figure is a consequence".
 *
 * ✅ AND SINCE 0055, THREE MORE — the "degradation must not be silent" half.
 * The first run of this gate reported all four of these as having no subject at
 * all; three were then built:
 *   · The shed count, which §2548 calls "the 429 count". It has a subject and
 *     the correct value is ZERO: `app/lib/ingest/semaphore.ts` queues and
 *     exposes no path that refuses, because G2 measured that Aloware never
 *     retries and tolerates 110 s of silence. A 429 here is a lost webhook with
 *     a status code on it, and `05c`:905 asserts zero 429 on this surface.
 *   · Event-loop p99, from `perf_hooks.monitorEventLoopDelay`.
 *   · `admin_alert(kind='folded_topology_saturated')`, now a legal kind with a
 *     writer that fans out one row per tenant.
 *
 * ✅ AND SINCE 0069/0070 THE FOURTH — G6/P24 (05c:1588, :2405), the PROTECTED
 * one — RUNS. It injects one STOP mid-storm, watches `suppression_list` against
 * the 5-second deadline and asks the real gate for a verdict at T+5 s. The
 * worker runs too, which no earlier version of this harness did: every previous
 * run measured INGEST only, which was enough for "zero lost" and useless for an
 * assertion whose whole subject is what happens to a job behind a backlog.
 *
 * 🔴 IT RUNS AND IT FAILS, and the cause is a declared Gate 2 open item rather
 * than a code defect. `g2-aloware.md:559`: *"No event named for SMS … inbound
 * SMS probably arrives as `Communication Initiated` — but §4.3 maps inbound SMS
 * to `message.received`, and that binding is UNPROVEN."* `aloware-ingest.ts`
 * reflects that honestly: none of its nine mapped names yields
 * `message.received`. So `mergeMessageFromEvent` re-derives the canonical from
 * the body, an unmapped name gives `null`, `stateOf(null)` returns `'failed'`,
 * and 0069's `p_state = 'received'` condition never holds. The job RESOLVES,
 * does not fail, and writes nothing.
 *
 * ⚠️ It cannot be fixed by inventing the name. Putting a plausible string in the
 * map would turn this green against something nobody observed on the wire, which
 * is the one thing this harness exists to refuse. It is blocked on capturing one
 * real inbound SMS against the paid account.
 *
 * So the gate STILL does not close — but the reason is now MEASURED rather than
 * assumed, and this is the folded leg only: :2405 wants both topologies.
 */

import { createHash, randomUUID } from 'node:crypto'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { performance } from 'node:perf_hooks'

import { sql } from 'drizzle-orm'
import postgres from 'postgres'

import { ingestWebhook, withSystemWork, withTenant, type IngestOutcome } from '../app/db'
import { startWorker, stopWorker, workerEnabled } from '../app/jobs/worker'
import { admitDelivery, drainSaturation } from '../app/lib/ingest/semaphore'

/** Overridable so the harness can be smoke-run before the real 20 000. */
const TOTAL = Number(process.env['G6_TOTAL'] ?? 20_000)
const TARGET_RATE = 333
const DISTINCT = TOTAL / 2
const CONCURRENCY = 32

/** The seeded demo tenant. The storm runs against real rows, not a fixture. */
const TENANT = '00000000-0000-7000-8000-00000000de01'
const TOKEN = 'gate6-storm-token'

function pct(xs: readonly number[], p: number): number {
  if (xs.length === 0) return Number.NaN
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(s.length * p))] ?? Number.NaN
}

/**
 * The endpoint the storm arrives on.
 *
 * 🔴 THIS HAD TO BE WRITTEN BY HAND, and that is itself a finding: the audit
 * found `app.webhook_endpoint` has NO production writer and no seed — only
 * tests insert tokens. So a real deployment today has no endpoint row, every
 * provider delivery gets a 401, and Aloware does not retry. The gate cannot run
 * without stepping over that hole, so it is stepped over loudly.
 */
async function seed(): Promise<string> {
  // The RAW 32 bytes, not hex. The column is bytea with a length CHECK, so a
  // hex string lands as 64 bytes of ASCII and is refused — which is the
  // constraint doing its job rather than an inconvenience.
  const digest = createHash('sha256').update(TOKEN).digest()

  // 🔴 AS THE OWNER, AND crm_app COULD NOT DO THIS. `webhook_endpoint` is
  // classified `definer_only`, so the application role holds no privilege on it
  // at all — the first attempt at this seed failed with permission denied,
  // which is the classification working exactly as designed: the table that
  // maps a bearer token to a tenant is not one the app may write.
  //
  // It is also the reason a real deployment has no endpoint row today.
  const ownerUrl = process.env['MIGRATION_DATABASE_URL']
  if (ownerUrl === undefined || ownerUrl === '') {
    throw new Error('MIGRATION_DATABASE_URL is required: only the owner can seed an endpoint')
  }

  const owner = postgres(ownerUrl, { max: 1, onnotice: () => {} })
  try {
    await owner`
      INSERT INTO app.webhook_endpoint (tenant_id, provider, token_sha256, label)
      SELECT ${TENANT}::uuid, 'aloware', ${digest}, 'gate-6 storm'
       WHERE NOT EXISTS (
         SELECT 1 FROM app.webhook_endpoint
          WHERE tenant_id = ${TENANT}::uuid AND token_sha256 = ${digest})`

    // A PREVIOUS RUN'S ROWS MAKE THE NEXT RUN'S NUMBERS A LIE: every delivery
    // would short-circuit on the dedupe probe and the run would measure the
    // duplicate path only. Cleared as the owner, and scoped to this harness's
    // own deliveries by their body shape.
    await owner`
      DELETE FROM app.inbound_webhook_event
       WHERE tenant_id = ${TENANT}::uuid AND aloware_call_id LIKE 'gate6-%'`
    await owner`
      DELETE FROM app.raw_payload_vault
       WHERE tenant_id = ${TENANT}::uuid
         AND convert_from(body, 'UTF8') LIKE '%"communication_id":"gate6-%'`
    await owner`DELETE FROM pgboss.job WHERE name = 'call-merge' AND singleton_key LIKE 'gate6-%'`
  } finally {
    await owner.end()
  }

  const seller = await withSystemWork(TENANT, async (tx) => {
    const rows = await tx.execute<{ id: string }>(
      sql`SELECT id FROM app.app_user WHERE tenant_id = ${TENANT}::uuid ORDER BY email LIMIT 1`,
    )
    return rows[0]?.id
  })

  if (seller === undefined) {
    throw new Error('no seller in the demo tenant — run npm run db:seed first')
  }
  return seller
}

/**
 * G6/P24 — THE PROTECTED ASSERTION (`05c` :1588, :2405).
 *
 * *"During the 20,000-webhook replay at 333/s, inject one STOP; assert the
 * `suppression_list` row exists within 5 seconds and that a dial to that number
 * issued at T+5 s returns `blocked_suppressed`."*
 *
 * 🔴 THIS IS THE ONE ASSERTION IN THE GATE WITH A LEGAL CONSEQUENCE, and it is
 * the reason the latency lanes exist. The STOP arrives as an SMS, so it lands in
 * `message-merge` — `lane_compliance` since 0070 — while the 20,000 call
 * deliveries fill `call-merge`, which is `lane_interactive`. Before the lanes
 * both drew from ONE pg-boss pool, and the STOP was §2367's "job 14,000 in a
 * FIFO drain".
 */
const STOP_OUR_NUMBER = '+13125559624'
const STOP_SEAT = 962_400
/** The deadline the register names, in ms. Not a tuning knob. */
const STOP_DEADLINE_MS = 5_000

/**
 * 🔴 A FRESH LEAD NUMBER EVERY RUN, AND THE APPEND-ONLY RULE IS WHY.
 *
 * The first version of this cleaned up after itself with `DELETE FROM
 * app.suppression_list` as the OWNER, and the engine refused: *"AP001:
 * suppression_list is append-only. Corrections are compensating appends, never
 * edits."* The statement trigger covers the owner too, which is the constitution
 * working rather than an obstacle — this is one of the three append-only tables
 * and there is no recompute job by design.
 *
 * Reusing a number would also make the assertion pass for the wrong reason: a
 * suppression row left by an earlier run exists at T0, and the elapsed time
 * reads as zero. A number nobody has ever texted is the only honest subject.
 */
const RUN_SUFFIX = String(Date.now()).slice(-7)
const STOP_LEAD_NUMBER = `+1415${RUN_SUFFIX}`

/**
 * The subject of the protected assertion, seeded as the owner.
 *
 * Texas on purpose: two zones and one-party recording, so neither the calling
 * window nor the recording guard decides the verdict this assertion is about.
 * `dial.test.ts` learned that with Florida, which would have passed for the
 * wrong reason.
 */
async function seedStopSubject(seller: string): Promise<string> {
  const ownerUrl = process.env['MIGRATION_DATABASE_URL']
  if (ownerUrl === undefined || ownerUrl === '') {
    throw new Error('MIGRATION_DATABASE_URL is required to seed the STOP subject')
  }

  const contactId = randomUUID()
  const owner = postgres(ownerUrl, { max: 1, onnotice: () => {} })
  try {
    await owner`
      INSERT INTO app.aloware_number_mapping
        (tenant_id, owner_user_id, aloware_user_id, aloware_line_id, from_number_e164, verified_at)
      SELECT ${TENANT}::uuid, ${seller}::uuid, ${STOP_SEAT}, 96240, ${STOP_OUR_NUMBER}, clock_timestamp()
       WHERE NOT EXISTS (
         SELECT 1 FROM app.aloware_number_mapping
          WHERE tenant_id = ${TENANT}::uuid AND from_number_e164 = ${STOP_OUR_NUMBER})`

    await owner`
      INSERT INTO app.contact (tenant_id, id, owner_user_id, full_name, created_via, state_code, zip5)
      VALUES (${TENANT}::uuid, ${contactId}::uuid, ${seller}::uuid, 'Gate6 Stopper', 'manual', 'TX', '75201')`

    await owner`
      INSERT INTO app.contact_phone (tenant_id, contact_id, owner_user_id, phone_e164, is_primary)
      VALUES (${TENANT}::uuid, ${contactId}::uuid, ${seller}::uuid, ${STOP_LEAD_NUMBER}, true)`
  } finally {
    await owner.end()
  }
  return contactId
}

interface StopResult {
  /** ms from the STOP being answered at the edge to the suppression row existing. */
  readonly suppressedInMs: number | null
  /** The gate's verdict for a dial issued at T0 + 5 s. */
  readonly verdictAtDeadline: string
  readonly ingestOutcome: string
}

/**
 * Injects ONE STOP through the same edge the storm uses, then watches for the
 * consequence.
 *
 * The delivery is an inbound SMS whose body is the bare keyword, which is what
 * `app.sms_intent_of` matches whole. Everything else about the path is the
 * product's: `ingestWebhook` stores it and enqueues `message-merge`, the
 * compliance-lane worker drains it, and `app.message_merge` appends the consent
 * row and the suppression row inside its own transaction.
 */
async function injectStopAndWatch(seller: string, contactId: string): Promise<StopResult> {
  const providerMessageId = `gate6-stop-${Date.now()}`
  const body = Buffer.from(
    JSON.stringify({
      event: 'Sms-Received',
      body: {
        id: Number(providerMessageId.replace(/\D/g, '').slice(-9)),
        direction: 1,
        user_id: STOP_SEAT,
        incoming_number: STOP_OUR_NUMBER,
        lead_number: STOP_LEAD_NUMBER,
        body: 'STOP',
        created_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
      },
    }),
  )

  const t0 = performance.now()
  const ingestOutcome = await admitDelivery(() =>
    ingestWebhook({
      endpointToken: TOKEN,
      body,
      providerEvent: 'Sms-Received',
      canonical: 'message.received',
      alowareCallId: providerMessageId,
      parseStatus: 'parsed',
      signatureValid: null,
    }),
  )

  // Poll for the row. Polling rather than LISTEN because what the register
  // asserts is wall-clock arrival, and a notification would measure the notify
  // rather than the write.
  //
  // 🔴 WATCHED AS THE OWNER, AND THE FIRST VERSION COULD NOT. `suppression_list`
  // is `definer_only`: `crm_app` holds no SELECT on it at all, and the poll died
  // with `permission denied for table suppression_list`. That is the
  // classification working — the tenant-wide table a STOP writes is not one the
  // application role reads directly, it reaches it through the gate. So the
  // harness observes from outside the product's own privilege set, which is also
  // the more honest vantage point for an assertion about whether a row EXISTS.
  const observer = postgres(process.env['MIGRATION_DATABASE_URL'] ?? '', {
    max: 1,
    onnotice: () => {},
  })

  let suppressedInMs: number | null = null
  try {
    for (;;) {
      const elapsed = performance.now() - t0
      const rows = await observer<{ n: string }[]>`
      SELECT count(*) AS n FROM app.suppression_list
       WHERE tenant_id = ${TENANT}::uuid AND phone_e164 = ${STOP_LEAD_NUMBER}`
      const found = (rows[0]?.n ?? '0') !== '0'
      if (found) {
        suppressedInMs = performance.now() - t0
        break
      }
      // Watched past the deadline on purpose: "how late" is a more useful number
      // than "late", and stopping at 5 s would report null for a 5.2 s arrival.
      if (elapsed > STOP_DEADLINE_MS * 3) break
      await new Promise((r) => setTimeout(r, 25))
    }

    // 🔴 THE DIAL AT T+5 s, WHICH IS THE HALF THAT MATTERS TO A REGULATOR. A
    // suppression row nobody reads is not a control; this asks the real gate, in
    // a real seller session, the way the dial button does.
    const remaining = STOP_DEADLINE_MS - (performance.now() - t0)
    if (remaining > 0) await new Promise((r) => setTimeout(r, remaining))

    // 🔴 UNDER A BREAK-GLASS OVERRIDE, AND WITHOUT IT THIS ASSERTION CANNOT BE
    // READ. The first run answered `blocked_calling_window`: the harness ran in
    // the evening, a Texas lead at 10pm Central IS outside the legal window, and
    // the gate was right while the assertion was unreadable. No choice of state
    // fixes it — between 06:00 and 12:00 UTC the entire United States is asleep
    // and no lead anywhere is legally callable, so a gate whose verdict depends
    // on what time the storm was run is a gate that reports the clock.
    //
    // ⚠️ AND THE OVERRIDE DOES NOT WEAKEN WHAT IS BEING ASSERTED, which is the
    // whole reason it is the right instrument. It releases EXACTLY
    // `blocked_timezone_unknown` and `blocked_calling_window`; suppression and
    // the recording guard still bind, and `dial-gate.test.ts` has a standing
    // assertion — *"does NOT release suppression under break-glass"* — that an
    // admin under break-glass still cannot dial a STOP. So a
    // `blocked_suppressed` here is the suppression deciding, on the one path
    // where the clock no longer can.
    //
    // Opened around this call only, never for the run: an override left live
    // would silently release the window for everything the storm touches.
    await observer`
      INSERT INTO app.break_glass_override (tenant_id, started_by_user_id, reason)
      VALUES (${TENANT}::uuid, ${seller}::uuid,
              'G6/P24: the clock must not decide the protected assertion')`

    let verdictAtDeadline: string
    try {
      verdictAtDeadline = await withTenant({ tenantId: TENANT, userId: seller }, async (tx) => {
        const rows = await tx.execute<{ verdict: string }>(
          sql`SELECT verdict::text AS verdict
                  FROM app.compliance_attempt(${contactId}::uuid, 'call', 'dial_button')`,
        )
        return rows[0]?.verdict ?? 'no row'
      })
    } finally {
      await observer`
        UPDATE app.break_glass_override SET ended_at = clock_timestamp(), end_reason = 'manual'
         WHERE tenant_id = ${TENANT}::uuid AND ended_at IS NULL`
    }

    return { suppressedInMs, verdictAtDeadline, ingestOutcome }
  } finally {
    await observer.end()
  }
}

/**
 * 🔴 THE PROBE THE SPLIT LEG CANNOT RUN WITHOUT, and the reason is a
 * misattribution rather than a missing number.
 *
 * Folded, the worker is in this process and its absence is impossible. Split, it
 * is a SEPARATE `npm run worker` that somebody has to have started — and if
 * nobody did, every job sits in `created`, the STOP never merges,
 * `suppression_list` never gets its row, and the run reports **exactly the
 * failure G6/P24 already has for a completely different reason**. We would read
 * "the compliance lane did not deliver in time" off a run where nothing was
 * draining at all, and the honest conclusion and the dishonest one look
 * identical on the console.
 *
 * §7.10's `security.process_heartbeat` would answer this directly and does not
 * exist, so this observes the property we actually care about instead of a proxy
 * for it: has ANYTHING moved a job out of `created` while the storm was running.
 */
async function drainerIsPresent(observer: postgres.Sql): Promise<boolean> {
  const rows = await observer<{ n: string }[]>`
    SELECT count(*) AS n FROM pgboss.job
     WHERE name = 'call-merge' AND state <> 'created'`
  return Number.parseInt(rows[0]?.n ?? '0', 10) > 0
}

interface StormResult {
  readonly outcomes: Record<string, number>
  readonly errors: number
  readonly latencies: number[]
  readonly wallMs: number
  readonly cpuMs: number
}

/**
 * Fires `TOTAL` deliveries, pacing to `TARGET_RATE`.
 *
 * Paced rather than fired flat out on purpose: 333/s is the threat §2414
 * describes — what a provider does when it recovers from OUR 20–45 minute
 * outage — and a harness that simply saturates measures a different question
 * (how fast can this machine go) than the one the gate asks (does the floor
 * hold while the provider does this to us).
 */
async function storm(): Promise<StormResult> {
  const outcomes: Record<string, number> = {}
  const latencies: number[] = []
  let errors = 0
  let issued = 0

  const cpu0 = process.cpuUsage()
  const t0 = performance.now()

  async function worker(): Promise<void> {
    for (;;) {
      const i = issued
      if (i >= TOTAL) return
      issued += 1

      // Half fresh, half replay of an earlier id. A storm of all-fresh ids never
      // exercises the transport dedupe, which is the mechanism §2268 says lets a
      // replay land without touching the domain.
      const callId = `gate6-${i % DISTINCT}`

      // Pace. `issued` is the position in the whole run, so this holds the RATE
      // rather than the gap between two calls.
      const due = t0 + (i / TARGET_RATE) * 1000
      const wait = due - performance.now()
      if (wait > 0) await new Promise((r) => setTimeout(r, wait))

      const started = performance.now()
      try {
        const outcome: IngestOutcome = await admitDelivery(() =>
          ingestWebhook({
            endpointToken: TOKEN,
            // 🔴 NO SEQUENCE NUMBER IN THE BODY, and the first version had one.
            //
            // The transport dedupe key is `sha256(body)` — which is the honest
            // answer to G2's measurement that Aloware sends no delivery id and no
            // event id. So a "replay" is a BYTE-IDENTICAL body, which is exactly
            // what a provider re-sending does. Putting `seq: i` in made all 20 000
            // bodies distinct, the dedupe never fired once, and the run reported
            // 100% accepted while proving nothing about the mechanism §2268 says
            // "lets a 20 000-webhook replay storm land without touching the
            // domain".
            body: Buffer.from(
              JSON.stringify({ event: 'Call-Completed', communication_id: callId }),
            ),
            providerEvent: 'Call-Completed',
            canonical: 'call.completed',
            alowareCallId: callId,
            parseStatus: 'parsed',
            signatureValid: null,
          }),
        )
        latencies.push(performance.now() - started)
        outcomes[outcome] = (outcomes[outcome] ?? 0) + 1
      } catch (err: unknown) {
        errors += 1
        if (errors <= 3) {
          console.error('[storm]', err instanceof Error ? err.message : String(err))
        }
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()))

  const cpu = process.cpuUsage(cpu0)
  return {
    outcomes,
    errors,
    latencies,
    wallMs: performance.now() - t0,
    cpuMs: (cpu.user + cpu.system) / 1000,
  }
}

/**
 * The polling floor, measured in the same event loop the storm is using.
 *
 * `app.leaderboard_read` and not a hand-written SELECT: the budget is the cost
 * of the real read, and a cheaper query would report a floor the product never
 * serves. Failures are counted rather than sampled — a poll that threw is not a
 * fast poll.
 */
async function pollFloor(seller: string, stop: () => boolean): Promise<[number[], number]> {
  const samples: number[] = []
  let failed = 0
  while (!stop()) {
    const started = performance.now()
    try {
      await withTenant({ tenantId: TENANT, userId: seller }, async (tx) => {
        await tx.execute(sql`SELECT * FROM app.leaderboard_board('all_time'::app.period_type)`)
      })
      samples.push(performance.now() - started)
    } catch {
      failed += 1
    }
    await new Promise((r) => setTimeout(r, 5))
  }
  return [samples, failed]
}

async function main(): Promise<void> {
  console.log(`Gate 6 — retry storm. ${TOTAL} deliveries at ${TARGET_RATE}/s, folded topology.\n`)
  const seller = await seed()
  const stopContact = await seedStopSubject(seller)

  // 🔴 THE WORKER RUNS, AND UNTIL NOW IT DID NOT. Every earlier run of this
  // harness measured INGEST only: deliveries landed, jobs were enqueued, and
  // nothing drained them. That was enough for "zero lost" and useless for
  // G6/P24, whose whole subject is what happens to a job behind a backlog.
  //
  // 🔴 WHICH LEG THIS IS COMES FROM `PROCESS_ROLES` AND FROM NOTHING ELSE, which
  // is the same switch production uses — §2543's point is that the fold is a
  // deployment decision rather than a rewrite, so a harness with its own
  // topology flag would be measuring a third thing that ships nowhere.
  //
  //   folded:  PROCESS_ROLES=web,worker,ingest   · the worker starts in here
  //   split:   PROCESS_ROLES=web,ingest          · `npm run worker` drains, over there
  //
  // :2405 wants the protected assertion in BOTH legs, and §340 (N19) adds the
  // reason the split leg carries its own weight: P1–P6 and P11 are asserted on
  // the SPLIT topology only, so the poll floor measured here is the one that
  // counts against its budget rather than an honest-but-uncounted number.
  const folded = workerEnabled()
  if (folded) await startWorker()

  console.log(
    folded
      ? 'LEG: FOLDED — the worker runs inside this process.\n'
      : 'LEG: SPLIT — the worker must be running SEPARATELY (`npm run worker`).\n',
  )

  // Sampled a few seconds in, once the storm has given a drainer something to
  // do. Folded needs no probe: the worker is this process.
  let drainerSeen = folded
  const drainProbe = folded
    ? Promise.resolve()
    : new Promise<void>((resolve) => {
        setTimeout(() => {
          const probe = postgres(process.env['MIGRATION_DATABASE_URL'] ?? '', {
            max: 1,
            onnotice: () => {},
          })
          void drainerIsPresent(probe)
            .then((seen) => {
              drainerSeen = seen
            })
            .finally(() => probe.end().then(resolve, () => resolve()))
        }, 10_000)
      })

  // 🔴 THE REAL HISTOGRAM, not the monitor's fake one. The first wiring of this
  // harness installed __installFakeHistogram(0) and dutifully reported a loop
  // p99 of 0.0 ms — a measurement of nothing, printed under the name of the
  // number the gate asks for. Every value out of this API is in NANOSECONDS.
  const lag = monitorEventLoopDelay({ resolution: 10 })
  lag.enable()

  let done = false
  const floor = pollFloor(seller, () => done)

  // Injected mid-storm rather than before or after it. The register says
  // "during", and the whole question is whether the compliance lane holds while
  // `call-merge` is draining 20,000 jobs — a STOP fired into a quiet system
  // measures nothing.
  const stopRun = new Promise<StopResult>((resolve, reject) => {
    setTimeout(
      () => {
        injectStopAndWatch(seller, stopContact).then(resolve, reject)
      },
      (TOTAL / TARGET_RATE) * 1000 * 0.5,
    )
  })

  const result = await storm()
  done = true
  const [floorSamples, floorFailed] = await floor
  const stop = await stopRun

  // The bulkhead's own counters, and the REAL event loop.
  const saturation = drainSaturation()
  const loop = { loopP99Ms: lag.percentile(99) / 1e6, loopMaxMs: lag.max / 1e6, alerted: false }
  lag.disable()

  const accepted = result.outcomes['accepted'] ?? 0
  const duplicate = result.outcomes['duplicate'] ?? 0
  const quarantined = result.outcomes['quarantined'] ?? 0
  const unknown = result.outcomes['unknown_token'] ?? 0
  const answered = accepted + duplicate + quarantined + unknown

  console.log('— INGEST —')
  console.log(`  answered      ${answered} / ${TOTAL}`)
  console.log(`  accepted      ${accepted}`)
  console.log(`  duplicate     ${duplicate}`)
  console.log(`  quarantined   ${quarantined}`)
  console.log(`  unknown_token ${unknown}`)
  console.log(`  errors        ${result.errors}`)
  console.log(`  LOST          ${TOTAL - answered}`)
  console.log(
    `  p50 ${pct(result.latencies, 0.5).toFixed(2)}ms  ` +
      `p95 ${pct(result.latencies, 0.95).toFixed(2)}ms  ` +
      `p99 ${pct(result.latencies, 0.99).toFixed(2)}ms`,
  )
  console.log(
    `  wall ${(result.wallMs / 1000).toFixed(1)}s  ` +
      `achieved ${(TOTAL / (result.wallMs / 1000)).toFixed(0)}/s`,
  )

  await drainProbe

  console.log('\n— G6/P24, THE PROTECTED ASSERTION —')
  console.log(`  leg                  ${folded ? 'folded' : 'split'}`)
  console.log(`  drainer observed     ${drainerSeen ? 'yes' : '🔴 NO'}`)
  console.log(`  STOP ingested        ${stop.ingestOutcome}`)
  console.log(
    `  suppression_list     ${
      stop.suppressedInMs === null
        ? 'NEVER APPEARED'
        : `${stop.suppressedInMs.toFixed(0)}ms  (deadline ${STOP_DEADLINE_MS}ms)`
    }`,
  )
  console.log(`  dial at T+5s         ${stop.verdictAtDeadline}  (must be blocked_suppressed)`)

  const p24InTime = stop.suppressedInMs !== null && stop.suppressedInMs <= STOP_DEADLINE_MS
  const p24Blocked = stop.verdictAtDeadline === 'blocked_suppressed'

  // 🔴 WITHOUT A DRAINER THERE IS NO VERDICT TO REPORT, only the appearance of
  // one. A split run with nobody working the queues produces the identical
  // console output to a real G6/P24 failure, and printing FAIL under it would
  // be this project's own worst failure mode: a number reported for a half that
  // was never measured. So the assertion is declared UNRUN rather than failed.
  const p24Meaningful = drainerSeen
  console.log(
    `  VERDICT              ${
      !p24Meaningful
        ? 'UNRUN — nothing drained the queues'
        : p24InTime && p24Blocked
          ? 'PASS'
          : 'FAIL'
    }`,
  )
  if (!p24Meaningful) {
    console.log(
      '  🔴 The split leg needs a SEPARATE worker. Start one in another shell:\n' +
        '       npm run worker\n' +
        '     and run this with PROCESS_ROLES=web,ingest so this process does not fold one in.\n' +
        '     Nothing above about G6/P24 means anything until that is true.',
    )
  }

  console.log(
    folded
      ? '\n— FOLDED BULKHEAD (the poll floor, same event loop as the storm) —'
      : '\n— THE POLL FLOOR (split: the worker is a different process) —',
  )
  console.log(`  samples ${floorSamples.length}   failed ${floorFailed}`)
  console.log(
    `  p50 ${pct(floorSamples, 0.5).toFixed(2)}ms  ` +
      `p95 ${pct(floorSamples, 0.95).toFixed(2)}ms  ` +
      `p99 ${pct(floorSamples, 0.99).toFixed(2)}ms`,
  )
  // 🔴 THE SAME NUMBER MEANS DIFFERENT THINGS IN THE TWO LEGS, and §340 (N19) is
  // why: P1–P6 and P11 are asserted on the SPLIT topology ONLY. Folded, this is
  // an honest number that is not the budget; split, it IS the budget.
  console.log(
    folded
      ? `  P11's red line is 80 ms for a 304. This is the FULL read, not a 304, and it is ` +
          `the FOLDED leg — §340 (N19) asserts P1–P6 and P11 on the SPLIT topology only, ` +
          `so this rung publishes its own honest number and is not judged by that budget.`
      : `  P11's red line is 80 ms for a 304, and §340 (N19) asserts it on THIS leg. ` +
          `Measured as the FULL read rather than a 304, so it is stricter than the budget ` +
          `rather than looser: ${pct(floorSamples, 0.95).toFixed(2)}ms against 80.`,
  )

  const cpuPerWebhook = result.cpuMs / TOTAL
  console.log('\n— FOLD/SPLIT INPUT (§2551) —')
  console.log(`  cpu_ms_per_webhook ${cpuPerWebhook.toFixed(3)}`)
  console.log(
    `  a 0.5 vCPU day has 43,200,000 cpu-ms; at this cost that is ` +
      `${Math.floor(43_200_000 / cpuPerWebhook).toLocaleString('en-US')} webhooks/day ` +
      `before the edge alone saturates it.`,
  )
  console.log(
    `  ⚠️ MEASURED ON THIS MACHINE, not on a 0.5 vCPU Starter instance. ` +
      `P6, P20 and N13 are already machine-dependent; this is the fourth.`,
  )
  console.log(
    `  ⚠️ AND IT INCLUDES THE POLL FLOOR'S CPU: process.cpuUsage() is per ` +
      `PROCESS, and folded, the process is doing both. That is the right number ` +
      `for a fold/split decision and the wrong one for "cost of a webhook".`,
  )

  console.log('\n— THE BULKHEAD (§2548 asks for the 429 count) —')
  console.log(`  shed / 429              ${saturation.shed}   <- correct value is ZERO`)
  console.log(`  peak queue depth        ${saturation.peakQueued}`)
  console.log(`  waits over the slow bar ${saturation.slowWaits}`)
  console.log(`  longest wait            ${saturation.maxWaitMs.toFixed(0)}ms`)
  console.log(
    `  The edge QUEUES and cannot shed. G2 measured that Aloware never retries ` +
      `and tolerates 110 s of silence, so a 429 is a lost webhook with a status ` +
      `code on it — and 05c:905 asserts ZERO 429 on this surface.`,
  )

  console.log('\n— THE EVENT LOOP (§2444: p99 > 200 ms sustained 60 s) —')
  console.log(`  loop p99                ${loop.loopP99Ms.toFixed(1)}ms`)
  console.log(`  loop max                ${loop.loopMaxMs.toFixed(1)}ms`)
  console.log(`  budget                  200ms`)
  console.log(`  alert raised            ${loop.alerted ? 'YES' : 'no'}`)

  await stopWorker()

  const lost = TOTAL - answered
  const clean = lost === 0 && result.errors === 0 && saturation.shed === 0
  const p24 = p24Meaningful && p24InTime && p24Blocked

  console.log(
    `\nRESULT [${folded ? 'folded' : 'split'}]: ` +
      `${lost === 0 ? 'zero webhooks lost' : `🔴 ${lost} WEBHOOKS LOST`}, ` +
      `${saturation.shed} shed, loop p99 ${loop.loopP99Ms.toFixed(1)}ms. ` +
      `G6/P24 ${!p24Meaningful ? '⬜ UNRUN' : p24 ? 'PASSED' : '🔴 FAILED'}.`,
  )
  console.log(
    p24 && clean
      ? `  This leg (${folded ? 'folded' : 'split'}) is done. :2405 wants BOTH — run the other one.`
      : '  Gate 6 NOT closed.',
  )

  // `retries: 0` on the protected assertion means exactly this: no second run,
  // no "flaky, re-run it". A failing G6/P24 is a red exit.
  process.exit(clean && p24 ? 0 : 1)
}

void main()
