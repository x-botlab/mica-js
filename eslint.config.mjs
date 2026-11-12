import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import { defineConfig, globalIgnores } from 'eslint/config';

export default defineConfig([
  globalIgnores([
    '**/dist/**',
    '**/coverage/**',
    '**/node_modules/**',
    // mica prepare 生成的 DDL 类型投影，已由 .gitignore 排除
    '**/*.d.ddl.ts',
  ]),
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    // Standalone Node ESM helpers sit outside the TypeScript projects.
    files: ['**/*.mjs'],
    languageOptions: {
      globals: { console: 'readonly', process: 'readonly', URL: 'readonly' },
    },
  },
]);
