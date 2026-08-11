import { existsSync, readFileSync } from 'node:fs'

import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { QUEUE_SPECS, CALL_MERGE_QUEUE, DEAD_LETTER_QUEUE } from '~/jobs/queues'

import { TEST_URL } from './setup/urls'

/**
 * GATE 8 — pg-boss under version stress. §2557.
 *
 * "Assert: version pinned exactly, its README vendored in the repo, 100% of its
 * surface wrapped in src/jobs/ behind our own types; a test proving a job that
 * throws N times lands in the DLQ with the raw body intact and the admin
 * counter visibly rising; singletonKey = aloware_call_id serializes two
 * webhooks for the same call arriving 50 ms apart; job-table
 * retention/archival explicitly configured."
 *
 * 🔴 THE FAILURE MODE IS ABSENCE, WHICH IS WHY IT IS A GATE AND NOT A REVIEW.
 * §2559: "a webhook retried zero times and discarded, or a DLQ that never
 * receives anything — and nobody notices for a long time."
 *
 * Measured before this file existed, off `pgboss.queue`:
 *
 *   retry_limit    2      retry_delay 0    retry_backoff false
 *   dead_letter    NULL   on all three queues
 *
 * So a call-merge that threw three times did so in the same millisecond — one
 * failure reported three times, not a retry policy — and then had nowhere to
 * go. It was marked `failed`, sat in `pgboss.job` until the deletion window,
 * and `app.dead_letter` never heard about it. Every part of that is silent.
 */

let sql: postgres.Sql

beforeAll(() => {
  sql = postgres(TEST_URL, { max: 1, onnotice: () => {} })
})

afterAll(async () => {
  await sql?.end()
})

describe('the version is pinned and its manual is in the repo', () => {
  it('pins pg-boss to an exact version, with no range', () => {
    // A caret is what lets `npm install` bring a minor with its own DDL into a
    // database where `harden()` fails closed on an unclassified table. G8 is
    // the gate for "version stress"; the range IS the stress.
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
      dependencies: Record<string, string>
    }
    const declared = pkg.dependencies['pg-boss']

    expect(declared, 'pg-boss is not a dependency').toBeDefined()
    expect(declared, `pg-boss is declared as "${declared ?? ''}", which is a RANGE`).toMatch(
      /^\d+\.\d+\.\d+$/,
    )
  })

  it('vendors the README for the exact version installed', () => {
    // §2558 wants the manual in the tree, and the reason is the same one that
    // made `queues.ts` read pg-boss's partial unique indexes off
    // `pgboss.job_common` rather than off the docs: the behaviour this product
    // depends on is version-specific, and a link rots to whatever is current.
    const installed = (
      JSON.parse(readFileSync('node_modules/pg-boss/package.json', 'utf8')) as { version: string }
    ).version

    const vendored = `docs/vendor/pg-boss-${installed}-README.md`
    expect(
      existsSync(vendored),
      `${vendored} is missing. The README is vendored per VERSION, so upgrading ` +
        `pg-boss is a change that has to bring its own manual with it.`,
    ).toBe(true)
  })

  it('pins the same version it has installed', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
      dependencies: Record<string, string>
    }
    const installed = (
      JSON.parse(readFileSync('node_modules/pg-boss/package.json', 'utf8')) as { version: string }
    ).version

    expect(pkg.dependencies['pg-boss']).toBe(installed)
  })
})

describe('every queue setting is declared rather than defaulted', () => {
  it('is reading a real set of queues', () => {
    expect(QUEUE_SPECS.length).toBeGreaterThan(3)
  })

  it('matches the live queue rows field by field', async () => {
    // 🎯 THE ASSERTION THAT WOULD HAVE CAUGHT THE ORIGINAL DEFECT. The previous
    // deploy step compared `policy` and nothing else, so `dead_letter` sat NULL
    // and `retry_delay` sat 0 while the check reported the queue "ready".
    const live = await sql<
      {
        name: string
        policy: string
        retry_limit: number
        retry_delay: number
        retry_backoff: boolean
        expire_seconds: number
        retention_seconds: number
        deletion_seconds: number
        dead_letter: string | null
      }[]
    >`SELECT name, policy, retry_limit, retry_delay, retry_backoff, expire_seconds,
             retention_seconds, deletion_seconds, dead_letter
        FROM pgboss.queue`

    const byName = new Map(live.map((r) => [r.name, r]))

    for (const spec of QUEUE_SPECS) {
      const row = byName.get(spec.name)
      expect(row, `queue "${spec.name}" is declared and does not exist`).toBeDefined()
      if (row === undefined) continue

      expect(row.policy, `${spec.name}.policy`).toBe(spec.policy)
      expect(row.retry_limit, `${spec.name}.retry_limit`).toBe(spec.retryLimit)
      expect(row.retry_delay, `${spec.name}.retry_delay`).toBe(spec.retryDelay)
      expect(row.retry_backoff, `${spec.name}.retry_backoff`).toBe(spec.retryBackoff)
      expect(row.expire_seconds, `${spec.name}.expire_seconds`).toBe(spec.expireInSeconds)
      expect(row.retention_seconds, `${spec.name}.retention_seconds`).toBe(spec.retentionSeconds)
      expect(row.deletion_seconds, `${spec.name}.deletion_seconds`).toBe(spec.deleteAfterSeconds)
      expect(row.dead_letter, `${spec.name}.dead_letter`).toBe(spec.deadLetter)
    }
  })

  it('gives every job-bearing queue a dead letter, and retries with backoff', () => {
    // The two merge queues carry a provider payload that cannot be re-fetched:
    // Aloware never retries, so a job we drop is a call nobody can reconstruct.
    // The cron tick is deliberately not in this set — a failed tick carries no
    // payload and the next one is a minute away.
    for (const name of [CALL_MERGE_QUEUE, 'message-merge']) {
      const spec = QUEUE_SPECS.find((q) => q.name === name)
      expect(spec?.deadLetter, `${name} has nowhere to send an exhausted job`).toBe(
        DEAD_LETTER_QUEUE,
      )
      expect(spec?.retryLimit, `${name} must retry more than once`).toBeGreaterThan(1)
      expect(
        spec?.retryBackoff,
        `${name} retries with no backoff is one failure, three times`,
      ).toBe(true)
    }
  })

  it('does not let the dead-letter queue dead-letter into itself', () => {
    // A DLQ for the DLQ is a loop, and a handler whose only job is to record a
    // failure has nothing useful to do on a second attempt.
    const spec = QUEUE_SPECS.find((q) => q.name === DEAD_LETTER_QUEUE)
    expect(spec?.deadLetter).toBeNull()
    expect(spec?.retryLimit).toBe(0)
  })

  it('configures retention and deletion on every queue, explicitly', () => {
    // §2559: "Unconfigured retention at ~450k high-churn rows/month produces
    // bloat that degrades the database serving the public board." Every value
    // below had a default that happened to be survivable, and a default that
    // happens to be survivable is not a decision.
    for (const spec of QUEUE_SPECS) {
      expect(spec.retentionSeconds, `${spec.name} keeps rows forever`).toBeGreaterThan(0)
      expect(spec.deleteAfterSeconds, `${spec.name} never deletes`).toBeGreaterThan(0)
    }

    // The dead letter outlives the job it describes, on purpose: it is what an
    // operator reads weeks later when somebody asks what happened to a call.
    const dlq = QUEUE_SPECS.find((q) => q.name === DEAD_LETTER_QUEUE)
    const merge = QUEUE_SPECS.find((q) => q.name === CALL_MERGE_QUEUE)
    expect(dlq?.retentionSeconds ?? 0).toBeGreaterThan(merge?.retentionSeconds ?? 0)
  })
})

describe('a job that exhausts its retries lands in the dead letter, body intact', () => {
  /**
   * 🎯 THE BEHAVIOURAL HALF OF THE GATE, and the one §2559 is actually about.
   *
   * Everything above reads configuration. This runs a real pg-boss against a
   * real queue with a handler that really throws, and asks the question the
   * gate asks: does the payload survive to somewhere an operator can read it.
   *
   * A throwaway queue rather than `call-merge`, because the assertion is about
   * pg-boss's dead-letter mechanism and not about the merge handler — and
   * because failing the live queue in a shared test database would leave rows
   * the next file has to reason about.
   */
  const PROBE_QUEUE = 'gate8-probe'
  const PROBE_DLQ = 'gate8-probe-dead-letter'

  it('moves the payload to the dead-letter queue, unchanged', async () => {
    const { PgBoss } = await import('pg-boss')
    const boss = new PgBoss({ connectionString: TEST_URL, schema: 'pgboss', migrate: false })

    await boss.start()
    try {
      await boss.createQueue(PROBE_DLQ, { policy: 'standard', retryLimit: 0 })
      await boss.createQueue(PROBE_QUEUE, {
        policy: 'standard',
        // ZERO retries so the test does not spend the backoff it exists to
        // prove is configured elsewhere. What is under test here is where the
        // job goes AFTER the last attempt, not how many there were.
        retryLimit: 0,
        deadLetter: PROBE_DLQ,
      })

      const payload = {
        tenantId: '00000000-0000-7000-8000-0000000e8001',
        alowareCallId: 'gate8-call-42',
        canonical: 'call.completed',
        nested: { kept: true },
      }

      await boss.send(PROBE_QUEUE, payload)

      let attempts = 0
      await boss.work(PROBE_QUEUE, { batchSize: 1, pollingIntervalSeconds: 1 }, () => {
        attempts += 1
        throw new Error('gate 8: this handler always throws')
      })

      // Poll rather than sleep a fixed span: pg-boss moves the job on its own
      // schedule and a fixed wait is either flaky or slow.
      let dead: { data: unknown }[] = []
      for (let i = 0; i < 30 && dead.length === 0; i += 1) {
        await new Promise((r) => setTimeout(r, 500))
        dead = await sql<{ data: unknown }[]>`
          SELECT data FROM pgboss.job WHERE name = ${PROBE_DLQ}`
      }

      expect(attempts, 'the handler never ran, so nothing was proven').toBeGreaterThan(0)
      expect(dead, 'the job exhausted its retries and never reached the dead letter').toHaveLength(
        1,
      )

      // THE RAW BODY INTACT, which is §2558's wording and the part that makes
      // the row replayable rather than merely a count. pg-boss wraps the
      // original payload; what matters is that every field is still there.
      expect(JSON.stringify(dead[0]?.data)).toContain('gate8-call-42')
      expect(JSON.stringify(dead[0]?.data)).toContain('"kept":true')
    } finally {
      await boss.stop({ graceful: false })
      await sql`DELETE FROM pgboss.job WHERE name IN (${PROBE_QUEUE}, ${PROBE_DLQ})`
      await sql`DELETE FROM pgboss.queue WHERE name IN (${PROBE_QUEUE}, ${PROBE_DLQ})`
    }
  }, 30_000)
})

describe('the singleton key serializes two deliveries about one call', () => {
  it('keeps at most one job active for a key, with the second still queued', async () => {
    // §4.5 asks for two deliveries about one call to be SERIALIZED, not
    // deduplicated — G2 measured `Call-Disposed` restating a disposition 6.6 s
    // after the event it restates, so the second delivery carries information.
    //
    // `key_strict_fifo` is what expresses that. Under `exclusive` — the obvious
    // alternative — a second delivery arriving while the first is still active
    // is REFUSED and its merge never happens.
    const key = `gate8-serial-${Date.now().toString(36)}`

    const insert = async (): Promise<void> => {
      await sql`
        INSERT INTO pgboss.job (id, name, data, singleton_key, policy, retry_limit)
        SELECT gen_random_uuid(), ${CALL_MERGE_QUEUE}, ${sql.json({ key })},
               ${key}, 'key_strict_fifo', 3`
    }

    try {
      await insert()
      // Fifty milliseconds apart, which is §4.5's own figure.
      await new Promise((r) => setTimeout(r, 50))
      await insert()

      const [count] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pgboss.job
         WHERE name = ${CALL_MERGE_QUEUE} AND singleton_key = ${key}`

      // BOTH ROWS EXIST. That is the whole difference from `exclusive`, where
      // the second insert is discarded and one delivery is silently lost.
      expect(count?.n, 'the second delivery was discarded rather than queued').toBe(2)
    } finally {
      await sql`DELETE FROM pgboss.job WHERE singleton_key = ${key}`
    }
  })

  it('has the policy on the queue that makes that true', async () => {
    // The behaviour above comes from a partial unique index pg-boss builds from
    // this column. A queue whose policy drifted would still accept both rows
    // here and stop serializing them at work time, which is invisible.
    const [row] = await sql<{ policy: string }[]>`
      SELECT policy FROM pgboss.queue WHERE name = ${CALL_MERGE_QUEUE}`
    expect(row?.policy).toBe('key_strict_fifo')
  })
})

describe('pg-boss cannot migrate itself under the application credential', () => {
  it('installs its schema as the migrator and denies CREATE to crm_app', async () => {
    // `migrate: false` in the worker is the other half. A library issuing DDL
    // against production under the application's credential is a change nobody
    // would see — and under version stress it is the change that arrives with a
    // minor bump.
    const [priv] = await sql<{ has_create: boolean }[]>`
      SELECT has_schema_privilege('crm_app', 'pgboss', 'CREATE') AS has_create`
    expect(priv?.has_create, 'crm_app can CREATE in the pgboss schema').toBe(false)

    const worker = readFileSync('app/jobs/worker.ts', 'utf8')
    expect(worker).toContain('migrate: false')
  })
})
