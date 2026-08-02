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
    route('board', 'routes/ui/board.tsx'),
    route('earnings', 'routes/ui/leaderboard.tsx'),
  ]),

  route('sign-out', 'routes/api/sign-out.ts'),
  route('api/board', 'routes/api/board.ts'),
  route('api/leaderboard', 'routes/api/leaderboard.ts'),
  route('api/my-day', 'routes/api/my-day.ts'),
  // better-auth mounts its whole surface under one splat. See the note in the
  // module for why this is the one resource route outside the endpoint factory.
  route('api/auth/*', 'routes/api/auth.ts'),
] satisfies RouteConfig
