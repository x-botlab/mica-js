import { fileURLToPath } from 'node:url';
import dts from 'vite-plugin-dts';
import { defineConfig } from 'vitest/config';

const coreSchematic = fileURLToPath(new URL('../core/src/schematic/index.ts', import.meta.url));

export default defineConfig(({ command }) => ({
  resolve:
    command === 'serve'
      ? {
          alias: {
            '@mica/core/schematic': coreSchematic,
          },
        }
      : undefined,
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
      external: ['@mica/core', '@mica/core/schematic'],
    },
  },
  plugins: [dts({ include: ['src'], exclude: ['src/**/*.test.ts', 'src/**/test-helpers.ts'] })],
}));
