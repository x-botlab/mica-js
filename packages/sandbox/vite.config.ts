import dts from 'vite-plugin-dts';
import { defineConfig } from 'vitest/config';
import { micaSandboxPlugins } from './vite.plugins';

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
  },
  plugins: [...micaSandboxPlugins(), dts({ include: ['src'], exclude: ['src/**/*.test.ts'] })],
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
