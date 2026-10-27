import { fileURLToPath } from 'node:url';
import { build, mergeConfig } from 'vite';
import playground from '../vite.config';

// The opaque-origin guest cannot import from the dev server. Bundle the real core RPC
// with the test guest, just as the widget runtime bundles its guest entry point.
export default mergeConfig(playground, {
  plugins: [
    {
      name: 'sandbox-rpc-fixture',
      resolveId(id: string) {
        return id === 'virtual:sandbox-rpc-guest' ? '\0sandbox-rpc-guest' : null;
      },
      async load(id: string) {
        if (id !== '\0sandbox-rpc-guest') return null;
        const result = await build({
          configFile: false,
          build: {
            write: false,
            minify: false,
            lib: {
              entry: fileURLToPath(new URL('./fixtures/sandbox-rpc-guest.ts', import.meta.url)),
              formats: ['es'],
            },
          },
        });
        const outputs = Array.isArray(result) ? result : [result];
        const chunk = outputs
          .flatMap((output) => ('output' in output ? output.output : []))
          .find((item) => item.type === 'chunk');
        if (!chunk) throw new Error('RPC guest fixture produced no bundle');
        return `export default ${JSON.stringify(chunk.code)};`;
      },
    },
  ],
});
