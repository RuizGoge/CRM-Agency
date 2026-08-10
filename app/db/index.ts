/**
 * The public surface of the data layer. Two functions and their types.
 *
 * Everything else in `app/db/**` is unreachable from application code by build
 * rule, not by convention — see the DATA-ACCESS GUARD in `eslint.config.js`.
 */
export {
  claimDueJobs,
  claimOutbox,
  ensurePartitions,
  ingestWebhook,
  withSystemWork,
  withTenant,
} from './client'
export type {
  ClaimedDelivery,
  ClaimedJob,
  IngestInput,
  IngestOutcome,
  ScopeMode,
  SessionIdentity,
  Tx,
} from './client'

/**
 * The provider capability registry (§3), read once per process.
 *
 * A third export on a surface whose comment says "two functions", and the
 * reason it belongs here rather than in the communications module is the same
 * reason the guard exists: reading it touches the driver, and only `app/db/**`
 * may. What the module owns is the TYPE gate — `alowareCapability` — which is
 * where callers actually go.
 */
export { ensureCapabilities } from './pool'
