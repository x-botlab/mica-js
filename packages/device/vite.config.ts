import dts from 'vite-plugin-dts';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { conditions: ['source', 'module', 'browser', 'development|production'] },
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
      external: ['@mica-js/core', '@mica-js/core/canvas', '@mica-js/core/schematic', '@mica-js/ir'],
    },
  },
  plugins: [
    dts({
      tsconfigPath: './tsconfig.build.json',
      entryRoot: 'src',
      bundleTypes: true,
      exclude: [
        'src/**/*.test.ts',
        'src/**/*.type-test.ts',
        'src/**/test-helpers.ts',
        'src/testing',
      ],
    }),
  ],
});
