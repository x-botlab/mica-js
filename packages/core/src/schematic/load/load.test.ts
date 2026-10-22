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
      { "id": "s-mcu", "device": "stm32-package:mcu", "x": 0, "y": 0, "rotation": 0 }
    ],
    "wires": [
      { "id": "w", "points": [{ "x": 0, "y": 0 }, { "x": 10, "y": 0 }] }
    ],
    "junctions": []
  }
}`;

const schematic: SchematicDocument = {
  version: 1,
  sheet: {
    symbols: [
      { id: 's-mcu', device: 'stm32-package:mcu', x: 0, y: 0, rotation: 0 },
      { id: 's-lcd', device: 'stm32-package:mcu', x: 50, y: 50, rotation: 0 },
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
      { name: null, wireIds: ['w'], members: [{ kind: 'pin', symbolId: 's-mcu', pinId: 'PC0' }] },
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
        symbols: [{ id: 'x', device: 'nope:nope', x: 0, y: 0, rotation: 0 }],
      },
    };
    expect(codesOf(catchError(() => loadSchematic(ghost, { devices })).diagnostics)).toContain(
      'device/unresolved',
    );
  });
});
