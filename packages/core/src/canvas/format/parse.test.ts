import { describe, expect, it } from 'vitest';
import { catchError, codesOf } from '../../schematic/format/test-helpers';
import { parseCanvas } from './parse';
import { serializeCanvas } from './serialize';
import type { CanvasDocument } from './types';

const SAMPLE = `{
  "version": 1,
  "id": "ct117e-m4-board-2d",
  "schematic": "schematic.sch",
  "layout": {
    "s-mcu": { "x": 100, "y": 220, "rotation": 0 }
  }
}`;

function codes(input: string): readonly string[] {
  return codesOf(catchError(() => parseCanvas(input)).diagnostics);
}

describe('parseCanvas', () => {
  it('parses the canvas example from the proposal', () => {
    const canvas = parseCanvas(SAMPLE);
    expect(canvas.version).toBe(1);
    expect(canvas.id).toBe('ct117e-m4-board-2d');
    expect(canvas.schematic).toBe('schematic.sch');
    expect(canvas.layout['s-mcu']).toEqual({ x: 100, y: 220, rotation: 0 });
  });

  it('throws with a pointer to the offending field', () => {
    const error = catchError(() =>
      parseCanvas(SAMPLE.replace('"id": "ct117e-m4-board-2d"', '"id": 3')),
    );
    expect(error.diagnostics[0]?.pointer).toBe('/id');
  });

  it('rejects unknown fields', () => {
    const error = catchError(() =>
      parseCanvas(
        SAMPLE.replace(
          '"schematic": "schematic.sch",',
          '"schematic": "schematic.sch", "extra": 1,',
        ),
      ),
    );
    expect(error.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'schema/unknown-field', pointer: '/extra' }),
    );
  });

  it('rejects unknown placement fields', () => {
    const error = catchError(() =>
      parseCanvas(SAMPLE.replace('"rotation": 0', '"rotation": 0, "mirror": true')),
    );
    expect(error.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'schema/unknown-field', pointer: '/layout/s-mcu/mirror' }),
    );
  });

  it('requires placement rotation', () => {
    expect(codes(SAMPLE.replace(', "rotation": 0', ''))).toContain('schema/missing-field');
  });

  it('rejects empty schematic references and layout keys', () => {
    expect(codes(SAMPLE.replace('"schematic": "schematic.sch"', '"schematic": ""'))).toContain(
      'schema/invalid-value',
    );
    expect(codes(SAMPLE.replace('"s-mcu":', '"":'))).toContain('schema/invalid-value');
  });

  it('rejects unsupported versions', () => {
    expect(codes(SAMPLE.replace('"version": 1', '"version": 2'))).toContain(
      'schema/unsupported-version',
    );
  });

  it('round-trips through serializeCanvas', () => {
    const canvas = parseCanvas(SAMPLE);
    expect(parseCanvas(serializeCanvas(canvas))).toEqual(canvas);
  });
});

describe('serializeCanvas', () => {
  it('writes layout keys in sorted order', () => {
    const canvas: CanvasDocument = {
      version: 1,
      id: 'c',
      schematic: 's.sch',
      layout: {
        b: { x: 2, y: 2, rotation: 0 },
        a: { x: 1, y: 1, rotation: 0 },
      },
    };
    const text = serializeCanvas(canvas);
    expect(text.indexOf('"a"')).toBeLessThan(text.indexOf('"b"'));
    expect(text.endsWith('}\n')).toBe(true);
  });
});
