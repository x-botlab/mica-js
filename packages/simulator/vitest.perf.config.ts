import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Performance observation run: `pnpm test:perf`.
 *
 * These files print throughput numbers for a human to read; they contain no
 * assertions. They are excluded from `pnpm test` (see `vite.config.ts`) so a
 * slow or busy machine can never fail CI.
 *
 * The aliases mirror `vite.config.ts`: perf runs usually happen before a
 * workspace build, so the packages must resolve from source.
 */
export default defineConfig({
  test: {
    include: ['src/**/*performance.test.ts', 'examples/**/*performance.test.ts'],
    exclude: ['**/node_modules/**'],
    environment: 'node',
    testTimeout: 300_000,
    alias: {
      '@mica-js/core/canvas': fileURLToPath(
        new URL('../core/src/canvas/index.ts', import.meta.url),
      ),
      '@mica-js/core/schematic': fileURLToPath(
        new URL('../core/src/schematic/index.ts', import.meta.url),
      ),
      '@mica-js/core': fileURLToPath(new URL('../core/src/index.ts', import.meta.url)),
      '@mica-js/ir': fileURLToPath(new URL('../ir/src/index.ts', import.meta.url)),
      '@mica-js/device': fileURLToPath(new URL('../device/src/index.ts', import.meta.url)),
    },
  },
});
