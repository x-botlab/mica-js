import dts from 'vite-plugin-dts';
import { defineConfig } from 'vitest/config';
import { micaSandboxPlugins } from '@mica-js/sandbox/vite';

export default defineConfig({
  base: './',
  resolve: { conditions: ['source', 'module', 'browser', 'development|production'] },
  build: {
    lib: {
      entry: {
        index: 'src/index.ts',
        'client/index': 'src/client/index.ts',
        'client/three': 'src/client/three.ts',
      },
      formats: ['es'],
      fileName: (_format, entryName) => `${entryName}.js`,
    },
    target: 'es2022',
    sourcemap: true,
    minify: false,
    rollupOptions: {
      external: [
        '@mica-js/core',
        '@mica-js/core/rpc',
        '@mica-js/sandbox',
        'rolldown',
        'three',
        'vite',
      ],
    },
  },
  plugins: [
    ...micaSandboxPlugins(),
    dts({
      tsconfigPath: './tsconfig.build.json',
      entryRoot: 'src',
      exclude: ['src/**/*.test.ts', 'src/**/*.type-test.ts'],
      bundleTypes: true,
    }),
  ],
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
