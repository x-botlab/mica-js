import { fileURLToPath } from 'node:url';
import dts from 'vite-plugin-dts';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    alias: { '@mica-js/ir': fileURLToPath(new URL('../ir/src/index.ts', import.meta.url)) },
    // The memory-release regression test observes WeakRef clearing after destroy.
    execArgv: ['--expose-gc'],
  },
  build: {
    lib: {
      entry: {
        index: 'src/index.ts',
        'schematic/index': 'src/schematic/index.ts',
        'canvas/index': 'src/canvas/index.ts',
      },
      formats: ['es'],
      fileName: (_format, entryName) => `${entryName}.js`,
    },
    target: 'es2022',
    sourcemap: true,
    minify: false,
    rollupOptions: { external: ['@mica-js/ir'] },
  },
  plugins: [
    dts({
      tsconfigPath: './tsconfig.build.json',
      entryRoot: 'src',
      include: ['src'],
      exclude: ['src/**/*.test.ts', 'src/**/*.type-test.ts', 'src/**/test-helpers.ts'],
      // One flattened declaration per entry, so consumers with node16 resolution never have to
      // follow extensionless imports inside the package.
      bundleTypes: true,
    }),
  ],
});
