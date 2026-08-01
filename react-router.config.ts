import type { Config } from '@react-router/dev/config'

export default {
  // Server-side render by default. ADR: the first paint must carry real board
  // data (Inertia-style page props are what make LCP < 1.5s reachable with 500
  // leads); a rendered-but-empty shell pays SSR cost for nothing.
  ssr: true,
} satisfies Config
