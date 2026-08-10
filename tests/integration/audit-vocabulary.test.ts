import { readFileSync } from 'node:fs'

import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { TEST_URL } from './setup/urls'

/**
 * The audit vocabulary and the event vocabulary are two closed lists answering
 * two different questions, and they must not share a word.
 *
 * 🔴 WRITTEN BECAUSE THE FIRST DRAFT COLLIDED SEVEN TIMES. Migration 0053's
 * action list originally contained `earnings.adjusted` and the relay mapped
 * `lead.owner_changed` — both RULED-OUT event names — and
 * `scripts/events-contract.test.ts` refused them on sight. It was right to:
 * it scans quoted literals and cannot know whether a given one is meant as an
 * event or as an action, and an audit action spelled like a discarded event is
 * precisely the ambiguity the ghost list exists to prevent.
 *
 * Four more collided with LIVE event names — `pipeline.stage_config_changed`,
 * `user.deactivated`, `opportunity.gate_blocked`, `compliance.override_ended` —
 * and the ghost gate does not catch those at all. A row reading
 * `action = 'user.deactivated'` next to an event named `user.deactivated` is
 * two vocabularies that look like one, which is how somebody later "fixes" an
 * audit query by joining on the wrong column.
 *
 * This file is the mechanism. Without it the separation is a thing somebody
 * checked once.
 */

interface Catalog {
  readonly events: readonly { readonly name: string }[]
  readonly ghosts: { readonly names: readonly string[] }
}

const catalog = JSON.parse(readFileSync('contracts/events/catalog.json', 'utf8')) as Catalog

let sql: postgres.Sql
let actions: readonly string[]

beforeAll(async () => {
  sql = postgres(TEST_URL, { max: 1, onnotice: () => {} })

  // READ FROM THE ENGINE, not from the migration text. The CHECK constraint on
  // `audit_log.action` calls this function, so what it returns is what the
  // database will actually accept — and a migration that redefines it later
  // moves this test without anybody editing it.
  const rows = await sql<{ list: string[] }[]>`SELECT app.audit_action_list() AS list`
  actions = rows[0]?.list ?? []
})

afterAll(async () => {
  await sql?.end()
})

describe('the audit vocabulary is closed and separate', () => {
  it('is reading a real list', () => {
    // The mutation guard: an empty list satisfies every "does not contain"
    // assertion below, forever.
    expect(actions.length).toBeGreaterThan(10)
  })

  it('shares no name with a live event', () => {
    const live = new Set(catalog.events.map((e) => e.name))
    const collisions = actions.filter((a) => live.has(a)).sort()

    expect(
      collisions,
      `${collisions.join(', ')} name both an audit action and a canonical event. ` +
        `Two closed vocabularies answering different questions must not share a word: ` +
        `an audit row whose action reads like an event name invites a join on the ` +
        `wrong column, and neither list can be renamed without a migration.`,
    ).toEqual([])
  })

  it('shares no name with a RULED-OUT event', () => {
    // The harder half, and the one that already fired. A ghost is a name the
    // corpus considered and discarded; reusing one as an action resurrects
    // exactly the confusion it was discarded to end.
    const ghosts = new Set(catalog.ghosts.names)
    const collisions = actions.filter((a) => ghosts.has(a)).sort()

    expect(
      collisions,
      `${collisions.join(', ')} are discarded event names being reused as audit actions. ` +
        `scripts/events-contract.test.ts refuses them in any string literal, and it is ` +
        `right to — it cannot tell an action from an event, and neither will a reader.`,
    ).toEqual([])
  })

  it('accepts a known action and refuses an invented one', () => {
    // The positive control. Without it the two assertions above pass over a
    // vocabulary that has nothing to do with what the CHECK enforces.
    expect(actions).toContain('ownership.transferred')
    expect(actions).not.toContain('something.invented')
  })
})
