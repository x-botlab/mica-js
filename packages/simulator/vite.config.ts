import { fileURLToPath } from 'node:url';
import dts from 'vite-plugin-dts';
import { defineConfig } from 'vitest/config';

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
    include: ['src/**/*.test.ts'],
    environment: 'node',
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
