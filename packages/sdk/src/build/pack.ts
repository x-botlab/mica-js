import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { zipSync } from 'fflate';
import type { loadProjectConfig } from './config.js';
import { isContained, packagePath } from './unified-paths.js';
import type { ReleaseFile, ReleaseManifest } from './unified-package.js';

type Project = Awaited<ReturnType<typeof loadProjectConfig>>;

/**
 * Timestamp stored for every ZIP entry.
 *
 * Local components keep the bytes independent of the clock and the timezone, so packing the same
 * build twice produces identical archives.
 */
const ZIP_MTIME = new Date(1980, 0, 1);

/** Name of the release record that ships at the package root and never describes itself. */
const RELEASE_FILE = 'release.json';

export interface PackDeviceOptions {
  /** Project root; the default archive is written beside it. */
  readonly root: string;
  /** Existing package directory that holds `release.json`. */
  readonly outDir: string;
  /** Archive path; relative paths resolve against the current directory. */
  readonly outFile?: string;
}

export interface PackDeviceResult {
  /** Absolute path of the written archive. */
  readonly outFile: string;
  readonly release: ReleaseManifest;
  /** Package paths written to the archive, including `release.json`. */
  readonly files: readonly string[];
}

/**
 * Packs an existing unified device build into a deterministic ZIP without rebuilding.
 *
 * The archive contains exactly the files declared by `release.json` plus `release.json` itself,
 * sorted by package path and stored without compression. `release.json` describes the published
 * files and is not part of that set. Every declared file must still match its recorded size and
 * SHA-256, so a package that no longer matches its release record is rejected instead of archived.
 *
 * @throws When `outDir` has no `release.json` or a declared file is missing or changed.
 */
export async function packDevice(options: PackDeviceOptions): Promise<PackDeviceResult> {
  const outDir = resolve(options.outDir);
  const releaseFile = join(outDir, RELEASE_FILE);
  let releaseBytes: Buffer;
  try {
    releaseBytes = await readFile(releaseFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    throw new Error(
      `Cannot find ${RELEASE_FILE} in ${outDir}; mica pack archives an existing unified device build, so run mica build first.`,
      { cause: error },
    );
  }
  const release = parseRelease(releaseFile, releaseBytes.toString('utf8'));
  const paths = [...Object.keys(release.files), RELEASE_FILE].sort(compare);
  const entries: Record<string, Uint8Array> = {};
  for (const path of paths) {
    entries[path] =
      path === RELEASE_FILE
        ? new Uint8Array(releaseBytes)
        : await readPackageFile(outDir, path, release.files[path]!);
  }
  const archive = zipSync(entries, { level: 0, mtime: ZIP_MTIME });
  const outFile = resolve(options.outFile ?? join(resolve(options.root), archiveName(release)));
  await mkdir(dirname(outFile), { recursive: true });
  const temporary = `${outFile}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, archive);
    await rename(temporary, outFile);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  return { outFile, release, files: paths };
}

/** Packs the unified device build that the project config declares. */
export function packDeviceProject(
  project: Project,
  options: { readonly outFile?: string } = {},
): Promise<PackDeviceResult> {
  return packDevice({
    root: project.root,
    outDir: resolve(project.root, project.config.outDir ?? 'dist'),
    ...(options.outFile === undefined ? {} : { outFile: options.outFile }),
  });
}

/** Default archive name: `<publisher>-<name>-<version>.zip`, derived from the release id. */
function archiveName(release: ReleaseManifest): string {
  return `${release.id.replaceAll(':', '-')}-${release.version}.zip`;
}

function parseRelease(releaseFile: string, text: string): ReleaseManifest {
  const invalid: (reason: string) => never = (reason) => {
    throw new Error(`Invalid ${releaseFile}: ${reason}`);
  };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    invalid(error instanceof Error ? error.message : String(error));
  }
  const root = value as Record<string, unknown>;
  if (typeof root !== 'object' || root === null || Array.isArray(root))
    invalid('expected an object');
  const { id, version, files } = root;
  if (typeof id !== 'string' || id.length === 0) invalid('id must be a nonempty string');
  if (typeof version !== 'string' || version.length === 0)
    invalid('version must be a nonempty string');
  if (typeof files !== 'object' || files === null || Array.isArray(files))
    invalid('files must be an object');
  const records: Record<string, ReleaseFile> = {};
  for (const [path, entry] of Object.entries(files)) {
    packagePath(path, `${releaseFile} file`);
    if (typeof entry !== 'object' || entry === null) invalid(`files['${path}'] must be an object`);
    const { size, integrity } = entry as Record<string, unknown>;
    if (typeof size !== 'number' || typeof integrity !== 'string')
      invalid(`files['${path}'] must record size and integrity`);
    records[path] = { size, integrity };
  }
  return { id, version, files: records };
}

/** Reads one declared package file and rejects content that `release.json` no longer describes. */
async function readPackageFile(
  outDir: string,
  path: string,
  record: ReleaseFile,
): Promise<Uint8Array> {
  const file = resolve(outDir, ...path.split('/'));
  if (!isContained(outDir, file))
    throw new Error(`Invalid release.json file path '${path}': it escapes ${outDir}`);
  let data: Buffer;
  try {
    data = await readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    throw new Error(`${outDir} is missing '${path}'; run mica build again.`, { cause: error });
  }
  const integrity = `sha256:${createHash('sha256').update(data).digest('hex')}`;
  if (data.byteLength !== record.size || integrity !== record.integrity)
    throw new Error(`${outDir} at '${path}' no longer matches release.json; run mica build again.`);
  return new Uint8Array(data);
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
