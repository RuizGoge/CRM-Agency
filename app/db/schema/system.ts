import { sql } from 'drizzle-orm'
import { check, text } from 'drizzle-orm/pg-core'

import { ref } from './_shared'

/**
 * `ref.system_constant` — the facts a PROCESS needs before it has a tenant.
 *
 * The one that matters today is `environment`, and §3's boot assertion has been
 * unimplementable without it: *"the process exits non-zero if any
 * `tier='mvp_required'` capability is not `status='verified'` while
 * `system_constant['environment'] = 'production'`"*. It was named in Phase 5,
 * `CONTEXT.md` has carried it as missing since Sprint 1 item 1, and the
 * `is_demo`-in-production trigger is still waiting on it too.
 *
 * 🔴 WHY THIS IS A ROW AND NOT AN ENVIRONMENT VARIABLE, which is the obvious
 * cheaper answer. An env var is set by whoever deploys, and a missing one reads
 * as empty — so `environment !== 'production'` would be TRUE on a production box
 * where somebody forgot the variable, and the gate would be disarmed in exactly
 * the case it exists for. **The failure has to be loud on the machine that got
 * it wrong**, and a row that travels with the database is the thing a deploy
 * cannot forget to bring.
 *
 * 🔴 AND WHY IT DEFAULTS TO `production` RATHER THAN TO `development`. Same
 * argument, one turn further. If a fresh database claimed to be development,
 * every gate keyed on this would be silent on a database nobody had classified —
 * which is the state a real production database is in on the day it is created.
 * So an unclassified database is treated as production and refuses, and a
 * developer's database has to say so about itself. Migration 0032 derives that
 * from a fact rather than asking: a database holding a demo tenant is not a
 * production database.
 *
 * `reference` class: `crm_app` reads it and can never write it, so no request
 * can talk the process into believing it is somewhere else.
 */
export const systemConstant = ref.table(
  'system_constant',
  {
    key: text('key').primaryKey(),
    value: text('value').notNull(),
    /** Why this row exists. Same requirement the RLS exception list carries. */
    reason: text('reason').notNull(),
  },
  (t) => [
    check('system_constant_value_present', sql`length(btrim(${t.value})) > 0`),
    check('system_constant_reason_present', sql`length(btrim(${t.reason})) > 0`),
    // The vocabulary is closed HERE rather than as an enum, because an enum
    // label is `ALTER TYPE ... ADD VALUE` — a statement this project handles
    // carefully — for a set that has exactly three members and no reason to
    // grow. A fourth environment is a CHECK edit somebody has to write down.
    check(
      'system_constant_environment_known',
      sql`${t.key} <> 'environment' OR ${t.value} IN ('production', 'development', 'test')`,
    ),
    /**
     * The vault's retention clock, bounded at both ends.
     *
     * 🔴 THE UPPER BOUND IS THE ONE THAT MATTERS, and nothing else in the
     * database catches it. A too-SHORT value is already refused downstream:
     * `raw_payload_vault_purge_after_receipt` rejects zero, and a non-numeric
     * value fails its cast. A too-LONG one is silent — and errata **E9** turns
     * that silence into the defect, because this clock is doing two jobs at
     * once. It is CCPA minimisation of consumer PII, and since `Recording-Saved`
     * carries a `direct_recording_url` that 302s to a pre-signed link, it is
     * also the bound on how long a database backup remains a set of bearer
     * tokens to call audio. `3650` would read as a typo and behave as a policy.
     *
     * 30–90 days is §4.6's window. E9 is why probe evidence does NOT live under
     * this clock: operational evidence must outlive the thing it certifies,
     * consumer payloads must not.
     */
    check(
      'system_constant_vault_retention_bounded',
      sql`${t.key} <> 'webhook_vault_retention_days'
          OR (${t.value} ~ '^[0-9]{1,3}$' AND ${t.value}::integer BETWEEN 30 AND 90)`,
    ),
  ],
)
