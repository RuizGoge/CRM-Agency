/**
 * The public surface of the data layer. Two functions and their types.
 *
 * Everything else in `app/db/**` is unreachable from application code by build
 * rule, not by convention — see the DATA-ACCESS GUARD in `eslint.config.js`.
 */
export { withSystemWork, withTenant } from './client'
export type { ScopeMode, SessionIdentity, Tx } from './client'
