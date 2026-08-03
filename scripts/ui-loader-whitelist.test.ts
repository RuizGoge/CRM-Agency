import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * A fourth UI loader cannot appear without somebody deciding to add it.
 *
 * `05-architecture.md` §1.2 asks for a versioned whitelist file and says adding
 * an entry is "a PR that touches that file and nothing else". The file did not
 * exist, so the count drifted from the sanctioned one to three with nothing able
 * to notice — and `CONTEXT.md` recorded the drift as two, because My Day's
 * loader had never been counted at all.
 *
 * This does not pretend the three are fine. It makes them enumerated, each with
 * a written reason, and it makes a fourth a red build.
 */

const UI_DIR = 'app/routes/ui'
const LOADER = /export\s+(?:async\s+function\s+loader|const\s+loader)\b/

interface Route {
  readonly file: string
  readonly kind: 'data' | 'navigation'
  readonly status: string
  readonly reason: string
  readonly decision?: string
}

const registry = JSON.parse(readFileSync('contracts/ui-loader-whitelist.json', 'utf8')) as {
  sanctioned: number
  routes: readonly Route[]
}

/** Every UI route file that actually exports a loader, read from the tree. */
const actual = readdirSync(UI_DIR)
  .filter((f) => f.endsWith('.tsx'))
  .map((f) => join(UI_DIR, f).replaceAll('\\', '/'))
  .filter((path) => LOADER.test(readFileSync(path, 'utf8')))

describe('every UI-route loader is accounted for', () => {
  it('has a registry entry for each loader that exists in the tree', () => {
    // THE ASSERTION THIS FILE EXISTS FOR. A new UI route with a loader turns the
    // build red until someone writes down why it is there — which is exactly the
    // "PR that touches that file and nothing else" the ruling describes.
    const registered = new Set(registry.routes.map((r) => r.file))
    for (const path of actual) {
      expect(
        registered.has(path),
        `${path} exports a loader and is not in contracts/ui-loader-whitelist.json`,
      ).toBe(true)
    }
  })

  it('has no registry entry for a loader that no longer exists', () => {
    // The other direction, so removing a loader is a visible edit too. A stale
    // entry would let the count read lower than it is.
    for (const route of registry.routes) {
      expect(actual, `${route.file} is registered but exports no loader`).toContain(route.file)
    }
  })

  it('gives every entry a real reason', () => {
    for (const route of registry.routes) {
      expect(route.reason.length, `${route.file} has no usable reason`).toBeGreaterThan(60)
      expect(['data', 'navigation']).toContain(route.kind)
    }
  })
})

describe('the count of DATA loaders is visible and does not drift', () => {
  it('sanctions exactly one, per §1.2', () => {
    expect(registry.sanctioned).toBe(1)
    const whitelisted = registry.routes.filter((r) => r.status === 'whitelisted')
    expect(whitelisted).toHaveLength(1)
    expect(whitelisted[0]?.file).toBe('app/routes/ui/board.tsx')
  })

  it('holds the over-budget loaders at exactly the two that exist today', () => {
    // Not a threshold that passes — a number that has to move deliberately, in
    // one direction. A third over-budget loader fails here; removing one fails
    // here too, which is correct: both are decisions, and both should be made
    // by editing this line rather than by drifting past it.
    const over = registry.routes.filter((r) => r.status === 'over-budget')
    expect(over.map((r) => r.file).sort(), 'the set of over-budget UI loaders changed').toEqual([
      'app/routes/ui/leaderboard.tsx',
      'app/routes/ui/my-day.tsx',
    ])

    // Each one owes an open decision in words. §1.1's four reasons are the
    // argument against them; the reason field has to answer it.
    for (const route of over) {
      expect(route.decision, `${route.file} is over budget with no decision recorded`).toBeTruthy()
      expect((route.decision ?? '').length).toBeGreaterThan(40)
    }
  })

  it('never counts a navigation loader as data', () => {
    // The escape hatch that would make this meaningless: relabel a data loader
    // as navigation and the count drops without anything changing on screen.
    // A navigation loader may only redirect, so it must not reach a module that
    // reads application data.
    for (const route of registry.routes.filter((r) => r.kind === 'navigation')) {
      const source = readFileSync(route.file, 'utf8')
      const loaderBody = source.slice(source.search(LOADER))
      expect(
        /\bredirect\s*\(/.test(loaderBody),
        `${route.file} is labelled navigation but never redirects`,
      ).toBe(true)
      expect(
        /\bread[A-Z]\w*\s*\(/.test(loaderBody.slice(0, 900)),
        `${route.file} is labelled navigation but calls a read`,
      ).toBe(false)
    }
  })
})
