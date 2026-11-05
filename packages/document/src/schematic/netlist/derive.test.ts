import { describe, expect, it } from 'vitest';
import { createDeviceRegistry } from '../device/registry';
import type { SchematicDocument } from '../../format/types';
import { catchError, codesOf } from '../../format/test-helpers';
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
      {
        id: '0000000b-2dc0-44c6-8963-e4ea065d722b',
        device: 'stm32-package:stm32g431rbt6-lqfp64',
        x: 480,
        y: 160,
        rotation: 0,
      },
      {
        id: '0000000a-c16f-4700-81a9-7ef80c62a850',
        device: 'lcd-package:ct117e-m4-tft-lcd-2-4',
        x: 136,
        y: 55,
        rotation: 0,
      },
      {
        id: '00000008-33b8-486d-8c54-1dc2d275f643',
        device: 'builtin:label',
        net: 'lcd-l-d0',
        x: 300,
        y: 100,
        rotation: 0,
      },
    ],
    wires: [
      {
        id: '0000000e-d219-4ea3-84bb-593c369c1900',
        points: [
          { x: 480, y: 160 },
          { x: 300, y: 160 },
          { x: 300, y: 55 },
          { x: 136, y: 55 },
        ],
      },
      {
        id: '0000000f-02d3-4c5c-815f-2fda0d3151f0',
        points: [
          { x: 300, y: 124 },
          { x: 300, y: 100 },
        ],
      },
    ],
    junctions: [
      {
        id: '00000004-9a12-484a-897d-ff38defa94b2',
        x: 300,
        y: 124,
        wires: ['0000000e-d219-4ea3-84bb-593c369c1900', '0000000f-02d3-4c5c-815f-2fda0d3151f0'],
      },
    ],
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
        wireIds: ['0000000e-d219-4ea3-84bb-593c369c1900', '0000000f-02d3-4c5c-815f-2fda0d3151f0'],
        members: [
          { kind: 'label', symbolId: '00000008-33b8-486d-8c54-1dc2d275f643' },
          { kind: 'pin', symbolId: '0000000a-c16f-4700-81a9-7ef80c62a850', pinId: 'D0' },
          { kind: 'pin', symbolId: '0000000b-2dc0-44c6-8963-e4ea065d722b', pinId: 'PC0' },
        ],
      },
    ]);
    expect(topology.pins).toEqual([
      {
        symbolId: '0000000a-c16f-4700-81a9-7ef80c62a850',
        pinId: 'D0',
        position: { x: 136, y: 55 },
        open: false,
        netName: 'lcd-l-d0',
      },
      {
        symbolId: '0000000b-2dc0-44c6-8963-e4ea065d722b',
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
        {
          id: '00000001-faa5-47fc-815d-1ddcb9eaeaea',
          device: 'builtin:label',
          net: 'A',
          x: 0,
          y: 0,
          rotation: 0,
        },
        {
          id: '00000002-e7c9-4d6d-89e9-2ffdad17b8bd',
          device: 'builtin:label',
          net: 'B',
          x: 10,
          y: 0,
          rotation: 0,
        },
      ],
      wires: [
        {
          id: '0000000d-4ab0-4ece-8091-de044c58c9ae',
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
          id: '0000000d-4ab0-4ece-8091-de044c58c9ae',
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
      { wireId: '0000000d-4ab0-4ece-8091-de044c58c9ae', end: 'end', point: { x: 10, y: 10 } },
      { wireId: '0000000d-4ab0-4ece-8091-de044c58c9ae', end: 'start', point: { x: 0, y: 0 } },
    ]);
  });

  it('connects a wire whose interior passes through a pin', () => {
    const document = documentWith({
      symbols: [
        {
          id: '00000009-20d0-411c-897b-44bc357e1972',
          device: 'stm32-package:stm32g431rbt6-lqfp64',
          x: 5,
          y: 0,
          rotation: 0,
        },
      ],
      wires: [
        {
          id: '0000000d-4ab0-4ece-8091-de044c58c9ae',
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
        wireIds: ['0000000d-4ab0-4ece-8091-de044c58c9ae'],
        members: [{ kind: 'pin', symbolId: '00000009-20d0-411c-897b-44bc357e1972', pinId: 'PC0' }],
      },
    ]);
  });

  it('merges wires that meet at the same pin without a junction', () => {
    const document = documentWith({
      symbols: [
        {
          id: '00000009-20d0-411c-897b-44bc357e1972',
          device: 'stm32-package:stm32g431rbt6-lqfp64',
          x: 0,
          y: 0,
          rotation: 0,
        },
      ],
      wires: [
        {
          id: '00000010-9cf4-407f-8900-09a16d33a38c',
          points: [
            { x: 0, y: 0 },
            { x: 10, y: 0 },
          ],
        },
        {
          id: '00000011-a914-47d5-84d1-8bafbe533ffb',
          points: [
            { x: 0, y: 0 },
            { x: 0, y: 10 },
          ],
        },
      ],
    });
    const topology = deriveSchematicTopology(document, { devices });
    expect(topology.nets).toHaveLength(1);
    expect(topology.nets[0]?.wireIds).toEqual([
      '00000010-9cf4-407f-8900-09a16d33a38c',
      '00000011-a914-47d5-84d1-8bafbe533ffb',
    ]);
  });

  it('does not connect crossing wires without a junction', () => {
    const document = documentWith({
      wires: [
        {
          id: '00000003-9133-41be-84f9-c255d593231c',
          points: [
            { x: 0, y: 0 },
            { x: 10, y: 0 },
          ],
        },
        {
          id: '0000000c-4a29-4075-8caa-d19142dfb112',
          points: [
            { x: 5, y: -5 },
            { x: 5, y: 5 },
          ],
        },
      ],
      symbols: [
        {
          id: '00000006-58c8-4974-8943-b00f84be79fc',
          device: 'builtin:label',
          net: 'L1',
          x: 10,
          y: 0,
          rotation: 0,
        },
        {
          id: '00000007-3abe-43ef-8e00-fe24590a3ea3',
          device: 'builtin:label',
          net: 'L2',
          x: 5,
          y: 5,
          rotation: 0,
        },
      ],
    });
    const topology = deriveSchematicTopology(document, { devices });
    expect(topology.nets.map((net) => net.name)).toEqual(['L1', 'L2']);
  });

  it('keeps isolated pins open and reports dangling ends', () => {
    const document = documentWith({
      symbols: [
        {
          id: '00000009-20d0-411c-897b-44bc357e1972',
          device: 'stm32-package:stm32g431rbt6-lqfp64',
          x: 100,
          y: 100,
          rotation: 0,
        },
        {
          id: '00000005-6e56-4e7f-8384-2e2e21b774e6',
          device: 'builtin:label',
          net: 'L',
          x: 0,
          y: 0,
          rotation: 0,
        },
      ],
      wires: [
        {
          id: '0000000d-4ab0-4ece-8091-de044c58c9ae',
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
        symbolId: '00000009-20d0-411c-897b-44bc357e1972',
        pinId: 'PC0',
        position: { x: 100, y: 100 },
        open: true,
        netName: null,
      },
    ]);
    expect(topology.nets).toEqual([
      {
        name: 'L',
        wireIds: ['0000000d-4ab0-4ece-8091-de044c58c9ae'],
        members: [{ kind: 'label', symbolId: '00000005-6e56-4e7f-8384-2e2e21b774e6' }],
      },
    ]);
    expect(topology.danglingWireEnds.map((item) => item.point)).toEqual([{ x: 10, y: 0 }]);
  });

  it('skips device resolution when no provider is given', () => {
    const topology = deriveSchematicTopology(SAMPLE);
    expect(topology.pins).toEqual([]);
    expect(topology.nets).toEqual([
      {
        name: 'lcd-l-d0',
        wireIds: ['0000000e-d219-4ea3-84bb-593c369c1900', '0000000f-02d3-4c5c-815f-2fda0d3151f0'],
        members: [{ kind: 'label', symbolId: '00000008-33b8-486d-8c54-1dc2d275f643' }],
      },
    ]);
  });

  it('throws for unresolved devices when a provider is given', () => {
    const document = documentWith({
      symbols: [
        {
          id: '00000009-20d0-411c-897b-44bc357e1972',
          device: 'missing-package:missing',
          x: 0,
          y: 0,
          rotation: 0,
        },
      ],
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
      symbols: [
        { id: '00000009-20d0-411c-897b-44bc357e1972', device: 'p:d', x: 0, y: 0, rotation: 0 },
      ],
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
        {
          id: '00000009-20d0-411c-897b-44bc357e1972',
          device: 'stm32-package:stm32g431rbt6-lqfp64',
          x: -0.2,
          y: 0,
          rotation: 0,
        },
      ],
      wires: [
        {
          id: '0000000d-4ab0-4ece-8091-de044c58c9ae',
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
