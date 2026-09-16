// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      'packages/domain/src/generated/**',
      '.hoplite/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        // Test files are excluded from the build tsconfigs; the per-package tsconfig.test.json projects
        // include them so type-aware rules run on tests too.
        project: [
          './tsconfig.json',
          './packages/*/tsconfig.test.json',
          './apps/*/tsconfig.test.json',
        ],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      '@typescript-eslint/no-non-null-assertion': 'error',
      'no-console': ['error', { allow: ['error'] }],
    },
  },
  {
    files: ['apps/cli/src/**/*.ts', 'tools/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
  {
    // Plain script files are not part of a TypeScript project, so type-aware rules cannot run on them.
    files: ['**/*.js', '**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    // Node tool scripts: they run under Node's globals and print to stdout by design.
    files: ['tools/**/*.mjs'],
    languageOptions: {
      globals: { console: 'readonly', process: 'readonly', URL: 'readonly' },
    },
    rules: { 'no-console': 'off' },
  },
  prettier,
);
