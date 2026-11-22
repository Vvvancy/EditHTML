// @ts-check
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/** 依赖方向：editor → renderer → blocks → core，禁止反向依赖（AGENTS.md）。 */
const forbid = (/** @type {string[]} */ pkgs) => ({
  'no-restricted-imports': [
    'error',
    {
      patterns: pkgs.map((p) => ({
        group: [`@edithtml/${p}`, `@edithtml/${p}/*`],
        message: `违反依赖方向：不得依赖 @edithtml/${p}`,
      })),
    },
  ],
});

export default tseslint.config(
  { ignores: ['.claude/**', '**/dist/**', '**/node_modules/**', '**/coverage/**', 'tests/fixtures/**'] },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    languageOptions: { globals: { ...globals.es2022 } },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  { files: ['packages/core/**'], rules: forbid(['blocks', 'renderer', 'editor', 'runtime', 'cli', 'importer']) },
  { files: ['packages/blocks/**'], rules: forbid(['renderer', 'editor', 'runtime', 'cli']) },
  { files: ['packages/renderer/**'], rules: forbid(['editor', 'runtime', 'cli']) },
  { files: ['packages/cli/**', '**/*.config.{js,ts}'], languageOptions: { globals: { ...globals.node } } },
  {
    files: ['packages/{blocks,renderer,editor,runtime,importer}/**', 'apps/web/**'],
    languageOptions: { globals: { ...globals.browser } },
  },
  prettier,
);
