import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { normalizePath, type Plugin, type ResolvedConfig } from 'vite';
import { buildContent, type ContentFile } from './content.js';
import { prepare } from './prepare.js';

export interface MicaSdkOptions {
  /** Source directory relative to the Vite root; defaults to src. */
  readonly sourceDir?: string;
}

const entryId = 'virtual:mica-sdk-empty';

async function watchTree(path: string, add: (path: string) => void): Promise<void> {
  add(path);
  const entries = await readdir(path, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    },
  );
  for (const entry of entries) {
    const child = resolve(path, entry.name);
    if (entry.isDirectory()) await watchTree(child, add);
    else if (!entry.name.endsWith('.d.ddl.ts')) add(child);
  }
}

/** Builds independent two-file devices/widgets, or serves those same files during development. */
export function micaSdk(options: MicaSdkOptions = {}): Plugin {
  let config: ResolvedConfig;
  let pending: Promise<readonly ContentFile[]> | undefined;
  let previous: Promise<unknown> = Promise.resolve();
  const compile = () => {
    if (pending) return pending;
    pending = previous
      .catch(() => undefined)
      .then(async () => {
        await prepare({ root: config.root, ...options });
        return buildContent({
          root: config.root,
          ...options,
          aliases: config.resolve.alias,
          minify: config.build.minify !== false,
        });
      });
    const result = pending;
    previous = result;
    void result.catch(() => {
      if (pending === result) pending = undefined;
    });
    return result;
  };

  return {
    name: 'mica:sdk',
    config(_config, environment) {
      if (environment.command !== 'build') return;
      return {
        publicDir: false,
        build: {
          sourcemap: false,
          copyPublicDir: false,
          lib: { entry: entryId, formats: ['es'], fileName: () => '__mica_sdk__.js' },
          rolldownOptions: { input: entryId },
        },
      };
    },
    configResolved(resolved) {
      config = resolved;
    },
    resolveId(id) {
      if (id === entryId) return '\0' + entryId;
    },
    load(id) {
      if (id === '\0' + entryId) return 'export {};';
    },
    async buildStart() {
      if (config.command !== 'build') return;
      pending = undefined;
      await watchTree(resolve(config.root, options.sourceDir ?? 'src'), (path) =>
        this.addWatchFile(path),
      );
      for (const file of await compile()) this.emitFile({ type: 'asset', ...file });
    },
    generateBundle(_options, bundle) {
      if (config.command !== 'build') return;
      for (const [name, output] of Object.entries(bundle)) {
        if (output.type === 'chunk' && output.facadeModuleId === '\0' + entryId)
          delete bundle[name];
        else if (
          output.type === 'chunk' ||
          !/^(devices\/[A-Za-z0-9-]+\/device|widgets\/[A-Za-z0-9-]+\/widget)\.(js|json)$/.test(name)
        )
          this.error(`Unexpected content artifact: ${name}`);
      }
    },
    configureServer(server) {
      const sourceRoot = normalizePath(resolve(config.root, options.sourceDir ?? 'src'));
      server.watcher.add(sourceRoot);
      const invalidate = (file: string) => {
        const path = normalizePath(file);
        if (
          path.endsWith('.d.ddl.ts') ||
          (path !== sourceRoot && !path.startsWith(sourceRoot + '/'))
        )
          return;
        pending = undefined;
        // Prepare editor declarations immediately, even before the first artifact request.
        void compile().then(
          () => server.ws.send({ type: 'full-reload', path: '*' }),
          (error: unknown) => server.config.logger.error(String(error)),
        );
      };
      server.watcher.on('add', invalidate).on('change', invalidate).on('unlink', invalidate);
      const dispose = () => {
        server.watcher.off('add', invalidate).off('change', invalidate).off('unlink', invalidate);
      };
      server.httpServer?.once('close', dispose);
      server.middlewares.use(async (request, response, next) => {
        const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
        const base = config.base.startsWith('/') ? config.base : '/';
        const relative = pathname.startsWith(base) ? pathname.slice(base.length) : '';
        if (!/^(devices|widgets)\//.test(relative)) return next();
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          response.statusCode = 405;
          response.end();
          return;
        }
        try {
          const file = (await compile()).find((item) => item.fileName === relative);
          if (!file) {
            response.statusCode = 404;
            response.end('Content not found');
            return;
          }
          response.setHeader(
            'Content-Type',
            file.fileName.endsWith('.json')
              ? 'application/json; charset=utf-8'
              : 'text/javascript; charset=utf-8',
          );
          response.setHeader('Cache-Control', 'no-store');
          response.end(request.method === 'HEAD' ? undefined : file.source);
        } catch (error) {
          response.statusCode = 500;
          response.end(String(error));
        }
      });
      void compile().catch((error: unknown) => server.config.logger.error(String(error)));
    },
  };
}
