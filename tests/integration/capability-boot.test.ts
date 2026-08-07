import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { assertRequiredCapabilities, readEnvironment } from '~/db/capability-registry'
import { bootRefusal } from '~/modules/communications/capability'
import type { CapabilityRow } from '~/modules/communications/capability'

import { APP_URL, OWNER_URL } from './setup/urls'

/**
 * §3's boot assertion — *"the process exits non-zero if any
 * `tier='mvp_required'` capability is not `status='verified'` while
 * `system_constant['environment'] = 'production'`"*.
 *
 * It was specified in Phase 5 and unbuildable until migration 0032, because
 * nothing in the database could say which environment it was. `CONTEXT.md` has
 * carried that as the blocker since Sprint 1 item 1.
 *
 * ⚠️ THIS GATE IS SILENT ON EVERY MACHINE THAT RUNS IT — development, CI, this
 * suite. It only fires in production, which is the one place nobody is watching
 * a terminal. So the tests below assert production explicitly rather than
 * waiting for an environment that will never occur here; a gate exercised only
 * where it does nothing is a gate nobody has tested.
 */

let owner: postgres.Sql
let appRole: postgres.Sql

const rows = (...rs: CapabilityRow[]): CapabilityRow[] => rs

const HOLE: CapabilityRow = { capability: 'call_list', status: 'unknown', tier: 'mvp_required' }
const DIAL: CapabilityRow = {
  capability: 'two_legged_call',
  status: 'verified',
  tier: 'mvp_required',
}
const OPTIONAL_HOLE: CapabilityRow = {
  capability: 'sms_send',
  status: 'absent',
  tier: 'mvp_optional',
}

beforeAll(() => {
  owner = postgres(OWNER_URL, { max: 1, onnotice: () => {} })
  appRole = postgres(APP_URL, { max: 1, onnotice: () => {} })
})

afterAll(async () => {
  await owner.end()
  await appRole.end()
})

describe('the refusal itself', () => {
  it('says nothing outside production, however many holes there are', () => {
    expect(bootRefusal(false, rows(HOLE, DIAL))).toBeNull()
  })

  it('refuses in production and NAMES what is missing', () => {
    const refusal = bootRefusal(true, rows(HOLE, DIAL))
    expect(refusal).toContain('CAP200')
    expect(refusal).toContain('call_list')
    // The status travels with the name: `unknown` and `absent` are different
    // claims, and an operator reading this at 3am needs to know which.
    expect(refusal).toContain('unknown')
    // And it must not name the one that is fine.
    expect(refusal).not.toContain('two_legged_call')
  })

  it('lets an mvp_optional hole through, in production, on purpose', () => {
    // §3 tiers `sms_send` optional because absent it makes SMS-dark permanent
    // rather than temporary and nothing else moves. Promoting it would stop
    // production booting over a feature the launch posture already has off.
    expect(bootRefusal(true, rows(DIAL, OPTIONAL_HOLE))).toBeNull()
  })

  it('passes in production when everything required is verified', () => {
    // A gate that only ever denies is indistinguishable from a broken one.
    expect(bootRefusal(true, rows(DIAL))).toBeNull()
  })
})

describe('what the database says it is', () => {
  it('reads the environment this suite runs against', async () => {
    expect(await readEnvironment(appRole)).toBe('test')
  })

  it('treats an unclassified database as production, not as development', async () => {
    // 🔴 THE DIRECTION IS THE WHOLE DESIGN. A real production database is
    // unclassified on the day it is created; defaulting the other way would
    // leave every gate keyed on this silent exactly there, and nothing about
    // that machine would look broken.
    const [saved] = await owner<{ value: string; reason: string }[]>`
      SELECT value, reason FROM ref.system_constant WHERE key = 'environment'`
    if (saved === undefined) throw new Error('no environment row to borrow')

    try {
      await owner`DELETE FROM ref.system_constant WHERE key = 'environment'`
      expect(await readEnvironment(owner)).toBe('production')
    } finally {
      await owner`
        INSERT INTO ref.system_constant (key, value, reason)
        VALUES ('environment', ${saved.value}, ${saved.reason})
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, reason = EXCLUDED.reason`
    }
  })
})

describe('the wired assertion, against the real registry', () => {
  it('does not refuse this database, because this database is not production', async () => {
    await expect(assertRequiredCapabilities(appRole)).resolves.toBeUndefined()
  })

  /**
   * 🎯 THE ONE THAT MATTERS. Everything above is either a pure function or a
   * read; this drives the real predicate against the real registry with the
   * database asserting production, which is the exact condition the gate exists
   * for and the only condition under which it has ever mattered.
   *
   * It also documents where the project stands: `call_list` is still
   * `mvp_required` and still unverified, so **production would not boot today**.
   * That is not a bug in this test — it is the finding, and §7.3's own "if
   * absent" cell for that row disagrees with its tier. The contradiction is the
   * owner's to resolve.
   */
  it('refuses a production database while call_list is unverified', async () => {
    await owner`UPDATE ref.system_constant SET value = 'production' WHERE key = 'environment'`
    try {
      await expect(assertRequiredCapabilities(appRole)).rejects.toThrow(/CAP200.*call_list/s)
    } finally {
      await owner`UPDATE ref.system_constant SET value = 'test' WHERE key = 'environment'`
    }
  })
})
