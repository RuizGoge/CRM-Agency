import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'postgresql',
  schema: './app/db/schema/*.ts',
  out: './app/db/migrations',
  dbCredentials: {
    url: process.env['DATABASE_URL'] ?? 'postgresql://crm:crm@localhost:5432/crm_dev',
  },
  // Phase 5: RLS policies, GRANTs, triggers and partial uniques are part of the
  // schema and must be reviewable as SQL. Migrations are never edited after merge.
  verbose: true,
  strict: true,
})
