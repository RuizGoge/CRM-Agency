import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type postgres from 'postgres'

/**
 * Installs the E1b DDL guard, as the OWNER.
 *
 * 🔴 IT LIVES IN ITS OWN MODULE FOR THE REASON `jobs-schema.ts` DOES: the
 * integration database and the operator's console must run the same text. A
 * second copy would be a suite asserting against a guard production does not
 * have — and this one guards seller isolation, so that divergence is the kind
 * that ends with fifty sellers reading each other's leads.
 *
 * 🔴 AND IT IS NOT A MIGRATION, WHICH IS THE WHOLE POINT. `CREATE EVENT TRIGGER`
 * requires superuser; since 2026-08-14 the deploy runs as `crm_migrator`, which
 * is not one. So the guard is applied by the owner, out of band, exactly as
 * `docs/sprint-0/deploy-credential-isolation.md` already describes for the three
 * role-altering statements. The authorisation infrastructure cannot bootstrap
 * itself under the credential it exists to limit; that is the property behaving
 * honestly, not a gap.
 *
 * The caller owns the connection and the failure policy — the CLI exits
 * non-zero, the test harness throws.
 */
export async function installDdlGuard(sql: postgres.Sql): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url))
  await sql.unsafe(readFileSync(join(here, 'ddl-guard.sql'), 'utf8'))
}

/** What a correctly armed database looks like. Read by the boot assertion too. */
export const GUARD_EVENT_TRIGGERS = [
  'authz_guard_alter',
  'authz_guard_drop',
  'authz_guard_policy',
] as const
