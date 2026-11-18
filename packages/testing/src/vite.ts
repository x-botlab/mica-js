import { resolve } from 'node:path';
import { normalizePath, createFilter, type Plugin, type ViteDevServer } from 'vite';
import { configDefaults, type ViteUserConfig as UserConfig } from 'vitest/config';
import { loadProjectConfig } from './config';
import { prepareTestbenches } from './prepare';

export interface MitestPluginOptions {
  readonly root?: string;
  readonly config?: string;
}

export function mitest(options: MitestPluginOptions = {}): Plugin {
  let root: string;
  let server: ViteDevServer | undefined;
  let pending: Promise<void> = Promise.resolve();
  let documents = new Map<string, string>();
  let dependencies = new Map<string, Set<string>>();
  let inputs = new Set<string>();
  let isTest: (file: string) => boolean = () => false;
  const pathKey = (file: string): string => normalizePath(resolve(file));

  const refresh = (): Promise<void> => {
    const task = pending.then(async () => {
      const next = await loadProjectConfig({
        root,
        ...(options.config === undefined ? {} : { config: options.config }),
      });
      const bindings = new Map<string, string>();
      const watched = new Map<string, Set<string>>();
      for (const [name, entry] of Object.entries(next.config.testbenches)) {
        const file = pathKey(resolve(next.root, entry.document));
        if (bindings.has(file))
          throw new Error(
            `Multiple testbenches configure ${file}; .sch imports require one configuration per document`,
          );
        bindings.set(
          file,
          normalizePath(resolve(next.root, '.mitest', 'testbenches', `${name}.ts`)),
        );
        watched.set(
          file,
          new Set([
            pathKey(next.configFile),
            file,
            ...Object.values(entry.devices).flatMap((directory) => [
              pathKey(resolve(next.root, directory, 'release.json')),
              pathKey(resolve(next.root, directory, 'package.json')),
            ]),
          ]),
        );
      }
      await prepareTestbenches(next);
      documents = bindings;
      dependencies = watched;
      inputs = new Set([
        pathKey(next.configFile),
        ...[...watched.values()].flatMap((files) => [...files]),
      ]);
      server?.watcher.add([...inputs]);
    });
    // The caller receives failures; keep later watch refreshes able to recover.
    pending = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  };

  const invalidate = (): void => {
    if (server === undefined) return;
    for (const environment of Object.values(server.environments)) {
      for (const file of documents.keys()) {
        const modules = new Set(environment.moduleGraph.getModulesByFile(file));
        const direct = environment.moduleGraph.getModuleById(file);
        if (direct !== undefined) modules.add(direct);
        for (const module of modules) environment.moduleGraph.invalidateModule(module);
      }
    }
  };

  return {
    name: 'mitest',
    enforce: 'pre',
    config(): UserConfig {
      return {
        test: {
          watchTriggerPatterns: [
            {
              pattern: /./,
              testsToRun(file) {
                if (!inputs.has(pathKey(file)) || server === undefined) return [];
                const tests = new Set<string>();
                for (const environment of Object.values(server.environments)) {
                  const visited = new Set<string>();
                  const visit = (id: string): void => {
                    if (visited.has(id)) return;
                    visited.add(id);
                    const module = environment.moduleGraph.getModuleById(id);
                    if (module === undefined) return;
                    if (module.file !== null && isTest(module.file)) tests.add(module.file);
                    for (const importer of module.importers)
                      if (importer.id !== null) visit(importer.id);
                  };
                  for (const [document, files] of dependencies)
                    if (files.has(pathKey(file))) visit(document);
                }
                return [...tests];
              },
            },
          ],
        },
      };
    },
    configResolved(config) {
      root = resolve(config.root, options.root ?? '.');
      isTest = createFilter(
        config.test?.include ?? configDefaults.include,
        config.test?.exclude ?? configDefaults.exclude,
        { resolve: config.root },
      );
    },
    configureServer(next) {
      server = next;
      const changed = (file: string): void => {
        if (!inputs.has(pathKey(file))) return;
        invalidate();
        void refresh().catch((error: unknown) => {
          next.config.logger.error(
            `mitest: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      };
      next.watcher.on('change', changed);
      next.watcher.on('add', changed);
      next.watcher.on('unlink', changed);
      next.httpServer?.once('close', () => {
        next.watcher.off('change', changed);
        next.watcher.off('add', changed);
        next.watcher.off('unlink', changed);
      });
    },
    async buildStart() {
      await refresh();
      for (const file of inputs) this.addWatchFile(file);
    },
    async load(id) {
      if (!id.endsWith('.sch')) return;
      await refresh();
      const file = pathKey(id);
      const target = documents.get(file);
      if (target === undefined)
        throw new Error(`Schematic ${file} is not configured in mitest.config.ts`);
      for (const dependency of dependencies.get(file) ?? []) this.addWatchFile(dependency);
      return `export { createTestbench as default } from ${JSON.stringify(target)};`;
    },
    async closeBundle() {
      await pending;
    },
  };
}
