#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepare, watchDevices, type PrepareWatcher } from './prepare.js';

/** Writable half of `process.stdout` / `process.stderr`, so tests can capture CLI output. */
export interface CliStreams {
  readonly out: { write(chunk: string): unknown };
  readonly err: { write(chunk: string): unknown };
}

export interface CliArguments {
  readonly help: boolean;
  readonly watch: boolean;
  readonly root: string;
  readonly sourceDir: string;
}

const DEFAULT_SOURCE_DIR = 'src';
const COMMAND = 'prepare';

const USAGE = `Usage: mica prepare [options]

Generates model.d.ddl.ts declarations next to every <source-dir>/devices/<name>/model.ddl.

Options:
  --watch             regenerate whenever a device definition is added, changed or removed
  --root <dir>        package root (default: current directory)
  --source-dir <dir>  source directory inside the root (default: src)
  -h, --help          show this help`;

/**
 * Parses the `mica prepare` command line. The command name is optional, so `mica --watch` runs
 * the same command as `mica prepare --watch`.
 * @throws On an unknown command or option, or a missing option value.
 */
export function parseCliArguments(argv: readonly string[]): CliArguments {
  // A bare `mica` only explains the command instead of guessing a package root.
  let help = argv.length === 0;
  let watch = false;
  let root = process.cwd();
  let sourceDir = DEFAULT_SOURCE_DIR;
  let index = 0;

  const command = argv[0];
  if (command !== undefined && !command.startsWith('-')) {
    if (command !== COMMAND) throw new Error(`Unknown command '${command}'.`);
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
      default:
        throw new Error(`Unknown argument '${argument}'.`);
    }
  }

  return { help, watch, root: resolve(root), sourceDir };
}

/** Runs one `mica prepare` invocation and returns the process exit code. */
export async function runCli(
  argv: readonly string[],
  streams: CliStreams = { out: process.stdout, err: process.stderr },
): Promise<number> {
  let options: CliArguments;
  try {
    options = parseCliArguments(argv);
  } catch (error) {
    streams.err.write(`mica prepare: ${messageOf(error)}\n\n${USAGE}\n`);
    return 1;
  }
  if (options.help) {
    streams.out.write(`${USAGE}\n`);
    return 0;
  }
  return options.watch ? watchLoop(options, streams) : prepareOnce(options, streams);
}

async function prepareOnce(options: CliArguments, streams: CliStreams): Promise<number> {
  try {
    report(await prepare({ root: options.root, sourceDir: options.sourceDir }), streams);
    return 0;
  } catch (error) {
    streams.err.write(`mica prepare: ${messageOf(error)}\n`);
    return 1;
  }
}

function watchLoop(options: CliArguments, streams: CliStreams): Promise<number> {
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
          streams.err.write(`mica prepare: ${messageOf(error)}\n`);
          settle(1);
        },
      );
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);

    void watcher.ready.then(() => {
      if (closing) return;
      const sourceRoot = resolve(options.root, options.sourceDir);
      streams.out.write(`mica prepare: watching ${sourceRoot} for changes\n`);
    });
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
