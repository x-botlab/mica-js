import dts from 'vite-plugin-dts';
import { defineConfig } from 'vitest/config';

export default defineConfig({
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
      include: ['src'],
      exclude: ['src/**/*.test.ts', 'src/**/*.type-test.ts', 'src/**/test-helpers.ts'],
      // One flattened declaration per entry, so consumers with node16 resolution never have to
      // follow extensionless imports inside the package.
      bundleTypes: true,
    }),
  ],
});
