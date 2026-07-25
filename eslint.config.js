import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * Size limits and bans come from docs/SPEC.md §4. They are lint rules rather than
 * review opinions on purpose — a limit nobody enforces is not a rule.
 */
export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/dist-types/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/*.config.js',
      '**/*.config.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/consistent-type-definitions': ['error', 'type'],
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],

      'max-lines': ['warn', { max: 300, skipBlankLines: true, skipComments: true }],
      'max-lines-per-function': ['warn', { max: 80, skipBlankLines: true, skipComments: true }],
      'max-params': ['error', 4],
      'max-depth': ['error', 4],
      complexity: ['warn', 15],
      'no-console': ['error', { allow: ['error'] }],
    },
  },
  {
    // Migrations are long by nature: one file is one complete schema change.
    files: ['**/db/migrations/**'],
    rules: { 'max-lines': 'off', 'max-lines-per-function': 'off' },
  },
  {
    // SPEC §4 allows a React component 250 lines of JSX; the 80-line function limit is
    // aimed at logic, and a component's return statement is not that.
    files: ['**/*.tsx'],
    rules: {
      'max-lines-per-function': ['warn', { max: 250, skipBlankLines: true, skipComments: true }],
    },
  },
  {
    /*
     * Page components are composition roots: each conditionally-rendered child is a
     * branch, so the count rises with the number of things on screen rather than with
     * how hard anything is to follow. CalendarPage tripped this twice; both times the
     * honest fix was to extract real logic (CalendarToolbar, useBookingDraft), and both
     * times the count came straight back from the JSX. Raised here rather than worked
     * around at the call site — the logic limits still apply everywhere else.
     */
    files: ['**/routes/*.tsx'],
    rules: { complexity: ['warn', 20] },
  },
  {
    files: ['**/*.test.ts', '**/*.test.tsx', '**/test/**'],
    rules: {
      'max-lines': 'off',
      'max-lines-per-function': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      // `expect(() => doThing()).toThrow()` is the idiom; braces around every one of
      // them adds noise without adding meaning.
      '@typescript-eslint/no-confusing-void-expression': 'off',
    },
  },
);
