#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { loadProjectConfig, type MicaConfig } from './config.js';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepare, watchDevices, type PrepareWatcher } from './prepare.js';
import type { BuildDeviceOptions } from './unified-build.js';
import { prepareDevice, watchDevice, type PrepareDeviceOptions } from './unified-prepare.js';

/** Writable half of `process.stdout` / `process.stderr`, so tests can capture CLI output. */
export interface CliStreams {
  readonly out: { write(chunk: string): unknown };
  readonly err: { write(chunk: string): unknown };
}

export interface CliArguments {
  readonly command: 'prepare' | 'build' | 'pack';
  readonly help: boolean;
  readonly watch: boolean;
  readonly root: string;
  readonly config?: string;
  readonly sourceDir?: string;
  readonly out?: string;
}

type PrepareOptions = { readonly root: string; readonly sourceDir: string };

/** Resolved project configuration; unified device projects reload it in watch mode. */
interface Project extends Awaited<ReturnType<typeof loadProjectConfig>> {
  readonly config: MicaConfig;
}

const USAGE = `Usage: mica <command> [options]

Commands:
  build              build one unified device package or standalone component artifacts
  pack               archive the existing unified device build into a ZIP, without rebuilding
  prepare            generate the type environment of the configured project

A mica.config.ts file identifies the project; it is discovered upwards from --root.
Projects that configure \`device\` build a unified device package and generate .mica types.

Options:
  --config <file>     explicit mica.config.ts, relative to --root
  --root <dir>        discovery directory (default: current directory)
  --source-dir <dir>  override the configured source directory
  --out <file>        ZIP output path (pack; default: <root>/<publisher>-<name>-<version>.zip)
  --watch            rebuild device projects on change, or watch prepare inputs (prepare)
  -h, --help         show this help`;

/** Parses SDK commands without reading or executing project configuration. */
export function parseCliArguments(argv: readonly string[]): CliArguments {
  // A bare `mica` only explains the command instead of guessing a package root.
  let help = argv.length === 0;
  let watch = false;
  let root = process.cwd();
  let sourceDir: string | undefined;
  let config: string | undefined;
  let out: string | undefined;
  let command: CliArguments['command'] = 'prepare';
  let index = 0;

  const first = argv[0];
  if (first !== undefined && !first.startsWith('-')) {
    if (first !== 'prepare' && first !== 'build' && first !== 'pack')
      throw new Error(`Unknown command '${first}'.`);
    command = first;
    index = 1;
  }

  for (; index < argv.length; index++) {
    const argument = argv[index]!;
    const separator = argument.indexOf('=');
    const flag = separator === -1 ? argument : argument.slice(0, separator);
    const inline = separator === -1 ? undefined : argument.slice(separator + 1);
    const flagValue = (): string => {
      if (inline !== undefined) {
        if (!inline) throw new Error(`Missing value for ${flag}.`);
        return inline;
      }
      const next = argv[++index];
      if (next === undefined || next.startsWith('-')) throw new Error(`Missing value for ${flag}.`);
      return next;
    };
    const bare = (): void => {
      if (inline !== undefined) throw new Error(`${flag} does not take a value.`);
    };

    switch (flag) {
      case '-h':
      case '--help':
        bare();
        help = true;
        break;
      case '--watch':
        bare();
        watch = true;
        break;
      case '--root':
        root = resolve(flagValue());
        break;
      case '--source-dir':
        sourceDir = flagValue();
        break;
      case '--config':
        config = flagValue();
        break;
      case '--out':
        out = flagValue();
        break;
      default:
        throw new Error(`Unknown argument '${argument}'.`);
    }
  }

  if (watch && command === 'pack') throw new Error('--watch is not supported by mica pack.');
  return {
    command,
    help,
    watch,
    root: resolve(root),
    ...(sourceDir === undefined ? {} : { sourceDir }),
    ...(config === undefined ? {} : { config }),
    ...(out === undefined ? {} : { out }),
  };
}

/** Runs one SDK command and returns its exit code. */
export async function runCli(
  argv: readonly string[],
  streams: CliStreams = { out: process.stdout, err: process.stderr },
): Promise<number> {
  let options: CliArguments;
  try {
    options = parseCliArguments(argv);
  } catch (error) {
    streams.err.write(`mica: ${messageOf(error)}\n\n${USAGE}\n`);
    return 1;
  }
  if (options.help) {
    streams.out.write(`${USAGE}\n`);
    return 0;
  }
  const load = async (): Promise<Project> => {
    const project = await loadProjectConfig({
      root: options.root,
      ...(options.config === undefined ? {} : { config: options.config }),
    });
    return {
      ...project,
      config: {
        ...project.config,
        ...(options.sourceDir === undefined ? {} : { sourceDir: options.sourceDir }),
      },
    };
  };
  try {
    const project = await load();
    if (options.command === 'build') {
      const { buildProject, resolveDeviceBuildOptions } = await import('./project.js');
      if (options.watch) {
        if (project.config.device === undefined)
          throw new Error('--watch requires a unified device project (device in mica.config.ts).');
        const loadBuild = async (): Promise<BuildDeviceOptions> =>
          resolveDeviceBuildOptions(await load());
        return await watchBuildLoop(project, loadBuild, streams);
      }
      await buildProject(project);
      streams.out.write('mica build: complete\n');
      return 0;
    }
    if (options.command === 'pack') {
      const { packDeviceProject } = await import('./pack.js');
      const packed = await packDeviceProject(
        project,
        options.out === undefined ? {} : { outFile: resolve(options.out) },
      );
      streams.out.write(`mica pack: ${packed.outFile}\n`);
      return 0;
    }
    if (project.config.device !== undefined) {
      const loadDevice = async (): Promise<PrepareDeviceOptions> => {
        const next = await load();
        const device = next.config.device;
        if (device === undefined)
          throw new Error('The unified device configuration was removed from mica.config.ts.');
        return {
          root: next.root,
          sourceDir: next.config.sourceDir ?? 'src',
          manifest: device.manifest,
          ...(device.model === undefined ? {} : { model: device.model }),
          configFile: next.configFile,
        };
      };
      const initial = await loadDevice();
      return options.watch
        ? await watchDeviceLoop(loadDevice, initial, streams)
        : await prepareDeviceOnce(initial, streams);
    }
    const preparation = { root: project.root, sourceDir: project.config.sourceDir ?? 'src' };
    return options.watch
      ? await watchLoop(preparation, streams)
      : await prepareOnce(preparation, streams);
  } catch (error) {
    streams.err.write(`mica ${options.command}: ${messageOf(error)}\n`);
    return 1;
  }
}

async function prepareOnce(options: PrepareOptions, streams: CliStreams): Promise<number> {
  try {
    report(await prepare({ root: options.root, sourceDir: options.sourceDir }), streams);
    return 0;
  } catch (error) {
    streams.err.write(`mica prepare: ${messageOf(error)}\n`);
    return 1;
  }
}

function watchLoop(options: PrepareOptions, streams: CliStreams): Promise<number> {
  return new Promise<number>((settle) => {
    let watcher: PrepareWatcher;
    try {
      watcher = watchDevices({
        root: options.root,
        sourceDir: options.sourceDir,
        onPrepare: (files) => report(files, streams),
        onError: (error) => streams.err.write(`mica prepare: ${messageOf(error)}\n`),
      });
    } catch (error) {
      streams.err.write(`mica prepare: ${messageOf(error)}\n`);
      settle(1);
      return;
    }
    awaitWatch(watcher, streams, settle, 'prepare', () => resolve(options.root, options.sourceDir));
  });
}

async function prepareDeviceOnce(
  options: PrepareDeviceOptions,
  streams: CliStreams,
): Promise<number> {
  try {
    const prepared = await prepareDevice(options);
    for (const file of prepared.files) streams.out.write(`${relative(process.cwd(), file)}\n`);
    streams.out.write(`mica prepare: device type environment ready for ${options.manifest}\n`);
    return 0;
  } catch (error) {
    streams.err.write(`mica prepare: ${messageOf(error)}\n`);
    return 1;
  }
}

function watchDeviceLoop(
  load: () => Promise<PrepareDeviceOptions>,
  initial: PrepareDeviceOptions,
  streams: CliStreams,
): Promise<number> {
  return new Promise<number>((settle) => {
    let watcher: PrepareWatcher;
    try {
      watcher = watchDevice({
        load,
        onPrepare: (files) => {
          for (const file of files) streams.out.write(`${relative(process.cwd(), file)}\n`);
        },
        onError: (error) => streams.err.write(`mica prepare: ${messageOf(error)}\n`),
      });
    } catch (error) {
      streams.err.write(`mica prepare: ${messageOf(error)}\n`);
      settle(1);
      return;
    }
    awaitWatch(watcher, streams, settle, 'prepare', () =>
      [initial.manifest, initial.model, initial.configFile]
        .filter((file): file is string => file !== undefined)
        .map((file) => relative(process.cwd(), resolve(initial.root, file)))
        .join(', '),
    );
  });
}

async function watchBuildLoop(
  project: Project,
  load: () => Promise<BuildDeviceOptions>,
  streams: CliStreams,
): Promise<number> {
  const { watchDeviceBuild } = await import('./unified-build.js');
  const sourceDir = resolve(project.root, project.config.sourceDir ?? 'src');
  return new Promise<number>((settle) => {
    let watcher: PrepareWatcher;
    try {
      watcher = watchDeviceBuild({
        load,
        onBuild: (summary) => streams.out.write(`mica build: complete ${summary}\n`),
        onError: (error) => streams.err.write(`mica build: ${messageOf(error)}\n`),
      });
    } catch (error) {
      streams.err.write(`mica build: ${messageOf(error)}\n`);
      settle(1);
      return;
    }
    awaitWatch(watcher, streams, settle, 'build', () => relative(process.cwd(), sourceDir) || '.');
  });
}

/** Reports readiness and stops the watcher on the first termination signal. */
function awaitWatch(
  watcher: PrepareWatcher,
  streams: CliStreams,
  settle: (code: number) => void,
  command: CliArguments['command'],
  watching: () => string,
): void {
  let closing = false;
  const stop = (): void => {
    // A second signal must not wait for a regeneration that may already be stuck.
    if (closing) process.exit(0);
    closing = true;
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    void watcher.dispose().then(
      () => settle(0),
      (error: unknown) => {
        streams.err.write(`mica ${command}: ${messageOf(error)}\n`);
        settle(1);
      },
    );
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  void watcher.ready.then(() => {
    if (closing) return;
    streams.out.write(`mica ${command}: watching ${watching()} for changes\n`);
  });
}

function report(files: readonly string[], streams: CliStreams): void {
  for (const file of files) streams.out.write(`${relative(process.cwd(), file)}\n`);
  if (!files.length) {
    streams.out.write('mica prepare: no device definitions found\n');
    return;
  }
  const plural = files.length === 1 ? 'declaration' : 'declarations';
  streams.out.write(`mica prepare: ${files.length} device ${plural} ready\n`);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  void runCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
