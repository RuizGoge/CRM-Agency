/**
 * Conditional GET for the poll surfaces.
 *
 * `CLAUDE.md` puts everything except two SSE channels on conditional-GET
 * polling, and `05-architecture.md` §1183 builds the cost model on it: at an
 * assumed 2 ms per `304`, *"17 req/s × 2 ms = 34 ms of CPU per wall second ≈
 * 7 % of a 0.5-CPU Starter instance. That is the number that makes a 5-second
 * poll compatible with USD 7/month of compute."* The same paragraph says it is
 * an assumption until the storm gate measures it.
 *
 * ONE IMPLEMENTATION, not three. Until now `api/leaderboard.ts` carried this
 * inline and `api/board.ts` and `api/my-day.ts` carried nothing at all — so two
 * of the three polled surfaces answered a full `200` with a database round trip
 * and a full serialization, every time, forever. Three copies of a cache header
 * is also how two of them end up with different semantics and nobody notices,
 * because the symptom of a wrong `304` is a screen that stops updating rather
 * than a screen that breaks.
 *
 * ⚠️ WHAT THIS DOES AND DOES NOT BUY, stated because §1183's model assumes the
 * other one. The tag is derived from the RENDERED BODY, so a `304` saves the
 * TRANSFER and not the work: the query still runs and the payload is still
 * built. The cheap form §1183 describes — *"two index probes, no handler, no
 * serialization"* — needs a write watermark, and a watermark alone would be
 * WRONG here: every one of these payloads is time-dependent (the leaderboard
 * excludes entries younger than the undo window; the board renders
 * `days_untouched` and `overdue_minutes`), so a purely write-derived tag would
 * answer `304` while the visible number moved. A correct cheap form needs a
 * watermark AND a time bucket at the granularity the payload actually renders,
 * and it should be built against a measurement rather than ahead of one. That
 * measurement is the floor leg of G6.
 */

/**
 * A weak entity tag for a JSON body.
 *
 * TWO ACCUMULATORS AND THE LENGTH, not the single 32-bit rolling hash this
 * replaces. A collision on a poll surface is not a wrong render — it is a
 * screen that stops updating and stays stopped until something else in the
 * payload happens to change, which is indistinguishable from a slow day. 32
 * bits over a 500-card board is a thinner margin than that failure deserves,
 * and a second accumulator costs one more multiply per character.
 *
 * Deliberately not a real digest: `node:crypto` in a module under `app/lib/**`
 * is a module a component may import, and this project has twice shipped a
 * server dependency into the browser bundle exactly that way.
 */
export function weakEtag(body: string): string {
  let a = 0
  let b = 0
  for (let i = 0; i < body.length; i += 1) {
    const c = body.charCodeAt(i)
    a = (a * 31 + c) | 0
    // A different multiplier and a different mixing step, so the two
    // accumulators do not agree about what a collision is.
    b = (b * 131 + (c ^ (a & 0xff))) | 0
  }
  return `W/"${(a >>> 0).toString(36)}-${(b >>> 0).toString(36)}-${body.length.toString(36)}"`
}

/**
 * Serialises `payload` and answers `304` when the client already has it.
 *
 * `private, no-store` on every one of these, without exception: these bodies
 * are per-seller by construction, and a shared cache serving one seller's book
 * to another is the silo failing outside the database, where none of the
 * policies can see it.
 */
export function jsonConditional(request: Request, payload: unknown, tagSource?: unknown): Response {
  const body = JSON.stringify(payload)

  // `tagSource` EXISTS BECAUSE OF THE BOARD, and without it that surface could
  // never answer a single 304. Its payload carries the NEW clock's starting
  // second, so the body differs every second whether or not anything happened —
  // a tag over the body would be a fresh tag on every poll, forever, and the
  // conditional GET would be pure overhead.
  //
  // Passing a projection is safe here and nowhere obvious: the clock now ticks
  // in the browser, so a client that gets a 304 keeps counting from the value it
  // already has, which is exactly right. A caller that strips a field the client
  // CANNOT re-derive would be building the stale-304 defect on purpose, which is
  // why this is an explicit argument rather than a filter applied for everyone.
  const etag = weakEtag(tagSource === undefined ? body : JSON.stringify(tagSource))

  if (request.headers.get('if-none-match') === etag) {
    // No body, and the tag repeated: a 304 without it makes the next request
    // unconditional, which turns a cache into a slower uncached path.
    return new Response(null, {
      status: 304,
      headers: { etag, 'cache-control': 'private, no-store' },
    })
  }

  return new Response(body, {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      etag,
      'cache-control': 'private, no-store',
    },
  })
}
