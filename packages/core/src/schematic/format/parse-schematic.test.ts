import { describe, expect, it } from 'vitest';
import type { ParseResult } from './result';
import { parseSchematic } from './parse-schematic';
import { serializeSchematic } from './serialize';
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

function expectValue<T>(result: ParseResult<T>): T {
  if (result.value === undefined) {
    throw new Error(`expected a value, got diagnostics ${JSON.stringify(result.diagnostics)}`);
  }
  return result.value;
}

function codes(input: string | unknown): readonly string[] {
  return parseSchematic(input).diagnostics.map((diagnostic) => diagnostic.code);
}

describe('parseSchematic', () => {
  it('parses the issue #6 example', () => {
    const result = parseSchematic(SAMPLE);
    expect(result.ok).toBe(true);
    expect(result.diagnostics).toEqual([]);
    const document = expectValue(result);
    expect(document.version).toBe(1);
    expect(document.id).toBe('ct117e-m4-board');
    expect(document.sheet.symbols).toHaveLength(3);
    expect(document.sheet.wires[0]?.points).toHaveLength(4);
    expect(document.sheet.junctions[0]?.wires).toEqual(['w-d0', 'w-label-d0']);
  });

  it('accepts plain values as well as text', () => {
    const document = expectValue(parseSchematic(SAMPLE));
    const result = parseSchematic({ ...document, sheet: { ...document.sheet } });
    expect(result.ok).toBe(true);
  });

  it('rejects a non-object document', () => {
    expect(codes('[]')).toContain('json/not-object');
  });

  it('rejects unknown fields', () => {
    const result = parseSchematic(SAMPLE.replace('"sheet": {', '"extra": true,\n  "sheet": {'));
    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContainEqual({
      severity: 'error',
      code: 'schema/unknown-field',
      message: 'Unknown field "extra".',
      pointer: '/extra',
    });
  });

  it('rejects malformed JSON text', () => {
    const result = parseSchematic('{"version":1,"id":"a",}');
    expect(result.ok).toBe(false);
    expect(result.value).toBeUndefined();
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.code).toBe('json/invalid');
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
    const result = parseSchematic(SAMPLE.replace('"x": 480', '"x": 1e400'));
    expect(
      result.diagnostics.some((diagnostic) => diagnostic.pointer === '/sheet/symbols/0/x'),
    ).toBe(true);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      'schema/invalid-value',
    );
  });

  it('rejects wires with fewer than two points', () => {
    const result = parseSchematic(
      SAMPLE.replace(
        '"points": [{ "x": 300, "y": 124 }, { "x": 300, "y": 100 }]',
        '"points": [{ "x": 300, "y": 124 }]',
      ),
    );
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      'wire/invalid-points',
    );
  });

  it('rejects duplicate element ids', () => {
    const result = parseSchematic(SAMPLE.replace('{ "id": "s-lcd"', '{ "id": "s-mcu"'));
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'id/duplicate',
        pointer: '/sheet/symbols/1/id',
        entity: { kind: 'symbol', id: 's-mcu' },
      }),
    );
  });

  it('rejects junctions that reference unknown or duplicate wires', () => {
    const unknown = parseSchematic(
      SAMPLE.replace('"wires": ["w-d0", "w-label-d0"]', '"wires": ["w-d0", "missing"]'),
    );
    expect(unknown.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      'junction/unknown-wire',
    );

    const duplicate = parseSchematic(
      SAMPLE.replace('"wires": ["w-d0", "w-label-d0"]', '"wires": ["w-d0", "w-d0"]'),
    );
    expect(duplicate.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      'junction/duplicate-wire',
    );
  });

  it('rejects junctions with fewer than two wires', () => {
    const result = parseSchematic(
      SAMPLE.replace('"wires": ["w-d0", "w-label-d0"]', '"wires": ["w-d0"]'),
    );
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      'schema/invalid-value',
    );
  });

  it('round-trips through serializeSchematic', () => {
    const document = expectValue(parseSchematic(SAMPLE));
    const reparsed = parseSchematic(serializeSchematic(document));
    expect(reparsed.ok).toBe(true);
    expect(reparsed.value).toEqual(document);
  });
});

describe('schematic document model', () => {
  it('keeps readonly nested arrays', () => {
    const document: SchematicDocument = expectValue(parseSchematic(SAMPLE));
    expect(document.sheet.symbols.map((symbol) => symbol.id)).toEqual([
      's-mcu',
      's-lcd',
      'lcd-l-d0',
    ]);
  });
});
