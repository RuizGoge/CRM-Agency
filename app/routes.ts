import { index, layout, route, type RouteConfig } from '@react-router/dev/routes'

/**
 * Two trees, and the split is load-bearing (docs/05-architecture.md Part III):
 *
 *   routes/ui/**   document routes. Exactly one is allowed to export a loader
 *                  that serves board data as SSR HTML; every other UI route
 *                  gets its data from a resource route.
 *   routes/api/**  resource routes — the ONLY server API. Every module here
 *                  goes through the endpoint factory so the generated registry
 *                  can drive the cache, silo, auth and topology suites.
 */
export default [
  index('routes/ui/home.tsx'),
  route('sign-in', 'routes/ui/sign-in.tsx'),

  // Everything a seller works inside sits under one shell, which is also where
  // the signed-out redirect lives — once, rather than repeated per screen.
  layout('routes/ui/shell.tsx', [
    route('my-day', 'routes/ui/my-day.tsx'),
    route('my-book', 'routes/ui/my-book.tsx'),
    route('board', 'routes/ui/board.tsx'),
    route('earnings', 'routes/ui/leaderboard.tsx'),
    // No loader, deliberately: the sanctioned UI-loader count is one and three
    // exist, so `ui.loader_whitelist` (shrink_only) would refuse a fourth.
    route('contacts/:contactId', 'routes/ui/contact.tsx'),
    // Admin-only by policy, not by this line: dead_letter and admin_alert are
    // tenant_admin_only, so a seller reaching this URL reads zero rows and the
    // screen renders its no-permission state rather than a table of zeros.
    route('admin/integration-health', 'routes/ui/integration-health.tsx'),
    // Correcting a wrong number on the public board. Admin-only by policy, not
    // by this line: `app.ledger_adjust` checks the role inside the definer.
    route('admin/earnings', 'routes/ui/earnings-admin.tsx'),
  ]),

  route('sign-out', 'routes/api/sign-out.ts'),
  route('api/board', 'routes/api/board.ts'),
  route('api/leaderboard', 'routes/api/leaderboard.ts'),
  route('api/my-day', 'routes/api/my-day.ts'),
  route('api/my-book', 'routes/api/my-book.ts'),
  route('api/home-setup', 'routes/api/home-setup.ts'),
  route('api/search', 'routes/api/search.ts'),
  route('api/contacts/:contactId', 'routes/api/contact.ts'),
  route('api/contacts/:contactId/timeline', 'routes/api/timeline.ts'),
  route('api/quick-add', 'routes/api/quick-add.ts'),
  route('api/opportunities', 'routes/api/opportunities.ts'),
  route('api/notes', 'routes/api/notes.ts'),
  route('api/calls', 'routes/api/calls.ts'),
  // The ingest edge. NOT under `api/`, and versioned, because ruling P8.2 fixes
  // both: this URL is configured inside Aloware's panel and we cannot redeploy
  // them. `/hooks/…` and `{path_secret}` appear in §4.2, §7 and two diagrams and
  // are struck by name.
  route('webhooks/aloware/v1/:endpointToken', 'routes/api/webhooks-aloware.ts'),
  route('api/celebrate', 'routes/api/celebrate.ts'),
  route('api/integration-health', 'routes/api/integration-health.ts'),
  // The writer the ingest edge never had. Admin-only, and the check lives inside
  // the definer rather than here — `webhook_endpoint` is `definer_only`, so
  // `crm_app` holds no privilege on the table at all.
  route('api/webhook-endpoints', 'routes/api/webhook-endpoints.ts'),
  // The compensating append. The ledger stays append-only; this never edits.
  route('api/ledger-corrections', 'routes/api/ledger-corrections.ts'),
  // better-auth mounts its whole surface under one splat. See the note in the
  // module for why this is the one resource route outside the endpoint factory.
  route('api/auth/*', 'routes/api/auth.ts'),
] satisfies RouteConfig
