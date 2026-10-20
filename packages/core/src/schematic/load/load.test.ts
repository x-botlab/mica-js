import { describe, expect, it } from 'vitest';
import { createDeviceRegistry } from '../device/registry';
import { SchematicError } from '../format/errors';
import type { SchematicDocument, SchematicViewDocument } from '../format/types';
import { catchError, codesOf } from '../format/test-helpers';
import { loadSchematic, loadView } from './load';

const devices = createDeviceRegistry([
  {
    packageId: 'stm32-package',
    devices: [{ id: 'mcu', symbol: { pins: { PC0: { x: 0, y: 0 } } } }],
  },
]);

const SCH_TEXT = `{
  "version": 1,
  "id": "board",
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
  id: 'board',
  sheet: {
    symbols: [
      { id: 's-mcu', device: 'stm32-package:mcu', x: 0, y: 0, rotation: 0 },
      { id: 's-lcd', device: 'stm32-package:mcu', x: 50, y: 50, rotation: 0 },
    ],
    wires: [],
    junctions: [],
  },
};

const VIEW_TEXT = `{
  "version": 1,
  "id": "board-2d",
  "schematic": "schematic.sch",
  "layout": {
    "s-mcu": { "x": 100, "y": 220, "rotation": 0 },
    "s-lcd": { "x": 10, "y": 20, "rotation": 90 }
  }
}`;

describe('loadSchematic', () => {
  it('parses and derives topology from text', () => {
    const loaded = loadSchematic(SCH_TEXT, { devices });
    expect(loaded.document.id).toBe('board');
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

describe('loadView', () => {
  it('returns placements sorted by symbol id', () => {
    const loaded = loadView(VIEW_TEXT, { schematic });
    expect(loaded.document.id).toBe('board-2d');
    expect(loaded.placements).toEqual([
      { symbolId: 's-lcd', placement: { x: 10, y: 20, rotation: 90 } },
      { symbolId: 's-mcu', placement: { x: 100, y: 220, rotation: 0 } },
    ]);
  });

  it('skips symbol validation when no schematic is provided', () => {
    const view: SchematicViewDocument = {
      version: 1,
      id: 'v',
      schematic: 'schematic.sch',
      layout: {
        anything: { x: 0, y: 0, rotation: 0 },
      },
    };
    expect(loadView(view).placements).toHaveLength(1);
  });

  it('rejects layout keys absent from the bound schematic', () => {
    const error = catchError(() =>
      loadView(
        {
          version: 1,
          id: 'v',
          schematic: 'schematic.sch',
          layout: {
            missing: { x: 0, y: 0, rotation: 0 },
            's-mcu': { x: 1, y: 1, rotation: 0 },
          },
        },
        { schematic },
      ),
    );
    expect(error.diagnostics).toEqual([
      {
        severity: 'error',
        code: 'view/unknown-symbol',
        message:
          'View layout references symbol "missing" which is absent from the bound schematic.',
        pointer: '/layout/missing',
      },
    ]);
  });

  it('rejects an empty schematic reference', () => {
    expect(
      codesOf(catchError(() => loadView(VIEW_TEXT.replace('"schematic.sch"', '""'))).diagnostics),
    ).toContain('schema/invalid-value');
  });
});
