import { existsSync, watch, type FSWatcher } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import type { PrepareWatcher } from './prepare.js';
import { loadDevicePackage, type LoadedDevicePackage } from './unified-manifest.js';
import { renderDeviceDeclaration, renderDeviceTypeScriptConfig } from './unified-types.js';

/** Directory below the project root that holds the generated type environment. */
export const DEVICE_TYPE_DIRECTORY = '.mica';

/** Generated global declaration file of a unified device project. */
export const DEVICE_DECLARATION_FILE = 'device.d.ts';

/** Generated TypeScript configuration that device projects extend. */
export const DEVICE_TSCONFIG_FILE = 'tsconfig.json';

const DEFAULT_DEBOUNCE_MS = 50;

export interface PrepareDeviceOptions {
  /** Project root holding `mica.config.ts`; defaults to the current directory. */
  readonly root: string;
  /** Source directory whose contents form the package root. */
  readonly sourceDir: string;
  /** Manifest path relative to the project root. */
  readonly manifest: string;
  /** DDL model source path relative to the project root. */
  readonly model?: string;
  /** Project config file, watched when prepare runs in watch mode. */
  readonly configFile?: string;
}

export interface PreparedDevice {
  /** Absolute paths of the written type environment files. */
  readonly files: readonly string[];
  readonly device: LoadedDevicePackage;
}

export interface WatchDeviceOptions {
  /** Resolves the current preparation inputs; called again after every change. */
  readonly load: () => Promise<PrepareDeviceOptions>;
  /** Coalescing window between a file event and the regeneration; defaults to 50 ms. */
  readonly debounceMs?: number;
  readonly onPrepare?: (files: readonly string[]) => void;
  /** Receives watch failures; defaults to `console.error`. */
  readonly onError?: (error: unknown) => void;
}

/**
 * Validates the device manifest and DDL and writes `.mica/device.d.ts` and `.mica/tsconfig.json`.
 *
 * Preparation never executes an author module: it reads JSON, compiles DDL and renders types. A
 * file whose content is unchanged keeps its previous bytes and timestamp, so a watching compiler
 * is not disturbed by repeated runs. A failing run reports the original manifest or DDL error and
 * leaves the previous type environment in place; the build is still prevented from running.
 */
export async function prepareDevice(options: PrepareDeviceOptions): Promise<PreparedDevice> {
  const root = resolve(options.root);
  const device = await loadDevicePackage({
    root,
    sourceDir: options.sourceDir,
    manifest: options.manifest,
    ...(options.model === undefined ? {} : { model: options.model }),
  });
  const declaration = renderDeviceDeclaration({
    manifest: device.manifest,
    ...(device.model === undefined ? {} : { model: device.model }),
    manifestPath: options.manifest,
  });
  const directory = join(root, DEVICE_TYPE_DIRECTORY);
  const declarationFile = join(directory, DEVICE_DECLARATION_FILE);
  const tsconfigFile = join(directory, DEVICE_TSCONFIG_FILE);
  await mkdir(directory, { recursive: true });
  await writeIfChanged(declarationFile, declaration);
  await writeIfChanged(tsconfigFile, renderDeviceTypeScriptConfig(options.sourceDir));
  return { files: [declarationFile, tsconfigFile], device };
}

/**
 * Regenerates the type environment whenever the manifest, the DDL model or the project config
 * changes. Inputs are re-resolved on every run, so editing the config or renaming a declared file
 * retargets the watchers. Generated writes never feed back into the loop.
 */
export function watchDevice(options: WatchDeviceOptions): PrepareWatcher {
  return watchPreparation({
    ...options,
    inputs: (loaded) => [
      resolve(loaded.root, loaded.manifest),
      ...(loaded.model === undefined ? [] : [resolve(loaded.root, loaded.model)]),
      ...(loaded.configFile === undefined ? [] : [loaded.configFile]),
    ],
    prepare: async (loaded) => (await prepareDevice(loaded)).files,
  });
}

export interface WatchPreparationOptions<T> {
  readonly load: () => Promise<T>;
  readonly inputs: (loaded: T) => readonly string[];
  readonly prepare: (loaded: T) => Promise<readonly string[]>;
  readonly debounceMs?: number;
  readonly onPrepare?: (files: readonly string[]) => void;
  readonly onError?: (error: unknown) => void;
}

export function watchPreparation<T>(options: WatchPreparationOptions<T>): PrepareWatcher {
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  let disposed = false;
  let queued = false;
  let timer: NodeJS.Timeout | undefined;
  let current: Promise<readonly string[]> | undefined;
  let targets = new Set<string>();
  const watchers = new Map<string, FSWatcher>();

  const report = (error: unknown): void => {
    if (options.onError === undefined) {
      console.error('mica prepare --watch:', error);
      return;
    }
    try {
      options.onError(error);
    } catch (reportingError) {
      console.error('mica prepare --watch:', error);
      console.error('mica prepare --watch error handler failed:', reportingError);
    }
  };

  const syncWatchers = (files: readonly string[]): void => {
    const next = new Set(files.map((file) => resolve(file)));
    const directories = new Set(
      [...next].map((file) => {
        let directory = dirname(file);
        while (!existsSync(directory) && dirname(directory) !== directory)
          directory = dirname(directory);
        return directory;
      }),
    );
    for (const [directory, watcher] of watchers) {
      if (directories.has(directory)) continue;
      watcher.close();
      watchers.delete(directory);
    }
    targets = next;
    for (const directory of directories) {
      if (watchers.has(directory)) continue;
      let watcher: FSWatcher;
      try {
        watcher = watch(directory, (_event, filename) => {
          if (disposed) return;
          if (filename === null) schedule();
          else {
            const changed = resolve(directory, filename.toString());
            if ([...targets].some((file) => file === changed || file.startsWith(changed + sep)))
              schedule();
          }
        });
      } catch (error) {
        report(error);
        continue;
      }
      watcher.on('error', (error) => {
        if (!disposed) report(error);
      });
      watchers.set(directory, watcher);
    }
  };

  const scan = async (): Promise<readonly string[]> => {
    let loaded: T;
    try {
      loaded = await options.load();
    } catch (error) {
      if (!disposed) report(error);
      return [];
    }
    try {
      syncWatchers(options.inputs(loaded));
      const files = await options.prepare(loaded);
      options.onPrepare?.(files);
      return files;
    } catch (error) {
      if (!disposed) report(error);
      return [];
    }
  };

  const drain = async (): Promise<readonly string[]> => {
    for (;;) {
      queued = false;
      const files = await scan();
      if (!queued || disposed) return files;
    }
  };

  const schedule = (): void => {
    if (disposed) return;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      run();
    }, debounceMs);
  };

  const start = (): Promise<readonly string[]> => {
    const task = drain();
    current = task;
    void task.finally(() => {
      if (current === task) current = undefined;
      if (queued && !disposed) schedule();
    });
    return task;
  };

  const run = (): void => {
    if (disposed) return;
    if (current) queued = true;
    else start();
  };

  const ready = start();

  return {
    ready,
    async dispose() {
      if (disposed) return;
      disposed = true;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      for (const watcher of watchers.values()) watcher.close();
      watchers.clear();
      await current;
    },
  };
}

async function writeIfChanged(file: string, content: string): Promise<void> {
  try {
    if ((await readFile(file, 'utf8')) === content) return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await writeFile(file, content, 'utf8');
}
