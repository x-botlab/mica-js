import dts from 'vite-plugin-dts';
import { defineConfig } from 'vitest/config';
import { micaSandboxPlugins } from '@mica-js/sandbox/vite';

export default defineConfig({
  resolve: { conditions: ['source', 'module', 'browser', 'development|production'] },
  build: {
    lib: {
      entry: { index: 'src/index.ts', sandbox: 'src/sandbox.ts' },
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
        '@mica-js/core/rpc',
        '@mica-js/core/lifecycle',
        '@mica-js/core/logging',
        '@mica-js/core/schematic',
        '@mica-js/device',
        '@mica-js/ir',
        '@mica-js/sandbox',
      ],
    },
  },
  plugins: [
    // The device guest is bundled here, in memory (`?sandbox-worker-code`), and inlined into
    // `sandbox.js`; it never becomes a dist file.
    ...micaSandboxPlugins(),
    dts({
      tsconfigPath: './tsconfig.build.json',
      entryRoot: 'src',
      exclude: ['src/**/*.test.ts', 'src/**/test-helpers.ts'],
      bundleTypes: true,
    }),
  ],
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    benchmark: {
      // The export getter tracker wraps every module export in a counting
      // getter while benchmarking, which dominates the cost of interpreted/JIT
      // instruction dispatch. Benchmarks measure the engine, not the tracker.
      suppressExportGetterWarnings: true,
    },
  },
});
