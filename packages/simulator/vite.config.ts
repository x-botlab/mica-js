import dts from 'vite-plugin-dts';
import { defineConfig } from 'vite';

export default defineConfig({
  resolve: { conditions: ['source'] },
  build: {
    lib: {
      entry: {
        index: 'src/index.ts',
        device: 'src/device.ts',
        model: 'src/model.ts',
        ddl: 'src/ddl.ts',
      },
      formats: ['es'],
      fileName: (_format, name) => `${name}.js`,
    },
    target: 'es2022',
    sourcemap: true,
    minify: false,
    rollupOptions: { external: (id) => id.startsWith('@mica-js/') },
  },
  plugins: [dts({ tsconfigPath: './tsconfig.build.json', entryRoot: 'src', bundleTypes: true })],
});
