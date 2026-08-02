import postgres from 'postgres'
import { afterAll, describe, expect, it } from 'vitest'

import { assertSafeConnection, readConnectionPosture, unsafeReasons } from '~/db/boot-assert'

import { APP_URL, OWNER_URL } from './setup/urls'

/**
 * Sprint-0 gate G4(a).
 *
 * The failure being guarded has no symptom: a superuser, a BYPASSRLS role or
 * the schema owner reads straight through every policy — FORCE included — so
 * every page renders perfectly with every seller's rows and nothing errors.
 * The refusal to boot IS the symptom, deliberately manufactured.
 *
 * Both halves are asserted here, because either alone passes for the wrong
 * reason: a guard that never fires proves nothing, and a guard that always
 * fires would simply be removed.
 */

const owner = postgres(OWNER_URL, { max: 1, onnotice: () => {} })
const app = postgres(APP_URL, { max: 1, onnotice: () => {} })

afterAll(async () => {
  await Promise.all([owner.end(), app.end()])
})

describe('the boot assertion', () => {
  it('refuses the owner credential, naming every reason', async () => {
    // This is the string `docker compose` hands out by default, and it was
    // this project's development default for eight sprint items.
    const posture = await readConnectionPosture(owner)

    expect(posture.isSuperuser || posture.ownsManagedSchema).toBe(true)
    expect(unsafeReasons(posture).length).toBeGreaterThan(0)

    await expect(assertSafeConnection(owner)).rejects.toThrow(/BOOT002/)
  })

  it('accepts the application role', async () => {
    const posture = await readConnectionPosture(app)

    expect(posture.user).toBe('crm_app')
    expect(posture.isSuperuser).toBe(false)
    expect(posture.bypassesRls).toBe(false)
    expect(posture.ownsManagedSchema).toBe(false)

    await expect(assertSafeConnection(app)).resolves.toBeUndefined()
  })

  it('is what the running application actually connects as', () => {
    // The guard is only worth anything if the pool it protects is the pool the
    // product uses. DATABASE_URL is set by vitest to the crm_app role, exactly
    // as a deployment would.
    expect(process.env['DATABASE_URL']).toContain('crm_app')
  })
})
