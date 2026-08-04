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
  /** §8.1's cap on what a measurement may fix the budget at. P20 is the row that has one. */
  readonly ceiling?: number
  /** The date the number came from. Optional because P6's numbers are ruled, not measured. */
  readonly measured?: string
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

  it('keeps the TTI budget measured, bounded and inside its ceiling', () => {
    // 🔴 THIS TEST USED TO ASSERT `expect(p20?.value).toBeNull()`, and its name
    // was "keeps the unmeasured TTI budget declared rather than deleted". That
    // was the right assertion while Gate 11 was half closed: deleting the row
    // would have made the gate green and the debt invisible on one commit.
    //
    // Measuring it is the other direction, and it had to be a deliberate edit
    // for the same reason. §8.1 caps what a measurement may fix the budget at:
    // past 3000 ms the answer is a faster board, not a bigger number, so the
    // ceiling is asserted here rather than left as prose in the row.
    const p20 = budgets.find((b) => b.id === 'P20')
    expect(p20).toBeDefined()
    expect(p20?.value).toBeTypeOf('number')
    expect(p20?.value ?? Infinity).toBeLessThanOrEqual(p20?.ceiling ?? 0)
    expect(p20?.measured, 'a measured budget records WHEN, or it is a number nobody can date').toBe(
      '2026-08-03',
    )
  })

  it('gives every budget a tier some command actually runs', () => {
    // The check that would have caught P20 sitting in an imaginary "nightly"
    // tier for a month. `check-perf-budgets.ts` refuses with PERF007 at build
    // time; this says the same thing where it is cheap to read, and the two
    // lists have to agree.
    const runnable = new Set(['pre-merge', 'e2e', 'e2e-lighthouse', 'integration'])
    for (const b of budgets) {
      expect(runnable.has(b.tier), `${b.id} names tier "${b.tier}", which nothing runs`).toBe(true)
    }
  })
})
