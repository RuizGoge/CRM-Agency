import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'

import { authDb } from '~/db/auth-client'
import { account, session, user, verification } from '~/db/schema/auth'

/**
 * Authentication.
 *
 * Deliberately small. Email and password only, no social providers, and — by
 * the Phase-5 stack decision — **no transactional email in the MVP**. The
 * consequence is stated rather than discovered: there is no self-service
 * password reset. A seller who forgets their password needs an admin to set a
 * new one. Adding email later turns that back on without a schema change.
 *
 * better-auth owns the `auth` schema and never touches `app`. The bridge from
 * an authenticated login to a tenant membership lives in `./identity.ts`.
 */
export const auth = betterAuth({
  baseURL: process.env['BETTER_AUTH_URL'] ?? 'http://localhost:3000',

  /**
   * Signs the session cookie. The development fallback is deliberately
   * obvious: a real deployment sets BETTER_AUTH_SECRET, and if it ever ships
   * with this value the string itself is the evidence.
   */
  secret: process.env['BETTER_AUTH_SECRET'] ?? 'dev-only-insecure-secret-change-me',

  database: drizzleAdapter(authDb, {
    provider: 'pg',
    // Passed explicitly so better-auth writes into schema `auth` rather than
    // `public`. `public` is 'managed' in security.schema_policy, so a table
    // landing there would break the next deploy — which is the gate working.
    schema: { user, session, account, verification },
  }),

  emailAndPassword: {
    enabled: true,
    requireEmailVerification: false,
    // `sendResetPassword` is deliberately NOT configured, and its absence is
    // the decision rather than an omission. There is no transactional email in
    // the MVP, so a reset link has nothing to travel on; wiring a handler here
    // would render a "check your email" screen for a message that never
    // arrives. Password recovery is an admin action until email ships in V1.1.
  },

  session: {
    // Sellers work a full shift; re-authenticating mid-day is friction on the
    // one screen that has to feel fast.
    expiresIn: 60 * 60 * 12,
    updateAge: 60 * 60,
  },

  advanced: {
    // The session cookie is the credential. Nothing about it is readable from
    // client JavaScript.
    useSecureCookies: process.env['NODE_ENV'] === 'production',
  },
})
