/**
 * Sprint-0 Gate G2 — the OUTBOUND half of the Aloware spike.
 *
 * Executes each declared probe against the real account, captures the exchange,
 * and writes it to `ref.capability_probe` — the table errata E9 specifies, whose
 * whole purpose is that "verified" becomes a rendered fact with a provenance
 * instead of a word in a column.
 *
 * THREE REFUSALS, each closing a way this script could produce a false finding:
 *
 *   1. A probe with no `source` does not run (SPIKE010). A path recalled from
 *      vendor documentation rather than read off the real account returns a 404
 *      that is indistinguishable from the capability being ABSENT — and `absent`
 *      on an mvp_required row is the finding that stops the MVP. The source is
 *      where the path was read.
 *   2. This script NEVER writes `ref.provider_capability` (SPIKE012). Promotion
 *      to `verified` is a migration that cites probe ids, so the moment a
 *      capability becomes real is a reviewable file in the chain and not the
 *      side effect of a script somebody ran. The engine agrees: `crm_app` has
 *      no write on either table, and the promotion trigger checks that the
 *      probe is 2xx, is of that capability, and matches `verified_at`.
 *   3. The bearer token is never stored and never printed. It travels in a
 *      header; secret-bearing query parameters are redacted before the URL is
 *      written, because that row outlives every retention window in the system.
 *
 * Run:  npm run spike:probe -- --dry-run
 *       npm run spike:probe -- --run=g2-2026-08-05
 */
import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import postgres from 'postgres'
import { z } from 'zod'

// -----------------------------------------------------------------------------

/**
 * The literal placeholder Aloware's own API reference prints in its example
 * bodies. It is substituted with `ALOWARE_API_TOKEN` at send time and **never**
 * substituted in what we write to disk.
 *
 * That is the whole redaction mechanism, and it is a mechanism rather than a
 * discipline: the declared body is what gets logged, and the declared body
 * physically does not contain the secret. There is no "remember to strip the
 * token" step anywhere, because the only copy that ever holds it is the one
 * handed to `fetch`.
 */
const TOKEN_PLACEHOLDER = '[API_TOKEN]'

const requestSchema = z.object({
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  /** Relative to ALOWARE_API_BASE. */
  path: z.string().min(1),
  query: z.record(z.string(), z.string()).optional(),
  body: z.unknown().optional(),
  /** Extra headers. */
  headers: z.record(z.string(), z.string()).optional(),
  /**
   * How this endpoint authenticates — READ off the panel, never assumed.
   *
   * 🔴 The first thing Gate G2 learned about this API contradicted the
   * assumption this script shipped with. Aloware's Two-Legged Call API takes
   * `api_token` as a FIELD IN THE JSON BODY, not as an `Authorization: Bearer`
   * header. A prober that had hard-coded Bearer would have received a 401 and
   * recorded it as evidence that the capability was ABSENT — on the one
   * capability whose absence makes the MVP unshippable.
   *
   * So auth is per-probe and declared: put `[API_TOKEN]` wherever the panel's
   * example puts it, and add `"auth": "bearer"` only if that endpoint really
   * uses a header.
   */
  auth: z.enum(['bearer', 'none']).default('none'),
})

const probeSchema = z.object({
  capability: z.string().min(1),
  tier: z.enum(['mvp_required', 'mvp_optional', 'probe_only']),
  question: z.string(),
  request: requestSchema.nullable(),
  source: z.string().nullable(),
  subject: z.string().nullable(),
})

const fileSchema = z.object({ probes: z.array(probeSchema) })

type Probe = z.infer<typeof probeSchema>

// -----------------------------------------------------------------------------

const args = process.argv.slice(2)
const flag = (name: string): string | undefined => {
  const hit = args.find((a) => a.startsWith(`--${name}=`))
  return hit?.slice(name.length + 3)
}
const has = (name: string): boolean => args.includes(`--${name}`)

const DRY_RUN = has('dry-run')
const NO_DB = has('no-db')
const ONLY = flag('only')
const RUN_ID = flag('run') ?? `g2-${new Date().toISOString().replace(/[:.]/g, '-')}`

const API_BASE = process.env['ALOWARE_API_BASE'] ?? ''
const API_TOKEN = process.env['ALOWARE_API_TOKEN'] ?? ''

const DB_URL =
  process.env['MIGRATION_DATABASE_URL'] ??
  process.env['DEV_DATABASE_URL'] ??
  'postgresql://crm:crm@localhost:5432/crm_dev'

const EVIDENCE_DIR = resolve(process.env['SPIKE_EVIDENCE_DIR'] ?? 'evidence/aloware')
const EVIDENCE_FILE = resolve(EVIDENCE_DIR, 'probes.ndjson')

/** Query parameter names whose VALUE must never reach a permanent row. */
const SECRET_PARAM = /token|key|secret|password|passwd|auth|signature|sig|bearer/i

// -----------------------------------------------------------------------------

interface Outcome {
  readonly probe: Probe
  readonly skipped: string | null
  readonly httpStatus: number | null
  readonly observedAt: Date | null
  readonly requestMethod: string
  readonly requestUrl: string
  readonly responseBody: Buffer | null
  readonly responseHeaders: Record<string, string> | null
  readonly latencyMs: number | null
  readonly transportError: string | null
}

/**
 * Deep-substitutes `[API_TOKEN]` with the real token. Applied ONLY to the copy
 * handed to `fetch` — never to the copy that is written to evidence.
 */
function withToken(value: unknown): unknown {
  if (typeof value === 'string') {
    // `[API_TOKEN]` first, then any other `[NAME]` that has a matching
    // `SPIKE_NAME` in the environment.
    //
    // THIS IS WHY A PHONE NUMBER IS NOT IN THIS REPOSITORY. A declaration is
    // committed and lives forever; a subject is a real person. E9 forbids
    // giving PII a permanent clock in `ref.capability_probe`, and a git history
    // is a longer clock than that table. So the declaration carries
    // `[DESTINATION_E164]` and the value comes from `.env`, which is ignored.
    //
    // Unresolved placeholders are not silently blanked — SPIKE014 refuses to
    // send them, so a missing variable stops the run instead of dialling `[…]`.
    return value
      .split(TOKEN_PLACEHOLDER)
      .join(API_TOKEN)
      .replace(/\[([A-Z][A-Z0-9_]*)\]/g, (whole, name: string) => {
        const fromEnv = process.env[`SPIKE_${name}`]
        return fromEnv === undefined || fromEnv === '' ? whole : fromEnv
      })
  }
  if (Array.isArray(value)) return value.map(withToken)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, withToken(v)]))
  }
  return value
}

function buildUrl(request: z.infer<typeof requestSchema>): { real: URL; redacted: string } {
  const real = new URL(
    request.path.replace(/^\//, ''),
    API_BASE.endsWith('/') ? API_BASE : `${API_BASE}/`,
  )
  for (const [k, v] of Object.entries(request.query ?? {})) {
    real.searchParams.set(k, String(withToken(v)))
  }

  // Two independent redactions, because a token can reach a URL two ways: as a
  // parameter someone NAMED like a secret, and as the placeholder substituted
  // above. The second is the one that would actually happen here.
  const redacted = new URL(real.toString())
  for (const key of [...redacted.searchParams.keys()]) {
    const current = redacted.searchParams.get(key) ?? ''
    if (SECRET_PARAM.test(key) || (API_TOKEN !== '' && current.includes(API_TOKEN))) {
      redacted.searchParams.set(key, '[REDACTED]')
    }
  }
  return { real, redacted: redacted.toString() }
}

async function execute(probe: Probe): Promise<Outcome> {
  const base = {
    probe,
    httpStatus: null,
    observedAt: null,
    responseBody: null,
    responseHeaders: null,
    latencyMs: null,
    transportError: null,
  }

  if (probe.request === null) {
    return { ...base, skipped: 'no request declared', requestMethod: '', requestUrl: '' }
  }
  if (probe.source === null || probe.source.trim() === '') {
    // SPIKE010. See the header comment — this is the refusal that stops a
    // remembered endpoint from being reported as an absent capability.
    return {
      ...base,
      skipped: 'SPIKE010: no source. Name where the path was read on the real account.',
      requestMethod: probe.request.method,
      requestUrl: '',
    }
  }

  const { real, redacted } = buildUrl(probe.request)

  // SPIKE014 · an unresolved [PLACEHOLDER] never leaves this machine.
  //
  // The declaration file is filled in from the panel, and some fields come from
  // elsewhere in the account — a line's phone number, an inbox id. A probe sent
  // with `[LINE_PHONE_NUMBER]` still in it comes back 4xx, and a 4xx from a
  // SOURCED path is exactly what this gate reads as `absent`. That is how a
  // half-filled form becomes "the MVP is not shippable".
  const unresolved = [
    ...JSON.stringify(probe.request.body ?? null).matchAll(/\[[A-Z][A-Z0-9_]*\]/g),
    ...redacted.matchAll(/\[[A-Z][A-Z0-9_]*\]/g),
  ]
    .map((m) => m[0])
    .filter((p) => p !== TOKEN_PLACEHOLDER && p !== '[REDACTED]')

  if (unresolved.length > 0) {
    return {
      ...base,
      skipped: `SPIKE014: unresolved placeholder(s) ${[...new Set(unresolved)].join(', ')}`,
      requestMethod: probe.request.method,
      requestUrl: redacted,
    }
  }

  const started = process.hrtime.bigint()

  try {
    const response = await fetch(real, {
      method: probe.request.method,
      headers: {
        accept: 'application/json',
        ...(probe.request.auth === 'bearer' ? { authorization: `Bearer ${API_TOKEN}` } : {}),
        ...(probe.request.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(probe.request.headers ?? {}),
      },
      ...(probe.request.body === undefined
        ? {}
        : { body: JSON.stringify(withToken(probe.request.body)) }),
      signal: AbortSignal.timeout(30_000),
    })
    const body = Buffer.from(await response.arrayBuffer())
    return {
      ...base,
      skipped: null,
      httpStatus: response.status,
      observedAt: new Date(),
      requestMethod: probe.request.method,
      requestUrl: redacted,
      responseBody: body,
      responseHeaders: Object.fromEntries(response.headers.entries()),
      latencyMs: Number((process.hrtime.bigint() - started) / 1_000_000n),
    }
  } catch (error) {
    // A transport failure is NOT evidence of absence, and it must never be
    // written as a probe: `absent` has to mean the provider answered and said
    // no, not that our laptop's DNS blinked.
    return {
      ...base,
      skipped: null,
      requestMethod: probe.request.method,
      requestUrl: redacted,
      transportError: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      latencyMs: Number((process.hrtime.bigint() - started) / 1_000_000n),
    }
  }
}

// -----------------------------------------------------------------------------

async function main(): Promise<void> {
  const raw: unknown = JSON.parse(
    readFileSync(resolve('scripts/spike/aloware-probes.json'), 'utf8'),
  )
  const declared = fileSchema.parse(raw).probes

  const selected = ONLY === undefined ? declared : declared.filter((p) => p.capability === ONLY)

  // Attempted = has a request. The SOURCE refusal deliberately lives inside
  // execute() and not in this filter: a probe silently filtered out is a probe
  // nobody notices is missing, and SPIKE010 exists to be seen. Filtering here
  // as well would also make that branch unreachable — a guard that cannot fire.
  const attempted = selected.filter((p) => p.request !== null)
  const ready = attempted.filter((p) => (p.source ?? '').trim() !== '')

  console.log(`run          ${RUN_ID}`)
  console.log(`declared     ${selected.length}`)
  console.log(`with request ${attempted.length}`)
  console.log(`ready to run ${ready.length}`)
  for (const p of selected) {
    const why =
      p.request === null
        ? 'no request declared'
        : (p.source ?? '').trim() === ''
          ? 'SPIKE010 no source'
          : 'ready'
    console.log(`  ${p.tier.padEnd(12)} ${p.capability.padEnd(38)} ${why}`)
  }

  if (DRY_RUN) return
  if (attempted.length === 0) {
    console.error(
      '\nSPIKE011 · nothing to run. Fill `request` and `source` in scripts/spike/aloware-probes.json\n' +
        "  by reading the real account's API reference — never from memory. An invented path\n" +
        '  returns a 404 that is indistinguishable from the capability being absent.',
    )
    process.exit(1)
  }
  if (API_BASE === '' || API_TOKEN === '') {
    console.error('SPIKE013 · ALOWARE_API_BASE and ALOWARE_API_TOKEN must be set in .env')
    process.exit(1)
  }

  mkdirSync(EVIDENCE_DIR, { recursive: true })
  const sql = NO_DB ? null : postgres(DB_URL, { max: 1 })
  let skipped = 0
  let htmlTwoXX = 0

  try {
    for (const probe of attempted) {
      const outcome = await execute(probe)

      if (outcome.skipped !== null) {
        console.error(`  ✖ ${probe.capability}: ${outcome.skipped}`)
        skipped += 1
        continue
      }

      appendFileSync(
        EVIDENCE_FILE,
        JSON.stringify({
          run: RUN_ID,
          capability: probe.capability,
          tier: probe.tier,
          question: probe.question,
          source: probe.source,
          subject: probe.subject,
          request_method: outcome.requestMethod,
          request_url: outcome.requestUrl,
          request_body: probe.request?.body ?? null,
          http_status: outcome.httpStatus,
          response_headers: outcome.responseHeaders,
          response_body_b64: outcome.responseBody?.toString('base64') ?? null,
          latency_ms: outcome.latencyMs,
          transport_error: outcome.transportError,
          observed_at: outcome.observedAt?.toISOString() ?? null,
        }) + '\n',
        'utf8',
      )

      if (outcome.transportError !== null) {
        console.error(`  ✖ ${probe.capability}: ${outcome.transportError} (NOT written as a probe)`)
        continue
      }
      if (
        outcome.httpStatus === null ||
        outcome.responseBody === null ||
        outcome.observedAt === null
      ) {
        continue
      }

      // SPIKE015 · a 2xx that returns HTML is a single-page app's catch-all
      // route, not a working endpoint.
      //
      // 🔴 This is the hole that found itself. Blind-probing four plausible
      // call-list paths returned `HTTP 200` with `<!DOCTYPE html>` on every
      // one, because the SPA serves its shell for any unmatched path. The
      // promotion trigger CAP003 only asserts the probe is 2xx — and these ARE
      // 2xx, with a non-empty body and a digest that validates. A capability
      // could be marked `verified` against a web page.
      //
      // SPIKE012 already prevented it: the prober never promotes, and a human
      // writing the migration would see the HTML. But a guarantee that depends
      // on somebody noticing is exactly the kind this project refuses to rest on.
      const contentType = outcome.responseHeaders?.['content-type'] ?? ''
      if (outcome.httpStatus < 300 && /text\/html/i.test(contentType)) {
        console.error(
          `  ⚠ SPIKE015 ${probe.capability}: HTTP ${outcome.httpStatus} but content-type is "${contentType}".\n` +
            `    A 2xx carrying HTML is an SPA catch-all, NOT a working endpoint. This row is evidence\n` +
            `    of that behaviour and must never back a 'verified' capability.`,
        )
        htmlTwoXX += 1
      }

      console.log(
        `  → ${probe.capability}: HTTP ${outcome.httpStatus} in ${outcome.latencyMs ?? 0} ms, ` +
          `${outcome.responseBody.length} bytes`,
      )

      if (sql !== null) {
        const digest = createHash('sha256').update(outcome.responseBody).digest()
        const [row] = await sql<{ probe_id: string }[]>`
          INSERT INTO ref.capability_probe
            (provider, capability, http_status, response_body, response_digest,
             observed_at, probe_run, request_method, request_url)
          VALUES
            ('aloware', ${probe.capability}, ${outcome.httpStatus}, ${outcome.responseBody},
             ${digest}, ${outcome.observedAt}, ${RUN_ID}, ${outcome.requestMethod},
             ${outcome.requestUrl})
          RETURNING probe_id
        `
        console.log(`    probe ${row?.probe_id ?? '(no id returned)'}`)
      }
    }
  } finally {
    await sql?.end()
  }

  console.log(`\nevidence -> ${EVIDENCE_FILE}`)
  console.log(
    'SPIKE012 · no capability was promoted. Read the evidence, then write the migration\n' +
      '  that flips status to `verified` citing these probe ids. Promotion is a reviewable\n' +
      '  file in the chain, never the side effect of running this.',
  )

  // Non-zero on a skip. A run that quietly probed five of seven and reported
  // success is how a gate gets called closed while two of its questions were
  // never asked.
  if (skipped > 0 || htmlTwoXX > 0) {
    if (skipped > 0) {
      console.error(`\n${skipped} probe(s) were refused. The gate is not answered for those.`)
    }
    if (htmlTwoXX > 0) {
      console.error(
        `\n${htmlTwoXX} probe(s) returned a 2xx carrying HTML (SPIKE015). Those endpoints do not exist;\n` +
          `  the status code says otherwise and is wrong.`,
      )
    }
    process.exit(1)
  }
}

await main()
