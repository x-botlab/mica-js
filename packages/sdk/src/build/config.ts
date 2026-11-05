import { stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { loadConfigFromFile } from 'vite';

export interface MicaConfig {
  readonly sourceDir?: string;
  readonly outDir?: string;
  readonly base?: string;
  readonly alias?: Readonly<Record<string, string>>;
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
  knownKeys(config, ['sourceDir', 'outDir', 'base', 'alias'], 'default export');
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
  return {
    ...(config as MicaConfig),
    sourceDir: (config.sourceDir as string | undefined) ?? 'src',
    outDir: (config.outDir as string | undefined) ?? 'dist',
    base: (config.base as string | undefined) ?? '/',
  };
}

export async function loadProjectConfig(
  options: { root?: string; config?: string } = {},
): Promise<{ root: string; configFile: string; config: MicaConfig }> {
  const configFile = await findProjectConfig(options.root, options.config);
  const root = dirname(configFile);
  const loaded = await loadConfigFromFile(
    { command: 'build', mode: 'production' },
    configFile,
    root,
    'silent',
    undefined,
    'bundle',
  );
  if (!loaded) throw new Error(`Unable to load Mica project config: ${configFile}`);
  return { root, configFile, config: validateConfig(loaded.config) };
}
