import { stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { loadConfigFromFile } from 'vite';

export interface TestbenchProjectOptions {
  readonly document: string;
  readonly devices: Readonly<Record<string, string>>;
}

export interface MitestConfig {
  readonly testbenches: Readonly<Record<string, TestbenchProjectOptions>>;
}

export function defineConfig(config: MitestConfig): MitestConfig {
  return config;
}

const CONFIG_FILE = 'mitest.config.ts';

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
  const start = resolve(root);
  if (config !== undefined) {
    const file = resolve(start, config);
    if (basename(file) !== CONFIG_FILE)
      throw new Error(`Mitest project config must be named ${CONFIG_FILE}: ${file}`);
    if (!(await isFile(file)))
      throw new Error(`Mitest project config is not a file or does not exist: ${file}`);
    return file;
  }
  let directory = start;
  for (;;) {
    const file = join(directory, CONFIG_FILE);
    if (await isFile(file)) return file;
    const parent = dirname(directory);
    if (parent === directory)
      throw new Error(`No ${CONFIG_FILE} project marker found from ${start} upward`);
    directory = parent;
  }
}

function invalid(field: string, expected: string): never {
  throw new Error(`Invalid Mitest config ${field}: expected ${expected}`);
}

function plainObject(value: unknown, field: string): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  )
    invalid(field, 'a plain object');
  return value as Record<string, unknown>;
}

function knownKeys(value: Record<string, unknown>, keys: readonly string[], field: string): void {
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !keys.includes(key))
      invalid(`${field}.${String(key)}`, 'a supported config key');
  }
}

function validateConfig(value: unknown): MitestConfig {
  const config = plainObject(value, 'default export');
  knownKeys(config, ['testbenches'], 'default export');
  const entries = plainObject(config.testbenches, 'testbenches');
  if (Reflect.ownKeys(entries).length === 0) invalid('testbenches', 'at least one testbench');
  const result: Record<string, TestbenchProjectOptions> = Object.create(null);
  for (const name of Reflect.ownKeys(entries)) {
    if (typeof name !== 'string' || !/^[A-Za-z][A-Za-z0-9]*$/.test(name))
      invalid('testbenches', 'ASCII alphanumeric names beginning with a letter');
    const field = `testbenches.${name}`;
    const entry = plainObject(entries[name], field);
    knownKeys(entry, ['document', 'devices'], field);
    if (typeof entry.document !== 'string' || entry.document.trim().length === 0)
      invalid(`${field}.document`, 'a nonempty path');
    const sources = plainObject(entry.devices, `${field}.devices`);
    const devices: Record<string, string> = Object.create(null);
    for (const id of Reflect.ownKeys(sources)) {
      if (
        typeof id !== 'string' ||
        typeof sources[id] !== 'string' ||
        sources[id].trim().length === 0
      )
        invalid(`${field}.devices`, 'device IDs mapped to nonempty directory paths');
      devices[id] = sources[id];
    }
    result[name] = { document: entry.document, devices };
  }
  return { testbenches: result };
}

export async function loadProjectConfig(options: { root?: string; config?: string } = {}): Promise<{
  readonly root: string;
  readonly configFile: string;
  readonly config: MitestConfig;
}> {
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
  if (!loaded) throw new Error(`Unable to load Mitest project config: ${configFile}`);
  return { root, configFile, config: validateConfig(loaded.config) };
}
