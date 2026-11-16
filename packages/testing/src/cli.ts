#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { watchPreparation } from '@mica-js/sdk/prepare';
import { loadProjectConfig } from './config';
import { prepareTestbenches, testbenchInputs } from './prepare';

export interface CliStreams {
  readonly out: { write(chunk: string): unknown };
  readonly err: { write(chunk: string): unknown };
}

export interface CliArguments {
  readonly help: boolean;
  readonly watch: boolean;
  readonly updateLock: boolean;
  readonly root: string;
  readonly config?: string;
}

const USAGE = `Usage: mitest <prepare|update-lock> [options]

Generate typed circuit test entry points from mitest.config.ts in .mitest/.
update-lock explicitly updates circuit dependency locks and prepares types.
Execute test cases with your chosen runner, such as Vitest or node:test.

Options:
  --config <file>     explicit mitest.config.ts, relative to --root
  --root <dir>        discovery directory (default: current directory)
  --watch            watch configuration, circuits and package manifests
  --update-lock      explicitly update circuit dependency locks (without --watch)
  -h, --help         show this help`;

export function parseCliArguments(argv: readonly string[]): CliArguments {
  let help = argv.length === 0;
  let watch = false;
  let updateLock = false;
  let root = process.cwd();
  let config: string | undefined;
  let index = 0;
  const first = argv[0];
  if (first !== undefined && !first.startsWith('-')) {
    if (first === 'update-lock') updateLock = true;
    else if (first !== 'prepare') throw new Error(`Unknown command '${first}'.`);
    index = 1;
  }
  for (; index < argv.length; index++) {
    const argument = argv[index]!;
    const separator = argument.indexOf('=');
    const flag = separator === -1 ? argument : argument.slice(0, separator);
    const inline = separator === -1 ? undefined : argument.slice(separator + 1);
    const bare = (): void => {
      if (inline !== undefined) throw new Error(`${flag} does not take a value.`);
    };
    const value = (): string => {
      if (inline !== undefined) {
        if (!inline) throw new Error(`Missing value for ${flag}.`);
        return inline;
      }
      const next = argv[++index];
      if (next === undefined || next.startsWith('-')) throw new Error(`Missing value for ${flag}.`);
      return next;
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
      case '--update-lock':
        bare();
        updateLock = true;
        break;
      case '--root':
        root = resolve(value());
        break;
      case '--config':
        config = value();
        break;
      default:
        throw new Error(`Unknown argument '${argument}'.`);
    }
  }
  if (watch && updateLock)
    throw new Error('--update-lock requires mitest prepare without --watch.');
  return {
    help,
    watch,
    updateLock,
    root: resolve(root),
    ...(config === undefined ? {} : { config }),
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runCli(
  argv: readonly string[],
  streams: CliStreams = {
    out: process.stdout,
    err: process.stderr,
  },
): Promise<number> {
  let options: CliArguments;
  try {
    options = parseCliArguments(argv);
  } catch (error) {
    streams.err.write(`mitest: ${messageOf(error)}\n\n${USAGE}\n`);
    return 1;
  }
  if (options.help) {
    streams.out.write(`${USAGE}\n`);
    return 0;
  }
  try {
    const load = () =>
      loadProjectConfig({
        root: options.root,
        ...(options.config === undefined ? {} : { config: options.config }),
      });
    const project = await load();
    const prepare = (next: Awaited<ReturnType<typeof load>>) =>
      prepareTestbenches({
        ...next,
        ...(options.updateLock ? { updateLock: true } : {}),
      });
    const report = (files: readonly string[]): void => {
      for (const file of files) streams.out.write(`${relative(process.cwd(), file)}\n`);
    };
    if (!options.watch) {
      report(await prepare(project));
      streams.out.write('mitest prepare: circuit testbench types ready\n');
      return 0;
    }
    return await new Promise<number>((settle) => {
      const watcher = watchPreparation({
        load,
        inputs: (next) => [next.configFile, ...testbenchInputs(next)],
        prepare,
        onPrepare: report,
        onError: (error) => streams.err.write(`mitest prepare: ${messageOf(error)}\n`),
      });
      let closing = false;
      const stop = (): void => {
        if (closing) process.exit(0);
        closing = true;
        process.off('SIGINT', stop);
        process.off('SIGTERM', stop);
        void watcher.dispose().then(
          () => settle(0),
          (error: unknown) => {
            streams.err.write(`mitest prepare: ${messageOf(error)}\n`);
            settle(1);
          },
        );
      };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
      void watcher.ready.then(() => {
        if (!closing)
          streams.out.write(`mitest prepare: watching ${project.configFile} for changes\n`);
      });
    });
  } catch (error) {
    streams.err.write(`mitest prepare: ${messageOf(error)}\n`);
    return 1;
  }
}

const entry = process.argv[1];
if (entry !== undefined && realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))) {
  void runCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
