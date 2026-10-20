import dts from 'vite-plugin-dts';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  build: {
    lib: {
      entry: {
        index: 'src/index.ts',
        'schematic/index': 'src/schematic/index.ts',
      },
      formats: ['es'],
      fileName: (_format, entryName) => `${entryName}.js`,
    },
    target: 'es2022',
    sourcemap: true,
    minify: false,
  },
  plugins: [dts({ include: ['src'], exclude: ['src/**/*.test.ts'] })],
});
