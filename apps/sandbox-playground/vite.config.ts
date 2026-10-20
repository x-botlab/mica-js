import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { SANDBOX_FRAME_HTML } from '../../packages/sandbox/src/host/frame-html';
import { micaSandboxPlugins } from '../../packages/sandbox/vite.plugins';

const FRAME_ROUTE = '/sandbox-frame.html';

/** Serves the ready-to-host frame document so the `frameUrl` mode can be demoed locally. */
function frameRoutePlugin() {
  return {
    name: 'mica-sandbox-playground:frame-route',
    configureServer(server: {
      middlewares: {
        use: (route: string, handler: (req: unknown, res: ResponseLike) => void) => void;
      };
    }) {
      server.middlewares.use(FRAME_ROUTE, (_req, res) => {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(SANDBOX_FRAME_HTML);
      });
    },
    generateBundle(this: {
      emitFile: (file: { type: 'asset'; fileName: string; source: string }) => void;
    }) {
      this.emitFile({ type: 'asset', fileName: FRAME_ROUTE.slice(1), source: SANDBOX_FRAME_HTML });
    },
  };
}

interface ResponseLike {
  setHeader(name: string, value: string): void;
  end(body: string): void;
}

export default defineConfig({
  plugins: [...micaSandboxPlugins(), frameRoutePlugin()],
  resolve: {
    alias: {
      '@mica/sandbox': fileURLToPath(
        new URL('../../packages/sandbox/src/index.ts', import.meta.url),
      ),
    },
  },
});
