import { index, route, type RouteConfig } from '@react-router/dev/routes'

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
  // better-auth mounts its whole surface under one splat. See the note in the
  // module for why this is the one resource route outside the endpoint factory.
  route('api/auth/*', 'routes/api/auth.ts'),
] satisfies RouteConfig
