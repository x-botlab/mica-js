import { describe, expect, it } from 'vitest';
import { parseSchematic } from './parse-schematic';
import { serializeSchematic } from './serialize';
import type { SchematicDocument } from './types';
import { catchError, codesOf } from './test-helpers';

const BASE = {
  version: 1,
  id: 'props',
  sheet: {
    symbols: [{ id: 's1', device: 'pkg:a', x: 0, y: 0, rotation: 0 }],
    wires: [],
    junctions: [],
  },
} as const;

function withProperties(properties: unknown): unknown {
  return {
    ...BASE,
    sheet: {
      ...BASE.sheet,
      symbols: [{ ...BASE.sheet.symbols[0], properties }],
    },
  };
}

describe('symbol properties', () => {
  it('parses string, number and boolean values', () => {
    const document = parseSchematic(withProperties({ label: 'MCU', speed: 72, enable: true }));
    expect(document.sheet.symbols[0]?.properties).toEqual({
      label: 'MCU',
      speed: 72,
      enable: true,
    });
  });

  it('treats a missing properties field as absent', () => {
    expect(parseSchematic(BASE).sheet.symbols[0]?.properties).toBeUndefined();
  });

  it('rejects null, arrays, objects and non-finite numbers', () => {
    expect(
      codesOf(catchError(() => parseSchematic(withProperties({ a: null }))).diagnostics),
    ).toContain('schema/invalid-value');
    expect(
      codesOf(catchError(() => parseSchematic(withProperties({ a: [1] }))).diagnostics),
    ).toContain('schema/invalid-value');
    expect(
      codesOf(catchError(() => parseSchematic(withProperties({ a: { b: 1 } }))).diagnostics),
    ).toContain('schema/invalid-value');
    expect(
      codesOf(
        catchError(() => parseSchematic(withProperties({ a: Number.POSITIVE_INFINITY })))
          .diagnostics,
      ),
    ).toContain('schema/invalid-value');
  });

  it('rejects empty keys', () => {
    expect(
      codesOf(catchError(() => parseSchematic(withProperties({ '': 1 }))).diagnostics),
    ).toContain('schema/invalid-value');
  });

  it('rejects a non-object properties field', () => {
    expect(codesOf(catchError(() => parseSchematic(withProperties('oops'))).diagnostics)).toContain(
      'schema/invalid-type',
    );
  });

  it('serializes sorted keys and round-trips', () => {
    const document: SchematicDocument = parseSchematic(
      withProperties({ zeta: 1, alpha: 'a', middle: false }),
    );
    const text = serializeSchematic(document);
    expect(text.indexOf('"alpha"')).toBeLessThan(text.indexOf('"middle"'));
    expect(text.indexOf('"middle"')).toBeLessThan(text.indexOf('"zeta"'));
    expect(parseSchematic(text)).toEqual(document);
  });

  it('omits an empty property map', () => {
    const document: SchematicDocument = parseSchematic(withProperties({}));
    expect(document.sheet.symbols[0]?.properties).toEqual({});
    expect(serializeSchematic(document)).not.toContain('properties');
  });
});
