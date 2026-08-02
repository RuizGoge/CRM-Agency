import { auth } from '~/lib/auth/server'

/**
 * better-auth's own endpoints: sign-in, sign-out, session.
 *
 * The one resource route that does NOT go through the endpoint factory, and
 * the reason is structural rather than an exemption: the factory's job is to
 * establish tenant context and owner scope around a handler, and these routes
 * run before any identity exists to establish it from. Everything downstream
 * of a session goes through the factory; this is what creates the session.
 *
 * It is therefore also the only route the silo suite cannot probe with a
 * foreign id, and it carries `siloProbe: { kind: 'none' }` in spirit — there
 * is no tenant-owned record here to scope.
 */
export async function loader({ request }: { request: Request }): Promise<Response> {
  return auth.handler(request)
}

export async function action({ request }: { request: Request }): Promise<Response> {
  return auth.handler(request)
}
