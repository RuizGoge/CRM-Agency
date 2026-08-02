import js from '@eslint/js'
import reactHooks from 'eslint-plugin-react-hooks'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: ['build/**', '.react-router/**', 'node_modules/**', 'app/db/migrations/**'],
  },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: {
          // eslint.config.js is the one linted file outside tsconfig's include
          // (which covers **/*.ts and **/*.tsx, so every .ts config is already in).
          allowDefaultProject: ['*.js'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Phase 5 non-negotiable: no implicit any anywhere.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },

  {
    files: ['app/**/*.tsx'],
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },

  // ---------------------------------------------------------------------------
  // MONEY GUARD — Phase 5 signed non-negotiable #4, layer (b).
  //
  // Money is bigint cents behind a branded `Money` type, and `app/lib/money/**`
  // is the ONLY place allowed to convert or do arithmetic on it. Everywhere else
  // these calls are how a float silently enters the money path: the public board
  // then shows 2,999.88 instead of 3,000 and no test goes red.
  // ---------------------------------------------------------------------------
  {
    files: ['app/**/*.ts', 'app/**/*.tsx'],
    ignores: ['app/lib/money/**'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.name='Number']",
          message:
            'Number() is banned outside app/lib/money/**. Money is bigint cents behind the branded Money type — see app/lib/money/money.ts and CLAUDE.md.',
        },
        {
          selector: "CallExpression[callee.name='parseFloat']",
          message: 'parseFloat() is banned outside app/lib/money/**. Money never becomes a float.',
        },
        {
          selector: "CallExpression[callee.object.name='Math'][callee.property.name='round']",
          message:
            'Math.round() is banned outside app/lib/money/**. Rounding money is a domain decision, not a formatting one.',
        },
      ],
    },
  },

  // ---------------------------------------------------------------------------
  // DATA-ACCESS GUARD — Sprint 1.2.
  //
  // The connection pool is module-private inside app/db/client.ts, and the only
  // supported way into the database is withTenant / withSystemWork via `~/db`.
  // A query issued outside that envelope runs with no session context: the
  // policies make it return zero rows rather than another seller's book, but a
  // surface that silently renders nothing is its own defect. This makes the
  // shortcut unavailable rather than discouraged.
  // ---------------------------------------------------------------------------
  {
    files: ['app/**/*.ts', 'app/**/*.tsx'],
    ignores: ['app/db/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/db/client', '~/db/client', '**/app/db/client'],
              message:
                'Import { withTenant } from "~/db". The pool is module-private; reaching past it means a unit of work with no session context.',
            },
            {
              group: ['postgres', 'drizzle-orm/postgres-js'],
              message:
                'Only app/db/** may construct a database connection. Application code uses withTenant from "~/db".',
            },
          ],
        },
      ],
    },
  },

  // ---------------------------------------------------------------------------
  // SESSION-CONTEXT GUARD — Sprint 1.2.
  //
  // set_config(key, value, true) scopes the setting to the current transaction
  // and resets it at COMMIT. With `false`, or with a bare SET, the setting is
  // SESSION-scoped and survives — so a transaction-mode pooler hands the next
  // client a connection still carrying the previous seller's identity. The
  // pages render perfectly, just with the wrong rows, and nothing errors.
  //
  // app/db/migrations/** is ignored globally: migrations legitimately use
  // `SET search_path` inside SECURITY DEFINER functions.
  // ---------------------------------------------------------------------------
  {
    files: ['app/**/*.ts', 'app/**/*.tsx', 'tests/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'TemplateElement[value.raw=/set_config\\s*\\([^)]*,\\s*false\\s*\\)/i]',
          message:
            'set_config(..., false) is SESSION-scoped and survives the transaction. The third argument is is_local and must be true — this is the invariant that makes a transaction-mode pooler safe.',
        },
        {
          selector: 'TemplateElement[value.raw=/\\bSET\\s+(?!LOCAL\\b)/]',
          message:
            'Use SET LOCAL. A bare SET is session-scoped and leaks across transactions on a pooled connection.',
        },
      ],
    },
  },
)
