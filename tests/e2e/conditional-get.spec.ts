import { expect, test, type Page } from '@playwright/test'

import { signIn } from './fixtures/seller'

/**
 * The polling floor: every polled surface answers a conditional GET.
 *
 * `CLAUDE.md` puts everything outside two SSE channels on conditional-GET
 * polling, and `05-architecture.md` §1183 builds the cost model on it — at an
 * assumed 2 ms per `304`, *"17 req/s × 2 ms = 34 ms of CPU per wall second ≈
 * 7 % of a 0.5-CPU Starter instance. That is the number that makes a 5-second
 * poll compatible with USD 7/month of compute."*
 *
 * 🔴 UNTIL THIS SPEC, ONE OF THE THREE SURFACES HAD ANY OF IT. `api/board` and
 * `api/my-day` answered a full `200` with a database round trip and a full
 * serialization on every request, and nothing anywhere asserted otherwise —
 * there was not one `etag`, `304` or `if-none-match` in `tests/`.
 *
 * ⚠️ WHAT THIS SPEC DOES NOT CLAIM, because measuring it is the whole point of
 * G6's floor leg. A `304` here saves the TRANSFER, not the work: the tag is
 * derived from the rendered payload, so the query still runs. §1183's 2 ms
 * assumes *"two index probes, no handler, no serialization"*, which is a
 * different implementation and should be built against a measurement rather
 * than ahead of one.
 */

const SURFACES = [
  { path: '/api/board', label: 'the pipeline board' },
  { path: '/api/my-day', label: 'My Day' },
  { path: '/api/leaderboard', label: 'the public board' },
] as const

interface Probe {
  status: number
  etag: string | null
  cacheControl: string | null
  bodyLength: number
}

async function get(page: Page, path: string, ifNoneMatch?: string): Promise<Probe> {
  return page.evaluate(
    async ({ p, tag }) => {
      const res = await fetch(p, tag === null ? undefined : { headers: { 'if-none-match': tag } })
      const text = await res.text()
      return {
        status: res.status,
        etag: res.headers.get('etag'),
        cacheControl: res.headers.get('cache-control'),
        bodyLength: text.length,
      }
    },
    { p: path, tag: ifNoneMatch ?? null },
  )
}

test.describe('every polled surface answers a conditional GET', () => {
  for (const surface of SURFACES) {
    test(`${surface.label} answers 200 then 304`, async ({ page }, testInfo) => {
      test.skip(testInfo.project.name !== 'desktop-ci', 'HTTP semantics, one profile')

      await signIn(page)

      const first = await get(page, surface.path)
      expect(first.status).toBe(200)
      expect(first.etag, `${surface.path} served no etag, so no poll can be conditional`).toMatch(
        /^W\/".+"$/,
      )
      expect(first.bodyLength).toBeGreaterThan(0)

      const second = await get(page, surface.path, first.etag ?? '')
      expect(second.status, `${surface.path} re-sent an unchanged payload`).toBe(304)

      // EMPTY, or the 304 saved nothing at all — which is the failure mode that
      // looks like a working cache in every header dump.
      expect(second.bodyLength).toBe(0)

      // AND IT REPEATS THE TAG. Without it the client has nothing to send next
      // time, so every second poll goes unconditional and the surface answers
      // 200-304-200-304 forever — a cache that works exactly half the time and
      // reports as working.
      expect(second.etag, 'the 304 dropped the tag, so the next poll cannot be conditional').toBe(
        first.etag,
      )
    })

    test(`${surface.label} re-sends on a stale tag`, async ({ page }, testInfo) => {
      test.skip(testInfo.project.name !== 'desktop-ci', 'HTTP semantics, one profile')

      // The other side of the arm. A route that answered 304 to anything would
      // pass the test above and freeze every seller's screen — and it would
      // look identical from the outside until somebody noticed their board had
      // not moved all morning.
      await signIn(page)

      const stale = await get(page, surface.path, 'W/"not-a-real-tag"')
      expect(stale.status, `${surface.path} answered 304 to a tag it never issued`).toBe(200)
      expect(stale.bodyLength).toBeGreaterThan(0)
    })

    test(`${surface.label} is never stored by a shared cache`, async ({ page }, testInfo) => {
      test.skip(testInfo.project.name !== 'desktop-ci', 'HTTP semantics, one profile')

      // Every one of these bodies is per-seller by construction. A shared cache
      // serving one seller's book to another is the silo failing OUTSIDE the
      // database, where not one of the policies can see it.
      await signIn(page)

      const first = await get(page, surface.path)
      expect(first.cacheControl).toBe('private, no-store')

      const second = await get(page, surface.path, first.etag ?? '')
      expect(second.cacheControl, 'the 304 dropped the privacy directive').toBe('private, no-store')
    })
  }

  test('the three surfaces do not share a tag', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-ci', 'one implementation, one profile')

    // They now share ONE implementation, and this is the failure that would
    // buy: a tag that did not depend on the payload would make My Day answer
    // 304 to the board's tag, and a seller would be served the wrong screen's
    // silence.
    await signIn(page)

    const tags = await Promise.all(SURFACES.map(async (s) => (await get(page, s.path)).etag))
    expect(new Set(tags).size, `three surfaces, tags ${JSON.stringify(tags)}`).toBe(SURFACES.length)
  })

  test('the board answers 304 across a second boundary, despite the NEW clock', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-ci', 'one clock, one profile')

    // 🔴 THE ASSERTION THE BOARD NEEDED ITS OWN TAG SOURCE FOR. Its payload
    // carries the NEW clock's starting second, so a tag over the body changes
    // every second whether or not a card did — and the board polls every
    // fifteen. Without the projection this surface would answer 200 to every
    // poll for ever, and the conditional GET would be strictly more work than
    // no conditional GET at all.
    //
    // Waiting past a second boundary is the whole test: a fetch pair taken
    // inside one second would pass with the defect present.
    await signIn(page)

    const first = await get(page, '/api/board')
    expect(first.status).toBe(200)

    await page.waitForTimeout(2_200)

    const later = await get(page, '/api/board', first.etag ?? '')
    expect(later.status, 'the running clock is still in the board’s etag').toBe(304)
  })
})
