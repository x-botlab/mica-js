import { parseFusedDocument, parseGeometry2D } from '@mica-js/document/fused';
import type { IFusedInstancePresentation } from '@mica-js/editor/fused/runtime';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { looksLikeHtml, packageFileUrl, parseCatalog } from '../workbench/src/catalog';
import { DOCUMENT_STORAGE_KEY, DocumentStore } from '../workbench/src/document-store';
import { OVERLAY_PX_PER_MM, measureOverlay } from '../workbench/src/overlay-density';
import { WORKBENCH_STEP, WORKBENCH_STEP_MS } from '../workbench/src/runtime-config';
import { SerialQueue } from '../workbench/src/serial-queue';

const DEVICE_SRC = join(import.meta.dirname, '..', 'device', 'src');

const LOCK = {
  id: 'example:ct107d-board',
  version: '0.1.0',
  integrity: `sha256:${'a'.repeat(64)}`,
};
const FILE = { size: 12, integrity: `sha256:${'b'.repeat(64)}` };

function catalogEntry() {
  return {
    lock: LOCK,
    directory: 'device',
    files: { 'package.json': FILE, 'assets/demo.hex': { ...FILE, size: 2 } },
  };
}

function catalogValue() {
  return [catalogEntry()];
}

const EMPTY_DOCUMENT = parseFusedDocument({
  version: 2,
  dependencies: {},
  instances: [],
  nodes: [],
  wires: [],
  labels: [],
  references: [],
});

describe('workbench catalog', () => {
  it('accepts the generated release catalog and builds encoded package URLs', () => {
    const [entry] = parseCatalog(catalogValue());
    expect(entry?.lock).toEqual(LOCK);
    expect(entry?.files['assets/demo.hex']).toEqual({ ...FILE, size: 2 });
    expect(packageFileUrl('/host/', entry!, 'assets/demo.hex')).toBe(
      '/host/device/assets/demo.hex',
    );
    expect(packageFileUrl('/host', entry!, 'package.json')).toBe('/host/device/package.json');
  });

  it('rejects malformed catalogs instead of trusting build artifacts', () => {
    expect(() => parseCatalog({})).toThrow(/array/);
    expect(() => parseCatalog([{ ...catalogEntry(), directory: '../escape' }])).toThrow(
      /directory/,
    );
    expect(() =>
      parseCatalog([{ ...catalogEntry(), lock: { ...LOCK, integrity: 'sha256:abc' } }]),
    ).toThrow(/integrity/);
    expect(() =>
      parseCatalog([
        {
          ...catalogEntry(),
          files: { 'assets/demo.hex': FILE },
        },
      ]),
    ).toThrow(/package\.json/);
    expect(() =>
      parseCatalog([
        {
          ...catalogEntry(),
          files: { 'package.json': FILE, '../escape.hex': FILE },
        },
      ]),
    ).toThrow(/path/);
    expect(() => parseCatalog([...catalogValue(), ...catalogValue()])).toThrow(/Duplicate/);
  });
});

describe('workbench browser draft', () => {
  it('round-trips a document through the same strict parser and reports an empty draft', () => {
    const data = new Map<string, string>();
    const store = new DocumentStore({
      getItem: (key) => data.get(key) ?? null,
      setItem: (key, value) => {
        data.set(key, value);
      },
    });
    expect(store.load()).toBeUndefined();
    store.save(EMPTY_DOCUMENT);
    expect(data.has(DOCUMENT_STORAGE_KEY)).toBe(true);
    expect(store.load()).toEqual(EMPTY_DOCUMENT);
  });

  it('rejects a corrupted draft instead of loading it partially', () => {
    const store = new DocumentStore({
      getItem: () => '{"version":2}',
      setItem: () => {},
    });
    expect(() => store.load()).toThrow();
  });
});

describe('workbench response diagnostics', () => {
  it('detects an HTML entry fallback before JSON/document parsing', () => {
    const encoder = new TextEncoder();
    expect(looksLikeHtml(encoder.encode('<!doctype html>\n<html>'))).toBe(true);
    expect(looksLikeHtml(encoder.encode('\n  <html lang="zh-CN">'))).toBe(true);
    expect(looksLikeHtml(encoder.encode('{"version":2}'))).toBe(false);
    expect(looksLikeHtml(encoder.encode('{\n  "version": 2\n}'))).toBe(false);
  });
});

describe('workbench runtime configuration', () => {
  it('uses an explicit 16 ms fixed step instead of the editor 10 µs default', () => {
    expect(WORKBENCH_STEP_MS).toBe(16);
    expect(WORKBENCH_STEP).toBe(16_000_000_000);
  });

  it('reserves the overlay at the board photo density, not one pixel per millimetre', () => {
    const geometry = parseGeometry2D(
      JSON.parse(readFileSync(join(DEVICE_SRC, 'geometry.json'), 'utf8')) as unknown,
      ['VCC', 'GND'],
    );
    expect(geometry.sizing).toBe('physical');
    const layout = measureOverlay({ geometry } as unknown as IFusedInstancePresentation);
    // 板外形 199.27×142.47 mm 在 4 px/mm 下为 797×570，与 863×617 的板面照片同量级；
    // 默认密度（1 px/mm）只有 199×142，段码与指示灯会被拉花。
    expect(layout).toEqual({ width: 797, height: 570, scale: OVERLAY_PX_PER_MM });
    expect(layout.width).toBeGreaterThan(geometry.bounds.width * 3);
    // 与照片的 4.3307 px/mm 相比略低，保证叠层位图小于照片本身的 863×617。
    expect(layout.width).toBeLessThan(863);
  });
});

describe('workbench serialized open queue', () => {
  it('runs tasks in call order and continues after a rejected task', async () => {
    const queue = new SerialQueue();
    const order: string[] = [];
    const first = queue.run(async () => {
      order.push('first:start');
      await Promise.resolve();
      order.push('first:end');
      return 1;
    });
    const rejected = queue.run(async () => {
      order.push('rejected');
      throw new Error('expected');
    });
    const last = queue.run(async () => {
      order.push('last');
      return 3;
    });
    await expect(first).resolves.toBe(1);
    await expect(rejected).rejects.toThrow('expected');
    await expect(last).resolves.toBe(3);
    expect(order).toEqual(['first:start', 'first:end', 'rejected', 'last']);
  });
});
