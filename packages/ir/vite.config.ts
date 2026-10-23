import dts from 'vite-plugin-dts';
import { defineConfig } from 'vitest/config';

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
  plugins: [
    dts({
      include: ['src'],
      exclude: [
        'src/**/*.test.ts',
        'src/**/*.type-test.ts',
        'src/jit/testing/**',
        'src/testing/**',
      ],
      // One flattened declaration, so node16 consumers never follow extensionless imports.
      bundleTypes: true,
    }),
  ],
});
