import dts from 'vite-plugin-dts';
import { defineConfig } from 'vitest/config';
import { micaSandboxPlugins } from '@mica-js/sandbox/vite';
import { micaWidgetPlugins } from '@mica-js/widget/vite';

export default defineConfig({
  resolve: { conditions: ['source', 'module', 'browser', 'development|production'] },
  build: {
    lib: {
      entry: 'src/index.ts',
      formats: ['es'],
      fileName: 'index',
      // The entry imports the editor chrome so the build can extract it into `dist/style.css`.
      cssFileName: 'style',
    },
    target: 'es2022',
    sourcemap: true,
    minify: false,
    rollupOptions: {
      external: [
        '@mica-js/core',
        '@mica-js/core/canvas',
        '@mica-js/sandbox',
        '@mica-js/simulator/sandbox',
        '@mica-js/widget',
      ],
    },
  },
  plugins: [
    // Tests import widget source, including its inlined guest and worklet queries.
    ...micaSandboxPlugins(),
    ...micaWidgetPlugins(),
    dts({
      tsconfigPath: './tsconfig.build.json',
      entryRoot: 'src',
      bundleTypes: true,
    }),
  ],
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
