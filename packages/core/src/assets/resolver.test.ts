import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isAssetError, type AssetError } from './errors';
import { DEFAULT_ASSET_MAX_SIZE, resolveAsset } from './resolver';

let base: string;
let root: string;
let outside: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'mica-assets-'));
  root = join(base, 'project');
  // A sibling whose name shares the root's prefix catches naive `startsWith(root)` containment.
  outside = join(base, 'project-other');
  await mkdir(root);
  await mkdir(outside);
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

function expectError(value: Uint8Array | AssetError): AssetError {
  expect(isAssetError(value)).toBe(true);
  if (!isAssetError(value)) {
    throw new Error('expected an AssetError');
  }
  return value;
}

describe('resolveAsset', () => {
  it('resolves an existing project file to its bytes', async () => {
    await writeFile(join(root, 'test.txt'), 'hello', 'utf8');

    const result = await resolveAsset('test.txt', { rootDir: root });

    expect(result).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(result as Uint8Array)).toBe('hello');
  });

  it('resolves nested project paths', async () => {
    await mkdir(join(root, 'assets'));
    await writeFile(join(root, 'assets', 'logo.bin'), new Uint8Array([1, 2, 3]));

    const result = await resolveAsset('assets/logo.bin', { rootDir: root });

    expect(result).toBeInstanceOf(Uint8Array);
    expect(Array.from(result as Uint8Array)).toEqual([1, 2, 3]);
  });

  it('reports asset/missing for a non-existent file', async () => {
    const error = expectError(await resolveAsset('missing.txt', { rootDir: root }));

    expect(error.code).toBe('asset/missing');
    expect(error.src).toBe('missing.txt');
    expect(error.message).toContain('missing.txt');
  });

  it('reports asset/out-of-root for path traversal', async () => {
    const error = expectError(await resolveAsset('../../../etc/passwd', { rootDir: root }));

    expect(error.code).toBe('asset/out-of-root');
  });

  it('reports asset/out-of-root for a sibling directory sharing the root prefix', async () => {
    await writeFile(join(outside, 'secret.txt'), 'secret', 'utf8');

    const error = expectError(await resolveAsset('../project-other/secret.txt', { rootDir: root }));

    expect(error.code).toBe('asset/out-of-root');
  });

  it('reports asset/out-of-root for an absolute path outside the root', async () => {
    await writeFile(join(outside, 'secret.txt'), 'secret', 'utf8');

    const error = expectError(await resolveAsset(join(outside, 'secret.txt'), { rootDir: root }));

    expect(error.code).toBe('asset/out-of-root');
  });

  it('reports asset/out-of-root when a symlink escapes the root', async (context) => {
    await writeFile(join(outside, 'secret.txt'), 'secret', 'utf8');
    const link = join(root, 'linked');
    try {
      await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      // Creating symlinks needs developer mode on Windows and may be forbidden in sandboxes.
      context.skip();
      return;
    }

    const error = expectError(await resolveAsset('linked/secret.txt', { rootDir: root }));

    expect(error.code).toBe('asset/out-of-root');
  });

  it('still allows a symlink that stays inside the root', async (context) => {
    await mkdir(join(root, 'target'));
    await writeFile(join(root, 'target', 'data.txt'), 'data', 'utf8');
    try {
      await symlink(
        join(root, 'target'),
        join(root, 'alias'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    } catch {
      context.skip();
      return;
    }

    const result = await resolveAsset('alias/data.txt', { rootDir: root });

    expect(result).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(result as Uint8Array)).toBe('data');
  });

  it('reports asset/too-large for a file above the limit', async () => {
    await writeFile(join(root, 'big.bin'), new Uint8Array(32));

    const error = expectError(await resolveAsset('big.bin', { rootDir: root, maxSize: 16 }));

    expect(error.code).toBe('asset/too-large');
    expect(error.details).toEqual({ size: 32, maxSize: 16 });
  });

  it('accepts a file exactly at the size limit', async () => {
    await writeFile(join(root, 'exact.bin'), new Uint8Array(16));

    const result = await resolveAsset('exact.bin', { rootDir: root, maxSize: 16 });

    expect(result).toBeInstanceOf(Uint8Array);
    expect((result as Uint8Array).byteLength).toBe(16);
  });

  it('defaults the size limit to 10 MiB', () => {
    expect(DEFAULT_ASSET_MAX_SIZE).toBe(10 * 1024 * 1024);
  });

  it('reports asset/undecodable when the path is not a regular file', async () => {
    await mkdir(join(root, 'folder'));

    const error = expectError(await resolveAsset('folder', { rootDir: root }));

    expect(error.code).toBe('asset/undecodable');
  });

  it('reports asset/undecodable when the decoder rejects the content', async () => {
    await writeFile(join(root, 'broken.png'), new Uint8Array([0xff, 0xfe]));

    const error = expectError(
      await resolveAsset('broken.png', {
        rootDir: root,
        decode: () => {
          throw new Error('bad image header');
        },
      }),
    );

    expect(error.code).toBe('asset/undecodable');
    expect(error.message).toContain('bad image header');
  });

  it('recognizes asset errors and ignores other values', () => {
    expect(isAssetError({ code: 'asset/missing', message: 'gone', src: 'a.bin' })).toBe(true);
    expect(isAssetError(new Error('boom'))).toBe(false);
    expect(isAssetError(null)).toBe(false);
    expect(isAssetError('asset/missing')).toBe(false);
  });
});
