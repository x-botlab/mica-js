import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import dts from 'vite-plugin-dts';
import { defineConfig } from 'vitest/config';
import { micaSandboxPlugins } from '@mica-js/sandbox/vite';
import { micaWidgetPlugins } from './src/build/vite-plugin';

const outDir = fileURLToPath(new URL('./dist', import.meta.url));
const declarationSource = fileURLToPath(new URL('./src/virtual-runtime.d.ts', import.meta.url));
const declarationReference = '/// <reference path="./virtual-runtime.d.ts" />';

/**
 * `bundleTypes` drops ambient modules and deletes every declaration that is not an entry, so the
 * `?audio-worklet` / `?audio-worklet-code` module declarations are copied next to the bundled
 * entries and referenced from `vite.d.ts`, the entry that publishes the plugins behind them.
 * TypeScript only honours reference directives before statements.
 */
async function publishQueryDeclarations(): Promise<void> {
  const declaration = await readFile(declarationSource, 'utf-8');
  await writeFile(resolve(outDir, 'virtual-runtime.d.ts'), declaration);
  const path = resolve(outDir, 'vite.d.ts');
  const content = await readFile(path, 'utf-8');
  if (!content.includes(declarationReference)) {
    await writeFile(path, `${declarationReference}\n${content}`);
  }
}

export default defineConfig({
  // A library ships next to its assets; a root-absolute base would break every deployment below '/'.
  base: './',
  resolve: { conditions: ['source', 'module', 'browser', 'development|production'] },
  build: {
    lib: {
      entry: {
        index: 'src/index.ts',
        vite: 'src/build/vite.ts',
      },
      formats: ['es'],
      fileName: (_format, entryName) => `${entryName}.js`,
    },
    target: 'es2022',
    sourcemap: true,
    minify: false,
    rollupOptions: {
      external: [
        '@mica-js/core',
        '@mica-js/core/canvas',
        '@mica-js/core/lifecycle',
        '@mica-js/core/logging',
        '@mica-js/core/rpc',
        '@mica-js/sandbox',
        '@mica-js/simulator',
        'rolldown',
        'vite',
      ],
    },
  },
  plugins: [
    // Both bundles the package inlines are built here, in memory: `?sandbox-worker-code` for the
    // guest worker and `?audio-worklet-code` for the worklet. Neither becomes a dist file.
    ...micaSandboxPlugins(),
    ...micaWidgetPlugins(),
    dts({
      tsconfigPath: './tsconfig.build.json',
      entryRoot: 'src',
      exclude: ['src/**/*.test.ts', 'src/**/test-helpers.ts'],
      // One flattened declaration per entry, so node16 consumers never follow extensionless imports.
      bundleTypes: true,
      afterBuild: publishQueryDeclarations,
    }),
  ],
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
