import { describe, expect, it } from 'vitest';
import { createDeviceRegistry } from '../device/registry';
import { parseDeviceReference } from '../device/reference';
import type { SchematicDocument } from '../format/types';
import { symbolPinPosition } from '../geometry/transform';
import { isConnectedVertex, planSegmentDrag } from './segment-drag';

const devices = createDeviceRegistry([
  {
    packageId: 'pkg',
    devices: [
      {
        id: 'mcu',
        raw: { pins: { A: { side: 'left' }, B: { side: 'right' } } },
        symbol: {
          name: 'MCU',
          bounds: { x: -20, y: -20, width: 40, height: 40 },
          pins: { A: { x: -40, y: 0, side: 'left' }, B: { x: 40, y: 0, side: 'right' } },
        },
      },
    ],
  },
]);

function documentOf(sheet: {
  symbols?: readonly unknown[];
  wires?: readonly unknown[];
  junctions?: readonly unknown[];
}): SchematicDocument {
  return {
    version: 1,
    sheet: {
      symbols: sheet.symbols ?? [],
      wires: sheet.wires ?? [],
      junctions: sheet.junctions ?? [],
    },
  } as SchematicDocument;
}

describe('planSegmentDrag', () => {
  it('slides a free segment with both of its vertices', () => {
    const document = documentOf({
      wires: [
        {
          id: 'w1',
          points: [
            { x: 0, y: 0 },
            { x: 50, y: 0 },
            { x: 50, y: 40 },
          ],
        },
      ],
    });
    expect(planSegmentDrag(document, 'w1', 0, { x: 0, y: 10 })).toEqual([
      { x: 0, y: 10 },
      { x: 50, y: 10 },
      { x: 50, y: 40 },
    ]);
  });

  it('slides the whole run of parallel segments so none goes diagonal', () => {
    const document = documentOf({
      wires: [
        {
          id: 'w1',
          points: [
            { x: 0, y: 0 },
            { x: 10, y: 0 },
            { x: 20, y: 0 },
            { x: 20, y: 30 },
          ],
        },
      ],
    });
    expect(planSegmentDrag(document, 'w1', 0, { x: 0, y: 5 })).toEqual([
      { x: 0, y: 5 },
      { x: 10, y: 5 },
      { x: 20, y: 5 },
      { x: 20, y: 30 },
    ]);
  });

  it('keeps a pin-attached end and bends the wire into a dogleg', () => {
    const symbol = { id: 's1', device: 'pkg:mcu', x: 0, y: 0, rotation: 0 };
    const reference = parseDeviceReference('pkg:mcu');
    if (reference === undefined) {
      throw new Error('The test device reference must parse.');
    }
    const anchor = devices.getDeviceSymbol(reference)?.pins['A'];
    const pin = symbolPinPosition(symbol, anchor ?? { x: 0, y: 0 });
    const document = documentOf({
      symbols: [symbol],
      wires: [
        {
          id: 'w1',
          points: [pin, { x: pin.x + 40, y: pin.y }, { x: pin.x + 40, y: pin.y + 40 }],
        },
      ],
    });
    expect(planSegmentDrag(document, 'w1', 0, { x: 0, y: 10 }, { devices })).toEqual([
      pin,
      { x: pin.x, y: pin.y + 10 },
      { x: pin.x + 40, y: pin.y + 10 },
      { x: pin.x + 40, y: pin.y + 40 },
    ]);
  });

  it('reports connected vertices from pins, anchors, junctions and other wires', () => {
    const document = documentOf({
      symbols: [
        { id: 'u1', device: 'pkg:mcu', x: 0, y: 0, rotation: 0 },
        { id: 'l1', device: 'builtin:label', net: 'D0', x: 200, y: 200, rotation: 0 },
      ],
      wires: [
        {
          id: 'w1',
          points: [
            { x: -40, y: 0 },
            { x: 40, y: 0 },
          ],
        },
        {
          id: 'w2',
          points: [
            { x: 200, y: 200 },
            { x: 200, y: 260 },
          ],
        },
      ],
      junctions: [{ id: 'j1', x: 40, y: 0, wires: ['w1'] }],
    });
    // Pin A sits at (-40, 0); the junction marks (40, 0) on this wire as connected.
    expect(isConnectedVertex(document, { x: -40, y: 0 }, 'w1', { devices })).toBe(true);
    expect(isConnectedVertex(document, { x: 40, y: 0 }, 'w1')).toBe(true);
    expect(isConnectedVertex(document, { x: 200, y: 200 }, 'w2')).toBe(true);
    expect(isConnectedVertex(document, { x: 200, y: 260 }, 'w2')).toBe(false);
    expect(isConnectedVertex(document, { x: 0, y: 0 }, 'w1', { devices })).toBe(false);
  });

  it('ignores unknown wires, degenerate segments and empty deltas', () => {
    const document = documentOf({
      wires: [
        {
          id: 'w1',
          points: [
            { x: 0, y: 0 },
            { x: 10, y: 0 },
          ],
        },
      ],
    });
    expect(planSegmentDrag(document, 'nope', 0, { x: 0, y: 5 })).toBeUndefined();
    expect(planSegmentDrag(document, 'w1', 0, { x: 0, y: 0 })).toBeUndefined();
    expect(planSegmentDrag(document, 'w1', 5, { x: 0, y: 5 })).toBeUndefined();
  });
});
