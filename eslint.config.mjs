import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import { defineConfig, globalIgnores } from 'eslint/config';

export default defineConfig([
  globalIgnores([
    '**/dist/**',
    '**/coverage/**',
    '**/node_modules/**',
    // mica prepare 生成的 .mica 类型环境
    '**/.mica/**',
    'apps/playground/public/draco/**',
    // mica prepare 生成的 DDL 类型投影，已由 .gitignore 排除
    '**/*.d.ddl.ts',
  ]),
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ['examples/fused-workbench/*/src/monitor/*.js'],
    languageOptions: {
      globals: {
        acquireDeviceViewApi: 'readonly',
        document: 'readonly',
      },
    },
  },
  {
    // Standalone Node ESM helpers sit outside the TypeScript projects.
    files: ['**/*.mjs'],
    languageOptions: {
      globals: {
        Buffer: 'readonly',
        console: 'readonly',
        process: 'readonly',
        URL: 'readonly',
      },
    },
  },
]);
