import { redirect } from 'react-router'

import { auth } from '~/lib/auth/server'

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
