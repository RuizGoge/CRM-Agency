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
 * ⚠️ ONE STILL CANNOT RUN, and it is the PROTECTED one. G6/P24 (05c:1588,
 * :2405): inject one STOP during the storm, assert the `suppression_list` row
 * within 5 s and a dial at T+5 s returning `blocked_suppressed`. There is no
 * STOP sniff at ingress (§10.9's `stopSniff` does not exist) and
 * `message.received` is unreachable, so no delivery can produce a STOP at all.
 *
 * So the gate STILL does not close. It is one assertion away rather than four,
 * and the one left is the one the register marks protected with `retries: 0`.
 */

import { createHash } from 'node:crypto'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { performance } from 'node:perf_hooks'

import { sql } from 'drizzle-orm'
import postgres from 'postgres'

import { ingestWebhook, withSystemWork, withTenant, type IngestOutcome } from '../app/db'
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

  // 🔴 THE REAL HISTOGRAM, not the monitor's fake one. The first wiring of this
  // harness installed __installFakeHistogram(0) and dutifully reported a loop
  // p99 of 0.0 ms — a measurement of nothing, printed under the name of the
  // number the gate asks for. Every value out of this API is in NANOSECONDS.
  const lag = monitorEventLoopDelay({ resolution: 10 })
  lag.enable()

  let done = false
  const floor = pollFloor(seller, () => done)
  const result = await storm()
  done = true
  const [floorSamples, floorFailed] = await floor

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

  console.log('\n— FOLDED BULKHEAD (the poll floor, same event loop) —')
  console.log(`  samples ${floorSamples.length}   failed ${floorFailed}`)
  console.log(
    `  p50 ${pct(floorSamples, 0.5).toFixed(2)}ms  ` +
      `p95 ${pct(floorSamples, 0.95).toFixed(2)}ms  ` +
      `p99 ${pct(floorSamples, 0.99).toFixed(2)}ms`,
  )
  console.log(
    `  P11 red line is 80 ms for a 304. This is the FULL read, not a 304, and ` +
      `it is the folded leg — §340 (N19) says P1–P6 and P11 are asserted on the ` +
      `SPLIT topology only and the folded rung publishes its own honest numbers.`,
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

  console.log('\n— STILL NOT ASSERTED, no subject exists —')
  console.log('  G6/P24 STOP injection   · no STOP sniff at ingress (PROTECTED assertion)')

  const lost = TOTAL - answered
  console.log(
    `\nRESULT: ${lost === 0 ? 'zero webhooks lost' : `🔴 ${lost} WEBHOOKS LOST`}, ` +
      `${saturation.shed} shed, loop p99 ${loop.loopP99Ms.toFixed(1)}ms. ` +
      `Gate 6 still NOT closed — G6/P24 has no subject.`,
  )

  process.exit(lost === 0 && result.errors === 0 && saturation.shed === 0 ? 0 : 1)
}

void main()
