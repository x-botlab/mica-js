import { describe, expect, it } from 'vitest';
import { SchematicError } from '../schematic/format/errors';
import { catchError, codesOf } from '../schematic/format/test-helpers';
import type { SchematicDocument } from '../schematic/format/types';
import { loadCanvas } from './load';

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

const CANVAS_TEXT = `{
  "version": 1,
  "id": "board-2d",
  "schematic": "schematic.sch",
  "layout": {
    "s-mcu": { "x": 100, "y": 220, "rotation": 0 },
    "s-lcd": { "x": 10, "y": 20, "rotation": 90 }
  }
}`;

describe('loadCanvas', () => {
  it('returns placements sorted by symbol id', () => {
    const loaded = loadCanvas(CANVAS_TEXT, { schematic });
    expect(loaded.document.id).toBe('board-2d');
    expect(loaded.placements).toEqual([
      { symbolId: 's-lcd', placement: { x: 10, y: 20, rotation: 90 } },
      { symbolId: 's-mcu', placement: { x: 100, y: 220, rotation: 0 } },
    ]);
  });

  it('skips symbol validation when no schematic is provided', () => {
    const loaded = loadCanvas({
      version: 1,
      id: 'c',
      schematic: 'schematic.sch',
      layout: { anything: { x: 0, y: 0, rotation: 0 } },
    });
    expect(loaded.placements).toHaveLength(1);
  });

  it('rejects layout keys absent from the bound schematic', () => {
    const error = catchError(() =>
      loadCanvas(
        {
          version: 1,
          id: 'c',
          schematic: 'schematic.sch',
          layout: {
            missing: { x: 0, y: 0, rotation: 0 },
            's-mcu': { x: 1, y: 1, rotation: 0 },
          },
        },
        { schematic },
      ),
    );
    expect(error).toBeInstanceOf(SchematicError);
    expect(error.diagnostics).toEqual([
      {
        severity: 'error',
        code: 'canvas/unknown-symbol',
        message:
          'Canvas layout references symbol "missing" which is absent from the bound schematic.',
        pointer: '/layout/missing',
      },
    ]);
  });

  it('rejects an empty schematic reference', () => {
    expect(
      codesOf(
        catchError(() => loadCanvas(CANVAS_TEXT.replace('"schematic.sch"', '""'))).diagnostics,
      ),
    ).toContain('schema/invalid-value');
  });
});
