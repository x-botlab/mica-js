import dts from 'vite-plugin-dts';
import { defineConfig } from 'vitest/config';

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
      external: ['@mica-js/core', '@mica-js/core/lifecycle', '@mica-js/core/schematic'],
    },
  },
  plugins: [
    dts({
      tsconfigPath: './tsconfig.build.json',
      entryRoot: 'src',
      bundleTypes: true,
    }),
  ],
});
