/**
 * Bundles every sandbox guest entry into a single self-contained file.
 *
 * `createSandbox({ source: { type: 'module', url } })` fetches the URL and *inlines* its text,
 * because the guest runs in an opaque origin without network access. Relative `import` statements
 * in that text would resolve against a `blob:` URL and fail, so the guest entries must not share
 * chunks. They are therefore built one at a time — a single-input Rollup build inlines every
 * dependency — and overwrite the code-split output of the main library build.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const GUEST_ENTRIES = [
  { entry: 'src/runtime/host.browser.ts', outDir: 'dist/runtime', fileName: 'host.browser.js' },
  { entry: 'src/runtime/host.node.ts', outDir: 'dist/runtime', fileName: 'host.node.js' },
  { entry: 'src/runtime/host.mock.ts', outDir: 'dist/runtime', fileName: 'host.mock.js' },
];

for (const guest of GUEST_ENTRIES) {
  await build({
    root,
    configFile: false,
    logLevel: 'warn',
    build: {
      outDir: guest.outDir,
      emptyOutDir: false,
      target: 'es2022',
      sourcemap: true,
      minify: false,
      lib: {
        entry: resolve(root, guest.entry),
        formats: ['es'],
        fileName: () => guest.fileName,
      },
    },
  });
}
