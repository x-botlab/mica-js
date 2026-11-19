import dts from 'vite-plugin-dts';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { conditions: ['source', 'module', 'browser', 'development|production'] },
  ssr: { resolve: { conditions: ['source'] } },
  build: {
    lib: {
      entry: {
        index: 'src/index.ts',
        node: 'src/node.ts',
        config: 'src/config.ts',
        cli: 'src/cli.ts',
        vite: 'src/vite.ts',
      },
      formats: ['es'],
      fileName: (_format, entryName) => `${entryName}.js`,
    },
    target: 'es2022',
    sourcemap: true,
    minify: false,
    rollupOptions: {
      external: [/^@mica-js\//, /^node:/, /^vitest(?:\/|$)/, 'vite'],
    },
  },
  plugins: [
    dts({
      tsconfigPath: './tsconfig.build.json',
      entryRoot: 'src',
      include: ['src'],
      exclude: ['src/**/*.test.ts', 'src/test-helpers.ts'],
      bundleTypes: true,
    }),
  ],
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    server: { deps: { inline: [/@mica-js\//] } },
  },
});
