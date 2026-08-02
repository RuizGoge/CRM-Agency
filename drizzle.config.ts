import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'postgresql',
  schema: './app/db/schema/*.ts',
  out: './app/db/migrations',
  dbCredentials: {
    // The OWNER credential, never the application's. crm_app cannot create a
    // table, and that is the point: DDL belongs to the one-shot pre-deploy job
    // and to nothing that serves a request. DATABASE_URL is deliberately not
    // consulted here, so pointing the app at the owner by accident does not
    // silently give migrations somewhere to run from either.
    url:
      process.env['MIGRATION_DATABASE_URL'] ??
      process.env['DEV_DATABASE_URL'] ??
      'postgresql://crm:crm@localhost:5432/crm_dev',
  },
  // Phase 5: RLS policies, GRANTs, triggers and partial uniques are part of the
  // schema and must be reviewable as SQL. Migrations are never edited after merge.
  verbose: true,
  strict: true,
})
