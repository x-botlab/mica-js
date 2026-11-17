import { join, resolve } from 'node:path';
import type { AliasOptions } from 'vite';
import type { loadProjectConfig } from './config.js';
import {
  assertSafeOutput,
  collectDevicePackage,
  createRelease,
  writeDevicePackage,
  type DevicePackageFile,
} from './unified-package.js';
import { prepareDevice } from './unified-prepare.js';

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
  const guarded = [
    root,
    resolve(root, sourceDir),
    resolve(root, options.manifest),
    ...(options.model === undefined ? [] : [resolve(root, options.model)]),
    join(root, '.mica'),
  ];
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
  };
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

export type { DevicePackageFile };

function resolveAliases(
  root: string,
  alias: Readonly<Record<string, string>>,
): AliasOptions | undefined {
  const entries = Object.entries(alias);
  if (entries.length === 0) return undefined;
  return Object.fromEntries(entries.map(([key, path]) => [key, resolve(root, path)]));
}
