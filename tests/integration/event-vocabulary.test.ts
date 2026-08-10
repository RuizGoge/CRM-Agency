import { readFileSync } from 'node:fs'

import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { TEST_URL } from './setup/urls'

/**
 * "An event outside the canonical 49 is a bug, not a feature" — now enforced by
 * POSTGRES, not only by the compiler.
 *
 * The TypeScript union shipped with the contract makes an invented name a build
 * error for code we write. It does nothing about a name arriving as DATA: a
 * webhook body, a replayed job payload, a hand-written INSERT during an
 * incident at 2am. An enum column refuses all of those, at any hour, by any
 * actor — which is the difference between a rule and a mechanism.
 *
 * And `event_consumer` turns the catalog's `consumers` column into a
 * constraint: the outbox carries a foreign key here, so a fan-out row for a
 * consumer that does not exist cannot be written at all.
 */

interface Catalog {
  readonly events: readonly { readonly name: string; readonly consumers: readonly string[] }[]
}

const catalog = JSON.parse(readFileSync('contracts/events/catalog.json', 'utf8')) as Catalog

let sql: postgres.Sql

beforeAll(() => {
  sql = postgres(TEST_URL, { max: 1, onnotice: () => {} })
})

afterAll(async () => {
  await sql?.end()
})

describe('the enum and the registry are the same 49 names', () => {
  it('matches the catalog exactly, in order', async () => {
    // In ORDER, not merely as a set. Postgres orders an enum by declaration, and
    // the calling-window suite already paid for that once — a comparison that
    // sorted first would hide a reordering that changes how any ORDER BY on this
    // column behaves.
    const rows = await sql<{ label: string }[]>`
      SELECT e.enumlabel AS label
        FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
        JOIN pg_namespace n ON n.oid = t.typnamespace
       WHERE n.nspname = 'app' AND t.typname = 'event_name'
       ORDER BY e.enumsortorder`

    expect(rows.map((r) => r.label)).toEqual(catalog.events.map((e) => e.name))
    expect(rows).toHaveLength(49)
  })

  it('refuses a name the catalog does not contain', async () => {
    // THE ASSERTION THIS TABLE EXISTS FOR. `opportunity.closed_won` is the ghost
    // six modules were waiting for; it is now unwritable rather than merely
    // un-typeable.
    await expect(sql`SELECT 'opportunity.closed_won'::app.event_name`).rejects.toThrow(
      /invalid input value for enum/i,
    )
  })

  it('accepts one the catalog does contain', async () => {
    // The positive control. Without it the assertion above passes for a type
    // that does not exist at all.
    const [row] = await sql<{ ok: string }[]>`SELECT 'opportunity.won'::app.event_name AS ok`
    expect(row?.ok).toBe('opportunity.won')
  })
})

describe('every declared subscription exists as a row, and no row is undeclared', () => {
  it('holds exactly the catalog pairs, in both directions', async () => {
    const declared = new Set(
      catalog.events.flatMap((e) => e.consumers.map((c) => `${c}→${e.name}`)),
    )
    const rows = await sql<{ consumer_name: string; event_name: string }[]>`
      SELECT consumer_name, event_name FROM app.event_consumer`
    const stored = new Set(rows.map((r) => `${r.consumer_name}→${r.event_name}`))

    const missing = [...declared].filter((p) => !stored.has(p))
    const extra = [...stored].filter((p) => !declared.has(p))

    expect(
      missing,
      `declared in the catalog, absent from event_consumer:\n  ${missing.join('\n  ')}`,
    ).toEqual([])
    expect(extra, `in event_consumer, declared nowhere:\n  ${extra.join('\n  ')}`).toEqual([])
  })

  it('is reading a real set of subscriptions', () => {
    // The mutation guard. Two empty sets are equal, and a broken catalog parse
    // would make every assertion above vacuous.
    expect(catalog.events.flatMap((e) => e.consumers).length).toBeGreaterThan(200)
  })
})

describe('the subscription registry is not application data', () => {
  it('leaves crm_app unable to write it', async () => {
    // A consumer subscribes by migration, which is the same standard the loader
    // whitelist and the budget file hold: adding one is an edit somebody makes
    // on purpose, not a row an endpoint can insert.
    for (const p of ['INSERT', 'UPDATE', 'DELETE'] as const) {
      const [priv] = await sql<{ ok: boolean }[]>`
        SELECT has_table_privilege('crm_app', 'app.event_consumer', ${p}) AS ok`
      expect(priv?.ok, `crm_app can ${p} event_consumer`).toBe(false)
    }
  })

  it('lets it be read, because a consumer has to find its own subscriptions', async () => {
    const [priv] = await sql<{ ok: boolean }[]>`
      SELECT has_table_privilege('crm_app', 'app.event_consumer', 'SELECT') AS ok`
    expect(priv?.ok).toBe(true)
  })
})
