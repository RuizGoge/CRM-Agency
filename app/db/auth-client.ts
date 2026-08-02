import { drizzle } from 'drizzle-orm/postgres-js'

import { pool } from './pool'

/**
 * A database handle with NO session context, for the authentication layer and
 * nothing else.
 *
 * This is a deliberate, named exception to the rule that every unit of work
 * opens with `app.begin_request`. It has to be: authentication is what
 * PRODUCES the identity that `begin_request` verifies, so it necessarily runs
 * before any identity exists. There is no ordering in which the session check
 * can itself be session-scoped.
 *
 * The exception is bounded three ways:
 *   1. Only `app/lib/auth/**` may import this file, enforced in eslint.config.js
 *      alongside the reason. Every other importer fails the build.
 *   2. It reaches only the `auth` schema. better-auth never touches `app`.
 *   3. The bridge from an authenticated login to a tenant membership goes
 *      through `resolveIdentity`, which is the only thing that reads
 *      `app.app_user` on this handle, and it reads exactly one row.
 *
 * DECLARED RESIDUAL RISK: the `auth` schema is on the versioned RLS exception
 * list, so password hashes and session tokens are readable by `crm_app`. RLS
 * cannot help here — at the moment a session is validated there is no session
 * context to scope by, which is the chicken-and-egg this comment exists to
 * name rather than hide. Closing it properly means a fourth Postgres role used
 * only by the auth layer; that is a real option and it is not taken today.
 */
export const authDb = drizzle(pool)
