import { startWorker, workerEnabled } from './worker'

/**
 * Folds the worker INTO the web process.
 *
 * Until this file existed, the foldable topology was declared and not wired:
 * `npm run worker` ran the split half, `workerEnabled()` read `PROCESS_ROLES`,
 * and nothing started a worker inside the web process. Jorge's ruling is that
 * the three processes are deployment configuration rather than an architectural
 * assumption — and by this project's founding rule, claiming a fold that has
 * never run is documentation, not a mechanism. This is the mechanism.
 *
 * Called from `app/entry.server.tsx`, which is the one module the web process
 * loads exactly once at boot regardless of which routes are hit.
 */

/**
 * Survives module re-evaluation, which module scope does not.
 *
 * Vite re-evaluates the SSR module graph on change, so a plain module-level
 * flag resets and a second pg-boss instance starts on every edit — each one
 * holding connections against a pool whose ceiling is 8. The registry key is
 * `Symbol.for`, so it is the same symbol across every re-evaluation in the
 * process.
 */
const BOOTED: unique symbol = Symbol.for('crm.folded-worker.booted')

interface BootRegistry {
  [BOOTED]?: true
}

/**
 * Starts the worker when this process carries the `worker` role, and REFUSES TO
 * START otherwise-serving when it cannot.
 *
 * The refusal is the same posture as the G4(a) boot assertion in `app/db/pool.ts`
 * and for the same reason: the alternative failure has no symptom. A web process
 * that serves every page perfectly while firing none of its reminders looks
 * healthy from every angle — no error page, no failing request, no red build.
 * In a FOLDED topology there is no separate worker process whose absence anyone
 * would notice, so the quiet outcome would be permanent.
 *
 * And a reminder is a legal artifact, not a convenience: it has to fire once, at
 * the right moment, inside the legal calling window. A deploy that will not come
 * up is loud and immediate. That is the trade being made, deliberately.
 */
export function bootFoldedWorker(): void {
  if (!workerEnabled()) return

  const registry = globalThis as BootRegistry
  if (registry[BOOTED] === true) return
  registry[BOOTED] = true

  void startWorker()
    .then(() => {
      // Said out loud on purpose. Without this line a folded worker that is
      // running and a folded worker that never started look exactly the same
      // from the console, and the whole point of this file is that the fold is
      // observable rather than asserted.
      console.log('[worker] folded into the web process. Dispatching every minute.')
    })
    .catch((err: unknown) => {
      const detail = err instanceof Error ? err.message : String(err)

      console.error(
        `JOBS002: refusing to start. This process carries the "worker" role and the ` +
          `worker did not start, so nothing here will fire scheduled reminders.\n\n` +
          `  underlying error: ${detail}\n\n` +
          `If the pg-boss schema is missing, install it AS THE MIGRATOR — the worker ` +
          `runs with migrate:false on purpose, so it cannot create its own:\n\n` +
          `  npm run db:jobs\n\n` +
          `A reminder has to fire once, at the right moment, inside the legal calling ` +
          `window. A web process that serves pages while silently firing none of them ` +
          `is the failure this refusal exists to prevent. To run this process without ` +
          `a worker, set PROCESS_ROLES to a list that does not include "worker".`,
      )
      process.exit(1)
    })
}

/**
 * No SIGTERM/SIGINT handler here, and that is a decision rather than an omission.
 *
 * An abrupt kill mid-dispatch is ALREADY a handled case: `claimed_at` is a lease,
 * so a job whose process died is picked up again once the lease expires, and the
 * lease is deliberately shorter than the fifteen minutes after which a reminder is
 * dropped rather than sent late. A shutdown hook that the dev server's own
 * `process.exit` can cut short would add a second, weaker path to a guarantee the
 * lease already carries — theatre over a mechanism that works.
 */
