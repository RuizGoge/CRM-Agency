import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { workerEnabled } from '~/jobs/worker'
import { QUEUE_SPECS } from '~/jobs/queues'
import { isEndpoint, type Endpoint } from '~/lib/endpoint/define'
import * as board from '~/routes/api/board'
import * as calls from '~/routes/api/calls'
import * as celebrate from '~/routes/api/celebrate'
import * as contact from '~/routes/api/contact'
import * as homeSetup from '~/routes/api/home-setup'
import * as integrationHealth from '~/routes/api/integration-health'
import * as leaderboard from '~/routes/api/leaderboard'
import * as myBook from '~/routes/api/my-book'
import * as myDay from '~/routes/api/my-day'
import * as quickAdd from '~/routes/api/quick-add'
import * as search from '~/routes/api/search'
import * as signOut from '~/routes/api/sign-out'
import * as timeline from '~/routes/api/timeline'
import * as webhooksAloware from '~/routes/api/webhooks-aloware'

/**
 * GATE 5 — topology fold/split equivalence. §2543.
 *
 * The ladder has carried this as "the fold EXISTS and ran" since Sprint 1: the
 * worker starts inside the web process and produced the same two terminal rows
 * as the separate process. What it has never had is the thing the gate is named
 * for — equivalence asserted as a PROPERTY rather than observed once on a happy
 * path.
 *
 * §2543's failure clause is the reason it matters: "if any behaviour differs
 * between topologies, the split is not configuration and the cheap tier is a
 * trap." The whole cost model of this product rests on the fold being a
 * deployment variable, and a fold that turns out not to be one is discovered
 * the day the fleet outgrows the cheap rung — which is the worst possible day.
 */

const ROLE_KEY = 'PROCESS_ROLES'

/** The four configurations §2543 (a) requires the app to boot in. */
const CONFIGURATIONS = [
  { roles: 'web', worker: false },
  { roles: 'worker', worker: true },
  { roles: 'ingest', worker: false },
  { roles: 'web,worker,ingest', worker: true },
] as const

const ROUTE_MODULES: readonly (readonly [string, Record<string, unknown>])[] = [
  ['routes/api/board.ts', board],
  ['routes/api/calls.ts', calls],
  ['routes/api/celebrate.ts', celebrate],
  ['routes/api/contact.ts', contact],
  ['routes/api/home-setup.ts', homeSetup],
  ['routes/api/integration-health.ts', integrationHealth],
  ['routes/api/leaderboard.ts', leaderboard],
  ['routes/api/my-book.ts', myBook],
  ['routes/api/my-day.ts', myDay],
  ['routes/api/quick-add.ts', quickAdd],
  ['routes/api/search.ts', search],
  ['routes/api/sign-out.ts', signOut],
  ['routes/api/timeline.ts', timeline],
  ['routes/api/webhooks-aloware.ts', webhooksAloware],
]

function endpoints(): readonly (readonly [string, Endpoint])[] {
  const out: (readonly [string, Endpoint])[] = []
  for (const [path, mod] of ROUTE_MODULES) {
    const spec = mod['endpoint']
    if (isEndpoint(spec)) out.push([path, spec])
  }
  return out
}

describe('(a) the app boots in all four ROLES configurations', () => {
  it('reads the worker role out of each of them, and only those', () => {
    // `PROCESS_ROLES` is the ENTIRE fold/split mechanism — one image, one
    // variable, no second build. Asserting all four rather than the two that
    // happen to be used means the split path is exercised before production
    // executes it for the first time, which is §2543's whole point.
    const original = process.env[ROLE_KEY]
    try {
      for (const config of CONFIGURATIONS) {
        process.env[ROLE_KEY] = config.roles
        expect(workerEnabled(), `PROCESS_ROLES=${config.roles}`).toBe(config.worker)
      }
    } finally {
      if (original === undefined) delete process.env[ROLE_KEY]
      else process.env[ROLE_KEY] = original
    }
  })

  it('runs the worker when the variable is absent, rather than silently not', () => {
    // ⚠️ AND THIS DIVERGES FROM ADR-076, WHICH IS RECORDED RATHER THAN FIXED.
    // The ADR rules "there is no default. A missing or empty PROCESS_ROLES →
    // the process exits non-zero at boot." The tree defaults ON instead, with
    // its own argument in `worker.ts`: the failure of a missing config should
    // be a noisier process, never a quieter one.
    //
    // Both readings are defensible and they contradict. Asserted as it BEHAVES
    // so that changing it is a decision somebody makes, not a drift — and named
    // here so the contradiction is countable rather than buried.
    const original = process.env[ROLE_KEY]
    try {
      delete process.env[ROLE_KEY]
      expect(workerEnabled()).toBe(true)
      process.env[ROLE_KEY] = ''
      expect(workerEnabled()).toBe(true)
    } finally {
      if (original === undefined) delete process.env[ROLE_KEY]
      else process.env[ROLE_KEY] = original
    }
  })
})

describe('(b) the union of units across the roles equals the registry', () => {
  it('gives every served unit exactly one home', () => {
    // 🎯 §2543 (b): "a unit belonging to no role, or to two roles that both run
    // it, fails the test."
    //
    // The registry exists now because the endpoint factory made it exist: every
    // resource route DECLARES its role, and `QUEUE_SPECS` declares the worker's.
    // Before that there was nothing to take a union of, which is why this
    // assertion could not be written.
    const byRole = { web: [] as string[], ingest: [] as string[], worker: [] as string[] }

    for (const [path, spec] of endpoints()) {
      if (spec.role === 'both') {
        // `both` is the one value that would let a unit run in two processes at
        // once. Nothing declares it today and the assertion below pins that: a
        // unit served by the web process AND the ingest process is served twice
        // under a split, which is the duplication this clause forbids.
        byRole.web.push(path)
        byRole.ingest.push(path)
      } else if (spec.role === 'ingest') {
        byRole.ingest.push(path)
      } else {
        byRole.web.push(path)
      }
    }

    for (const queue of QUEUE_SPECS) byRole.worker.push(`queue:${queue.name}`)

    const union = [...byRole.web, ...byRole.ingest, ...byRole.worker]
    const registry = [...endpoints().map(([p]) => p), ...QUEUE_SPECS.map((q) => `queue:${q.name}`)]

    // Nothing belongs to no role: the union covers the registry.
    expect([...union].sort()).toEqual([...registry].sort())

    // And nothing belongs to two roles that both run it: the union has no
    // duplicates. A `both` route would break this, which is the point.
    expect(new Set(union).size, `a unit is mounted in two roles: ${union.join(', ')}`).toBe(
      union.length,
    )
  })

  it('puts the ingest edge in the ingest role and nothing else there', () => {
    // The bulkhead is a ROLE decision before it is a code decision: a webhook
    // storm shares an event loop with the seller's board only because the two
    // are in the same process. Which units carry the `ingest` role is therefore
    // what a split actually separates.
    const ingest = endpoints()
      .filter(([, spec]) => spec.role === 'ingest')
      .map(([path]) => path)

    expect(ingest).toEqual(['routes/api/webhooks-aloware.ts'])
  })

  it('is reading a real registry', () => {
    // The mutation guard: two empty lists are equal, and every assertion above
    // would pass over a registry that failed to load.
    expect(endpoints().length).toBeGreaterThan(10)
    expect(QUEUE_SPECS.length).toBeGreaterThan(3)
  })
})

describe('(c) no test is aware of which topology it is running in', () => {
  it('mentions the topology variable nowhere under tests/e2e', () => {
    // 🎯 §2543 (c)'s LAST CLAUSE, and it is the half that makes the other half
    // mean anything: "with no test aware of which is running."
    //
    // A suite that can see its topology is a suite that can accommodate one —
    // a skip here, a longer timeout there — and then both runs pass while the
    // behaviour differs, which is precisely the outcome the gate exists to
    // refuse. Asserted statically, over the tree, so it cannot pass because
    // something happened to be unset when it ran.
    const offenders: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) walk(path)
        else if (entry.name.endsWith('.ts')) {
          const source = readFileSync(path, 'utf8')
          if (/E2E_TOPOLOGY|PROCESS_ROLES/.test(source)) offenders.push(path.replace(/\\/g, '/'))
        }
      }
    }
    walk('tests/e2e')

    expect(
      offenders,
      `${offenders.join(', ')} can see which topology is running. The only thing ` +
        `that may differ between the two runs is the SERVER's role set.`,
    ).toEqual([])
  })

  it('is reading a real suite', () => {
    // The mutation guard: an empty directory satisfies the assertion above.
    const specs = readdirSync('tests/e2e').filter((f) => f.endsWith('.spec.ts'))
    expect(specs.length).toBeGreaterThan(10)
  })

  it('switches topology on the server and nowhere else', () => {
    // The positive control for the same property, from the other side: the
    // variable must exist SOMEWHERE, or the two runs are the same run twice and
    // the comparison proves nothing.
    const config = readFileSync('playwright.config.ts', 'utf8')
    expect(config).toContain('E2E_TOPOLOGY')
    expect(config).toContain("PROCESS_ROLES: 'web,ingest'")
  })
})

describe('(e) the struck ingress URL forms exist nowhere', () => {
  it('contains no /hooks/ or /intake/ literal', () => {
    // Ruling P8.2 strikes both by name — "there is no `path_secret`, no
    // `/hooks/`, and no unversioned form" — while §4.2's own sequence diagram,
    // §7's flow and two other diagrams still draw the struck one. This is the
    // grep gate that keeps the diagrams from being copied back in.
    //
    // It matters more than a naming preference: the URL is configured inside
    // Aloware's panel and we cannot redeploy them. Whatever shape ships on the
    // day it is configured is the shape it keeps forever.
    // 🔴 COMMENTS ARE STRIPPED FIRST, and the first version of this gate was
    // RED because of them. `app/routes.ts` and `webhooks-aloware.ts` both quote
    // the struck form in order to say it is struck — "`/hooks/…` and
    // `{path_secret}` appear in §4.2 … and are struck by name" — so the gate
    // was failing on the documentation that explains the rule.
    //
    // That is the mirror image of a trap this project already paid: the
    // definer-tenancy gate once PASSED because a comment mentioned the call it
    // was looking for. Same cause, opposite sign, same fix — and the fix must
    // not be "stop writing the explanation", which is how a rule loses the only
    // record of why it exists.
    const stripComments = (source: string): string =>
      source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')

    // ⚠️ THE SEGMENT MAY START THE STRING. `app/routes.ts` mounts paths WITHOUT
    // a leading slash — `route('webhooks/aloware/v1/:endpointToken', …)` — so a
    // pattern anchored on `/hooks/` misses `'hooks/aloware/…'` entirely. The
    // mutation proved it: reintroducing the struck form was caught only by the
    // positive control below, while the grep gate that exists to catch it
    // stayed green. A gate that needs another assertion to cover for it is not
    // the gate it claims to be.
    //
    // THE OPENING QUOTE IS ITSELF THE BOUNDARY, which took two attempts to get
    // right: an alternation of `^` or a slash cannot match at the position
    // right after the quote, so `'hooks/aloware/…'` still slipped through and
    // the mutation was caught only by the positive control a second time.
    //
    // Read as: a quote, then OPTIONALLY anything ending in a slash, then the
    // struck segment. `webhooks/` does not match, because the optional group
    // has to end in `/` and `web` does not.
    const NAMES_STRUCK_FORM = /['"`](?:[^'"`\n]*\/)?(hooks|intake)\//

    const offenders: string[] = []
    const files = [
      ...ROUTE_MODULES.map(([path]) => `app/${path}`),
      'app/routes.ts',
      'app/db/client.ts',
    ]

    for (const file of files) {
      if (NAMES_STRUCK_FORM.test(stripComments(readFileSync(file, 'utf8')))) offenders.push(file)
    }

    expect(offenders, `${offenders.join(', ')} still name a struck URL form`).toEqual([])
  })

  it('mounts the versioned form, and the descriptor agrees with the route table', () => {
    // The positive control. Without it the assertion above is satisfied by a
    // tree with no ingress route at all.
    const routes = readFileSync('app/routes.ts', 'utf8')
    expect(routes).toContain('webhooks/aloware/v1/:endpointToken')

    const spec = endpoints().find(([path]) => path === 'routes/api/webhooks-aloware.ts')?.[1]
    expect(spec?.path).toBe('/webhooks/aloware/v1/:endpointToken')
  })
})
