import { describe, expect, it } from 'vitest';
import { parseView } from './parse-view';
import { serializeView } from './serialize';
import { catchError, codesOf } from './test-helpers';
import type { SchematicViewDocument } from './types';

const SAMPLE = `{
  "version": 1,
  "id": "ct117e-m4-board-2d",
  "schematic": "schematic.sch",
  "layout": {
    "s-mcu": { "x": 100, "y": 220, "rotation": 0 }
  }
}`;

function codes(input: string): readonly string[] {
  return codesOf(catchError(() => parseView(input)).diagnostics);
}

describe('parseView', () => {
  it('parses the 2D view example from the proposal', () => {
    const view = parseView(SAMPLE);
    expect(view.version).toBe(1);
    expect(view.id).toBe('ct117e-m4-board-2d');
    expect(view.schematic).toBe('schematic.sch');
    expect(view.layout['s-mcu']).toEqual({ x: 100, y: 220, rotation: 0 });
  });

  it('throws with a pointer to the offending field', () => {
    const error = catchError(() =>
      parseView(SAMPLE.replace('"id": "ct117e-m4-board-2d"', '"id": 3')),
    );
    expect(error.diagnostics[0]?.pointer).toBe('/id');
  });

  it('rejects unknown fields', () => {
    const error = catchError(() =>
      parseView(
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
      parseView(SAMPLE.replace('"rotation": 0', '"rotation": 0, "mirror": true')),
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

  it('round-trips through serializeView', () => {
    const view = parseView(SAMPLE);
    expect(parseView(serializeView(view))).toEqual(view);
  });
});

describe('serializeView', () => {
  it('writes layout keys in sorted order', () => {
    const view: SchematicViewDocument = {
      version: 1,
      id: 'v',
      schematic: 's.sch',
      layout: {
        b: { x: 2, y: 2, rotation: 0 },
        a: { x: 1, y: 1, rotation: 0 },
      },
    };
    const text = serializeView(view);
    expect(text.indexOf('"a"')).toBeLessThan(text.indexOf('"b"'));
    expect(text.endsWith('}\n')).toBe(true);
  });
});
