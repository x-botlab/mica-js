import { createHash } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import { mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { isBuiltin } from 'node:module';
import { dirname, isAbsolute, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compileDDL } from '@mica-js/ddl';
import type { DeviceIR } from '@mica-js/device-model';
import { build, normalizePath } from 'vite';
import type { Geometry2D } from '../device.js';
import type { DeviceConfig, MicaConfig } from './config.js';
import { loadProjectConfig } from './config.js';
import { assertSelfContained, modelExpression, stripModelSource } from './content.js';
import {
  DevicePackageError,
  generateDeviceDeclaration,
  generateDeviceTsconfig,
  validateDevicePackage,
  validateDevicePackageModel,
  validateGeometry,
  type DevicePackageManifest,
  type ResourceReference,
} from './device-package.js';

const DECLARATION_DIRECTORY = '.mica';
const DECLARATION_FILE = 'device.d.ts';
const TSCONFIG_FILE = 'tsconfig.json';
const GENERATED_MARKER = '@mica-js/sdk prepare';

export interface LoadedDeviceProject {
  readonly root: string;
  readonly config: MicaConfig;
  readonly manifestPath: string;
  readonly manifest: DevicePackageManifest;
  readonly model: DeviceIR;
  readonly geometry: Geometry2D | undefined;
}

export interface DeviceBuildResult {
  readonly packageDir: string;
  readonly releaseFile: string;
  readonly files: readonly string[];
}

export interface DevicePrepareResult {
  readonly files: readonly string[];
}

const sdkVersionPromise = readFile(
  fileURLToPath(new URL('../../package.json', import.meta.url)),
  'utf8',
)
  .then((content) => (JSON.parse(content) as { version?: unknown }).version)
  .then((version) => {
    if (typeof version !== 'string') throw new Error('The SDK package.json has no version');
    return version;
  });

export function sdkVersion(): Promise<string> {
  return sdkVersionPromise;
}

function exists(path: string): Promise<boolean> {
  return stat(path).then(
    (entry) => entry.isFile(),
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
      throw error;
    },
  );
}

function inside(root: string, path: string): boolean {
  const value = relative(root, path);
  return value === '' || (value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value));
}

/** Resolves one regular source file and rejects symlinks and paths escaping the project root. */
async function regularFile(root: string, path: string, field: string): Promise<string> {
  let real: string;
  try {
    real = await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw new Error(`${field}: file not found: ${path}`, { cause: error });
    throw error;
  }
  if (!inside(root, real)) throw new Error(`${field}: must stay inside the project root`);
  if (!(await stat(real)).isFile()) throw new Error(`${field}: must be a regular file`);
  return real;
}

async function sourceFile(root: string, configured: string, field: string): Promise<string> {
  const file = resolve(root, configured);
  const candidates = [file];
  const extension = /\.(?:[cm]?[jt]sx?)$/.exec(file);
  if (extension === null) {
    candidates.push(`${file}.ts`, `${file}.tsx`, `${file}.js`, `${file}.mjs`);
  } else {
    const stem = file.slice(0, -extension[0].length);
    candidates.push(`${stem}.ts`, `${stem}.tsx`, `${stem}.js`, `${stem}.mjs`, `${stem}.mts`);
  }
  for (const candidate of candidates) {
    if (await exists(candidate)) return regularFile(root, candidate, field);
  }
  throw new Error(`${field}: source file not found: ${configured}`);
}

function isResourceReference(value: unknown): value is ResourceReference {
  return (
    typeof value === 'object' &&
    value !== null &&
    'src' in value &&
    'mode' in value &&
    (value as { mode?: unknown }).mode === 'package'
  );
}

async function loadGeometry(
  root: string,
  manifest: DevicePackageManifest,
): Promise<Geometry2D | undefined> {
  const declared = manifest.view2d?.geometry;
  if (declared === undefined) return undefined;
  if (typeof declared !== 'string') return declared;
  const file = await regularFile(root, resolve(root, declared), 'view2d.geometry');
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw new Error(`view2d.geometry: file not found: ${declared}`, { cause: error });
    throw error;
  }
  return validateGeometry(parsed, declared);
}

export async function loadDeviceProject(
  root: string,
  config: MicaConfig,
): Promise<LoadedDeviceProject> {
  if (config.device === undefined) throw new Error('Not a unified device project');
  const manifestPath = await regularFile(
    root,
    resolve(root, config.device.manifest ?? 'package.json'),
    'package.json',
  );
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw new Error(`Device manifest not found: ${relative(root, manifestPath)}`, {
        cause: error,
      });
    throw error;
  }
  const manifest = validateDevicePackage(raw, { sdkVersion: await sdkVersion() });
  let model: DeviceIR = { kind: 'device', name: manifest.name, declarations: [] };
  if (manifest.model !== undefined) {
    const modelPath = await regularFile(
      root,
      resolve(root, config.device.model ?? 'src/model.ddl'),
      'model.ddl',
    );
    let source: string;
    try {
      source = await readFile(modelPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        throw new Error(`model: DDL source not found: ${relative(root, modelPath)}`, {
          cause: error,
        });
      throw error;
    }
    model = await compileDDL(source, { uri: pathToFileURL(modelPath).href });
  }
  const geometry = await loadGeometry(root, manifest);
  validateDevicePackageModel(manifest, model, geometry);
  return { root, config, manifestPath, manifest, model, geometry };
}

export async function prepareDeviceProject(
  root: string,
  config: MicaConfig,
): Promise<DevicePrepareResult> {
  const project = await loadDeviceProject(root, config);
  const directory = resolve(root, DECLARATION_DIRECTORY);
  const declaration = resolve(directory, DECLARATION_FILE);
  const tsconfig = resolve(directory, TSCONFIG_FILE);
  const header = `// Generated by ${GENERATED_MARKER}; do not edit.\n`;
  await writeIfChanged(
    declaration,
    `${header}${generateDeviceDeclaration(project.manifest, project.model)}`,
  );
  await writeIfChanged(tsconfig, generateDeviceTsconfig());
  return { files: [declaration, tsconfig] };
}

async function writeIfChanged(file: string, content: string): Promise<void> {
  try {
    if ((await readFile(file, 'utf8')) === content) return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content, 'utf8');
}

async function bundle(
  root: string,
  source: string,
  label: string,
  expected: readonly string[],
  aliases?: Readonly<Record<string, string>>,
): Promise<string> {
  const entryId = 'virtual:mica-device-entry';
  const bundled = await build({
    configFile: false,
    root,
    publicDir: false,
    logLevel: 'silent',
    resolve: {
      ...(aliases === undefined
        ? {}
        : {
            alias: Object.fromEntries(
              Object.entries(aliases).map(([key, path]) => [key, resolve(root, path)]),
            ),
          }),
      conditions: ['source', 'module', 'browser', 'production'],
    },
    plugins: [
      {
        name: 'mica:device-entry',
        enforce: 'pre',
        resolveId(id) {
          if (isBuiltin(id))
            throw new Error(`Node built-ins are unavailable in device modules: ${id}`);
          if (id === entryId) return '\0' + entryId;
        },
        load(id) {
          if (id === '\0' + entryId) return source;
        },
      },
    ],
    build: {
      write: false,
      target: 'es2022',
      sourcemap: false,
      minify: true,
      lib: {
        entry: entryId,
        formats: ['es'],
        fileName: () => 'entry.js',
        cssFileName: 'entry',
      },
      rolldownOptions: {
        input: entryId,
        output: { codeSplitting: false },
        onwarn(warning, warn) {
          if (warning.code === 'UNRESOLVED_IMPORT') throw new Error(warning.message);
          warn(warning);
        },
      },
    },
  } as Parameters<typeof build>[0]);
  if ('close' in bundled) throw new Error('Watch builds are not supported inside a device build');
  const outputs = (Array.isArray(bundled) ? bundled : [bundled]).flatMap((result) => result.output);
  const chunk = outputs[0];
  if (
    outputs.length !== 1 ||
    chunk?.type !== 'chunk' ||
    chunk.imports.length ||
    chunk.dynamicImports.some((name) => name !== chunk.fileName)
  )
    throw new Error(
      `${label}: implementation must produce exactly one self-contained JavaScript module (${outputs.map((item) => item.fileName).join(', ')})`,
    );
  assertSelfContained(chunk.code, label);
  for (const name of expected) {
    if (!chunk.exports.includes(name)) throw new Error(`${label}: missing ${name} export`);
  }
  return chunk.code;
}

function packageManifest(manifest: DevicePackageManifest): Uint8Array {
  const published = {
    publisher: manifest.publisher,
    name: manifest.name,
    version: manifest.version,
    ...(manifest.description === undefined ? {} : { description: manifest.description }),
    ...(manifest.license === undefined ? {} : { license: manifest.license }),
    engines: manifest.engines,
    displayName: manifest.displayName,
    ...(manifest.icon === undefined ? {} : { icon: manifest.icon }),
    ...(manifest.designatorPrefix === undefined
      ? {}
      : { designatorPrefix: manifest.designatorPrefix }),
    ...(manifest.entries === undefined ? {} : { entries: manifest.entries }),
    ...(manifest.properties === undefined ? {} : { properties: manifest.properties }),
    ...(manifest.pins === undefined ? {} : { pins: manifest.pins }),
    ...(manifest.model === undefined ? {} : { model: manifest.model }),
    ...(manifest.view2d === undefined ? {} : { view2d: manifest.view2d }),
    ...(manifest.view === undefined ? {} : { view: manifest.view }),
    type: 'module',
  };
  return Buffer.from(`${JSON.stringify(published, null, 2)}\n`, 'utf8');
}

function integrity(data: Uint8Array): string {
  return `sha256:${createHash('sha256').update(data).digest('hex')}`;
}

function defaultOutput(config: MicaConfig, name: string): string {
  const outDir = config.outDir ?? 'dist';
  if (config.device?.output !== undefined) return config.device.output;
  const normalized = outDir.replaceAll('\\', '/').replace(/\/$/, '');
  // A standalone project writes its package root to the default/own outDir. An aggregate
  // child sharing `../dist` or a plain build directory adds the device name.
  if (outDir === 'dist' || posix.basename(normalized) === name) return outDir;
  return `${outDir}/${name}`;
}

function safeOutput(root: string, outDir: string, configured: string): string {
  const output = resolve(root, configured);
  const outputRoot = resolve(root, outDir);
  if (!inside(outputRoot, output) || relative(root, output) === '')
    throw new Error(
      'Device output directory must be outDir or a child of it, but not the project root',
    );
  for (const source of ['src', 'views', 'assets', '.mica']) {
    const directory = resolve(root, source);
    if (inside(directory, output) || inside(output, directory))
      throw new Error(`Device output directory must not overlap source directory ${source}`);
  }
  return output;
}

export async function buildDeviceProject(
  root: string,
  config: MicaConfig,
): Promise<DeviceBuildResult> {
  if (config.device === undefined) throw new Error('Not a unified device project');
  const project = await prepareDeviceProject(root, config);
  void project;
  const loaded = await loadDeviceProject(root, config);
  const { manifest, model, geometry } = loaded;
  const output = safeOutput(root, config.outDir ?? 'dist', defaultOutput(config, manifest.name));
  const release = resolve(root, config.device.release ?? `${relative(root, output)}.release.json`);
  if (inside(output, release)) throw new Error('release.json must be outside the package root');
  if (manifest.view2d?.entry !== undefined)
    throw new Error('view2d.entry is not supported: view runtime adaptation is not implemented');
  if (manifest.entries !== undefined && Object.keys(manifest.entries).length > 0)
    throw new Error('entries are not supported: view runtime adaptation is not implemented');
  if (manifest.view !== undefined && Object.keys(manifest.view).length > 0)
    throw new Error('HTML views are not supported: view runtime adaptation is not implemented');
  const files = new Map<string, Uint8Array>();
  const sources = new Set<string>();
  const add = (path: string, data: Uint8Array): void => {
    if (files.has(path)) throw new Error(`Duplicate device package file: ${path}`);
    files.set(path, data);
  };
  const copied = new Set<string>();
  const copyStatic = async (path: string): Promise<void> => {
    if (copied.has(path) || files.has(path)) return;
    copied.add(path);
    const file = await regularFile(root, resolve(root, path), path);
    sources.add(file);
    add(path, new Uint8Array(await readFile(file)));
  };
  const aliases = config.alias;

  if (manifest.model !== undefined) {
    const entry = await sourceFile(root, config.device.entry ?? 'src/index.ts', 'model.entry');
    sources.add(entry);
    const source =
      `export { create } from ${JSON.stringify(normalizePath(entry))};\n` +
      `export const model = ${modelExpression(stripModelSource(model))};\n`;
    const code = await bundle(root, source, 'model.js', ['create', 'model'], aliases);
    add(manifest.model.entry, Buffer.from(code, 'utf8'));
  }
  if (manifest.view2d !== undefined) {
    if (typeof manifest.view2d.geometry === 'string') await copyStatic(manifest.view2d.geometry);
    if (geometry?.bodyImage !== undefined) await copyStatic(geometry.bodyImage);
  }
  if (manifest.icon !== undefined) await copyStatic(manifest.icon);
  for (const property of Object.values(manifest.properties ?? {})) {
    if (isResourceReference(property.default)) await copyStatic(property.default.src);
  }

  add('package.json', packageManifest(manifest));

  const releaseTarget = await realpath(release).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return release;
    throw error;
  });
  const protectedPaths = new Set([
    loaded.manifestPath,
    resolve(root, config.device.model ?? 'src/model.ddl'),
    resolve(root, 'mica.config.ts'),
    resolve(root, 'tsconfig.json'),
    resolve(root, 'package-lock.json'),
    resolve(root, 'pnpm-lock.yaml'),
    resolve(root, 'yarn.lock'),
    ...sources,
  ]);
  for (const path of protectedPaths) {
    if (inside(output, path))
      throw new Error('Device output directory must not contain project sources');
    if (releaseTarget === path)
      throw new Error('release.json must not overwrite a project source or config');
  }
  const sourceDirectories = new Set([
    resolve(root, 'src'),
    resolve(root, 'views'),
    resolve(root, 'assets'),
    resolve(root, '.mica'),
  ]);
  for (const source of sources) {
    const directory = dirname(source);
    if (relative(root, directory) !== '') sourceDirectories.add(directory);
  }
  for (const directory of sourceDirectories) {
    if (inside(directory, releaseTarget))
      throw new Error('release.json must not be written inside a source directory');
  }
  if (releaseTarget !== release) throw new Error('release.json must not resolve through a symlink');
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  for (const [path, data] of files) {
    const file = resolve(output, path);
    if (!inside(output, file) || relative(output, file) === '')
      throw new Error(`Device package file escapes the package root: ${path}`);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, data);
  }
  const releaseFiles: Record<string, { size: number; integrity: string }> = {};
  for (const path of [...files.keys()].sort()) {
    const data = files.get(path)!;
    releaseFiles[path] = { size: data.length, integrity: integrity(data) };
  }
  const releaseDocument = {
    id: `${manifest.publisher}:${manifest.name}`,
    version: manifest.version,
    files: releaseFiles,
  };
  await mkdir(dirname(release), { recursive: true });
  await writeFile(release, `${JSON.stringify(releaseDocument, null, 2)}\n`, 'utf8');
  return {
    packageDir: output,
    releaseFile: release,
    files: [...files.keys()].sort(),
  };
}

export interface DeviceWatchOptions {
  readonly root: string;
  readonly configFile: string;
  readonly config: MicaConfig;
  readonly debounceMs?: number;
  readonly onPrepare?: (files: readonly string[]) => void;
  readonly onError?: (error: unknown) => void;
}

export interface DeviceWatcher {
  readonly ready: Promise<readonly string[]>;
  dispose(): Promise<void>;
}

export function watchDeviceProject(options: DeviceWatchOptions): DeviceWatcher {
  const root = resolve(options.root);
  const debounceMs = options.debounceMs ?? 50;
  let config = options.config;
  let disposed = false;
  let queued = false;
  let timer: NodeJS.Timeout | undefined;
  let current: Promise<readonly string[]> | undefined;

  const relevant = (filename: string | null): boolean => {
    if (filename === null) return true;
    const normalized = filename.toString().replaceAll('\\', '/');
    if (normalized.startsWith(`${DECLARATION_DIRECTORY}/`)) return false;
    if (normalized.startsWith(`${config.outDir ?? 'dist'}/`)) return false;
    if (normalized.includes('node_modules/')) return false;
    const manifest = config.device?.manifest ?? 'package.json';
    const model = config.device?.model ?? 'src/model.ddl';
    return (
      normalized === manifest ||
      normalized === model ||
      normalized === relative(root, options.configFile).replaceAll('\\', '/') ||
      normalized === 'package.json' ||
      normalized === 'mica.config.ts' ||
      normalized.endsWith('.ddl') ||
      normalized.endsWith('.json') ||
      normalized.startsWith('views/') ||
      normalized.startsWith('assets/')
    );
  };

  const regenerate = async (): Promise<readonly string[]> => {
    if (disposed) return [];
    try {
      const loaded = await loadProjectConfig({ root });
      config = loaded.config;
      const result = await prepareDeviceProject(root, config);
      options.onPrepare?.(result.files);
      return result.files;
    } catch (error) {
      if (!disposed) {
        try {
          options.onError?.(error);
        } catch {
          // A failing reporter must not end the watch loop.
        }
      }
      return [];
    }
  };

  const drain = async (): Promise<readonly string[]> => {
    for (;;) {
      queued = false;
      const files = await regenerate();
      if (!queued || disposed) return files;
    }
  };

  const run = (): void => {
    if (disposed) return;
    if (current !== undefined) {
      queued = true;
      return;
    }
    const task = drain();
    current = task;
    void task.finally(() => {
      if (current === task) current = undefined;
      if (queued && !disposed) schedule();
    });
  };

  const schedule = (): void => {
    if (disposed) return;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      run();
    }, debounceMs);
  };

  let watcher: FSWatcher;
  try {
    watcher = watch(root, { recursive: true }, (_event, filename) => {
      if (!disposed && relevant(filename?.toString() ?? null)) schedule();
    });
  } catch (error) {
    throw new Error(
      `Cannot watch ${root} for device changes: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  watcher.on('error', (error) => {
    if (!disposed) {
      try {
        options.onError?.(error);
      } catch {
        // Ignore reporter failures.
      }
    }
  });

  run();
  return {
    ready: current ?? Promise.resolve([]),
    async dispose() {
      if (disposed) return;
      disposed = true;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      watcher.close();
      await current;
    },
  };
}

export type { DeviceConfig };
export { DevicePackageError };
