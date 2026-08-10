import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { cacheControlFor, isEndpoint, type Endpoint } from '~/lib/endpoint/define'

/**
 * The route registry, and the gate that makes the endpoint factory a mechanism
 * rather than a helper nobody has to use.
 *
 * 🔴 `CLAUDE.md` HAS DESCRIBED THIS AS EXISTING SINCE PHASE 6. "Every file goes
 * through the endpoint factory so the generated registry can drive the cache,
 * silo, auth and topology suites" — and `grep defineEndpoint` over the whole
 * tree returned nothing until this branch. A factory that routes MAY use is
 * documentation; what makes it a rule is this file failing when one does not.
 *
 * THE REGISTRY IS DERIVED FROM THE FRAMEWORK'S OWN ROUTE TABLE, never from a
 * directory glob. `05c`:1911 supersedes §995's "scanning routes/api/**" for a
 * reason worth keeping: a route that exists is in `app/routes.ts` by
 * construction, so a registry built from it is exhaustive rather than
 * conventional. A glob misses a route mounted from somewhere unexpected; the
 * manifest cannot.
 */

/** Modules that serve a URL and are deliberately NOT factory endpoints. */
const EXEMPT: ReadonlyMap<string, string> = new Map([
  [
    'routes/api/auth.ts',
    'better-auth mounts its ENTIRE surface under one splat route, so there is no single method, path, audience or idempotency to declare — sign-in, sign-up, session refresh and callback all arrive at the same module. Wrapping it would mean inventing a descriptor that describes none of them accurately. Its scoping is better-auth’s own and its session handling is asserted by auth-identity.test.ts.',
  ],
])

interface Mounted {
  readonly urlPath: string
  readonly modulePath: string
}

/**
 * Reads `app/routes.ts` for every mounted resource route.
 *
 * Static, and that is the fourth time in this project the right answer has been
 * to read the file: it needs no database, no ordering and no running server,
 * and it cannot go green because something else mutated shared state.
 */
function mountedApiRoutes(): readonly Mounted[] {
  const source = readFileSync('app/routes.ts', 'utf8')
  const found: Mounted[] = []

  for (const m of source.matchAll(/route\(\s*'([^']+)'\s*,\s*'(routes\/api\/[^']+)'/g)) {
    const urlPath = m[1]
    const modulePath = m[2]
    if (urlPath !== undefined && modulePath !== undefined) found.push({ urlPath, modulePath })
  }
  return found
}

const MOUNTED = mountedApiRoutes()

describe('every resource route goes through the factory', () => {
  it('is reading a real route table', () => {
    // The mutation guard. A regex that matched nothing would make every
    // assertion below pass over an empty list, forever — which is exactly how
    // this project's own consent test once passed without being able to fail.
    expect(MOUNTED.length).toBeGreaterThan(10)
  })

  it('exports a branded descriptor from every module that is not exempt', async () => {
    const missing: string[] = []

    for (const { modulePath } of MOUNTED) {
      if (EXEMPT.has(modulePath)) continue

      const mod: Record<string, unknown> = (await import(`../../app/${modulePath}`)) as Record<
        string,
        unknown
      >

      // IDENTITY, NOT SHAPE. `isEndpoint` checks a module-private symbol, so an
      // object that carries every field with the right types still fails.
      if (!isEndpoint(mod['endpoint'])) missing.push(modulePath)
    }

    expect(
      missing,
      `${missing.join(', ')} serve a URL and export no branded endpoint descriptor.\n` +
        `Every resource route declares its method, audience, scope, cache policy, ` +
        `idempotency and silo probe through defineEndpoint, or the suites below ` +
        `cannot see it — and a route the suites cannot see is one whose denial ` +
        `shape and cache header nobody is checking.`,
    ).toEqual([])
  })

  it('holds the exemption list at exactly the modules justified today', () => {
    // Pinned, like every other exception list in this tree. The failure mode it
    // closes is somebody greening a red build by appending a name rather than a
    // descriptor.
    expect([...EXEMPT.keys()].sort()).toEqual(['routes/api/auth.ts'])

    for (const [name, reason] of EXEMPT) {
      expect(reason.length, `${name} is exempt with no usable reason`).toBeGreaterThan(80)
    }
  })
})

describe('what the registry lets the suites ask', () => {
  async function registry(): Promise<readonly { mount: Mounted; spec: Endpoint }[]> {
    const out: { mount: Mounted; spec: Endpoint }[] = []
    for (const mount of MOUNTED) {
      if (EXEMPT.has(mount.modulePath)) continue
      const mod: Record<string, unknown> = (await import(
        `../../app/${mount.modulePath}`
      )) as Record<string, unknown>
      const spec = mod['endpoint']
      if (isEndpoint(spec)) out.push({ mount, spec })
    }
    return out
  }

  it('declares a path that matches where the route is actually mounted', async () => {
    // A descriptor whose path has drifted from the route table describes a
    // route that does not exist, and every suite reading it would be checking
    // the wrong URL while passing.
    const drifted: string[] = []
    for (const { mount, spec } of await registry()) {
      const declared = spec.path.replace(/^\//, '')
      if (declared !== mount.urlPath)
        drifted.push(`${mount.modulePath}: ${spec.path} vs /${mount.urlPath}`)
    }
    expect(drifted, drifted.join('\n')).toEqual([])
  })

  it('gives every endpoint exactly one permitted cache-control value', async () => {
    // 🎯 THE DEFECT THIS FILE WAS WRITTEN FOR. `my-book.ts` shipped a seller's
    // entire book with NO cache-control header while `contact.ts` and
    // `search.ts` — the same class of body — both sent one. Nothing noticed
    // because nothing was looking at the routes as a SET.
    const allowed = new Set(['private, no-store', 'private, max-age=0, must-revalidate'])
    for (const { mount, spec } of await registry()) {
      expect(
        allowed.has(cacheControlFor(spec)),
        `${mount.modulePath} resolves to a value that is not one of the two permitted`,
      ).toBe(true)
    }
  })

  it('counts the endpoints that opt out of a silo probe, and makes each say why', async () => {
    // ADR-073 makes silo testability a DECLARED property of every endpoint. The
    // opt-outs are allowed and COUNTED, so the number moving is visible.
    const optedOut = (await registry()).filter(({ spec }) => spec.siloProbe.kind === 'none')

    for (const { mount, spec } of optedOut) {
      if (spec.siloProbe.kind !== 'none') continue
      expect(
        spec.siloProbe.reason.length,
        `${mount.modulePath} opts out of a silo probe without a usable reason`,
      ).toBeGreaterThan(80)
    }

    // Pinned. Six today, and each one is argued in its own module. A seventh is
    // a decision somebody makes on purpose.
    expect(optedOut.map(({ mount }) => mount.modulePath).sort()).toEqual([
      'routes/api/home-setup.ts',
      'routes/api/integration-health.ts',
      'routes/api/leaderboard.ts',
      'routes/api/quick-add.ts',
      'routes/api/sign-out.ts',
      'routes/api/webhooks-aloware.ts',
    ])
  })

  it('makes every non-GET answer the idempotency question', async () => {
    // The sendBeacon-on-tab-close double delivery is real in this product and
    // already cost a double credit once. `none` is permitted and takes a reason.
    for (const { mount, spec } of await registry()) {
      if (spec.method === 'GET') continue
      expect(
        spec.idempotency,
        `${mount.modulePath} is a mutation with no idempotency declaration`,
      ).toBeDefined()
      if (spec.idempotency.kind === 'none') {
        expect(
          spec.idempotency.reason.length,
          `${mount.modulePath} declares no idempotency and gives no reason`,
        ).toBeGreaterThan(40)
      }
    }
  })

  it('records the ONE endpoint whose cache header contradicts ADR-011', async () => {
    // Counted rather than hidden, and counted rather than silently fixed.
    //
    // ADR-011 rules a pollable GET is `private, max-age=0, must-revalidate` and
    // never `no-store`, because `private` already forbids the shared cache and
    // `no-store` forbids storing the response a 304 exists to avoid re-sending.
    // `app/lib/http/conditional.ts:63` ships `no-store` on every conditional
    // GET with its own argument written out.
    //
    // Left alone because the three polling surfaces demonstrably answer 304s
    // today and the polling floor is what Gate 6 measures: changing the header
    // on every polled surface moves a measured number, which is a ruling and
    // not a refactor. This assertion exists so the contradiction has a count.
    const pollable = (await registry()).filter(
      ({ spec }) => spec.method === 'GET' && spec.etag.kind !== 'none',
    )
    expect(pollable.length).toBeGreaterThan(2)

    for (const { spec } of pollable) {
      expect(cacheControlFor(spec)).toBe('private, no-store')
    }
  })
})
