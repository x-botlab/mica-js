import { fileURLToPath } from 'node:url';
import dts from 'vite-plugin-dts';
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  build: {
    lib: {
      entry: 'src/index.ts',
      formats: ['es'],
      fileName: 'index',
    },
    target: 'es2022',
    sourcemap: true,
    minify: false,
    rollupOptions: {
      external: ['@mica-js/core', '@mica-js/core/schematic', '@mica-js/device', '@mica-js/ir'],
    },
  },
  plugins: [
    dts({
      tsconfigPath: './tsconfig.build.json',
      entryRoot: 'src',
      bundleTypes: true,
    }),
  ],
  test: {
    include: ['src/**/*.test.ts', 'examples/**/*.test.ts'],
    // Performance files only print observations; they are not correctness
    // tests, so they never gate `pnpm test` (and can never fail CI on a busy
    // machine). Run them explicitly with `pnpm test:perf`.
    exclude: [...configDefaults.exclude, '**/*performance.test.ts'],
    environment: 'node',
    benchmark: {
      // The export getter tracker wraps every module export in a counting
      // getter while benchmarking, which dominates the cost of interpreted/JIT
      // instruction dispatch. Benchmarks measure the engine, not the tracker.
      suppressExportGetterWarnings: true,
    },
    // Tests run before the workspace build, so resolve the workspace packages from source.
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
