import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * A COMPONENT MAY NOT IMPORT A ROUTE MODULE AT RUNTIME.
 *
 * 🔴 Written because it happened, and because the symptom pointed nowhere near
 * the cause. Building the speed-to-lead clock, a shared `mmss` helper was
 * exported from `app/routes/api/board.ts` — next to the derivation that
 * produces the string, which reads well and is wrong. That route imports
 * `~/db` and `~/lib/auth/identity`, so one function pulled **postgres, drizzle
 * and better-auth into the client bundle.**
 *
 * What a person saw: the 500-card board rendered every card and then simply
 * never armed drag. No error, no blank screen, nothing in the console — the
 * page had shipped a database driver to the browser and was still parsing it.
 * P6 caught it as a locator that never resolved, which is a long way from
 * "the wrong module is in the bundle".
 *
 * TYPE IMPORTS ARE FINE and are the common case: `import type { BoardCard }`
 * is erased at build, so a component may name a route's types freely. This
 * asserts the runtime edge only.
 *
 * The rule that follows: a helper shared between a server route and a client
 * component belongs in NEITHER. It goes in `app/lib/**`, which has no server
 * imports.
 */

const COMPONENT_ROOTS = ['app/components', 'app/styles']

function filesUnder(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) filesUnder(full, acc)
    else if (/\.(ts|tsx)$/.test(entry)) acc.push(full)
  }
  return acc
}

/**
 * Every `import` that is NOT type-only, with its specifier.
 *
 * Deliberately a parse of the source rather than a walk of the built bundle:
 * the bundle answers "did this ship", and by then the question is already a
 * performance mystery. This answers "can this ship", in the file somebody is
 * editing.
 */
function runtimeImports(source: string): string[] {
  const specifiers: string[] = []
  const pattern = /(^|\n)\s*import\s+([\s\S]*?)from\s+['"]([^'"]+)['"]/g

  for (const match of source.matchAll(pattern)) {
    const clause = match[2] ?? ''
    const specifier = match[3] ?? ''
    // `import type { X } from` — erased. `import { type X, y } from` is not:
    // it still emits a runtime import for `y`.
    if (/^\s*type\s/.test(clause)) continue
    specifiers.push(specifier)
  }

  return specifiers
}

describe('the client half of the tree cannot reach the server half', () => {
  it('finds components to check, so an empty pass is impossible', () => {
    // The cheapest way to make a grep gate green is to point it at nothing.
    const files = COMPONENT_ROOTS.flatMap((root) => filesUnder(root))
    expect(files.length, 'no component files found — the roots moved').toBeGreaterThan(5)
  })

  it('lets a component import a route TYPE, which is erased', () => {
    // Stated as a test so nobody tightens this into a ban on the specifier and
    // breaks every card component in the tree.
    const erased = runtimeImports("import type { BoardCard } from '~/routes/api/board'\n")
    expect(erased).toEqual([])
  })

  it('refuses a runtime import of a route module from any component', () => {
    const offenders: string[] = []

    for (const file of COMPONENT_ROOTS.flatMap((root) => filesUnder(root))) {
      for (const specifier of runtimeImports(readFileSync(file, 'utf8'))) {
        if (specifier.startsWith('~/routes/')) offenders.push(`${file} -> ${specifier}`)
      }
    }

    expect(
      offenders,
      `a component imports a route module at runtime, which ships the server's ` +
        `dependencies to the browser:\n  ${offenders.join('\n  ')}\n` +
        `Move the shared value into app/lib/**, which has no server imports.`,
    ).toEqual([])
  })

  it('refuses a component importing the data layer or auth directly', () => {
    // The same failure by a shorter route. `~/db` opens a postgres pool at
    // module load; a component that names it has put a connection pool in a
    // browser bundle without going through a route at all.
    const banned = ['~/db', '~/lib/auth/server', '~/lib/auth/identity']
    const offenders: string[] = []

    for (const file of COMPONENT_ROOTS.flatMap((root) => filesUnder(root))) {
      for (const specifier of runtimeImports(readFileSync(file, 'utf8'))) {
        if (banned.some((b) => specifier === b || specifier.startsWith(`${b}/`))) {
          offenders.push(`${file} -> ${specifier}`)
        }
      }
    }

    expect(offenders, `${offenders.join(', ')} reaches the server from a component`).toEqual([])
  })
})
