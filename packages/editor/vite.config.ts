import dts from 'vite-plugin-dts';
import { defineConfig } from 'vitest/config';
import { micaSandboxPlugins } from '@mica-js/sandbox/vite';
import { copyFile } from 'node:fs/promises';
import { build, type Plugin } from 'vite';
import { fileURLToPath } from 'node:url';

const editorRoot = fileURLToPath(new URL('.', import.meta.url));

function htmlEnvironmentAssets(): Plugin {
  return {
    name: 'mica-editor:html-environment',
    apply: 'build',
    async closeBundle() {
      for (const [name, entry] of [
        ['environment', 'entry'],
        ['environment-sw', 'service-worker'],
        ['content', 'content'],
      ]) {
        await build({
          configFile: false,
          root: editorRoot,
          resolve: { conditions: ['source', 'module', 'browser', 'default'] },
          build: {
            outDir: 'dist/view-environment',
            emptyOutDir: false,
            target: 'es2022',
            lib: {
              entry: `src/fused/html/environment/${entry}.ts`,
              formats: ['es'],
              fileName: () => `${name}.js`,
            },
            rollupOptions: { output: { codeSplitting: false } },
          },
        });
      }
      for (const document of ['index.html', 'content.html'])
        await copyFile(
          new URL(`./src/fused/html/environment/${document}`, import.meta.url),
          new URL(`./dist/view-environment/${document}`, import.meta.url),
        );
    },
  };
}

export default defineConfig({
  resolve: { conditions: ['source', 'module', 'browser', 'development|production'] },
  build: {
    lib: {
      entry: {
        index: 'src/index.ts',
        fused: 'src/fused/index.ts',
        'fused-runtime': 'src/fused/runtime/index.ts',
        'fused-html': 'src/fused/html/index.ts',
      },
      formats: ['es'],
      fileName: (_format, name) => `${name}.js`,
      cssFileName: 'style',
    },
    target: 'es2022',
    sourcemap: true,
    minify: false,
    rollupOptions: {
      external: [/^@mica-js\//, /^react(?:-dom)?(?:\/|$)/],
    },
  },
  plugins: [
    ...micaSandboxPlugins(),
    htmlEnvironmentAssets(),
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
