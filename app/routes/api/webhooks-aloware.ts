import { ingestWebhook } from '~/db'
import { extractKeys } from '~/modules/communications/aloware-ingest'
import { defineEndpoint } from '~/lib/endpoint/define'

/**
 * `POST /webhooks/aloware/v1/{endpoint_token}` — the ingest edge (ARR-INT-04).
 *
 * Write first, respond fast, process async. This handler does four things and
 * refuses to do a fifth: read the bytes, extract keys without ever throwing,
 * make ONE database call, answer. No domain work happens here — the merge is a
 * job, and §4.2 ruling 5 is that the response never waits on it.
 *
 * ⚠️ THE URL IS `/webhooks/aloware/v1/…`, NOT `/hooks/aloware/…`. Ruling **P8.2**
 * strikes the shorter form by name — *"there is no `path_secret`, no `/hooks/`,
 * and no unversioned form"* — while §4.2's own sequence diagram, §7's flow and
 * two other diagrams still draw the struck one. P8.2 is a Part I ruling and
 * outranks all of them. The version segment exists because we cannot redeploy
 * Aloware: whatever shape this is on the day it is configured is the shape it
 * keeps.
 *
 * 🔴 IT NEVER ANSWERS NON-2xx FOR A PAYLOAD WE HOLD, and Gate G2 turned that
 * from a courtesy into the whole design. The measurements:
 *
 *   - **Aloware never retries.** Six deliveries were answered `500` during the
 *     spike and not one came back — three hours, zero. Delivery is "at most
 *     once, no recovery", so anything this edge declines to keep is gone.
 *   - **It tolerates at least 110 s of silence.** Being slow is nearly free.
 *     Failing fast is the worst thing available: a `500` in 2 ms is permanent
 *     loss, delivered promptly.
 *
 * So the only non-2xx here is `401` for a token nobody issued, which is the one
 * case where nothing was stored and there is nothing to lose.
 */

/**
 * §4.2's hard cap. Enforced twice on purpose: the header is a claim and the
 * byte count is a fact, and a body arriving without `content-length` (chunked)
 * would slip a header-only check entirely.
 *
 * A body over the cap is REFUSED rather than truncated. Truncating changes the
 * bytes, and the bytes are the digest, and the digest is the only replay
 * defence there is — a truncated payload would be stored under a key that
 * describes something the provider never sent.
 */
const MAX_BODY_BYTES = 256 * 1024

export async function action({
  request,
  params,
}: {
  request: Request
  params: { endpointToken?: string }
}): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response(null, { status: 405, headers: { allow: 'POST' } })
  }

  const token = params.endpointToken
  if (token === undefined || token.length === 0) {
    return unauthorized()
  }

  const declared = request.headers.get('content-length')
  if (declared !== null && declared.length > 0) {
    // `Number.parseInt` rather than `Number(` — the money guard bans the latter
    // outside `app/lib/money/**`, and a header is exactly the kind of untrusted
    // string it exists to keep away from arithmetic.
    const claimed = Number.parseInt(declared, 10)
    if (Number.isFinite(claimed) && claimed > MAX_BODY_BYTES) {
      return tooLarge()
    }
  }

  const raw = Buffer.from(await request.arrayBuffer())
  if (raw.byteLength > MAX_BODY_BYTES) {
    return tooLarge()
  }

  // A zero-byte delivery has nothing in it to replay and the vault's own
  // `raw_payload_vault_body_present` CHECK would refuse it, so it is answered
  // rather than stored. It is still a 2xx: there is no payload here to lose.
  if (raw.byteLength === 0) {
    return accepted()
  }

  // 🔴 THE DECODE IS FOR THE EXTRACTOR ONLY, and this is the line that keeps it
  // harmless. `toString('utf8')` is lossy on invalid bytes — it substitutes
  // U+FFFD — but the VAULT receives `raw`, and `provider_event_id` is
  // `sha256(raw)` computed inside the database. So a body that does not decode
  // cleanly still gets stored byte-exact and keyed correctly; all the decode can
  // cost is a `parse_status` of `unparsed`, which is a visible row rather than a
  // lost delivery.
  const keys = extractKeys(raw.toString('utf8'))

  // 🔴 NO SIGNATURE, MEASURED RATHER THAN ASSUMED. G2 established that Aloware
  // sends no HMAC, no timestamp and no nonce — its webhook form offers
  // `None · Basic · Bearer` and nothing else. §4.2 ruling 3 made this column
  // nullable precisely so we would not have to record a lie, and `null` is the
  // honest value: not "valid", not "invalid", but "this provider gives us
  // nothing to verify". The permanent line that says so belongs on
  // `/admin/integration-health`, not in a comment here.
  const outcome = await ingestWebhook({
    endpointToken: token,
    body: raw,
    providerEvent: keys.providerEvent,
    canonical: keys.canonical,
    alowareCallId: keys.alowareCallId,
    parseStatus: keys.parseStatus,
    signatureValid: null,
  })

  if (outcome === 'unknown_token') {
    return unauthorized()
  }

  // `accepted`, `duplicate` and `quarantined` are all 204. The provider can act
  // on none of the three, and telling a replay apart from a first delivery in
  // the status code would invite exactly the retry we do not want and cannot
  // receive.
  return accepted()
}

/** 204 with no body. Nothing here is cacheable and nothing here is readable. */
const accepted = (): Response =>
  new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } })

/**
 * The only non-2xx that means "we kept nothing" (§4.2 ruling 4).
 *
 * No `WWW-Authenticate` and no body: the credential is a path segment, so there
 * is no scheme to name, and a description of what was wrong with the token is a
 * hint for whoever is guessing them.
 */
const unauthorized = (): Response =>
  new Response(null, { status: 401, headers: { 'cache-control': 'no-store' } })

/** Over the cap. The one refusal that is about the payload rather than the caller. */
const tooLarge = (): Response =>
  new Response(null, { status: 413, headers: { 'cache-control': 'no-store' } })

/**
 * The ingest edge. Not under api/, and versioned, because ruling P8.2 fixes
 * both: this URL lives in Aloware's panel and we cannot redeploy them.
 */
export const endpoint = defineEndpoint({
  method: 'POST',
  path: '/webhooks/aloware/v1/:endpointToken',
  // Reachable in the ingest role, never in the worker: a bulkhead that shares
  // a process with the relay is not one.
  role: 'ingest',
  audience: 'public-ingress',
  scope: 'provider',
  surface: 'ingress',
  summary: 'Stores one provider delivery and enqueues its merge, in one round trip.',
  // G2 measured that Aloware does NOT retry, so the edge admits and stores
  // rather than rejecting - and the dedupe is on the provider's own id.
  idempotency: {
    kind: 'natural',
    constraint: 'inbound_webhook_event dedupe on (tenant, provider_event_id)',
  },
  siloProbe: {
    kind: 'none',
    reason:
      'Arrives with no session and no tenant: app.webhook_ingest DERIVES the tenant from the endpoint token, so there is no caller identity to present a foreign id with. An unknown token is the only 401 in the product.',
  },
})
