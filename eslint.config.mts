import { dirname } from 'path';
import { fileURLToPath } from 'url';

import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export default defineConfig([
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  {
    files: ['src/**/*.ts', 'lib/**/*.ts'],
    languageOptions: {
      parserOptions: {
        project: './tsconfig.json',
        tsconfigRootDir: __dirname,
      },
      globals: globals.node,
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/explicit-function-return-type': 'off',
    },
  },

  {
    ignores: ['dist/**', 'node_modules/**'],
  },
]);
