import { reactRouter } from '@react-router/dev/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [reactRouter()],
  // Native since Vite 8 — resolves the `~/*` alias from tsconfig.json, which
  // stays the single source of truth for path mapping.
  resolve: { tsconfigPaths: true },
  server: { port: 3000 },
  build: {
    // Emitted so the performance gate can compute a route's INITIAL JS from the
    // module graph rather than from a browser. Sprint-0 Gate 11 (P12/P13).
    //
    // The alternative was to boot the server and read the rendered <script> and
    // <link rel="modulepreload"> tags, which needs a database and a session
    // because /board redirects when signed out — a pre-merge budget check that
    // depends on auth is a budget check that gets skipped.
    manifest: true,
  },
})
