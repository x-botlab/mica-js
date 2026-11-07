import dts from 'vite-plugin-dts';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  build: {
    lib: {
      entry: {
        index: 'src/index.ts',
        'client/index': 'src/client/index.ts',
        'client/three': 'src/client/three.ts',
      },
      formats: ['es'],
    },
    target: 'es2022',
    sourcemap: true,
    minify: false,
    rollupOptions: {
      // The client subpath is the only consumer; applications install Three.js themselves.
      external: ['three'],
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
      },
    },
  },
  plugins: [
    dts({
      tsconfigPath: './tsconfig.build.json',
      entryRoot: 'src',
      bundleTypes: false,
      exclude: ['src/**/*.test.ts', 'src/**/*.type-test.ts'],
    }),
  ],
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
