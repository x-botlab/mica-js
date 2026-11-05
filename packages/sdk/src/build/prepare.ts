import { watch, type FSWatcher } from 'node:fs';
import { readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compileDDL, generateDeviceTypeScript, type DeviceIR } from '@mica-js/ddl';

/** Device definition file expected inside every device directory. */
export const DEVICE_SOURCE_FILE = 'model.ddl';

/** TypeScript declaration generated next to {@link DEVICE_SOURCE_FILE}. */
export const DEVICE_DECLARATION_FILE = 'model.d.ddl.ts';

/** Runtime surface every generated declaration imports its boundary types from. */
const DEVICE_MODULE = '@mica-js/sdk/device';

/** Text marking a file as a `mica prepare` output, so only generated files are removed. */
const GENERATED_MARKER = '@mica-js/sdk prepare';

const DEVICE_DIRECTORY = 'devices';
const DEFAULT_SOURCE_DIR = 'src';
const DEFAULT_DEBOUNCE_MS = 50;
const DEVICE_ALIASES = [
  'Props',
  'PropertyInput',
  'Inputs',
  'Memory',
  'Outputs',
  'Context',
  'Batch',
  'Adapter',
  'Factory',
] as const;

export interface PrepareOptions {
  /** Package root containing the source directory; defaults to `process.cwd()`. */
  readonly root?: string;
  /** Source directory inside the root that holds `devices/`; defaults to `src`. */
  readonly sourceDir?: string;
}

export interface WatchOptions extends PrepareOptions {
  /** Coalescing window between a file event and the regeneration; defaults to 50 ms. */
  readonly debounceMs?: number;
  /** Receives the declaration paths after every successful regeneration. */
  readonly onPrepare?: (files: readonly string[]) => void;
  /** Receives every failed regeneration; watching continues afterwards. */
  readonly onError?: (error: unknown) => void;
}

export interface PrepareWatcher {
  /** Declaration paths from the initial scan; resolves empty when that scan failed. */
  readonly ready: Promise<readonly string[]>;
  /** Stops watching and resolves once the regeneration in flight has finished. */
  dispose(): Promise<void>;
}

/**
 * Compiles `<root>/<sourceDir>/devices/<name>/model.ddl` into the source-adjacent
 * `model.d.ddl.ts` declaration module of every device directory.
 *
 * Every device compiles before the first write, so a failing definition never leaves the package
 * with a partly updated set of declarations. A declaration whose content is unchanged keeps its
 * previous file and timestamp. The previous declaration of a device is removed when its
 * definition fails to compile or no longer exists; only files carrying the generated marker are
 * ever removed.
 *
 * @returns Absolute paths of the declaration files that the current definitions describe, in
 * device directory order.
 * @throws The original `BuildError` of a failed compilation, with the device file path prefixed
 * to its message.
 */
export async function prepare(options: PrepareOptions = {}): Promise<readonly string[]> {
  const root = resolve(options.root ?? process.cwd());
  const sourceDir = options.sourceDir ?? DEFAULT_SOURCE_DIR;
  const devicesDir = resolve(root, sourceDir, DEVICE_DIRECTORY);

  const directories = await listDeviceDirectories(devicesDir);
  const devices: { sourceFile: string; declarationFile: string }[] = [];
  const orphaned: string[] = [];
  for (const directory of directories) {
    const deviceDir = join(devicesDir, directory);
    const sourceFile = join(deviceDir, DEVICE_SOURCE_FILE);
    const declarationFile = join(deviceDir, DEVICE_DECLARATION_FILE);
    if (await isFile(sourceFile)) devices.push({ sourceFile, declarationFile });
    else orphaned.push(declarationFile);
  }

  const outputs: { file: string; content: string }[] = [];
  for (const device of devices)
    outputs.push({
      file: device.declarationFile,
      content: await compileDeclaration(device.sourceFile, device.declarationFile),
    });

  for (const file of orphaned) await removeGenerated(file);
  for (const output of outputs) await writeIfChanged(output.file, output.content);
  return outputs.map((output) => output.file);
}

/**
 * Regenerates declarations whenever a device definition below `<root>/<sourceDir>` appears,
 * changes or disappears; output writes never feed back into the watch loop.
 *
 * Events are coalesced within {@link WatchOptions.debounceMs} and runs are serialized, so a
 * save burst produces a single regeneration. Failures reach {@link WatchOptions.onError} and
 * never stop the watcher.
 *
 * @throws When the source directory cannot be watched; the message names that directory.
 */
export function watchDevices(options: WatchOptions = {}): PrepareWatcher {
  const root = resolve(options.root ?? process.cwd());
  const sourceDir = options.sourceDir ?? DEFAULT_SOURCE_DIR;
  const sourceRoot = resolve(root, sourceDir);
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;

  let disposed = false;
  let queued = false;
  let timer: NodeJS.Timeout | undefined;
  let current: Promise<readonly string[]> | undefined;

  const report = (error: unknown): void => {
    try {
      options.onError?.(error);
    } catch {
      // A failing reporter must not end the watch loop.
    }
  };

  const scan = async (): Promise<readonly string[]> => {
    try {
      const files = await prepare({ root, sourceDir });
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

  let watcher: FSWatcher;
  try {
    watcher = watch(sourceRoot, { recursive: true }, (_event, filename) => {
      if (disposed) return;
      void isRelevantEvent(sourceRoot, filename).then(
        (relevant) => {
          if (relevant && !disposed) schedule();
        },
        () => {
          // An unreadable path may still be the device directory that changed.
          if (!disposed) schedule();
        },
      );
    });
  } catch (error) {
    throw new Error(
      `Cannot watch ${sourceRoot} for ${DEVICE_SOURCE_FILE} changes: ${messageOf(error)}`,
      { cause: error },
    );
  }
  watcher.on('error', (error) => {
    if (!disposed) report(error);
  });

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
      watcher.close();
      await current;
    },
  };
}

async function compileDeclaration(sourceFile: string, declarationFile: string): Promise<string> {
  try {
    const source = await readFile(sourceFile, 'utf8');
    const model = await compileDDL(source, { uri: pathToFileURL(sourceFile).href });
    return renderDeclaration(model);
  } catch (error) {
    // The editor must never keep declarations that a failed definition contradicts.
    await removeGenerated(declarationFile).catch(() => undefined);
    throw annotate(error, sourceFile);
  }
}

function renderDeclaration(model: DeviceIR): string {
  const prefix = model.name;
  const generated = generateDeviceTypeScript(model, {
    deviceModule: DEVICE_MODULE,
    name: prefix,
  });
  const aliases = DEVICE_ALIASES.map((alias) => `export type ${alias} = ${prefix}${alias};`);
  return [
    `// Generated by ${GENERATED_MARKER} from ${DEVICE_SOURCE_FILE}; do not edit.`,
    '',
    generated.trimEnd(),
    '',
    ...aliases,
    '',
  ].join('\n');
}

/** A `model.ddl` edit or a device directory appearing, disappearing or being renamed. */
async function isRelevantEvent(
  sourceRoot: string,
  filename: string | Buffer | null,
): Promise<boolean> {
  if (filename === null) return true;
  const relativePath = filename.toString();
  if (basename(relativePath) === DEVICE_SOURCE_FILE) return true;
  return isDirectory(join(sourceRoot, relativePath));
}

async function listDeviceDirectories(devicesDir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(devicesDir, { withFileTypes: true });
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return [];
    throw error;
  }
  const directories: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) directories.push(entry.name);
    else if (entry.isSymbolicLink() && (await isDirectory(join(devicesDir, entry.name))))
      directories.push(entry.name);
  }
  return directories.sort();
}

async function removeGenerated(file: string): Promise<void> {
  let content: string;
  try {
    content = await readFile(file, 'utf8');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return;
    throw error;
  }
  if (!content.includes(GENERATED_MARKER)) return;
  await unlink(file).catch((error: unknown) => {
    if (errorCode(error) !== 'ENOENT') throw error;
  });
}

async function writeIfChanged(file: string, content: string): Promise<void> {
  try {
    if ((await readFile(file, 'utf8')) === content) return;
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
  }
  await writeFile(file, content, 'utf8');
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    throw error;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    throw error;
  }
}

function annotate(error: unknown, sourceFile: string): Error {
  if (error instanceof Error) {
    error.message = `${sourceFile}: ${error.message}`;
    return error;
  }
  return new Error(`${sourceFile}: ${String(error)}`);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const code: unknown = error.code;
  return typeof code === 'string' ? code : undefined;
}
