import { packagePathProblem } from '@mica-js/document/fused';
import type { DeviceLock, PackageFile, PackageFiles } from '@mica-js/document/fused';

/** One locked device release copied next to the host. */
export interface CatalogEntry {
  readonly lock: DeviceLock;
  /** Directory below the host base URL that holds the package files. */
  readonly directory: string;
  readonly files: Readonly<Record<string, PackageFile>>;
}

const INTEGRITY = /^sha256:[0-9a-f]{64}$/;
const DIRECTORY = /^[a-z][a-z0-9-]*$/;
const DEVICE_ID = /^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readFile(value: unknown, path: string): PackageFile {
  if (!record(value)) {
    throw new Error(`Invalid catalog file entry ${JSON.stringify(path)}`);
  }
  const size = value['size'];
  const integrity = value['integrity'];
  if (
    typeof size !== 'number' ||
    !Number.isSafeInteger(size) ||
    size < 0 ||
    typeof integrity !== 'string' ||
    !INTEGRITY.test(integrity)
  ) {
    throw new Error(`Invalid catalog file entry ${JSON.stringify(path)}`);
  }
  return { size, integrity };
}

/**
 * Parses the generated catalog of locked packages.
 *
 * The catalog is an artifact, so the host validates it instead of trusting its shape. Paths are
 * normalized package paths and `package.json` must be part of every release, which keeps a broken
 * preparation step visible before any package byte is verified by the workbench.
 */
export function parseCatalog(value: unknown): readonly CatalogEntry[] {
  if (!Array.isArray(value)) throw new Error('Invalid device catalog: expected an array');
  const seen = new Set<string>();
  return Object.freeze(
    value.map((item: unknown, index): CatalogEntry => {
      if (!record(item)) throw new Error(`Invalid catalog entry ${index}`);
      if (!record(item['lock'])) throw new Error(`Invalid catalog lock ${index}`);
      const { id, version, integrity } = item['lock'];
      if (typeof id !== 'string' || !DEVICE_ID.test(id))
        throw new Error(`Invalid catalog device id ${String(id)}`);
      if (typeof version !== 'string' || version.length === 0)
        throw new Error(`Invalid catalog version for ${id}`);
      if (typeof integrity !== 'string' || !INTEGRITY.test(integrity))
        throw new Error(`Invalid catalog integrity for ${id}`);
      if (seen.has(id)) throw new Error(`Duplicate catalog device ${id}`);
      seen.add(id);
      if (typeof item['directory'] !== 'string' || !DIRECTORY.test(item['directory']))
        throw new Error(`Invalid catalog directory for ${id}`);
      if (!record(item['files'])) throw new Error(`Invalid catalog files for ${id}`);
      const files: Record<string, PackageFile> = Object.create(null) as Record<
        string,
        PackageFile
      >;
      for (const [path, file] of Object.entries(item['files'])) {
        if (packagePathProblem(path) !== undefined) {
          throw new Error(`Invalid catalog path ${JSON.stringify(path)}`);
        }
        files[path] = Object.freeze(readFile(file, path));
      }
      if (!Object.hasOwn(files, 'package.json'))
        throw new Error(`Catalog release ${id} has no package.json`);
      return Object.freeze({
        lock: Object.freeze({ id, version, integrity }),
        directory: item['directory'],
        files: Object.freeze(files),
      });
    }),
  );
}

/** Absolute URL of one declared package file below the host base URL. */
export function packageFileUrl(
  baseUrl: string,
  entry: CatalogEntry,
  path: string,
): string {
  if (packagePathProblem(path) !== undefined) {
    throw new Error(`Invalid package path ${JSON.stringify(path)}`);
  }
  if (!Object.hasOwn(entry.files, path))
    throw new Error(`Release ${entry.lock.id} does not declare ${path}`);
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const encoded = path.split('/').map(encodeURIComponent).join('/');
  return `${base}${entry.directory}/${encoded}`;
}

/** Structural view returned to the workbench device provider. */
export function packageFiles(entry: CatalogEntry, read: (path: string) => Promise<Uint8Array>): PackageFiles {
  return {
    lock: entry.lock,
    files: entry.files,
    read,
  };
}
