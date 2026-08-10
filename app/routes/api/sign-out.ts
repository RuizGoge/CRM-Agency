import { redirect } from 'react-router'

import { auth } from '~/lib/auth/server'
import { defineEndpoint } from '~/lib/endpoint/define'

/**
 * Sign out, as its own route.
 *
 * It started as an action on the shell layout, which does not work and fails
 * in a way worth remembering: a `<Form method="post">` with no `action` posts
 * to the ACTIVE route, and a layout has no path of its own, so the request
 * resolved to `/` — which has a loader and no action, and answered 405.
 *
 * A dedicated route is also the more honest shape. Ending a session is an
 * operation, not a property of the frame the screens sit in.
 */
export async function action({ request }: { request: Request }): Promise<Response> {
  const response = await auth.api.signOut({ headers: request.headers, asResponse: true })
  const cookie = response.headers.get('set-cookie')

  return redirect('/sign-in', cookie ? { headers: { 'set-cookie': cookie } } : undefined)
}

/** A GET here is someone typing the URL. Nothing to show, and nothing to do. */
export function loader(): Response {
  return redirect('/my-day')
}

/**
 * Sign out, as its own route.
 */
export const endpoint = defineEndpoint({
  method: 'POST',
  path: '/sign-out',
  role: 'web',
  audience: 'owner',
  scope: 'owner',
  surface: 'json',
  summary: 'Destroys the session and redirects to sign-in.',
  idempotency: {
    kind: 'natural',
    constraint: 'destroying an already-destroyed session is a no-op that still redirects',
  },
  siloProbe: {
    kind: 'none',
    reason:
      'Acts only on the session cookie the caller presented and reads no tenant data. There is no id to present.',
  },
})
