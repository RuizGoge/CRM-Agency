import { readFileSync } from 'node:fs'

import postgres from 'postgres'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { readCapabilities } from '~/db/capability-registry'
import {
  alowareCapability,
  installCapabilities,
  resetCapabilitiesForTest,
  unverifiedRequiredCapabilities,
} from '~/modules/communications/capability'
import type { CapabilityName, CapabilityRow } from '~/modules/communications/capability'

import { APP_URL } from './setup/urls'

/**
 * §3's capability gate — the TREE half.
 *
 * Migration 0030 moved `two_legged_call` to `verified` in the database. Nothing
 * read it: `alowareCapability` was specified in `05-architecture.md` §3 and had
 * never been written, so the registry was a lock with no door and the "screen
 * does not compile until the spike proves it" guarantee did not exist in any
 * form. This file asserts it now does.
 *
 * ⚠️ THE FIRST TEST IS A COMPILE-TIME ONE, and it is the only one that matters
 * if the others all pass. Every runtime assertion below is satisfied by a union
 * that has quietly collapsed into `{status, call?}` — which compiles, passes,
 * and lets a caller reach `.call` on an unverified capability.
 */

let appRole: postgres.Sql

beforeAll(() => {
  appRole = postgres(APP_URL, { max: 1, onnotice: () => {} })
})

afterAll(async () => {
  await appRole.end()
})

afterEach(() => {
  resetCapabilitiesForTest()
})

const rows = (...rs: CapabilityRow[]): CapabilityRow[] => rs

describe('the type gate', () => {
  it('does not let a caller reach `call` on an unverified capability', () => {
    installCapabilities(rows({ capability: 'sms_send', status: 'unknown', tier: 'mvp_optional' }))
    const cap = alowareCapability('sms_send')

    if (cap.status !== 'verified') {
      // @ts-expect-error `call` exists ONLY on the verified variant. If this
      // line stops erroring, TypeScript reports the unused directive and the
      // build goes red — so widening the union cannot pass silently. That is
      // the whole gate: there is no `callOrThrow`, no assertion helper and no
      // default branch, because each is a way to turn this compile error into a
      // runtime one, and a runtime one means a seller taps Call and nothing
      // happens.
      void cap.call
    }

    expect(cap.status).toBe('unknown')
  })

  it('carries `call` on the verified variant', () => {
    installCapabilities(
      rows({ capability: 'two_legged_call', status: 'verified', tier: 'mvp_required' }),
    )
    const cap = alowareCapability('two_legged_call')

    expect(cap.status).toBe('verified')
    if (cap.status === 'verified') {
      expect('call' in cap).toBe(true)
    }
  })
})

describe('the registry snapshot', () => {
  it('refuses to answer before it is installed', () => {
    // Not a defensive throw. Returning `{status:'unknown'}` here would fail
    // closed in the narrow sense and OPEN in the sense that matters: a wiring
    // bug would be indistinguishable from a capability the spike never proved,
    // so the product would quietly have no dialer while the admin page blamed
    // Aloware for it.
    expect(() => alowareCapability('two_legged_call')).toThrow(/CAP101/)
  })

  it('refuses to be installed twice', () => {
    installCapabilities(rows())
    expect(() => installCapabilities(rows())).toThrow(/CAP100/)
  })

  it('reads a name with no registry row as unknown, not as an error', () => {
    installCapabilities(rows())
    expect(alowareCapability('call_list')).toEqual({ status: 'unknown' })
  })

  it('keeps `absent` and `unknown` distinct', () => {
    installCapabilities(
      rows(
        { capability: 'call_list', status: 'absent', tier: 'mvp_required' },
        { capability: 'sms_send', status: 'unknown', tier: 'mvp_optional' },
      ),
    )
    // Neither can dial. They are different claims to `/admin/integration-health`
    // — `absent` is "the provider answered and said no", `unknown` is "we never
    // established it" — and collapsing them is how a transport failure gets
    // recorded as a verdict.
    expect(alowareCapability('call_list').status).toBe('absent')
    expect(alowareCapability('sms_send').status).toBe('unknown')
  })
})

/**
 * The names `CapabilityName` declares. Written out rather than derived, because
 * a list derived from the type it is checking agrees with itself by
 * construction and asserts nothing.
 */
const IN_TREE: readonly CapabilityName[] = [
  'two_legged_call',
  'webhook_subscription',
  'sms_send',
  'call_list',
  'contact_lookup',
  'sequence_enroll',
  'sequence_disenroll',
  'recording_announcement_on_two_legged',
]

/**
 * The capability names migration 0029 seeds, read out of the migration file.
 *
 * ⚠️ THIS IS READ FROM THE FILE AND NOT FROM THE DATABASE, and the reason is a
 * defect this suite already produced once. Asked of `ref.provider_capability`,
 * this question passes in isolation and FAILS IN THE SUITE: `crm_test` is shared
 * between files and `capability-probe.test.ts` seeds `zz_test_happy` to prove
 * its happy path is reachable. A row another file wrote is not a drifted
 * registry, but it is indistinguishable from one when you ask the engine.
 *
 * The question is static — which names does the schema seed — so it is answered
 * statically: no database, no ordering between files, no cleanup. `snapshot-chain.test.ts`
 * made exactly this move for exactly this reason. **Fourth time this project has
 * paid the signature of shared state**, and the first three are in CONTEXT.md.
 */
function seededCapabilityNames(): readonly string[] {
  const sql = readFileSync(
    new URL('../../app/db/migrations/0029_provider_capability_probe.sql', import.meta.url),
    'utf8',
  )
  const start = sql.indexOf('INSERT INTO ref.provider_capability')
  if (start === -1) throw new Error('migration 0029 no longer seeds ref.provider_capability')
  const block = sql.slice(start, sql.indexOf(';', start))
  return [...block.matchAll(/\(\s*'aloware'\s*,\s*'([a-z_]+)'/g)].map((m) => m[1] ?? '')
}

describe('the tree and the schema name the same capabilities', () => {
  it('agrees in both directions', () => {
    const seeded = new Set(seededCapabilityNames())
    expect(seeded.size).toBeGreaterThan(0)

    // Every name the tree knows is seeded. A name with no row reads `unknown`
    // forever, which looks exactly like an unproven capability and is actually
    // a missing seed — the failure would be a feature silently disabled with
    // the admin page blaming the provider for it.
    expect(IN_TREE.filter((n) => !seeded.has(n))).toEqual([])

    // And every seeded row has a name. A row the tree cannot name is
    // unreachable, so whatever it guards is ungated.
    expect([...seeded].filter((n) => !IN_TREE.includes(n as CapabilityName))).toEqual([])
  })
})

describe('against the real registry', () => {
  /**
   * Scoped to the names the tree declares, for the same shared-database reason
   * as above: another file's fixture row is not this product's registry. What
   * the assertion claims is exactly what it can see — of the capabilities this
   * product knows about, one is verified.
   */
  /**
   * 🔴 THIS ASSERTION MOVED, and the move is the point. It read `['two_legged_call']`
   * until migration 0031 gave an inbound capability a shape to be evidenced in
   * — `ref.capability_delivery` — and promoted `webhook_subscription` against
   * Aloware's own `Save and Test Webhook` delivery. A guardian that had to be
   * edited is a guardian that was watching.
   */
  it('has exactly two verified capabilities: the dial and the subscription', async () => {
    const registry = await readCapabilities(appRole)
    expect(
      registry
        .filter((r) => r.status === 'verified' && IN_TREE.includes(r.capability))
        .map((r) => r.capability)
        .sort(),
    ).toEqual(['two_legged_call', 'webhook_subscription'])
  })

  it('evidences each verified capability from exactly one side, never both', async () => {
    // `capability_verified_needs_evidence` is `num_nonnulls(...) = 1` rather
    // than two OR'd clauses, because a row pointing at BOTH a probe and a
    // delivery claims two different things proved the same capability — and the
    // one somebody later reads is whichever the query happened to join.
    const rows = await appRole<{ capability: string; sides: number }[]>`
      SELECT capability,
             num_nonnulls(evidence_probe_id, evidence_delivery_id) AS sides
        FROM ref.provider_capability
       WHERE provider = 'aloware' AND status = 'verified'`
    expect(rows.length).toBeGreaterThan(0)
    expect([...rows].map((r) => r.sides)).toEqual(rows.map(() => 1))
  })

  /**
   * 🔴 A GUARDIAN THAT RECORDS THE REMAINING HOLE, written to go red when it
   * closes. Same shape as the two ratchet guardians that had to change when P20
   * was measured: a gap that closes because nobody noticed is the failure this
   * prevents, in both directions. It listed TWO capabilities until 0031 closed
   * `webhook_subscription`, and this edit is that guardian being edited.
   *
   * `call_list` is the one left, and it is NOT waiting on a mechanism — it is
   * waiting on a ruling. G2 found it neither documented nor discoverable, while
   * §3's own "if absent" cell for that row describes a compensating control and
   * the MVP shipping anyway. `mvp_required` and that cell cannot both be true,
   * and reclassifying a tier so a boot passes is exactly the move the
   * constitution forbids unless the decision is explicit and the owner's.
   */
  it('reports the one remaining mvp_required hole, unreclassified', async () => {
    const registry = (await readCapabilities(appRole)).filter((r) => IN_TREE.includes(r.capability))
    const blocking = unverifiedRequiredCapabilities(registry)
    expect(blocking.map((r) => r.capability)).toEqual(['call_list'])
  })
})
