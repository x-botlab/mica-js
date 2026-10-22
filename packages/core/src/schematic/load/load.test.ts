import { describe, expect, it } from 'vitest';
import { createDeviceRegistry } from '../device/registry';
import { SchematicError } from '../../format/errors';
import type { SchematicDocument } from '../../format/types';
import { catchError, codesOf } from '../../format/test-helpers';
import { loadSchematic } from './load';

const devices = createDeviceRegistry([
  {
    packageId: 'stm32-package',
    devices: [{ id: 'mcu', symbol: { pins: { PC0: { x: 0, y: 0 } } } }],
  },
]);

const SCH_TEXT = `{
  "version": 1,
  "sheet": {
    "symbols": [
      { "id": "00000002-2dc0-44c6-8963-e4ea065d722b", "device": "stm32-package:mcu", "x": 0, "y": 0, "rotation": 0 }
    ],
    "wires": [
      { "id": "00000003-4ab0-4ece-8091-de044c58c9ae", "points": [{ "x": 0, "y": 0 }, { "x": 10, "y": 0 }] }
    ],
    "junctions": []
  }
}`;

const schematic: SchematicDocument = {
  version: 1,
  sheet: {
    symbols: [
      {
        id: '00000002-2dc0-44c6-8963-e4ea065d722b',
        device: 'stm32-package:mcu',
        x: 0,
        y: 0,
        rotation: 0,
      },
      {
        id: '00000001-c16f-4700-81a9-7ef80c62a850',
        device: 'stm32-package:mcu',
        x: 50,
        y: 50,
        rotation: 0,
      },
    ],
    wires: [],
    junctions: [],
  },
};

describe('loadSchematic', () => {
  it('parses and derives topology from text', () => {
    const loaded = loadSchematic(SCH_TEXT, { devices });
    expect(loaded.document.sheet.symbols).toHaveLength(1);
    expect(loaded.topology.nets).toEqual([
      {
        name: null,
        wireIds: ['00000003-4ab0-4ece-8091-de044c58c9ae'],
        members: [{ kind: 'pin', symbolId: '00000002-2dc0-44c6-8963-e4ea065d722b', pinId: 'PC0' }],
      },
    ]);
  });

  it('accepts an already parsed document', () => {
    const loaded = loadSchematic(schematic);
    expect(loaded.topology.nets).toEqual([]);
    expect(loaded.topology.danglingWireEnds).toEqual([]);
  });

  it('propagates parse failures as SchematicError', () => {
    expect(catchError(() => loadSchematic('{"version":2}'))).toBeInstanceOf(SchematicError);
  });

  it('propagates topology failures', () => {
    const ghost = {
      ...schematic,
      sheet: {
        ...schematic.sheet,
        symbols: [
          {
            id: '00000004-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
            device: 'nope:nope',
            x: 0,
            y: 0,
            rotation: 0,
          },
        ],
      },
    };
    expect(codesOf(catchError(() => loadSchematic(ghost, { devices })).diagnostics)).toContain(
      'device/unresolved',
    );
  });
});
