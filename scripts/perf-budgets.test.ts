import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

/**
 * Sprint-0 Gate 11's own wiring.
 *
 * The budget check is a real mechanism — it builds, measures the artifact and
 * exits non-zero, and all four of its failure modes were proven by mutation.
 * What no mutation of the checker can catch is the checker not being RUN. Both
 * assertions here guard that one silent regression: unhook `perf` from `verify`
 * and every other gate in the repository stays green while the performance
 * budget quietly goes back to being a sentence in a document, which is the
 * exact state this gate was built to end.
 */

interface PackageJson {
  readonly scripts: Readonly<Record<string, string>>
}

interface Budget {
  readonly id: string
  readonly tier: string
  readonly direction: string
  readonly value: number | null
}

const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as PackageJson
const budgets = (
  JSON.parse(readFileSync('perf-budgets.json', 'utf8')) as { budgets: readonly Budget[] }
).budgets

describe('the performance gate is wired into the build', () => {
  it('runs the budget check as part of verify', () => {
    // `verify` is what the pre-commit hook runs and what CI runs, so this is the
    // one place the check has to appear for it to be a gate at all.
    expect(pkg.scripts['verify']).toContain('npm run perf')
  })

  it('measures a fresh build rather than whatever was lying around', () => {
    // Without the build, the checker would grade a stale artifact — or the
    // artifact from before the change being reviewed, which is worse than not
    // measuring because it reports a number that was once true.
    expect(pkg.scripts['perf']).toContain('npm run build')
    expect(pkg.scripts['perf']).toContain('check-perf-budgets')
  })
})

describe('every budget is a one-way ratchet', () => {
  it('declares monotonic_down on every row', () => {
    // Errata E6, rank 1. A budget that may be loosened by editing a literal is
    // the failure mode the whole ratchet design exists for; the direction is
    // what 05c 10.0.1 will enforce in Postgres once that table lands.
    expect(budgets.length).toBeGreaterThan(0)
    for (const b of budgets) expect(b.direction).toBe('monotonic_down')
  })

  it('carries a measured value for every budget in the enforced tier', () => {
    // The other half of E6: no value row until the gate measures, and a null in
    // an enforced tier fails the build. This asserts the file's own state so a
    // value cannot be quietly removed to make a red build green.
    const enforced = budgets.filter((b) => b.tier === 'pre-merge')
    expect(enforced.length).toBeGreaterThan(0)
    for (const b of enforced) expect(b.value).toBeTypeOf('number')
  })

  it('keeps the unmeasured TTI budget declared rather than deleted', () => {
    // Gate 11 is HALF closed and the file has to keep saying so. Deleting the
    // row would make the gate green and the debt invisible on the same commit.
    const p20 = budgets.find((b) => b.id === 'P20')
    expect(p20).toBeDefined()
    expect(p20?.value).toBeNull()
  })
})
