import { readFile, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { loadConfigFromFile } from 'vite';

/** Single unified-device project settings; presence of `device` selects the new build mode. */
export interface DeviceConfig {
  /** Project-root manifest; defaults to `package.json`. */
  readonly manifest?: string;
  /** DDL source; defaults to `src/model.ddl`. */
  readonly model?: string;
  /** Author factory entry; defaults to `src/index.ts`. */
  readonly entry?: string;
  /** Package root relative to the project root; defaults to `<outDir>/<name>`. */
  readonly output?: string;
  /** Release manifest outside the package root; defaults to `<output>.release.json`. */
  readonly release?: string;
}

export interface MicaConfig {
  readonly sourceDir?: string;
  readonly outDir?: string;
  readonly base?: string;
  readonly alias?: Readonly<Record<string, string>>;
  readonly device?: DeviceConfig;
}

export function defineConfig(config: MicaConfig): MicaConfig {
  return config;
}

const CONFIG_FILE = 'mica.config.ts';

async function isFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    throw error;
  }
}

export async function findProjectConfig(root = process.cwd(), config?: string): Promise<string> {
  const startingRoot = resolve(root);
  if (config !== undefined) {
    const file = resolve(startingRoot, config);
    if (basename(file) !== CONFIG_FILE) {
      throw new Error(`Mica project config must be named ${CONFIG_FILE}: ${file}`);
    }
    if (!(await isFile(file))) {
      throw new Error(`Mica project config is not a file or does not exist: ${file}`);
    }
    return file;
  }

  let directory = startingRoot;
  while (true) {
    const file = join(directory, CONFIG_FILE);
    if (await isFile(file)) return file;
    const parent = dirname(directory);
    if (parent === directory) {
      throw new Error(`No ${CONFIG_FILE} project marker found from ${startingRoot} upward`);
    }
    directory = parent;
  }
}

function invalid(field: string, expected: string): never {
  throw new Error(`Invalid Mica config ${field}: expected ${expected}`);
}

function plainObject(value: unknown, field: string): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  ) {
    return invalid(field, 'a plain object');
  }
  return value as Record<string, unknown>;
}

function knownKeys(value: Record<string, unknown>, keys: readonly string[], field: string): void {
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !keys.includes(key)) {
      invalid(`${field}.${String(key)}`, 'a supported config key');
    }
  }
}

function validateConfig(value: unknown): MicaConfig {
  const config = plainObject(value, 'default export');
  knownKeys(config, ['sourceDir', 'outDir', 'base', 'alias', 'device'], 'default export');
  for (const field of ['sourceDir', 'outDir', 'base'] as const) {
    const entry = config[field];
    if (entry !== undefined && (typeof entry !== 'string' || entry.trim().length === 0)) {
      invalid(field, 'a nonempty string');
    }
  }
  if (config.alias !== undefined) {
    const aliases = plainObject(config.alias, 'alias');
    for (const key of Reflect.ownKeys(aliases)) {
      if (typeof key !== 'string' || typeof aliases[key] !== 'string') {
        invalid(`alias.${String(key)}`, 'a string');
      }
    }
  }
  let device: DeviceConfig | undefined;
  if (config.device !== undefined) {
    const value = plainObject(config.device, 'device');
    knownKeys(value, ['manifest', 'model', 'entry', 'output', 'release'], 'device');
    for (const field of ['manifest', 'model', 'entry', 'output', 'release'] as const) {
      const entry = value[field];
      if (entry !== undefined && (typeof entry !== 'string' || entry.trim().length === 0)) {
        invalid(`device.${field}`, 'a nonempty string');
      }
    }
    device = { ...(value as DeviceConfig) };
  }
  return {
    ...(config as MicaConfig),
    sourceDir: (config.sourceDir as string | undefined) ?? 'src',
    outDir: (config.outDir as string | undefined) ?? 'dist',
    base: (config.base as string | undefined) ?? '/',
    ...(device === undefined ? {} : { device }),
  };
}

/**
 * A project-root `package.json` carrying the unified device identity selects device mode even
 * when the optional `device` key is absent from `mica.config.ts`.
 */
async function isDeviceManifest(packageFile: string): Promise<boolean> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(packageFile, 'utf8'));
  } catch {
    return false;
  }
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  const engines = record.engines;
  return (
    typeof record.publisher === 'string' &&
    typeof record.name === 'string' &&
    typeof record.displayName === 'string' &&
    typeof engines === 'object' &&
    engines !== null &&
    typeof (engines as Record<string, unknown>).mica === 'string'
  );
}

export async function loadProjectConfig(
  options: { root?: string; config?: string } = {},
): Promise<{ root: string; configFile: string; config: MicaConfig }> {
  const startingRoot = resolve(options.root ?? process.cwd());
  const localConfig = join(startingRoot, CONFIG_FILE);
  let configFile: string;
  if (
    options.config === undefined &&
    (await isDeviceManifest(join(startingRoot, 'package.json')))
  ) {
    // A single-device manifest at the starting root outranks an aggregate config above it.
    configFile = localConfig;
  } else {
    try {
      configFile = await findProjectConfig(options.root, options.config);
    } catch (error) {
      if (
        options.config !== undefined ||
        !(await isDeviceManifest(join(startingRoot, 'package.json')))
      )
        throw error;
      // Unified device projects may omit mica.config.ts entirely; the manifest is the marker.
      configFile = localConfig;
    }
  }
  const root = dirname(configFile);
  const loaded = (await isFile(configFile))
    ? await loadConfigFromFile(
        { command: 'build', mode: 'production' },
        configFile,
        root,
        'silent',
        undefined,
        'bundle',
      )
    : null;
  if (!loaded && (await isFile(configFile)))
    throw new Error(`Unable to load Mica project config: ${configFile}`);
  let config = validateConfig(loaded?.config ?? {});
  if (config.device === undefined && (await isDeviceManifest(join(root, 'package.json'))))
    config = { ...config, device: {} };
  return { root, configFile, config };
}
