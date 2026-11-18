import { describe, expect, it } from 'vitest';
import { DeviceCache } from '../devices';
import { PreparationError } from '@mica-js/sdk/fused';
import type { FusedDocument } from '@mica-js/document/fused';
import {
  defaultPackages,
  FILE_GEOMETRY_MANIFEST,
  LED,
  LED_MANIFEST,
  MISSING_IMAGE_MANIFEST,
  NO_GEOMETRY_MANIFEST,
} from './test-helpers';

describe('DeviceCache', () => {
  it('verifies a release once and hands out manifest, geometry and files', async () => {
    const packages = defaultPackages();
    const cache = new DeviceCache(packages.registry);
    const lock = packages.lock(LED_MANIFEST);

    const [first, second] = await Promise.all([cache.get(lock), cache.get(lock)]);
    const third = await cache.get(lock);

    expect(first).toBe(second);
    expect(third).toBe(first);
    expect(packages.counters.opens).toBe(1);
    expect(first.lock).toEqual(lock);
    expect(first.manifest.displayName).toBe('Demo LED');
    expect(first.geometry.sizing).toBe('physical');
    expect(first.geometry.pins['anode']?.position).toEqual({ x: -6, y: 0 });
    expect(new TextDecoder().decode(await first.files.read('art/body.png'))).toBe('png-bytes');
    expect(cache.getLoaded(LED)).toBe(first);
    cache.dispose();
  });

  it('parses geometry declared as a package file', async () => {
    const packages = defaultPackages();
    const cache = new DeviceCache(packages.registry);
    const device = await cache.get(packages.lock(FILE_GEOMETRY_MANIFEST));

    expect(device.geometry.sizing).toBe('flexible');
    expect(device.geometry.bounds).toEqual({ x: 0, y: 0, width: 8, height: 8 });
    cache.dispose();
  });

  it('rejects a body image the release does not list', async () => {
    const packages = defaultPackages();
    const cache = new DeviceCache(packages.registry);
    await expect(cache.get(packages.lock(MISSING_IMAGE_MANIFEST))).rejects.toMatchObject({
      problems: [{ code: 'package/missing-entry' }],
    });
    cache.dispose();
  });

  it('rejects a device without 2D geometry', async () => {
    const packages = defaultPackages();
    const cache = new DeviceCache(packages.registry);
    await expect(cache.get(packages.lock(NO_GEOMETRY_MANIFEST))).rejects.toMatchObject({
      problems: [{ code: 'view2d/invalid-geometry' }],
    });
    cache.dispose();
  });

  it('prepares every device of a document and rejects an unlocked one', async () => {
    const packages = defaultPackages();
    const cache = new DeviceCache(packages.registry);
    const lock = packages.lock(LED_MANIFEST);
    const document: FusedDocument = {
      version: 2,
      dependencies: { [LED]: { version: lock.version, integrity: lock.integrity } },
      instances: [
        {
          id: '11111111-1111-4111-8111-111111111111',
          device: LED,
          placement: { x: 0, y: 0, rotation: 0 },
        },
      ],
      nodes: [],
      wires: [],
      labels: [],
      references: [],
    };

    const prepared = await cache.prepareDocument(document);
    expect([...prepared.keys()]).toEqual([LED]);
    expect(prepared.get(LED)?.manifest.name).toBe('led');

    const unlocked: FusedDocument = {
      ...document,
      dependencies: {},
    };
    await expect(cache.prepareDocument(unlocked)).rejects.toBeInstanceOf(PreparationError);
    await expect(cache.prepareDocument(unlocked)).rejects.toMatchObject({
      problems: [{ code: 'document/unlocked-device' }],
    });
    cache.dispose();
  });

  it('keeps the loaded map identity until another release is opened', async () => {
    const packages = defaultPackages();
    const cache = new DeviceCache(packages.registry);
    const before = cache.getLoadedDevices();
    expect(before.size).toBe(0);

    await cache.get(packages.lock(LED_MANIFEST));
    const after = cache.getLoadedDevices();
    expect(after.size).toBe(1);
    expect(after).toBe(cache.getLoadedDevices());
    expect([...after.keys()]).toEqual([LED]);
    cache.dispose();
  });

  it('rejects use after dispose', () => {
    const packages = defaultPackages();
    const cache = new DeviceCache(packages.registry);
    const lock = packages.lock(LED_MANIFEST);
    cache.dispose();
    expect(() => cache.get(lock)).toThrow(/disposed/);
  });
});
