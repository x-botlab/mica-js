import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import dts from 'vite-plugin-dts';
import { defineConfig } from 'vitest/config';

const outDir = fileURLToPath(new URL('./dist', import.meta.url));
const declarationSource = fileURLToPath(new URL('./src/sandbox-worker.d.ts', import.meta.url));
const bundledEntries = ['index.d.ts', 'vite.d.ts'];
const declarationReference = '/// <reference path="./sandbox-worker.d.ts" />';

/**
 * `bundleTypes` drops ambient modules and deletes every declaration that is not an entry, so the
 * `*?sandbox-worker` module is copied next to the bundled entries and referenced from their first
 * line. TypeScript only honours reference directives before statements.
 */
async function publishSandboxWorkerDeclaration(): Promise<void> {
  const declaration = await readFile(declarationSource, 'utf-8');
  await writeFile(resolve(outDir, 'sandbox-worker.d.ts'), declaration);
  for (const entry of bundledEntries) {
    const path = resolve(outDir, entry);
    const content = await readFile(path, 'utf-8');
    if (!content.startsWith(declarationReference)) {
      await writeFile(path, `${declarationReference}\n${content}`);
    }
  }
}

export default defineConfig({
  build: {
    lib: {
      entry: {
        index: 'src/index.ts',
        vite: 'src/vite.ts',
      },
      formats: ['es'],
      fileName: (_format, entryName) => `${entryName}.js`,
    },
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      // The Vite plugins run in the consumer's Node build config, so Node built-ins stay imports.
      external: ['rolldown', /^node:/],
    },
    minify: false,
  },
  plugins: [
    dts({
      include: ['src'],
      exclude: ['src/**/*.test.ts'],
      // One flattened declaration, so node16 consumers never follow extensionless imports.
      bundleTypes: true,
      afterBuild: publishSandboxWorkerDeclaration,
    }),
  ],
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
