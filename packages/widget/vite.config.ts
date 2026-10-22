import { fileURLToPath } from 'node:url';
import dts from 'vite-plugin-dts';
import { defineConfig } from 'vitest/config';
import { micaWidgetPlugins } from './vite.plugins';

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
      external: ['@mica-js/core', '@mica-js/core/canvas', '@mica-js/sandbox'],
    },
  },
  plugins: [
    ...micaWidgetPlugins(),
    dts({
      tsconfigPath: './tsconfig.build.json',
      entryRoot: 'src',
      exclude: ['src/**/*.test.ts', 'src/**/test-helpers.ts'],
      // One flattened declaration, so node16 consumers never follow extensionless imports.
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
      '@mica-js/sandbox': fileURLToPath(new URL('../sandbox/src/index.ts', import.meta.url)),
    },
  },
});
