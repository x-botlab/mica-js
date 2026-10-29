import { fileURLToPath } from 'node:url';
import dts from 'vite-plugin-dts';
import { defineConfig } from 'vitest/config';
import { micaSandboxPlugins } from '@mica-js/sandbox/vite';
import { micaWidgetPlugins } from '@mica-js/widget/vite';

export default defineConfig({
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
    // Tests resolve `@mica-js/widget` from source, and the widget package inlines its guest worker
    // and audio worklet through these two queries. The library build itself externalizes it.
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
    // Tests run before the workspace build, so resolve the workspace packages from source.
    alias: {
      '@mica-js/core/canvas': fileURLToPath(
        new URL('../core/src/canvas/index.ts', import.meta.url),
      ),
      '@mica-js/widget': fileURLToPath(new URL('../widget/src/index.ts', import.meta.url)),
    },
  },
});
