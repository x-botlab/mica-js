import { micaSandboxPlugins } from '@mica-js/sandbox/vite';
import dts from 'vite-plugin-dts';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { conditions: ['source'] },
  ssr: { resolve: { conditions: ['source'] } },
  build: {
    lib: {
      entry: {
        index: 'src/index.ts',
        device: 'src/device.ts',
        model: 'src/model.ts',
        ddl: 'src/ddl.ts',
        sandbox: 'src/sandbox.ts',
      },
      formats: ['es'],
      fileName: (_format, name) => `${name}.js`,
    },
    target: 'es2022',
    sourcemap: true,
    minify: false,
    rollupOptions: { external: (id) => id.startsWith('@mica-js/') },
  },
  plugins: [
    ...micaSandboxPlugins(),
    dts({
      tsconfigPath: './tsconfig.build.json',
      entryRoot: 'src',
      exclude: ['src/**/*.test.ts', 'src/**/test-helpers.ts'],
      bundleTypes: true,
    }),
  ],
  test: {
    include: ['src/simulation-runtime/**/*.test.ts'],
    environment: 'node',
    // Test generated code from the compiler under development, not a stale build.
    server: { deps: { inline: ['@mica-js/compiler'] } },
  },
});
