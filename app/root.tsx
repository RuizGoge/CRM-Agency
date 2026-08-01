import { isRouteErrorResponse, Links, Meta, Outlet, Scripts, ScrollRestoration } from 'react-router'

import type { Route } from './+types/root'

import './styles/tokens/primitives.css'
import './styles/tokens/theme.css'
import './styles/tokens/motion.css'
import './styles/reset.css'

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    // v1 hard-codes light and ships no theme toggle. `color-scheme` rides
    // alongside so native controls — the date picker in Quick Schedule, the
    // tel keypad in mobile quick-add — follow the theme.
    <html lang="en-US" data-theme="light" style={{ colorScheme: 'light' }}>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  )
}

export default function App() {
  return <Outlet />
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let heading = 'Something went wrong'
  let detail = 'The problem has been recorded. Try again, or come back in a moment.'

  if (isRouteErrorResponse(error)) {
    // Cross-silo access is always an owner-scoped not-found, never a 403:
    // a 403 confirms the record exists. See docs/05-architecture.md Part III.
    heading = error.status === 404 ? 'Not found' : `${error.status} ${error.statusText}`
    detail =
      error.status === 404
        ? "This record doesn't exist, or it isn't yours."
        : 'The problem has been recorded. Try again, or come back in a moment.'
  }

  return (
    <main
      style={{ padding: 'var(--space-16) var(--space-8)', maxWidth: '38rem', margin: '0 auto' }}
    >
      <h1 style={{ fontSize: 'var(--type-2xl)', fontWeight: 'var(--font-weight-bold)' }}>
        {heading}
      </h1>
      <p style={{ marginTop: 'var(--space-3)', color: 'var(--color-text-secondary)' }}>{detail}</p>
    </main>
  )
}
