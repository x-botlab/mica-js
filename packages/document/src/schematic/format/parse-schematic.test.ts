import { describe, expect, it } from 'vitest';
import { SchematicError } from '../../format/errors';
import { parseSchematic } from './parse-schematic';
import { serializeSchematic } from './serialize';
import { catchError, codesOf } from '../../format/test-helpers';
import type { SchematicDocument } from '../../format/types';

const SAMPLE = `{
  "version": 1,
  "sheet": {
    "symbols": [
      { "id": "3f1a9c2e-5b64-4d17-9c8a-1e2d3f4a5b60", "device": "stm32-package:stm32g431rbt6-lqfp64", "x": 480, "y": 160, "rotation": 0 },
      { "id": "7c2b4d1a-6e35-4f82-a9b1-2c3d4e5f6a71", "device": "lcd-package:ct117e-m4-tft-lcd-2-4", "x": 136, "y": 55, "rotation": 0 },
      { "id": "9d3c2b1a-4e5f-4a6b-8c7d-0e1f2a3b4c82", "device": "builtin:label", "net": "lcd-l-d0", "x": 300, "y": 100, "rotation": 0 }
    ],
    "wires": [
      {
        "id": "1b2c3d4e-5f60-4a71-9b82-3c4d5e6f7a93",
        "points": [{ "x": 480, "y": 160 }, { "x": 300, "y": 160 }, { "x": 300, "y": 55 }, { "x": 136, "y": 55 }]
      },
      {
        "id": "2c3d4e5f-6a71-4b82-9c93-4d5e6f7a8b04",
        "points": [{ "x": 300, "y": 124 }, { "x": 300, "y": 100 }]
      }
    ],
    "junctions": [
      { "id": "4e5f6a7b-8c93-4d04-9e15-6f7a8b9c0d25", "x": 300, "y": 124, "wires": ["1b2c3d4e-5f60-4a71-9b82-3c4d5e6f7a93", "2c3d4e5f-6a71-4b82-9c93-4d5e6f7a8b04"] }
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
    expect(Object.keys(document)).toEqual(['version', 'sheet']);
    expect(document.sheet.symbols).toHaveLength(3);
    expect(document.sheet.wires[0]?.points).toHaveLength(4);
    expect(document.sheet.junctions[0]?.wires).toEqual([
      '1b2c3d4e-5f60-4a71-9b82-3c4d5e6f7a93',
      '2c3d4e5f-6a71-4b82-9c93-4d5e6f7a8b04',
    ]);
  });

  it('accepts plain values as well as text', () => {
    const document = parseSchematic(SAMPLE);
    expect(parseSchematic({ ...document, sheet: { ...document.sheet } })).toEqual(document);
  });

  it('throws a SchematicError carrying every diagnostic', () => {
    const error = catchError(() =>
      parseSchematic(SAMPLE.replace('"version": 1', '"version": "1"')),
    );
    expect(error).toBeInstanceOf(SchematicError);
    expect(codesOf(error.diagnostics)).toContain('schema/invalid-type');
    expect(error.message).toContain('/version');
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

  it('rejects a document-level id', () => {
    const error = catchError(() =>
      parseSchematic(SAMPLE.replace('"version": 1,', '"version": 1,\n  "id": "board",')),
    );
    expect(codesOf(error.diagnostics)).toContain('schema/unknown-field');
    expect(error.message).toContain('/id');
  });

  it('rejects malformed JSON text', () => {
    const error = catchError(() => parseSchematic('{"version":1,"sheet":{},}'));
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
      parseSchematic(
        SAMPLE.replace(
          '{ "id": "7c2b4d1a-6e35-4f82-a9b1-2c3d4e5f6a71"',
          '{ "id": "3f1a9c2e-5b64-4d17-9c8a-1e2d3f4a5b60"',
        ),
      ),
    );
    expect(error.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'id/duplicate',
        pointer: '/sheet/symbols/1/id',
        entity: { kind: 'symbol', id: '3f1a9c2e-5b64-4d17-9c8a-1e2d3f4a5b60' },
      }),
    );
  });

  it('requires UUID v4 element ids', () => {
    const symbol = catchError(() =>
      parseSchematic(
        SAMPLE.replace('"id": "3f1a9c2e-5b64-4d17-9c8a-1e2d3f4a5b60"', '"id": "s-mcu"'),
      ),
    );
    expect(symbol.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: 'error',
        code: 'schema/invalid-value',
        message: 'Field "id" must be a UUID v4.',
        pointer: '/sheet/symbols/0/id',
      }),
    );

    const wire = catchError(() =>
      parseSchematic(
        SAMPLE.replace('"id": "1b2c3d4e-5f60-4a71-9b82-3c4d5e6f7a93"', '"id": "w-d0"'),
      ),
    );
    expect(wire.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: 'error',
        code: 'schema/invalid-value',
        message: 'Field "id" must be a UUID v4.',
        pointer: '/sheet/wires/0/id',
      }),
    );

    const junction = catchError(() =>
      parseSchematic(
        SAMPLE.replace('"id": "4e5f6a7b-8c93-4d04-9e15-6f7a8b9c0d25"', '"id": "j-d0"'),
      ),
    );
    expect(junction.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: 'error',
        code: 'schema/invalid-value',
        message: 'Field "id" must be a UUID v4.',
        pointer: '/sheet/junctions/0/id',
      }),
    );
  });

  it('rejects junctions that reference unknown or duplicate wires', () => {
    const unknown = catchError(() =>
      parseSchematic(
        SAMPLE.replace(
          '"wires": ["1b2c3d4e-5f60-4a71-9b82-3c4d5e6f7a93", "2c3d4e5f-6a71-4b82-9c93-4d5e6f7a8b04"]',
          '"wires": ["1b2c3d4e-5f60-4a71-9b82-3c4d5e6f7a93", "missing"]',
        ),
      ),
    );
    expect(codesOf(unknown.diagnostics)).toContain('junction/unknown-wire');

    const duplicate = catchError(() =>
      parseSchematic(
        SAMPLE.replace(
          '"wires": ["1b2c3d4e-5f60-4a71-9b82-3c4d5e6f7a93", "2c3d4e5f-6a71-4b82-9c93-4d5e6f7a8b04"]',
          '"wires": ["1b2c3d4e-5f60-4a71-9b82-3c4d5e6f7a93", "1b2c3d4e-5f60-4a71-9b82-3c4d5e6f7a93"]',
        ),
      ),
    );
    expect(codesOf(duplicate.diagnostics)).toContain('junction/duplicate-wire');
  });

  it('rejects junctions with fewer than two wires', () => {
    expect(
      codes(
        SAMPLE.replace(
          '"wires": ["1b2c3d4e-5f60-4a71-9b82-3c4d5e6f7a93", "2c3d4e5f-6a71-4b82-9c93-4d5e6f7a8b04"]',
          '"wires": ["1b2c3d4e-5f60-4a71-9b82-3c4d5e6f7a93"]',
        ),
      ),
    ).toContain('schema/invalid-value');
  });

  it('round-trips through serializeSchematic', () => {
    const document: SchematicDocument = parseSchematic(SAMPLE);
    expect(parseSchematic(serializeSchematic(document))).toEqual(document);
  });
});
