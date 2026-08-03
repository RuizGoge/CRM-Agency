import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * The Protected List cannot claim coverage it does not have.
 *
 * `04-ux-flows.md` §8 rule 1: no MVP item may be marked done while its protected
 * assertion is skipped. The failure it names is specific — the feature ships,
 * the test is disabled "temporarily", and the detail is gone by the time anyone
 * runs a demo. A registry of ten items is only worth something if claiming
 * coverage that does not exist FAILS, so that is what this asserts.
 *
 * It deliberately does NOT check that the ten items are done. Six of them are
 * not, and pretending otherwise is the thing being prevented. It checks that
 * every item says which of the three states it is in, and that each state is
 * backed by something real: a test id that exists, or a named blocker, or a
 * written list of what is missing.
 */

interface Item {
  readonly id: string
  readonly title: string
  readonly status: 'covered' | 'blocked' | 'partial'
  readonly test?: string | null
  readonly blocker?: string
  readonly missing?: readonly string[]
}

const registry = JSON.parse(readFileSync('contracts/protected-list.json', 'utf8')) as {
  items: readonly Item[]
}

/** Every e2e spec, concatenated. Test ids are asserted to appear in a title. */
const E2E_DIR = 'tests/e2e'
const specText = readdirSync(E2E_DIR)
  .filter((f) => f.endsWith('.spec.ts'))
  .map((f) => readFileSync(join(E2E_DIR, f), 'utf8'))
  .join('\n')

describe('the Protected List is complete and honest', () => {
  it('carries exactly the ten items, numbered without gaps', () => {
    // Ten is the number the document commits to. An eleventh would be scope
    // added to a list whose whole purpose is that nothing may be traded into it;
    // a ninth would be one quietly dropped.
    expect(registry.items).toHaveLength(10)
    expect(registry.items.map((i) => i.id)).toEqual([
      'DEMO-01',
      'DEMO-02',
      'DEMO-03',
      'DEMO-04',
      'DEMO-05',
      'DEMO-06',
      'DEMO-07',
      'DEMO-08',
      'DEMO-09',
      'DEMO-10',
    ])
  })

  it('gives every item a title and a known status', () => {
    for (const item of registry.items) {
      expect(item.title.length, `${item.id} has no title`).toBeGreaterThan(20)
      expect(['covered', 'blocked', 'partial']).toContain(item.status)
    }
  })
})

describe('a claim of coverage has to be real', () => {
  it('resolves every covered item to a test that actually exists', () => {
    // THE ASSERTION THIS FILE EXISTS FOR. Marking an item `covered` with a test
    // id nobody wrote — or renaming the test later — turns the build red instead
    // of quietly un-protecting the item.
    const covered = registry.items.filter((i) => i.status === 'covered')
    expect(covered.length, 'no item claims coverage, which cannot be right').toBeGreaterThan(0)

    for (const item of covered) {
      expect(item.test, `${item.id} is covered but names no test`).toBeTruthy()
      expect(
        specText.includes(`${item.test}`),
        `${item.id} claims coverage by "${item.test}", which appears in no e2e spec title`,
      ).toBe(true)
    }
  })

  it('resolves each covered id to exactly one test', () => {
    // §8's own wording: a CI test fails if any entry resolves to zero OR MORE
    // THAN ONE test. Two tests for one id means neither is the assertion.
    for (const item of registry.items.filter((i) => i.status === 'covered')) {
      const occurrences = specText.split(`${item.test}:`).length - 1
      expect(occurrences, `${item.id} resolves to ${occurrences} tests, not one`).toBe(1)
    }
  })

  it('never counts a skipped test as coverage', () => {
    // The exact erosion §8 rule 1 describes. `test.skip` at the top level of a
    // protected assertion would leave the registry green and the demo detail
    // unguarded. The per-profile `test.skip(...)` guards inside these specs take
    // an argument, so they do not match.
    for (const item of registry.items.filter((i) => i.status === 'covered')) {
      const pattern = new RegExp(`test\\.skip\\(\\s*['"\`][^'"\`]*${item.test}`)
      expect(pattern.test(specText), `${item.id}'s assertion is skipped`).toBe(false)
    }
  })
})

describe('an uncovered item has to say why, in words', () => {
  it('names a blocker for every blocked item', () => {
    for (const item of registry.items.filter((i) => i.status === 'blocked')) {
      // Long enough that "TODO" and "later" do not satisfy it. A blocker nobody
      // could restate is a blocker nobody will notice clearing.
      expect(
        (item.blocker ?? '').length,
        `${item.id} is blocked with no usable reason`,
      ).toBeGreaterThan(30)
      expect(item.test ?? null, `${item.id} is blocked but names a test`).toBeNull()
    }
  })

  it('lists what is missing for every partial item', () => {
    for (const item of registry.items.filter((i) => i.status === 'partial')) {
      expect(item.missing, `${item.id} is partial with no missing list`).toBeTruthy()
      expect((item.missing ?? []).length, `${item.id} lists nothing missing`).toBeGreaterThan(1)
      for (const line of item.missing ?? []) expect(line.length).toBeGreaterThan(30)
    }
  })

  it('keeps the count of unfinished items visible', () => {
    // Not a threshold to pass — a number that has to move deliberately. Reading
    // it in a test failure is how a session learns the list is not done without
    // having to go looking.
    const done = registry.items.filter((i) => i.status === 'covered').length
    expect(done, `${done} of 10 protected items are covered`).toBe(3)
  })
})
