import { fileURLToPath } from 'node:url';
import dts from 'vite-plugin-dts';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    alias: {
      '@mica-js/core/schematic': fileURLToPath(
        new URL('../core/src/schematic/index.ts', import.meta.url),
      ),
      '@mica-js/core': fileURLToPath(new URL('../core/src/index.ts', import.meta.url)),
      '@mica-js/ir': fileURLToPath(new URL('../ir/src/index.ts', import.meta.url)),
    },
  },
  build: {
    lib: {
      entry: 'src/index.ts',
      formats: ['es'],
      fileName: 'index',
    },
    target: 'es2022',
    sourcemap: true,
    minify: false,
    rollupOptions: { external: ['@mica-js/core', '@mica-js/core/schematic', '@mica-js/ir'] },
  },
  plugins: [
    dts({
      tsconfigPath: './tsconfig.build.json',
      entryRoot: 'src',
      bundleTypes: true,
      exclude: ['src/**/*.test.ts', 'src/**/*.type-test.ts', 'src/**/test-helpers.ts'],
    }),
  ],
});
