import { describe, expect, it } from 'vitest';
import { parseView } from './parse-view';
import type { ParseResult } from './result';
import { serializeView } from './serialize';
import type { SchematicViewDocument } from './types';

const SAMPLE = `{
  "version": 1,
  "id": "ct117e-m4-board-2d",
  "schematic": "schematic.sch",
  "layout": {
    "s-mcu": { "x": 100, "y": 220, "rotation": 0 }
  }
}`;

function expectValue<T>(result: ParseResult<T>): T {
  if (result.value === undefined) {
    throw new Error(`expected a value, got diagnostics ${JSON.stringify(result.diagnostics)}`);
  }
  return result.value;
}

function codes(input: string): readonly string[] {
  return parseView(input).diagnostics.map((diagnostic) => diagnostic.code);
}

describe('parseView', () => {
  it('parses the issue #6 example', () => {
    const result = parseView(SAMPLE);
    expect(result.ok).toBe(true);
    const view = expectValue(result);
    expect(view.version).toBe(1);
    expect(view.id).toBe('ct117e-m4-board-2d');
    expect(view.schematic).toBe('schematic.sch');
    expect(view.layout['s-mcu']).toEqual({ x: 100, y: 220, rotation: 0 });
  });

  it('rejects unknown fields', () => {
    const result = parseView(
      SAMPLE.replace('"schematic": "schematic.sch",', '"schematic": "schematic.sch", "extra": 1,'),
    );
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'schema/unknown-field', pointer: '/extra' }),
    );
  });

  it('rejects unknown placement fields', () => {
    const result = parseView(SAMPLE.replace('"rotation": 0', '"rotation": 0, "mirror": true'));
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'schema/unknown-field', pointer: '/layout/s-mcu/mirror' }),
    );
  });

  it('requires placement rotation', () => {
    const result = parseView(SAMPLE.replace(', "rotation": 0', ''));
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      'schema/missing-field',
    );
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
    const view = expectValue(parseView(SAMPLE));
    const reparsed = parseView(serializeView(view));
    expect(reparsed.ok).toBe(true);
    expect(reparsed.value).toEqual(view);
  });
});

describe('serializeView', () => {
  it('writes layout keys in sorted order', () => {
    const view: SchematicViewDocument = {
      version: 1,
      id: 'v',
      schematic: 's.sch',
      layout: Object.assign(
        Object.create(null) as Record<string, { x: number; y: number; rotation: number }>,
        {
          b: { x: 2, y: 2, rotation: 0 },
          a: { x: 1, y: 1, rotation: 0 },
        },
      ),
    };
    const text = serializeView(view);
    expect(text.indexOf('"a"')).toBeLessThan(text.indexOf('"b"'));
    expect(text.endsWith('}\n')).toBe(true);
  });
});
