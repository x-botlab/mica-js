import { lstat, open, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { parseStrictJson } from '@mica-js/document/fused';
import type { DeviceRegistry, PackageFile, PackageFiles } from '@mica-js/document/fused';
import { isPackagePath, releaseIntegrity } from './package.js';
import { checkProgramPath, PROGRAM_LIMITS, ProgramError, type ProgramFile } from './program.js';

export async function readProgramDirectory(
  directory: string,
  src: string,
): Promise<readonly ProgramFile[]> {
  checkProgramPath(src);
  const root = await realpath(directory);
  let selected = root;
  for (const part of src.split('/')) {
    selected = resolve(selected, part);
    const info = await lstat(selected);
    if (info.isSymbolicLink() || !info.isDirectory())
      throw new ProgramError(
        'program/source-resolve-failed',
        `Program root ${src} must contain only ordinary directories.`,
      );
  }
  const files: ProgramFile[] = [];
  let total = 0;
  let visited = 0;
  const visit = async (current: string, prefix: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      checkProgramPath(path);
      if (++visited > PROGRAM_LIMITS.maxFiles * PROGRAM_LIMITS.maxDepth)
        throw new ProgramError(
          'program/resource-limit',
          'Program directory traversal exceeds the fixed limit.',
        );
      const file = resolve(current, entry.name);
      if (entry.isDirectory()) await visit(file, path);
      else if (entry.isFile()) {
        if (files.length >= PROGRAM_LIMITS.maxFiles)
          throw new ProgramError(
            'program/resource-limit',
            'Program file count exceeds the fixed limit.',
          );
        const actual = await realpath(file);
        const child = relative(selected, actual);
        if (
          isAbsolute(child) ||
          child === '..' ||
          child.startsWith('..\\') ||
          child.startsWith('../')
        )
          throw new ProgramError(
            'program/source-resolve-failed',
            `Program file ${path} leaves its root.`,
          );
        const handle = await open(file, 'r');
        try {
          const info = await handle.stat();
          if (!info.isFile())
            throw new ProgramError(
              'program/source-resolve-failed',
              `Program file ${path} is not a regular file.`,
            );
          const capacity = Math.min(
            PROGRAM_LIMITS.maxFileBytes,
            PROGRAM_LIMITS.maxTotalBytes - total,
          );
          if (info.size > capacity)
            throw new ProgramError(
              'program/resource-limit',
              `Program file ${path} exceeds the fixed byte limits.`,
            );
          const data = new Uint8Array(info.size);
          let read = 0;
          while (read < data.length) {
            const result = await handle.read(data, read, data.length - read, read);
            if (result.bytesRead === 0)
              throw new ProgramError(
                'program/source-resolve-failed',
                `Program file ${path} changed while reading.`,
              );
            read += result.bytesRead;
          }
          if ((await handle.read(new Uint8Array(1), 0, 1, read)).bytesRead !== 0)
            throw new ProgramError(
              'program/source-resolve-failed',
              `Program file ${path} changed while reading.`,
            );
          total += data.length;
          files.push({ path, data });
        } finally {
          await handle.close();
        }
      } else
        throw new ProgramError(
          'program/source-resolve-failed',
          `Program path ${path} is a link or special file.`,
        );
    }
  };
  await visit(selected, '');
  return files;
}

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
