import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DeviceLock, PackageFiles, UnifiedDeviceManifest } from '@mica-js/document/fused';
import { openDevicePackage, releaseIntegrity } from './package';

const MANIFEST: UnifiedDeviceManifest = {
  publisher: 'test',
  name: 'lamp',
  version: '1.0.0',
  engines: { mica: '^1.0.0' },
  displayName: 'Lamp',
  pins: {},
};

afterEach(() => {
  vi.unstubAllGlobals();
});

/** JSON Canonicalization Scheme subset: sorted object keys, no extra whitespace. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

function hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

interface Fixture {
  readonly lock: DeviceLock;
  readonly registry: { open(lock: DeviceLock): Promise<PackageFiles> };
  readonly files: Record<string, Uint8Array>;
}

/**
 * One release whose lock is derived from its real bytes.
 *
 * The digests come from `node:crypto`, so they never depend on the implementation under test.
 */
function fixture(tamper = false): Fixture {
  const files: Record<string, Uint8Array> = {
    'package.json': new TextEncoder().encode(JSON.stringify(MANIFEST, null, 2)),
    'model.js': new TextEncoder().encode('export const model = {};'),
  };
  const table: Record<string, { size: number; integrity: string }> = {};
  for (const [path, bytes] of Object.entries(files)) {
    const digest = `sha256:${hex(bytes)}`;
    table[path] = { size: bytes.length, integrity: digest };
  }
  const lock: DeviceLock = {
    id: 'test:lamp',
    version: MANIFEST.version,
    integrity: `sha256:${createHash('sha256')
      .update(canonicalJson({ id: 'test:lamp', version: MANIFEST.version, files: table }), 'utf8')
      .digest('hex')}`,
  };
  const served = tamper
    ? { ...table, 'model.js': { ...table['model.js']!, integrity: `sha256:${'0'.repeat(64)}` } }
    : table;
  return {
    lock,
    files,
    registry: {
      async open(requested: DeviceLock) {
        return {
          lock: requested,
          files: served,
          read: async (path: string) => files[path]!.slice(),
        };
      },
    },
  };
}

function withoutWebCrypto(): void {
  vi.stubGlobal('crypto', {});
}

describe('fused package hashing', () => {
  it('verifies a release without WebCrypto, as in an opaque-origin sandbox worker', async () => {
    const { lock, registry } = fixture();
    withoutWebCrypto();
    const opened = await openDevicePackage(registry, lock);
    expect(opened.manifest.name).toBe('lamp');
    expect(opened.lock.integrity).toBe(lock.integrity);
    // The packaged fallback produces the same release identity as the fixture digests.
    expect(await releaseIntegrity({ id: 'test:lamp', version: '1.0.0', files: opened.files })).toBe(
      lock.integrity,
    );
  });

  it('still rejects a tampered release without WebCrypto', async () => {
    const { lock, registry } = fixture(true);
    withoutWebCrypto();
    await expect(openDevicePackage(registry, lock)).rejects.toMatchObject({
      code: 'package/integrity-mismatch',
    });
  });

  it('reports a failing WebCrypto digest instead of skipping verification', async () => {
    const { lock, registry } = fixture();
    vi.stubGlobal('crypto', {
      subtle: { digest: () => Promise.reject(new Error('digest disabled')) },
    });
    await expect(openDevicePackage(registry, lock)).rejects.toThrowError(
      /WebCrypto refused to compute a SHA-256 digest: digest disabled/,
    );
  });

  it('verifies identical release bytes with and without WebCrypto', async () => {
    const { lock, registry } = fixture();
    const native = await openDevicePackage(registry, lock);
    withoutWebCrypto();
    const packaged = await openDevicePackage(registry, lock);
    expect(packaged.files).toEqual(native.files);
    expect(packaged.lock).toEqual(native.lock);
  });
});
