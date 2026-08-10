/**
 * Sprint-0 Gate G2 — the INBOUND half of the Aloware spike.
 *
 * This is a disposable measuring instrument, not the ingest process. It exists
 * to answer, with captured bytes rather than vendor documentation:
 *
 *   - are the webhooks SIGNED, and with what scheme     -> every header, verbatim
 *   - do they RETRY, and with what backoff              -> the `status` arm
 *   - is delivery duplicated / out of order             -> body digest + arrival seq
 *   - does the provider require a SYNCHRONOUS response
 *     below ~1 s                                        -> the `delay` arm
 *   - what is the real burst shape (OQ-2)               -> monotonic inter-arrival
 *
 * Design rules this file follows, all of them load-bearing:
 *
 *   1. IT NEVER PARSES. The body is stored as raw bytes plus a sha256. A parser
 *      is an opinion about the payload, and the payload's shape is one of the
 *      things the gate is trying to learn.
 *   2. IT CAPTURES EVERY PATH. Anything not under /_spike/ is recorded, so a
 *      webhook configured against a path we did not anticipate is still evidence
 *      instead of a 404 nobody sees.
 *   3. IT WRITES TWICE. One NDJSON line to disk AND one to stdout. Disk is the
 *      record of truth under a local tunnel; stdout is the only thing that
 *      survives on a host with an ephemeral filesystem.
 *   4. IT REFUSES TO BOOT WITHOUT A CONTROL SECRET. The control plane can make
 *      this endpoint return 500 or hang, which is exactly how the retry and the
 *      synchronous-response measurements are taken. On a public URL, an open
 *      control plane lets a stranger change what the gate measures.
 *
 * Run:  npx tsx scripts/spike/aloware-receiver.ts
 * Env:  SPIKE_CONTROL_SECRET (required) · PORT (default 8787) · SPIKE_EVIDENCE_DIR
 */
import { createHash, timingSafeEqual } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { resolve } from 'node:path'

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------

const CONTROL_SECRET = process.env['SPIKE_CONTROL_SECRET'] ?? ''
if (CONTROL_SECRET.length < 16) {
  console.error(
    'SPIKE001 · refusing to start: SPIKE_CONTROL_SECRET must be set and at least 16 characters.\n' +
      '  The control plane arms failure and delay responses. Unprotected on a public URL,\n' +
      '  anyone can change what this gate measures. Generate one with:\n' +
      "    node -e \"console.log(require('crypto').randomBytes(24).toString('base64url'))\"",
  )
  process.exit(1)
}

const PORT = Number.parseInt(process.env['PORT'] ?? '8787', 10)
const EVIDENCE_DIR = resolve(process.env['SPIKE_EVIDENCE_DIR'] ?? 'evidence/aloware')
const EVIDENCE_FILE = resolve(EVIDENCE_DIR, 'webhooks.ndjson')

/** Bodies above this are truncated rather than refused — a truncated capture is
 *  still evidence of arrival, and refusing would teach the provider to retry. */
const MAX_BODY_BYTES = 5 * 1024 * 1024

/** `hang` must not leak sockets forever. This is far longer than any provider
 *  timeout we expect to observe, so it never masks the number we are measuring. */
const HANG_CEILING_MS = 120_000

// -----------------------------------------------------------------------------
// The arm — what this endpoint does to the NEXT deliveries
// -----------------------------------------------------------------------------

type ArmMode =
  | 'ok' // respond 204 immediately (the resting state)
  | 'status' // respond with `status` immediately   -> retry / backoff probe
  | 'delay' // wait `delayMs`, then respond 204     -> synchronous-response probe
  | 'hang' // never respond                        -> the extreme of the same probe

interface Arm {
  readonly mode: ArmMode
  readonly status: number
  readonly delayMs: number
  /** -1 means "until changed". Otherwise decremented, then falls back to `ok`. */
  remaining: number
  readonly note: string
  readonly armedAt: string
  readonly armId: string
}

const RESTING_ARM: Arm = {
  mode: 'ok',
  status: 204,
  delayMs: 0,
  remaining: -1,
  note: 'resting',
  armedAt: new Date().toISOString(),
  armId: 'rest',
}

let arm: Arm = RESTING_ARM
let sequence = 0

// -----------------------------------------------------------------------------
// Evidence
// -----------------------------------------------------------------------------

interface Capture {
  readonly seq: number
  readonly received_at: string
  /** Monotonic clock. Wall time can step; inter-arrival deltas must not. */
  readonly received_monotonic_ns: string
  readonly method: string
  readonly url: string
  readonly http_version: string
  readonly remote_addr: string
  /** Flat [name, value, name, value, ...] — preserves ORDER and DUPLICATES,
   *  both of which a normalised header object silently destroys. */
  readonly raw_headers: readonly string[]
  readonly body_bytes: number
  readonly body_sha256: string
  readonly body_b64: string
  readonly body_truncated: boolean
  /** False when the client hung up mid-body — a delivery that never completed. */
  readonly body_complete: boolean
  readonly arm: { mode: ArmMode; armId: string; status: number; delayMs: number }
  readonly response_status: number | null
  readonly response_latency_ms: number
  /** True when the client hung up before we answered. THIS is the provider's
   *  synchronous-response requirement, observed rather than asked about. */
  readonly client_aborted: boolean
}

mkdirSync(EVIDENCE_DIR, { recursive: true })

function record(capture: Capture): void {
  const line = JSON.stringify(capture)
  // Synchronous on purpose: a spike that loses its last capture because the
  // process died with a buffered write is a spike that has to be re-run.
  appendFileSync(EVIDENCE_FILE, line + '\n', 'utf8')
  console.log(line)
}

function readEvidence(): string {
  try {
    return readFileSync(EVIDENCE_FILE, 'utf8')
  } catch {
    return ''
  }
}

// -----------------------------------------------------------------------------
// Control plane
// -----------------------------------------------------------------------------

function secretMatches(provided: string | undefined): boolean {
  if (provided === undefined) return false
  // Hash both sides so timingSafeEqual gets equal-length buffers regardless of
  // what was supplied.
  const a = createHash('sha256').update(provided).digest()
  const b = createHash('sha256').update(CONTROL_SECRET).digest()
  return timingSafeEqual(a, b)
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name]
  return Array.isArray(value) ? value[0] : value
}

function json(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload, null, 2)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(body)
}

function handleControl(req: IncomingMessage, res: ServerResponse, url: URL): void {
  // /_spike/health is deliberately open: it is how we confirm the URL is
  // reachable, and how a host's health check keeps the instance warm. It
  // reveals nothing and changes nothing.
  if (url.pathname === '/_spike/health') {
    json(res, 200, { ok: true, captures: sequence })
    return
  }

  if (!secretMatches(header(req, 'x-spike-secret'))) {
    json(res, 404, { error: 'not_found' })
    return
  }

  if (url.pathname === '/_spike/state') {
    json(res, 200, { arm, captures: sequence, evidence_file: EVIDENCE_FILE })
    return
  }

  if (url.pathname === '/_spike/evidence') {
    res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8' })
    res.end(readEvidence())
    return
  }

  if (url.pathname === '/_spike/arm') {
    const mode = url.searchParams.get('mode') ?? 'ok'
    if (mode !== 'ok' && mode !== 'status' && mode !== 'delay' && mode !== 'hang') {
      json(res, 400, { error: 'mode must be one of ok | status | delay | hang' })
      return
    }
    arm = {
      mode,
      status: Number.parseInt(url.searchParams.get('status') ?? '204', 10),
      delayMs: Number.parseInt(url.searchParams.get('delay_ms') ?? '0', 10),
      remaining: Number.parseInt(url.searchParams.get('count') ?? '-1', 10),
      note: url.searchParams.get('note') ?? '',
      armedAt: new Date().toISOString(),
      armId: createHash('sha256')
        .update(`${mode}:${Date.now()}:${sequence}`)
        .digest('hex')
        .slice(0, 12),
    }
    json(res, 200, { armed: arm })
    return
  }

  json(res, 404, { error: 'not_found' })
}

// -----------------------------------------------------------------------------
// Capture path — everything that is not /_spike/
// -----------------------------------------------------------------------------

function handleDelivery(req: IncomingMessage, res: ServerResponse): void {
  const startNs = process.hrtime.bigint()
  const seq = ++sequence
  const receivedAt = new Date().toISOString()
  const effective = arm
  if (arm.remaining > 0) {
    arm.remaining -= 1
    if (arm.remaining === 0) arm = RESTING_ARM
  }

  const chunks: Buffer[] = []
  let total = 0
  let truncated = false
  let bodyComplete = false
  let responded: number | null = null
  let aborted = false
  let recorded = false

  const finish = (): void => {
    // Exactly one line per delivery. Both the response path and the abort path
    // lead here, and a capture written twice would read as a duplicate
    // delivery — corrupting the very question this instrument answers.
    if (recorded) return
    recorded = true
    const body = Buffer.concat(chunks)
    const latencyNs = process.hrtime.bigint() - startNs
    record({
      seq,
      received_at: receivedAt,
      received_monotonic_ns: startNs.toString(),
      method: req.method ?? '',
      url: req.url ?? '',
      http_version: req.httpVersion,
      remote_addr: req.socket.remoteAddress ?? '',
      raw_headers: req.rawHeaders,
      body_bytes: total,
      body_sha256: createHash('sha256').update(body).digest('hex'),
      body_b64: body.toString('base64'),
      body_truncated: truncated,
      body_complete: bodyComplete,
      arm: {
        mode: effective.mode,
        armId: effective.armId,
        status: effective.status,
        delayMs: effective.delayMs,
      },
      response_status: responded,
      response_latency_ms: Number(latencyNs / 1_000_000n),
      client_aborted: aborted,
    })
  }

  // Registered BEFORE the body is read, not inside the `end` handler: a client
  // that hangs up mid-body never fires `end`, and that delivery would otherwise
  // leave no trace at all. The client hanging up before we answer IS the
  // measurement in the `delay` and `hang` arms — observed from the socket.
  res.on('close', () => {
    if (responded === null) {
      aborted = true
      finish()
    }
  })

  const respond = (status: number): void => {
    if (res.writableEnded || aborted) return
    responded = status
    res.writeHead(status, { 'content-length': '0' })
    res.end()
    finish()
  }

  req.on('data', (chunk: Buffer) => {
    total += chunk.length
    if (total <= MAX_BODY_BYTES) {
      chunks.push(chunk)
    } else {
      truncated = true
    }
  })

  req.on('end', () => {
    bodyComplete = true
    switch (effective.mode) {
      case 'ok':
        respond(204)
        break
      case 'status':
        respond(effective.status)
        break
      case 'delay':
        setTimeout(() => respond(204), effective.delayMs)
        break
      case 'hang':
        setTimeout(() => respond(504), HANG_CEILING_MS)
        break
    }
  })
}

// -----------------------------------------------------------------------------

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  if (url.pathname.startsWith('/_spike/')) {
    handleControl(req, res, url)
    return
  }
  handleDelivery(req, res)
})

// A provider that keeps a connection open must not be cut off by our own idle
// timeout — that would look exactly like the provider giving up, which is the
// thing we are here to measure.
server.headersTimeout = 0
server.requestTimeout = 0
server.keepAliveTimeout = 620_000

server.listen(PORT, () => {
  console.error(`[spike] aloware receiver listening on :${PORT}`)
  console.error(`[spike] evidence -> ${EVIDENCE_FILE}`)
  console.error(`[spike] capture path: everything except /_spike/*`)
})
