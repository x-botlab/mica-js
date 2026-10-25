import type { Stats } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createAssetError, type AssetError } from './errors';

/** Default upper bound for one asset: 10 MiB, the host-wide limit from RFC 0009 §3. */
export const DEFAULT_ASSET_MAX_SIZE = 10 * 1024 * 1024;

/** Optional content check, e.g. an image decoder. Throwing reports `asset/undecodable`. */
export type AssetDecoder = (bytes: Uint8Array, src: string) => void | Promise<void>;

export interface AssetResolverOptions {
  /** Project root. `src` is resolved relative to it and may not escape it. */
  readonly rootDir: string;
  /** Maximum accepted file size in bytes; defaults to {@link DEFAULT_ASSET_MAX_SIZE}. */
  readonly maxSize?: number;
  /** Optional decoder; a rejection maps to `asset/undecodable`. */
  readonly decode?: AssetDecoder;
}

/**
 * Resolves a project-relative resource reference to its bytes.
 *
 * The path is canonicalized twice — lexically against `rootDir`, then through `fs.realpath` — so
 * `..` segments and symlinks that leave the project root both report `asset/out-of-root`. The
 * resolver never performs a network read.
 */
export async function resolveAsset(
  src: string,
  options: AssetResolverOptions,
): Promise<Uint8Array | AssetError> {
  const { rootDir, decode } = options;
  const maxSize = options.maxSize ?? DEFAULT_ASSET_MAX_SIZE;
  if (typeof src !== 'string' || src.length === 0) {
    return createAssetError('asset/missing', 'Asset src must be a non-empty string.', String(src));
  }
  if (!Number.isFinite(maxSize) || maxSize < 0) {
    return createAssetError('asset/too-large', `Invalid asset size limit: ${maxSize}`, src);
  }

  const root = path.resolve(rootDir);
  const resolved = path.resolve(root, src);
  if (!isWithin(root, resolved)) {
    return createAssetError('asset/out-of-root', `Asset path escapes root: ${src}`, src);
  }

  let realPath: string;
  try {
    realPath = await fs.realpath(resolved);
  } catch (error) {
    return fileSystemError(error, src, 'resolve');
  }

  // The root itself may be reached through a symlink (macOS `/var` -> `/private/var`), so compare
  // the escaped path against the canonical root rather than the configured spelling.
  const realRoot = await realPathOrSelf(root);
  if (!isWithin(realRoot, realPath)) {
    return createAssetError(
      'asset/out-of-root',
      `Asset symlink escapes root: ${src} -> ${realPath}`,
      src,
    );
  }

  let stats: Stats;
  try {
    stats = await fs.stat(realPath);
  } catch (error) {
    return fileSystemError(error, src, 'inspect');
  }
  if (!stats.isFile()) {
    return createAssetError('asset/undecodable', `Asset is not a regular file: ${src}`, src);
  }
  if (stats.size > maxSize) {
    return createAssetError(
      'asset/too-large',
      `Asset too large: ${stats.size} bytes exceeds limit ${maxSize}`,
      src,
      { size: stats.size, maxSize },
    );
  }

  let bytes: Uint8Array;
  try {
    const data = await fs.readFile(realPath);
    bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  } catch (error) {
    return fileSystemError(error, src, 'read');
  }
  // The file may have grown between `stat` and `readFile`; the read result is authoritative.
  if (bytes.byteLength > maxSize) {
    return createAssetError(
      'asset/too-large',
      `Asset too large: ${bytes.byteLength} bytes exceeds limit ${maxSize}`,
      src,
      { size: bytes.byteLength, maxSize },
    );
  }

  if (decode !== undefined) {
    try {
      await decode(bytes, src);
    } catch (error) {
      return createAssetError(
        'asset/undecodable',
        `Failed to decode asset "${src}": ${messageOf(error)}`,
        src,
        error,
      );
    }
  }

  return bytes;
}

/** True when `candidate` is `root` itself or lives below it; a plain prefix test is not enough. */
function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

async function realPathOrSelf(target: string): Promise<string> {
  try {
    return await fs.realpath(target);
  } catch {
    return target;
  }
}

function fileSystemError(error: unknown, src: string, action: string): AssetError {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ENOENT' || code === 'ENOTDIR') {
    return createAssetError('asset/missing', `Asset file not found: ${src}`, src);
  }
  return createAssetError(
    'asset/undecodable',
    `Failed to ${action} asset "${src}": ${messageOf(error)}`,
    src,
    error,
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
