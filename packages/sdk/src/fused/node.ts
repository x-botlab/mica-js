import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { parseStrictJson } from '@mica-js/document/fused';
import type { DeviceRegistry, PackageFile, PackageFiles } from '@mica-js/document/fused';
import { isPackagePath, releaseIntegrity } from './package.js';

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function readDirectoryPackage(directory: string): Promise<PackageFiles> {
  const root = await realpath(directory);
  const release = parseStrictJson(await readFile(resolve(root, 'release.json'), 'utf8'));
  if (
    !record(release) ||
    typeof release.id !== 'string' ||
    typeof release.version !== 'string' ||
    !record(release.files) ||
    Object.keys(release).some((key) => !['id', 'version', 'files'].includes(key))
  ) {
    throw new Error(`Invalid release.json in ${root}`);
  }
  const files: Record<string, PackageFile> = Object.create(null);
  for (const [path, file] of Object.entries(release.files)) {
    if (
      !isPackagePath(path) ||
      !record(file) ||
      typeof file.size !== 'number' ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      typeof file.integrity !== 'string' ||
      !/^sha256:[a-f0-9]{64}$/.test(file.integrity) ||
      Object.keys(file).some((key) => !['size', 'integrity'].includes(key))
    ) {
      throw new Error(`Invalid release file ${path} in ${root}`);
    }
    files[path] = Object.freeze({ size: file.size, integrity: file.integrity });
  }
  const identity = { id: release.id, version: release.version, files: Object.freeze(files) };
  const lock = Object.freeze({
    id: identity.id,
    version: identity.version,
    integrity: await releaseIntegrity(identity),
  });
  return Object.freeze({
    lock,
    files: identity.files,
    async read(path: string) {
      if (!isPackagePath(path) || !Object.hasOwn(files, path))
        throw new Error(`Undeclared package file ${path}`);
      const file = await realpath(resolve(root, ...path.split('/')));
      const child = relative(root, file);
      if (
        isAbsolute(child) ||
        child === '..' ||
        child.startsWith('..\\') ||
        child.startsWith('../') ||
        !(await stat(file)).isFile()
      ) {
        throw new Error(`Package file ${path} escapes ${root} or is not a regular file`);
      }
      return new Uint8Array(await readFile(file));
    },
  });
}

export function createDirectoryRegistry(
  directories: Readonly<Record<string, string>>,
): DeviceRegistry {
  const roots = { ...directories };
  return {
    async open(lock) {
      const directory = Object.hasOwn(roots, lock.id) ? roots[lock.id] : undefined;
      if (directory === undefined) throw new Error(`No local package configured for ${lock.id}`);
      const source = await readDirectoryPackage(directory);
      if (
        source.lock.id !== lock.id ||
        source.lock.version !== lock.version ||
        source.lock.integrity !== lock.integrity
      ) {
        throw new Error(
          `Local package ${lock.id} differs from its dependency lock; refresh the dependency lock explicitly`,
        );
      }
      return source;
    },
  };
}
