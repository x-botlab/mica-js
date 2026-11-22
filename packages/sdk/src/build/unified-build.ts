import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import type { AliasOptions } from 'vite';
import type { loadProjectConfig } from './config.js';
import type { PrepareWatcher } from './prepare.js';
import {
  assertSafeOutput,
  collectDevicePackage,
  createRelease,
  releaseIntegrity,
  writeDevicePackage,
  type DevicePackageFile,
  type ReleaseManifest,
} from './unified-package.js';
import { DEVICE_TYPE_DIRECTORY, prepareDevice, watchPreparation } from './unified-prepare.js';

type Project = Awaited<ReturnType<typeof loadProjectConfig>>;

export interface BuildDeviceOptions {
  /** Project root that holds the manifest and the source directory. */
  readonly root: string;
  /** Manifest path relative to the project root. */
  readonly manifest: string;
  /** Output directory that receives the package files and `release.json`. */
  readonly outDir: string;
  /** Source directory whose contents form the package root; defaults to `src`. */
  readonly sourceDir?: string;
  /** DDL source path relative to the project root. */
  readonly model?: string;
  /** Project config file, watched only when preparation runs in watch mode. */
  readonly configFile?: string;
  /** Import aliases resolved against the project root. */
  readonly alias?: Readonly<Record<string, string>>;
  /** Minifies every emitted module; defaults to `true`. */
  readonly minify?: boolean;
}

export interface BuildDeviceResult {
  /** Absolute output directory that holds the package files and `release.json`. */
  readonly outDir: string;
  /** Absolute paths of the written package files. */
  readonly files: readonly string[];
  /** Release record that describes the published package files. */
  readonly release: ReleaseManifest;
}

/**
 * Prepares the type environment, builds every package file and writes the release.
 *
 * Preparation runs first, so a manifest or DDL error prevents the build instead of shipping an
 * artifact that contradicts the sources. Nothing authored by the device is executed: modules are
 * bundled, not run.
 */
export async function buildDevice(options: BuildDeviceOptions): Promise<BuildDeviceResult> {
  const sourceDir = options.sourceDir ?? 'src';
  const root = resolve(options.root);
  const guarded = guardsOf(root, sourceDir, options);
  // Validate before preparation writes anything, and again before the output reset.
  const outDir = assertSafeOutput(options.outDir, guarded);
  const prepared = await prepareDevice({
    root,
    sourceDir,
    manifest: options.manifest,
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.configFile === undefined ? {} : { configFile: options.configFile }),
  });
  const aliases = resolveAliases(options.root, options.alias ?? {});
  const files = await collectDevicePackage({
    root,
    sourceDir,
    device: prepared.device,
    ...(aliases === undefined ? {} : { aliases }),
    ...(options.minify === undefined ? {} : { minify: options.minify }),
  });
  const release = createRelease(prepared.device.manifest, files);
  await writeDevicePackage({ outDir, files, release, protect: guarded });
  return {
    outDir,
    files: files.map((file) => resolve(outDir, ...file.path.split('/'))),
    release,
  };
}

/** Absolute files and directories that an output reset must never touch. */
function guardsOf(root: string, sourceDir: string, options: BuildDeviceOptions): readonly string[] {
  return [
    root,
    resolve(root, sourceDir),
    resolve(root, options.manifest),
    ...(options.model === undefined ? [] : [resolve(root, options.model)]),
    join(root, DEVICE_TYPE_DIRECTORY),
  ];
}

/** Builds the unified device package that the project config declares. */
export async function buildDeviceProject(
  project: Project,
  outDir: string,
): Promise<BuildDeviceResult> {
  const device = project.config.device;
  if (device === undefined)
    throw new Error('The project does not configure a unified device build.');
  return buildDevice({
    root: project.root,
    manifest: device.manifest,
    outDir,
    sourceDir: project.config.sourceDir ?? 'src',
    ...(device.model === undefined ? {} : { model: device.model }),
    configFile: project.configFile,
    ...(project.config.alias === undefined ? {} : { alias: project.config.alias }),
  });
}

export interface WatchDeviceBuildOptions {
  /** Resolves the current build inputs; called again after every change. */
  readonly load: () => Promise<BuildDeviceOptions>;
  /** Coalescing window between a file event and the rebuild; defaults to 50 ms. */
  readonly debounceMs?: number;
  /** Receives `id@version integrity` after every successful build. */
  readonly onBuild?: (summary: string) => void;
  /** Receives build failures; watching continues afterwards. */
  readonly onError?: (error: unknown) => void;
}

/**
 * Builds the device once, then rebuilds after source, manifest, DDL or project config changes.
 *
 * Every build is staged below `.mica` and published only after it completes, so `outDir` always
 * holds one complete package. A failing build reports the original error and leaves the previous
 * package untouched; watching continues. Inputs are re-resolved on every run, so a config edit can
 * retarget the source directory and the output. Build outputs (`.mica` and `outDir`) never feed
 * back into the loop.
 */
export function watchDeviceBuild(options: WatchDeviceBuildOptions): PrepareWatcher {
  return watchPreparation({
    load: options.load,
    inputs: (build) => [
      resolve(build.root, build.manifest),
      ...(build.model === undefined ? [] : [resolve(build.root, build.model)]),
      ...(build.configFile === undefined ? [] : [resolve(build.root, build.configFile)]),
    ],
    directories: (build) => [resolve(build.root, build.sourceDir ?? 'src')],
    ignored: (build) => [
      resolve(build.outDir),
      previousDirectory(build.outDir),
      join(resolve(build.root), DEVICE_TYPE_DIRECTORY),
    ],
    prepare: async (build) => [await buildDeviceStaged(build)],
    ...(options.debounceMs === undefined ? {} : { debounceMs: options.debounceMs }),
    onPrepare: (lines) => {
      const summary = lines[0];
      if (summary !== undefined) options.onBuild?.(summary);
    },
    ...(options.onError === undefined ? {} : { onError: options.onError }),
  });
}

/** Builds into a staging directory and swaps it in, returning the `id@version integrity` summary. */
async function buildDeviceStaged(options: BuildDeviceOptions): Promise<string> {
  const root = resolve(options.root);
  const sourceDir = options.sourceDir ?? 'src';
  const guarded = guardsOf(root, sourceDir, options);
  const outDir = assertSafeOutput(options.outDir, guarded);
  const stagingRoot = join(root, DEVICE_TYPE_DIRECTORY, 'build-watch');
  const staging = join(stagingRoot, 'package');
  await rm(stagingRoot, { recursive: true, force: true });
  try {
    const result = await buildDevice({ ...options, outDir: staging });
    await replaceDirectory(staging, outDir, guarded);
    return `${result.release.id}@${result.release.version} ${releaseIntegrity(result.release)}`;
  } finally {
    // A leftover staging directory is replaced by the next run, so cleanup never fails a build.
    await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Sibling directory that holds the previous package while a new one is swapped in. */
function previousDirectory(outDir: string): string {
  const target = resolve(outDir);
  return join(dirname(target), `.${basename(target)}.mica-previous`);
}

/**
 * Replaces `outDir` with `staging` as one unit: the previous directory is moved aside first, so a
 * consumer never observes a partially written package, and is restored when the swap fails.
 */
async function replaceDirectory(
  staging: string,
  outDir: string,
  protect: readonly string[],
): Promise<void> {
  const target = assertSafeOutput(outDir, protect);
  await mkdir(dirname(target), { recursive: true });
  const backup = previousDirectory(target);
  await rm(backup, { recursive: true, force: true });
  const existed = await exists(target);
  let removable = true;
  try {
    if (existed) await rename(target, backup);
    try {
      await rename(staging, target);
    } catch (error) {
      if (existed) {
        try {
          await rename(backup, target);
        } catch (restoreError) {
          removable = false;
          throw new AggregateError(
            [error, restoreError],
            `Cannot restore ${target}; the previous package is kept in ${backup}`,
            { cause: restoreError },
          );
        }
      }
      throw error;
    }
  } finally {
    if (removable) await rm(backup, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export type { DevicePackageFile };

function resolveAliases(
  root: string,
  alias: Readonly<Record<string, string>>,
): AliasOptions | undefined {
  const entries = Object.entries(alias);
  if (entries.length === 0) return undefined;
  return Object.fromEntries(entries.map(([key, path]) => [key, resolve(root, path)]));
}
