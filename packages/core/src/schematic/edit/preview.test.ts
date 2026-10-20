import { describe, expect, it } from 'vitest';
import type { DeviceSymbolProvider } from '../device/symbol';
import type { SchematicDocument } from '../format/types';
import { previewSymbolDrag } from './preview';

const devices: DeviceSymbolProvider = {
  getDeviceSymbol: () => ({
    name: 'U',
    pins: { p1: { x: 0, y: 0 }, p2: { x: 20, y: 0 } },
  }),
  getDeviceName: () => 'U',
};

function makeDocument(): SchematicDocument {
  return {
    version: 1,
    id: 'preview',
    sheet: {
      symbols: [{ id: 's1', device: 'pkg:a', x: 0, y: 0, rotation: 0 }],
      wires: [
        {
          id: 'w1',
          points: [
            { x: 0, y: 0 },
            { x: 10, y: 0 },
            { x: 10, y: 20 },
          ],
        },
        {
          id: 'w2',
          points: [
            { x: 10, y: 10 },
            { x: 20, y: 10 },
          ],
        },
      ],
      junctions: [{ id: 'j1', x: 10, y: 10, wires: ['w1', 'w2'] }],
    },
  };
}

describe('previewSymbolDrag', () => {
  it('moves the wire endpoint attached to a moving pin', () => {
    const preview = previewSymbolDrag(makeDocument(), devices, 's1', { x: 0, y: -5, rotation: 0 });
    expect(preview?.wires.get('w1')).toEqual([
      { x: 0, y: -5 },
      { x: 10, y: -5 },
      { x: 10, y: 20 },
    ]);
  });

  it('leaves a junction alone while it still lies on the rerouted wire', () => {
    const preview = previewSymbolDrag(makeDocument(), devices, 's1', { x: 0, y: -5, rotation: 0 });
    expect(preview?.junctions.has('j1')).toBe(false);
  });

  it('projects a detached junction onto the rerouted wire', () => {
    const document = makeDocument();
    const sheet = {
      ...document.sheet,
      wires: [
        {
          id: 'w1',
          points: [
            { x: 0, y: 0 },
            { x: 10, y: 0 },
          ],
        },
        {
          id: 'w2',
          points: [
            { x: 5, y: 0 },
            { x: 5, y: 10 },
          ],
        },
      ],
      junctions: [{ id: 'j1', x: 5, y: 0, wires: ['w1', 'w2'] }],
    };
    const preview = previewSymbolDrag({ ...document, sheet }, devices, 's1', {
      x: 0,
      y: -5,
      rotation: 0,
    });
    expect(preview?.junctions.get('j1')).toEqual({ x: 5, y: -5 });
  });

  it('carries anchors sitting on a moving pin', () => {
    const document = makeDocument();
    const sheet = {
      ...document.sheet,
      symbols: [
        ...document.sheet.symbols,
        { id: 'l1', device: 'builtin:label', x: 0, y: 0, rotation: 0 },
      ],
    };
    const preview = previewSymbolDrag({ ...document, sheet }, devices, 's1', {
      x: 4,
      y: 6,
      rotation: 0,
    });
    expect(preview?.symbols.get('l1')).toEqual({ x: 4, y: 6 });
  });

  it('returns an empty preview when nothing moves', () => {
    const preview = previewSymbolDrag(makeDocument(), devices, 's1', { x: 0, y: 0, rotation: 0 });
    expect(preview?.wires.size).toBe(0);
    expect(preview?.junctions.size).toBe(0);
    expect(preview?.symbols.size).toBe(0);
  });

  it('returns undefined for unknown symbols', () => {
    expect(
      previewSymbolDrag(makeDocument(), devices, 'nope', { x: 0, y: 0, rotation: 0 }),
    ).toBeUndefined();
  });
});
