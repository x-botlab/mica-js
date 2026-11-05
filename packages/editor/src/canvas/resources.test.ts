import { describe, expect, it, vi } from 'vitest';
import type { CanvasDocument } from '@mica-js/document/canvas';
import { prepareCanvasResources } from './resources';

const id = '11111111-1111-4111-8111-111111111111';
const canvas: CanvasDocument = {
  version: 1,
  widgets: [{ id, widget: 'demo:display', x: 0, y: 0, width: 100, height: 60, rotation: 0 }],
};
const module = {
  definition: { properties: {}, ports: {} },
  code: 'throw new Error("metadata must not execute this");',
};
const devices = { resolve: vi.fn(async () => undefined) };

describe('canvas resource preparation', () => {
  it('resolves full library IDs without evaluating code or enumerating libraries', async () => {
    const files = { read: vi.fn() };
    const widgets = { resolve: vi.fn(async () => module) };
    const resources = await prepareCanvasResources(
      canvas,
      'https://test/project/main.cnv',
      files,
      devices,
      widgets,
    );
    expect(widgets.resolve).toHaveBeenCalledExactlyOnceWith('demo:display');
    expect(files.read).not.toHaveBeenCalled();
    expect(resources.widgets.get('demo:display')).toBe(module);
  });

  it('resolves document assets and decodes inline defaults before mounting', async () => {
    const files = { read: vi.fn(async () => new Uint8Array([4, 5])) };
    const widgets = {
      resolve: async () => ({
        ...module,
        definition: {
          properties: {
            bytes: { type: 'binary', default: { src: 'AQID', mode: 'inline' } },
            image: { type: 'image' },
          },
          ports: {},
        },
      }),
    };
    const resources = await prepareCanvasResources(
      {
        ...canvas,
        widgets: [
          { ...canvas.widgets[0]!, properties: { image: { src: 'image.png', mode: 'file' } } },
        ],
      },
      'https://test/project/main.cnv',
      files,
      devices,
      widgets,
    );
    expect(files.read).toHaveBeenCalledExactlyOnceWith('https://test/project/image.png');
    expect(resources.assets.get(id)).toEqual({
      AQID: new Uint8Array([1, 2, 3]),
      'image.png': new Uint8Array([4, 5]),
    });
  });

  it('rejects missing widget definitions', async () => {
    await expect(
      prepareCanvasResources(canvas, 'https://test/main.cnv', { read: vi.fn() }, devices, {
        resolve: async () => undefined,
      }),
    ).rejects.toThrow('was not found');
  });

  it('validates bindings before starting runtimes', async () => {
    await expect(
      prepareCanvasResources(
        {
          ...canvas,
          widgets: [
            { ...canvas.widgets[0]!, bindings: { missing: { symbol: id, port: 'value' } } },
          ],
        },
        'https://test/main.cnv',
        { read: vi.fn() },
        devices,
        { resolve: async () => module },
      ),
    ).rejects.toThrow();
  });

  it('reads the referenced schematic and retains resource references in its document', async () => {
    const schematic = {
      version: 1,
      sheet: {
        symbols: [
          {
            id,
            device: 'demo:device',
            x: 0,
            y: 0,
            rotation: 0,
            properties: { bytes: { src: 'AQ==', mode: 'inline' } },
          },
        ],
        wires: [],
        junctions: [],
      },
    };
    const files = { read: vi.fn(async () => new TextEncoder().encode(JSON.stringify(schematic))) };
    const library = {
      resolve: vi.fn(async () => ({
        definition: { kind: 'device' as const, id: 'device', version: '1', displayName: 'Device' },
        code: '',
      })),
    };
    const resources = await prepareCanvasResources(
      { ...canvas, schematic: 'main.sch' },
      'https://test/project/main.cnv',
      files,
      library,
      { resolve: async () => module },
    );
    expect(files.read).toHaveBeenCalledExactlyOnceWith('https://test/project/main.sch');
    expect(library.resolve).toHaveBeenCalledExactlyOnceWith('demo:device');
    expect(resources.schematic.sheet.symbols[0]!.properties!.bytes).toEqual({
      src: 'AQ==',
      mode: 'inline',
    });
    expect(resources.simulationAssets[id]).toEqual({ 'AQ==': new Uint8Array([1]) });
  });
});
