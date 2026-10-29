import { fileURLToPath } from 'node:url';
import dts from 'vite-plugin-dts';
import { defineConfig } from 'vitest/config';
import { micaSandboxPlugins } from '@mica-js/sandbox/vite';

const resolveSource = (path: string): string => fileURLToPath(new URL(path, import.meta.url));
/** Guest bundles stay self-contained; resolve workspace imports to source, never to stale dist. */
const guestAliases = [
  { find: '@mica-js/core/canvas', replacement: resolveSource('../core/src/canvas/index.ts') },
  { find: '@mica-js/core/rpc', replacement: resolveSource('../core/src/rpc/index.ts') },
  {
    find: '@mica-js/core/lifecycle',
    replacement: resolveSource('../core/src/lifecycle/index.ts'),
  },
  { find: '@mica-js/core/logging', replacement: resolveSource('../core/src/logging/index.ts') },
  { find: '@mica-js/core/schematic', replacement: resolveSource('../core/src/schematic/index.ts') },
  { find: '@mica-js/core', replacement: resolveSource('../core/src/index.ts') },
  { find: '@mica-js/ir', replacement: resolveSource('../ir/src/index.ts') },
  { find: '@mica-js/device', replacement: resolveSource('../device/src/index.ts') },
  { find: '@mica-js/sandbox', replacement: resolveSource('../sandbox/src/index.ts') },
];

export default defineConfig({
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
    ...micaSandboxPlugins({ aliases: guestAliases }),
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
    // Tests run before the workspace build, so resolve the workspace packages from source.
    alias: {
      '@mica-js/core/canvas': resolveSource('../core/src/canvas/index.ts'),
      '@mica-js/core/rpc': resolveSource('../core/src/rpc/index.ts'),
      '@mica-js/core/lifecycle': resolveSource('../core/src/lifecycle/index.ts'),
      '@mica-js/core/logging': resolveSource('../core/src/logging/index.ts'),
      '@mica-js/core/schematic': resolveSource('../core/src/schematic/index.ts'),
      '@mica-js/core': resolveSource('../core/src/index.ts'),
      '@mica-js/ir': resolveSource('../ir/src/index.ts'),
      '@mica-js/device': resolveSource('../device/src/index.ts'),
      '@mica-js/sandbox': resolveSource('../sandbox/src/index.ts'),
    },
  },
});
