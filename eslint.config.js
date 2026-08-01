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
)
