import { reactRouter } from '@react-router/dev/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [reactRouter()],
  // Native since Vite 8 — resolves the `~/*` alias from tsconfig.json, which
  // stays the single source of truth for path mapping.
  resolve: { tsconfigPaths: true },
  server: { port: 3000 },
})
