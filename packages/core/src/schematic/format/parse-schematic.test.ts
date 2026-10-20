import { describe, expect, it } from 'vitest';
import { SchematicError } from './errors';
import { parseSchematic } from './parse-schematic';
import { serializeSchematic } from './serialize';
import { catchError, codesOf } from './test-helpers';
import type { SchematicDocument } from './types';

const SAMPLE = `{
  "version": 1,
  "id": "ct117e-m4-board",
  "sheet": {
    "symbols": [
      { "id": "s-mcu", "device": "stm32-package:stm32g431rbt6-lqfp64", "x": 480, "y": 160, "rotation": 0 },
      { "id": "s-lcd", "device": "lcd-package:ct117e-m4-tft-lcd-2-4", "x": 136, "y": 55, "rotation": 0 },
      { "id": "lcd-l-d0", "device": "builtin:label", "x": 300, "y": 100, "rotation": 0 }
    ],
    "wires": [
      {
        "id": "w-d0",
        "points": [{ "x": 480, "y": 160 }, { "x": 300, "y": 160 }, { "x": 300, "y": 55 }, { "x": 136, "y": 55 }]
      },
      {
        "id": "w-label-d0",
        "points": [{ "x": 300, "y": 124 }, { "x": 300, "y": 100 }]
      }
    ],
    "junctions": [
      { "id": "j-d0", "x": 300, "y": 124, "wires": ["w-d0", "w-label-d0"] }
    ]
  }
}`;

function codes(input: string | unknown): readonly string[] {
  return codesOf(catchError(() => parseSchematic(input)).diagnostics);
}

describe('parseSchematic', () => {
  it('parses the issue #6 example', () => {
    const document = parseSchematic(SAMPLE);
    expect(document.version).toBe(1);
    expect(document.id).toBe('ct117e-m4-board');
    expect(document.sheet.symbols).toHaveLength(3);
    expect(document.sheet.wires[0]?.points).toHaveLength(4);
    expect(document.sheet.junctions[0]?.wires).toEqual(['w-d0', 'w-label-d0']);
  });

  it('accepts plain values as well as text', () => {
    const document = parseSchematic(SAMPLE);
    expect(parseSchematic({ ...document, sheet: { ...document.sheet } })).toEqual(document);
  });

  it('throws a SchematicError carrying every diagnostic', () => {
    const error = catchError(() =>
      parseSchematic(SAMPLE.replace('"id": "ct117e-m4-board"', '"id": 1')),
    );
    expect(error).toBeInstanceOf(SchematicError);
    expect(codesOf(error.diagnostics)).toContain('schema/invalid-type');
    expect(error.message).toContain('/id');
    expect(error.code).toBe(error.diagnostics[0]?.code);
  });

  it('rejects a non-object document', () => {
    expect(codes('[]')).toContain('json/not-object');
  });

  it('rejects unknown fields', () => {
    const error = catchError(() =>
      parseSchematic(SAMPLE.replace('"sheet": {', '"extra": true,\n  "sheet": {')),
    );
    expect(error.diagnostics).toContainEqual({
      severity: 'error',
      code: 'schema/unknown-field',
      message: 'Unknown field "extra".',
      pointer: '/extra',
    });
  });

  it('rejects malformed JSON text', () => {
    const error = catchError(() => parseSchematic('{"version":1,"id":"a",}'));
    expect(error.diagnostics).toHaveLength(1);
    expect(error.diagnostics[0]?.code).toBe('json/invalid');
  });

  it('rejects unsupported and non-integer versions', () => {
    expect(codes(SAMPLE.replace('"version": 1', '"version": 2'))).toContain(
      'schema/unsupported-version',
    );
    expect(codes(SAMPLE.replace('"version": 1', '"version": 1.5'))).toContain(
      'schema/invalid-value',
    );
    expect(codes(SAMPLE.replace('"version": 1', '"version": "1"'))).toContain(
      'schema/invalid-type',
    );
  });

  it('rejects non-finite coordinates', () => {
    const error = catchError(() => parseSchematic(SAMPLE.replace('"x": 480', '"x": 1e400')));
    expect(
      error.diagnostics.some((diagnostic) => diagnostic.pointer === '/sheet/symbols/0/x'),
    ).toBe(true);
    expect(codesOf(error.diagnostics)).toContain('schema/invalid-value');
  });

  it('rejects wires with fewer than two points', () => {
    const error = catchError(() =>
      parseSchematic(
        SAMPLE.replace(
          '"points": [{ "x": 300, "y": 124 }, { "x": 300, "y": 100 }]',
          '"points": [{ "x": 300, "y": 124 }]',
        ),
      ),
    );
    expect(codesOf(error.diagnostics)).toContain('wire/invalid-points');
  });

  it('rejects duplicate element ids', () => {
    const error = catchError(() =>
      parseSchematic(SAMPLE.replace('{ "id": "s-lcd"', '{ "id": "s-mcu"')),
    );
    expect(error.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'id/duplicate',
        pointer: '/sheet/symbols/1/id',
        entity: { kind: 'symbol', id: 's-mcu' },
      }),
    );
  });

  it('rejects junctions that reference unknown or duplicate wires', () => {
    const unknown = catchError(() =>
      parseSchematic(
        SAMPLE.replace('"wires": ["w-d0", "w-label-d0"]', '"wires": ["w-d0", "missing"]'),
      ),
    );
    expect(codesOf(unknown.diagnostics)).toContain('junction/unknown-wire');

    const duplicate = catchError(() =>
      parseSchematic(
        SAMPLE.replace('"wires": ["w-d0", "w-label-d0"]', '"wires": ["w-d0", "w-d0"]'),
      ),
    );
    expect(codesOf(duplicate.diagnostics)).toContain('junction/duplicate-wire');
  });

  it('rejects junctions with fewer than two wires', () => {
    expect(codes(SAMPLE.replace('"wires": ["w-d0", "w-label-d0"]', '"wires": ["w-d0"]'))).toContain(
      'schema/invalid-value',
    );
  });

  it('round-trips through serializeSchematic', () => {
    const document: SchematicDocument = parseSchematic(SAMPLE);
    expect(parseSchematic(serializeSchematic(document))).toEqual(document);
  });
});
