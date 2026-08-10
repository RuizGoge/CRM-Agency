import { readFileSync } from 'node:fs'

import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  CARD_GAP_PX,
  CARD_H_DESKTOP_PX,
  CARD_H_MOBILE_PX,
  cardPitchPx,
} from '~/styles/tokens/geometry'

import { TEST_URL } from './setup/urls'

/**
 * The fixed card height, in the three places it exists, compared as NUMBERS.
 *
 * `04b` carried three different card heights before ruling N17 struck two of
 * them — 108/92 in §3.6, 112 in §2's mock, 120/156 in §1 — which is why this
 * geometry is registered with the `pinned` arm rather than left as a token
 * somebody can retune. The failure it prevents is not a broken-looking card:
 * a column whose pitch stops being uniform stops being virtualisable, and the
 * drag gate loses its headroom on a board a seller uses all day, silently.
 *
 * Compared as VALUES and never as names. Errata E7/NEW-1 records what a drift
 * test that compares names does: it stays green through exactly the failure it
 * was written to catch.
 *
 * The THIRD place arrived with the column virtualizer: it multiplies by the row
 * pitch in JavaScript and `04b` §2.1 forbids it from reading layout to find out
 * what the pitch is. So the numbers exist in TypeScript too, and the drift this
 * file catches is now the one that matters most — a virtualizer dividing by 120
 * while a phone renders 156 puts every card in the column at the wrong offset
 * and opens gaps a seller reads as missing leads.
 */

let sql: postgres.Sql

const CSS = readFileSync(new URL('../../app/styles/tokens/theme.css', import.meta.url), 'utf-8')
const RESET = readFileSync(new URL('../../app/styles/reset.css', import.meta.url), 'utf-8')

function declared(name: string): number {
  const found = new RegExp(`--${name}:\\s*(\\d+)px`).exec(CSS)?.[1]
  if (!found) throw new Error(`--${name} is not declared in theme.css`)
  return Number(found)
}

async function pinned(name: string): Promise<number> {
  const rows = await sql<{ value_num: string }[]>`
    SELECT value_num::text AS value_num FROM ref.ci_ratchet
     WHERE name = ${name} ORDER BY set_at LIMIT 1`
  const value = rows[0]?.value_num
  if (!value) throw new Error(`${name} has no registered value`)
  return Number(value)
}

beforeAll(() => {
  sql = postgres(TEST_URL, { max: 1, onnotice: () => {} })
})

afterAll(async () => {
  await sql?.end()
})

describe('the card height is pinned at the engine, not in a stylesheet', () => {
  it('registers both names with the pinned arm', async () => {
    const rows = await sql<{ name: string; direction: string }[]>`
      SELECT name, direction::text AS direction FROM ref.ci_ratchet_name
       WHERE name LIKE 'ui.card_h_%' ORDER BY name`

    expect(rows.map((r) => r.name)).toEqual(['ui.card_h_desktop', 'ui.card_h_mobile'])
    // Neither direction is an improvement for a geometry with a published
    // derivation, so neither monotonic arm is honest here.
    for (const row of rows) expect(row.direction).toBe('pinned')
  })

  it('keeps the stylesheet and the engine on the same two numbers', async () => {
    expect(declared('size-card-h')).toBe(await pinned('ui.card_h_desktop'))
    expect(declared('size-card-h-mobile')).toBe(await pinned('ui.card_h_mobile'))
  })

  it('keeps the virtualizer on the same two numbers as the stylesheet', async () => {
    // The third representation. Nothing in the running product compares these
    // to the CSS: the browser reads the token, the virtualizer reads the
    // constant, and the two disagreeing produces a board that renders — with
    // cards at offsets that drift further apart the further a seller scrolls.
    expect(CARD_H_DESKTOP_PX).toBe(declared('size-card-h'))
    expect(CARD_H_MOBILE_PX).toBe(declared('size-card-h-mobile'))
    expect(CARD_H_DESKTOP_PX).toBe(await pinned('ui.card_h_desktop'))
    expect(CARD_H_MOBILE_PX).toBe(await pinned('ui.card_h_mobile'))
  })

  it('keeps the gap the virtualizer adds equal to the gap the column renders', () => {
    // `--space-2` is the gap on the card list and 0.5rem at the 16px root that
    // reset.css pins. The pitch is `height + gap`, so a gap that changed in the
    // stylesheet alone would leave the spacers short by 8px per card — 1,000px
    // of missing column on a 125-card book, which reads as a scrollbar that
    // lies rather than as a bug in a number.
    const rem = /--space-2:\s*([\d.]+)rem/.exec(CSS)?.[1]
    expect(rem, '--space-2 is not declared in rem').toBeDefined()
    // The rem→px conversion is only true because the root is left at the
    // browser default, which reset.css states rather than assumes. If that ever
    // becomes a number, this multiplication is the line that has to change with
    // it — so it is asserted here instead of being a fact somebody remembers.
    expect(RESET, 'the 16px root the rem conversion depends on').toMatch(/font-size:\s*100%/)
    expect(CARD_GAP_PX).toBe(Number(rem) * 16)

    expect(cardPitchPx(false)).toBe(CARD_H_DESKTOP_PX + CARD_GAP_PX)
    expect(cardPitchPx(true)).toBe(CARD_H_MOBILE_PX + CARD_GAP_PX)
  })

  it('never lets one name mean both geometries', async () => {
    // The failure a single `ui.card_h` would produce: whichever number was
    // written last wins on both breakpoints, and a phone renders a desktop
    // card with its bottom row cut off.
    expect(await pinned('ui.card_h_desktop')).not.toBe(await pinned('ui.card_h_mobile'))
  })

  it('refuses a different value under the pinned arm', async () => {
    // Both sides of the arm. A ratchet that never rejects passes a naive test
    // for ever, and this is the walk it exists to stop: somebody decides the
    // card should be 96px because a chip did not fit.
    await expect(
      sql`INSERT INTO ref.ci_ratchet (name, value_num, set_by_run)
          VALUES ('ui.card_h_desktop', 96, 'a test that must not succeed')`,
    ).rejects.toThrow(/AP004/)

    // And restating the pinned value is accepted, which is what makes the
    // number auditable rather than merely frozen.
    await expect(
      sql`INSERT INTO ref.ci_ratchet (name, value_num, set_by_run)
          VALUES ('ui.card_h_desktop', 120, 'restating the pinned value')`,
    ).resolves.toBeDefined()
  })

  it('switches the rendered height at exactly one breakpoint', () => {
    // `--card-h` is what a card renders at, and it resolves to the desktop
    // token by default and the mobile one below the density breakpoint. If the
    // swap were written anywhere else, the tree would carry a second hard-coded
    // breakpoint number — which is the thing `BREAKPOINTS` exists to prevent.
    expect(CSS).toMatch(/--card-h:\s*var\(--size-card-h\)/)
    expect(RESET).toMatch(/--card-h:\s*var\(--size-card-h-mobile\)/)
    expect((RESET.match(/@media \(max-width: \d+px\)/g) ?? []).length, 'a second breakpoint').toBe(
      1,
    )
  })
})
