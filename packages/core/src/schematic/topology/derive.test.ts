import { describe, expect, it } from 'vitest';
import { createDeviceRegistry } from '../device/registry';
import type { SchematicDocument } from '../format/types';
import { catchError, codesOf } from '../format/test-helpers';
import { deriveSchematicTopology } from './derive';

const devices = createDeviceRegistry([
  {
    packageId: 'stm32-package',
    devices: [
      {
        id: 'stm32g431rbt6-lqfp64',
        symbol: { name: 'MCU', pins: { PC0: { x: 0, y: 0 } } },
      },
    ],
  },
  {
    packageId: 'lcd-package',
    devices: [{ id: 'ct117e-m4-tft-lcd-2-4', symbol: { pins: { D0: { x: 0, y: 0 } } } }],
  },
]);

const SAMPLE: SchematicDocument = {
  version: 1,
  sheet: {
    symbols: [
      { id: 's-mcu', device: 'stm32-package:stm32g431rbt6-lqfp64', x: 480, y: 160, rotation: 0 },
      { id: 's-lcd', device: 'lcd-package:ct117e-m4-tft-lcd-2-4', x: 136, y: 55, rotation: 0 },
      { id: 'lcd-l-d0', device: 'builtin:label', net: 'lcd-l-d0', x: 300, y: 100, rotation: 0 },
    ],
    wires: [
      {
        id: 'w-d0',
        points: [
          { x: 480, y: 160 },
          { x: 300, y: 160 },
          { x: 300, y: 55 },
          { x: 136, y: 55 },
        ],
      },
      {
        id: 'w-label-d0',
        points: [
          { x: 300, y: 124 },
          { x: 300, y: 100 },
        ],
      },
    ],
    junctions: [{ id: 'j-d0', x: 300, y: 124, wires: ['w-d0', 'w-label-d0'] }],
  },
};

function documentWith(
  overrides: Partial<SchematicDocument['sheet']> & {
    symbols?: SchematicDocument['sheet']['symbols'];
  },
): SchematicDocument {
  return {
    ...SAMPLE,
    sheet: {
      symbols: overrides.symbols ?? [],
      wires: overrides.wires ?? [],
      junctions: overrides.junctions ?? [],
    },
  };
}

describe('deriveSchematicTopology', () => {
  it('derives the net of the issue #6 example', () => {
    const topology = deriveSchematicTopology(SAMPLE, { devices });
    expect(topology.nets).toEqual([
      {
        name: 'lcd-l-d0',
        wireIds: ['w-d0', 'w-label-d0'],
        members: [
          { kind: 'label', symbolId: 'lcd-l-d0' },
          { kind: 'pin', symbolId: 's-lcd', pinId: 'D0' },
          { kind: 'pin', symbolId: 's-mcu', pinId: 'PC0' },
        ],
      },
    ]);
    expect(topology.pins).toEqual([
      {
        symbolId: 's-lcd',
        pinId: 'D0',
        position: { x: 136, y: 55 },
        open: false,
        netName: 'lcd-l-d0',
      },
      {
        symbolId: 's-mcu',
        pinId: 'PC0',
        position: { x: 480, y: 160 },
        open: false,
        netName: 'lcd-l-d0',
      },
    ]);
    expect(topology.danglingWireEnds).toEqual([]);
  });

  it('reports conflicting labels on one net', () => {
    const document = documentWith({
      symbols: [
        { id: 'a', device: 'builtin:label', net: 'A', x: 0, y: 0, rotation: 0 },
        { id: 'b', device: 'builtin:label', net: 'B', x: 10, y: 0, rotation: 0 },
      ],
      wires: [
        {
          id: 'w',
          points: [
            { x: 0, y: 0 },
            { x: 10, y: 0 },
          ],
        },
      ],
    });
    const error = catchError(() => deriveSchematicTopology(document, { devices }));
    expect(codesOf(error.diagnostics)).toEqual(['net/naming-conflict']);
  });

  it('leaves pure drawing components out of nets', () => {
    const document = documentWith({
      wires: [
        {
          id: 'w',
          points: [
            { x: 0, y: 0 },
            { x: 10, y: 10 },
          ],
        },
      ],
    });
    const topology = deriveSchematicTopology(document, { devices });
    expect(topology.nets).toEqual([]);
    expect(topology.danglingWireEnds).toEqual([
      { wireId: 'w', end: 'end', point: { x: 10, y: 10 } },
      { wireId: 'w', end: 'start', point: { x: 0, y: 0 } },
    ]);
  });

  it('connects a wire whose interior passes through a pin', () => {
    const document = documentWith({
      symbols: [{ id: 's', device: 'stm32-package:stm32g431rbt6-lqfp64', x: 5, y: 0, rotation: 0 }],
      wires: [
        {
          id: 'w',
          points: [
            { x: 0, y: 0 },
            { x: 10, y: 0 },
          ],
        },
      ],
    });
    const topology = deriveSchematicTopology(document, { devices });
    expect(topology.nets).toEqual([
      {
        name: null,
        wireIds: ['w'],
        members: [{ kind: 'pin', symbolId: 's', pinId: 'PC0' }],
      },
    ]);
  });

  it('merges wires that meet at the same pin without a junction', () => {
    const document = documentWith({
      symbols: [{ id: 's', device: 'stm32-package:stm32g431rbt6-lqfp64', x: 0, y: 0, rotation: 0 }],
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
            { x: 0, y: 0 },
            { x: 0, y: 10 },
          ],
        },
      ],
    });
    const topology = deriveSchematicTopology(document, { devices });
    expect(topology.nets).toHaveLength(1);
    expect(topology.nets[0]?.wireIds).toEqual(['w1', 'w2']);
  });

  it('does not connect crossing wires without a junction', () => {
    const document = documentWith({
      wires: [
        {
          id: 'horizontal',
          points: [
            { x: 0, y: 0 },
            { x: 10, y: 0 },
          ],
        },
        {
          id: 'vertical',
          points: [
            { x: 5, y: -5 },
            { x: 5, y: 5 },
          ],
        },
      ],
      symbols: [
        { id: 'l1', device: 'builtin:label', net: 'L1', x: 10, y: 0, rotation: 0 },
        { id: 'l2', device: 'builtin:label', net: 'L2', x: 5, y: 5, rotation: 0 },
      ],
    });
    const topology = deriveSchematicTopology(document, { devices });
    expect(topology.nets.map((net) => net.name)).toEqual(['L1', 'L2']);
  });

  it('keeps isolated pins open and reports dangling ends', () => {
    const document = documentWith({
      symbols: [
        { id: 's', device: 'stm32-package:stm32g431rbt6-lqfp64', x: 100, y: 100, rotation: 0 },
        { id: 'l', device: 'builtin:label', net: 'L', x: 0, y: 0, rotation: 0 },
      ],
      wires: [
        {
          id: 'w',
          points: [
            { x: 0, y: 0 },
            { x: 10, y: 0 },
          ],
        },
      ],
    });
    const topology = deriveSchematicTopology(document, { devices });
    expect(topology.pins).toEqual([
      {
        symbolId: 's',
        pinId: 'PC0',
        position: { x: 100, y: 100 },
        open: true,
        netName: null,
      },
    ]);
    expect(topology.nets).toEqual([
      { name: 'L', wireIds: ['w'], members: [{ kind: 'label', symbolId: 'l' }] },
    ]);
    expect(topology.danglingWireEnds.map((item) => item.point)).toEqual([{ x: 10, y: 0 }]);
  });

  it('skips device resolution when no provider is given', () => {
    const topology = deriveSchematicTopology(SAMPLE);
    expect(topology.pins).toEqual([]);
    expect(topology.nets).toEqual([
      {
        name: 'lcd-l-d0',
        wireIds: ['w-d0', 'w-label-d0'],
        members: [{ kind: 'label', symbolId: 'lcd-l-d0' }],
      },
    ]);
  });

  it('throws for unresolved devices when a provider is given', () => {
    const document = documentWith({
      symbols: [{ id: 's', device: 'missing-package:missing', x: 0, y: 0, rotation: 0 }],
    });
    expect(
      codesOf(catchError(() => deriveSchematicTopology(document, { devices })).diagnostics),
    ).toContain('device/unresolved');
  });

  it('treats devices without symbol geometry as connected nowhere', () => {
    const registry = createDeviceRegistry([
      { packageId: 'p', devices: [{ id: 'd', displayName: 'D' }] },
    ]);
    const document = documentWith({
      symbols: [{ id: 's', device: 'p:d', x: 0, y: 0, rotation: 0 }],
    });
    const topology = deriveSchematicTopology(document, { devices: registry });
    expect(topology.pins).toEqual([]);
    expect(topology.nets).toEqual([]);
  });

  it('is independent of input order', () => {
    const shuffled: SchematicDocument = {
      ...SAMPLE,
      sheet: {
        symbols: [...SAMPLE.sheet.symbols].reverse(),
        wires: [...SAMPLE.sheet.wires].reverse(),
        junctions: [...SAMPLE.sheet.junctions],
      },
    };
    expect(deriveSchematicTopology(shuffled, { devices })).toEqual(
      deriveSchematicTopology(SAMPLE, { devices }),
    );
  });

  it('computes bounds over wires and symbols', () => {
    const topology = deriveSchematicTopology(SAMPLE, { devices });
    expect(topology.bounds).toEqual({ x: 136, y: 55, width: 344, height: 105 });
  });

  it('honours tolerance when attaching wires to pins', () => {
    const document = documentWith({
      symbols: [
        { id: 's', device: 'stm32-package:stm32g431rbt6-lqfp64', x: -0.2, y: 0, rotation: 0 },
      ],
      wires: [
        {
          id: 'w',
          points: [
            { x: 0, y: 0 },
            { x: 10, y: 0 },
          ],
        },
      ],
    });
    expect(deriveSchematicTopology(document, { devices }).nets).toEqual([]);
    expect(deriveSchematicTopology(document, { devices, tolerance: 0.5 }).nets).toHaveLength(1);
  });
});
