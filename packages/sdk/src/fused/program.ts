import { projectPathProblem } from '@mica-js/document/fused';
import type { ProgramFiles, ProgramFormat, ProgramLoader } from '@mica-js/document/fused';
import { readonlyBytes } from './firmware.js';
import { unzipSync } from 'fflate';

export const PROGRAM_LIMITS = Object.freeze({
  maxFiles: 1024,
  maxFileBytes: 32 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
  maxMemoryBytes: 64 * 1024 * 1024,
  maxPathBytes: 1024,
  maxDepth: 32,
});

export interface ProgramTarget {
  readonly deviceId: string;
  readonly property: string;
  readonly loader: ProgramLoader;
}
export interface ProgramProject {
  readonly id: string;
  readonly title: string;
}
export interface ProgramFile {
  readonly path: string;
  readonly data: Uint8Array;
}
export type ProgramArtifact =
  | { readonly kind: 'memory'; readonly format: ProgramFormat; readonly data: Uint8Array }
  | { readonly kind: 'filesystem'; readonly files: readonly ProgramFile[] };
export interface ProgramProjectSelectionRequest extends ProgramTarget {
  readonly templateIds: readonly string[];
}
export interface ProgramProjectProvider {
  select?(
    request: ProgramProjectSelectionRequest,
    signal: AbortSignal,
  ): Promise<ProgramProject | undefined>;
  resolve(projectId: string, target: ProgramTarget, signal?: AbortSignal): Promise<ProgramArtifact>;
}
export interface ProgramSources {
  readonly projects?: ProgramProjectProvider;
}

export class ProgramError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ProgramError';
  }
}

export function readProgramArchive(data: Uint8Array): readonly ProgramFile[] {
  if (data.byteLength > PROGRAM_LIMITS.maxTotalBytes)
    throw new ProgramError('program/resource-limit', 'Program archive exceeds the byte limit.');
  const names = new Set<string>();
  let total = 0;
  try {
    const files = unzipSync(data, {
      filter(file) {
        checkProgramPath(file.name.endsWith('/') ? file.name.slice(0, -1) : file.name);
        if (file.name.endsWith('/')) return false;
        if (names.has(file.name))
          throw new ProgramError('program/invalid-path', `Duplicate program path ${file.name}.`);
        names.add(file.name);
        total += file.originalSize;
        if (
          names.size > PROGRAM_LIMITS.maxFiles ||
          file.originalSize > PROGRAM_LIMITS.maxFileBytes ||
          total > PROGRAM_LIMITS.maxTotalBytes
        )
          throw new ProgramError(
            'program/resource-limit',
            'Program archive exceeds the file limits.',
          );
        return true;
      },
    });
    return Object.entries(files).map(([path, bytes]) => ({ path, data: bytes }));
  } catch (cause) {
    if (cause instanceof ProgramError) throw cause;
    throw new ProgramError(
      'program/source-resolve-failed',
      `Cannot decode program ZIP: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}

export function checkProgramPath(path: string): void {
  const problem = projectPathProblem(path);
  if (problem !== undefined)
    throw new ProgramError(
      'program/invalid-path',
      `Program path ${JSON.stringify(path)} ${problem}.`,
    );
  if (
    new TextEncoder().encode(path).length > PROGRAM_LIMITS.maxPathBytes ||
    path.split('/').length > PROGRAM_LIMITS.maxDepth
  ) {
    throw new ProgramError(
      'program/resource-limit',
      `Program path ${JSON.stringify(path)} exceeds the fixed path limits.`,
    );
  }
}

export function createProgramFiles(files: readonly ProgramFile[]): ProgramFiles {
  if (!Array.isArray(files))
    throw new ProgramError('program/source-resolve-failed', 'A program file set must be an array.');
  if (files.length > PROGRAM_LIMITS.maxFiles)
    throw new ProgramError('program/resource-limit', 'Program file count exceeds the fixed limit.');
  const snapshots = new Map<string, ReturnType<typeof readonlyBytes>>();
  let total = 0;
  for (const file of files) {
    if (
      file === null ||
      typeof file !== 'object' ||
      typeof file.path !== 'string' ||
      !(file.data instanceof Uint8Array)
    ) {
      throw new ProgramError(
        'program/source-resolve-failed',
        'Program files require a path and Uint8Array data.',
      );
    }
    checkProgramPath(file.path);
    if (snapshots.has(file.path))
      throw new ProgramError('program/invalid-path', `Duplicate program path ${file.path}.`);
    total += file.data.byteLength;
    if (file.data.byteLength > PROGRAM_LIMITS.maxFileBytes || total > PROGRAM_LIMITS.maxTotalBytes)
      throw new ProgramError(
        'program/resource-limit',
        'Program file bytes exceed the fixed limit.',
      );
    snapshots.set(file.path, readonlyBytes(file.data));
  }
  const paths = Object.freeze([...snapshots.keys()].sort());
  for (const path of paths) {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) {
      if (snapshots.has(parts.slice(0, i).join('/')))
        throw new ProgramError(
          'program/invalid-path',
          `Program file ${path} conflicts with a parent file.`,
        );
    }
  }
  return Object.freeze({
    paths,
    read(path: string) {
      checkProgramPath(path);
      const bytes = snapshots.get(path);
      if (bytes === undefined)
        throw new ProgramError('program/file-not-found', `Program file ${path} does not exist.`);
      return bytes;
    },
  });
}
