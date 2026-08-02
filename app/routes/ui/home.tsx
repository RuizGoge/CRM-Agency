import { redirect } from 'react-router'

import { resolveIdentity } from '~/lib/auth/identity'

import type { Route } from './+types/home'

/**
 * The front door.
 *
 * It used to be the Phase-6 foundation screen, which existed to prove the dev
 * command served a page off the canonical token layer. That job is done — the
 * tokens are now carried by screens a seller actually uses, which is a
 * stronger proof than a page nobody visits.
 *
 * My Day rather than Earnings: the board is what a seller checks, but My Day
 * is what they work from.
 */
export async function loader({ request }: Route.LoaderArgs): Promise<Response> {
  const identity = await resolveIdentity(request)
  return redirect(identity ? '/my-day' : '/sign-in')
}

export default function Home(): React.JSX.Element {
  // Unreachable: the loader always redirects. Present because an index route
  // needs a component, and returning null is the honest version of "this
  // renders nothing".
  return <></>
}
