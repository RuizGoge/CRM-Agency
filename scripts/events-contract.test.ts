import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { EVENT_CONSUMERS, EVENT_EMITTERS, EVENT_NAMES, GHOSTS } from '~/lib/events/events'

import { fieldsOf, readContract, renderCatalog } from './generate-events'

/**
 * "An event outside the canonical 49 is a bug, not a feature" becomes a red
 * build instead of a sentence in CLAUDE.md.
 *
 * Until this file existed the 49-event contract lived only as a markdown table
 * in a 57 KB document, and `app/lib/events/**` — which CLAUDE.md describes as
 * generated from `contracts/events/` — did not exist at all. A rule with no
 * mechanism is documentation, and this project's constitution says to call that
 * what it is.
 *
 * The ghost assertions are the ones that will actually fire. A wrong-but-
 * plausible name is not caught by a compiler and does not throw: the emitter
 * emits, no consumer is listening, and the sale is simply never celebrated.
 */

const GENERATED = 'app/lib/events/catalog.generated.ts'
const CONTRACT = 'contracts/events/catalog.json'
const SELF = 'scripts/events-contract.test.ts'

const contract = readContract()

describe('the generated catalog and the contract cannot drift', () => {
  it('matches what the generator produces right now', async () => {
    // THE ASSERTION THIS FILE EXISTS FOR, first half. Hand-editing the generated
    // file, or editing the contract without regenerating, is a red build naming
    // the command to run. Same shape as snapshot-chain.test.ts, for the same
    // reason: a source of truth nobody re-derives is a source of truth that
    // stops being true.
    const expected = await renderCatalog()
    const actual = readFileSync(GENERATED, 'utf8')
    expect(actual, `${GENERATED} is stale — run \`npm run events:generate\``).toBe(expected)
  })

  it('exports exactly the names the contract declares, in order', () => {
    expect([...EVENT_NAMES]).toEqual(contract.events.map((event) => event.name))
  })
})

describe('the count is 49 and moving it is a decision', () => {
  it('holds the declared split of 40 core plus 9 from Amendment 1', () => {
    // Not a threshold that passes — a number that has to move deliberately. A
    // fiftieth event fails here, and so does deleting one.
    const amendment = contract.events.filter((event) => event.amendment === 1)
    const core = contract.events.filter((event) => event.amendment === undefined)

    expect(contract.count.total).toBe(49)
    expect(contract.count.core + contract.count.amendment_1).toBe(contract.count.total)
    expect(core, 'the §4 catalog changed size').toHaveLength(contract.count.core)
    expect(amendment, 'Amendment 1 changed size').toHaveLength(contract.count.amendment_1)
    expect(EVENT_NAMES).toHaveLength(49)
  })

  it('never lists the same name twice', () => {
    expect(new Set(EVENT_NAMES).size).toBe(EVENT_NAMES.length)
  })

  it('gives every event one emitter and at least one consumer', () => {
    // An event with no consumer is a write nobody reads; an event with no
    // emitter is a name waiting to be invented at a call site.
    for (const name of EVENT_NAMES) {
      expect(EVENT_EMITTERS[name], `${name} has no emitter`).toBeTruthy()
      expect(EVENT_CONSUMERS[name].length, `${name} has no consumer`).toBeGreaterThan(0)
    }
  })

  it('gives every event a real reason to exist', () => {
    for (const event of contract.events) {
      expect(event.note.length, `${event.name} has no usable note`).toBeGreaterThan(60)
    }
  })
})

describe('the envelope is declared once and never re-declared per event', () => {
  it('carries §3 exactly', () => {
    expect(Object.keys(contract.envelope.fields)).toEqual([
      'event_id',
      'tenant_id',
      'owner_user_id',
      'actor_user_id',
      'occurred_at_utc_ms',
      'recorded_at_utc_ms',
      'schema_version',
      'source_system',
      'correlation_id',
    ])
  })

  it('never lets a payload restate an envelope field', () => {
    // §4's first row spells the envelope into lead.created's payload and then
    // writes "ENVELOPE, …" for the other thirty-nine. Copying that into the
    // contract would give tenant_id two definitions, and the one that drifts is
    // always the copy.
    const envelopeFields = new Set(Object.keys(contract.envelope.fields))
    for (const event of contract.events) {
      for (const field of Object.keys(fieldsOf(event))) {
        expect(envelopeFields.has(field), `${event.name}.${field} restates an envelope field`).toBe(
          false,
        )
      }
    }
  })
})

describe('money never enters an event as a number', () => {
  it('never names a field in dollars', () => {
    // §4 names these fields `_usd` — deal_value_annual_premium_usd, delta_usd,
    // amount_usd — and that suffix is an invitation to put dollars in a JS
    // number. `Number(` is already a build error outside app/lib/money/**; this
    // closes the door one step earlier, at the contract, where the field is
    // named. A field called `*_usd` fails here whatever type it claims.
    for (const event of contract.events) {
      for (const field of Object.keys(fieldsOf(event))) {
        expect(field.endsWith('_usd'), `${event.name}.${field} is named in dollars`).toBe(false)
      }
    }
  })

  it('types every premium as money, whatever it is called', () => {
    // The one semantic inference worth making: a premium is money in this
    // product and in no reading is it anything else.
    for (const event of contract.events) {
      for (const [field, spec] of Object.entries(fieldsOf(event))) {
        if (field.endsWith('_premium')) {
          expect(
            spec.startsWith('money'),
            `${event.name}.${field} is a premium typed ${spec}`,
          ).toBe(true)
        }
      }
    }
  })

  it('holds the money-carrying fields at exactly the fifteen that exist today', () => {
    // A PINNED SET, not a guess from the field name. The first version of this
    // test inferred money from names matching `*_total`, and caught
    // `lead.import_completed.rows_total` — a row count. Guessing semantics from
    // a name produces exactly that: a gate that fires on the wrong thing and
    // gets loosened until it fires on nothing.
    //
    // Pinning means adding a money field is an edit to this list, which is the
    // same shape as the card-height and loader-count gates. Every entry here is
    // a number that can reach a public leaderboard.
    const carried = contract.events
      .flatMap((event) =>
        Object.entries(fieldsOf(event))
          .filter(([, spec]) => spec.startsWith('money'))
          .map(([field]) => `${event.name}.${field}`),
      )
      .sort()

    expect(carried, 'the set of money-carrying event fields changed').toEqual([
      'celebration.triggered.amount',
      'contact.became_client.annual_premium',
      'contact.owner_changed.closed_won_moved',
      'earnings.updated.delta',
      'earnings.updated.new_total_all_time',
      'leaderboard.rank_changed.new_total_all_time',
      'opportunity.created.deal_value_annual_premium',
      'opportunity.lost.deal_value_at_loss',
      'opportunity.reopened.deal_value_reversed',
      'opportunity.stage_changed.deal_value_annual_premium',
      'opportunity.value_changed.new_value',
      'opportunity.value_changed.old_value',
      'opportunity.went_cold.deal_value_annual_premium',
      'opportunity.won.deal_value_annual_premium',
      'user.deactivated.closed_won_total',
    ])
  })
})

describe('a name that was ruled out cannot come back', () => {
  it('never registers a ghost that is also canonical', () => {
    const canonical = new Set<string>(EVENT_NAMES)
    for (const ghost of Object.keys(GHOSTS)) {
      expect(canonical.has(ghost), `${ghost} is both canonical and a ghost`).toBe(false)
    }
  })

  it('remaps every ghost to a real event, or to nothing on purpose', () => {
    const canonical = new Set<string>(EVENT_NAMES)
    for (const [name, ghost] of Object.entries(GHOSTS)) {
      if (ghost.use !== null) {
        expect(
          canonical.has(ghost.use),
          `${name} remaps to ${ghost.use}, which is not canonical`,
        ).toBe(true)
      }
      expect(ghost.consequence.length, `${name} has no stated consequence`).toBeGreaterThan(40)
    }
  })

  it('still registers the collisions §2 found across multiple modules', () => {
    // THE ESCAPE HATCH THIS CLOSES. Every assertion above passes if someone
    // deletes the ghost list, so the ghosts that §2 recorded as multi-module
    // failures are named here. Removing one is then an edit to this line rather
    // than a silent loss of the only check that catches them.
    for (const [ghost, use] of [
      ['opportunity.closed_won', 'opportunity.won'],
      ['lead.went_cold', 'opportunity.went_cold'],
      ['sms.received', 'message.received'],
      ['email.received', 'message.received'],
      ['sms.opt_out_received', 'consent.updated'],
      ['task.created', 'activity.created'],
      ['meeting.booked', 'appointment.scheduled'],
      ['pipeline.settings_updated', 'pipeline.stage_config_changed'],
    ] as const) {
      expect(GHOSTS[ghost]?.use, `${ghost} is no longer registered as a ghost`).toBe(use)
    }
  })

  it('keeps automation.action_requested deleted rather than remapped', () => {
    // The one ghost whose ruling is architectural: four modules expected it, and
    // giving automations their own action event would be a parallel write path
    // that bypasses every gate — including the single outbound compliance gate.
    // Automations call the owning module's command path instead.
    const deleted = GHOSTS['automation.action_requested']
    expect(deleted, 'automation.action_requested is no longer registered').toBeDefined()
    expect(deleted?.use, 'automation.action_requested was given a remap target').toBeNull()
  })
})

describe('no ghost name appears in the tree', () => {
  const ROOTS = ['app', 'scripts']
  const EXEMPT = new Set([GENERATED, SELF])

  /** Every TypeScript file that is not one of the two allowed to name a ghost. */
  const sources = ROOTS.flatMap((root) =>
    readdirSync(root, { recursive: true, encoding: 'utf8' })
      .map((entry) => join(root, entry).replaceAll('\\', '/'))
      .filter((path) => path.endsWith('.ts') || path.endsWith('.tsx'))
      .filter((path) => !EXEMPT.has(path)),
  )

  it('finds no ruled-out event name in a string literal', () => {
    // THE ASSERTION THIS FILE EXISTS FOR, second half — and the only one here
    // that can fail because of code somebody wrote rather than because of the
    // contract. Quoted literals only: prose in a comment discussing a ghost is
    // how these rulings get explained, and a checker that forbade that would be
    // "fixed" by deleting the explanation.
    const found: string[] = []
    for (const path of sources) {
      const source = readFileSync(path, 'utf8')
      for (const [ghost, ruling] of Object.entries(GHOSTS)) {
        const literal = new RegExp(`['"]${ghost.replaceAll('.', '\\.')}['"]`)
        if (literal.test(source)) {
          const fix = ruling.use === null ? 'it was deleted' : `use \`${ruling.use}\``
          found.push(`${path} names \`${ghost}\` — ${fix}. ${ruling.consequence}`)
        }
      }
    }
    expect(found, found.join('\n')).toEqual([])
  })

  it('is actually reading files', () => {
    // A scan over an empty list passes forever. This is the mutation guard: if
    // the walk breaks, the assertion above becomes a green no-op.
    expect(sources.length).toBeGreaterThan(30)
    expect(sources).toContain('app/lib/events/events.ts')
  })
})

describe('the contract file is the source', () => {
  it('says so where somebody editing the generated file would look', () => {
    const generated = readFileSync(GENERATED, 'utf8')
    expect(generated).toContain(`GENERATED FROM ${CONTRACT} — DO NOT EDIT`)
    expect(generated).toContain('npm run events:generate')
  })
})
