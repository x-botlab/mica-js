import { describe, expect, it } from 'vitest';
import { parseSchematic } from './parse-schematic';
import { serializeSchematic } from './serialize';
import type { SchematicDocument } from '../../format/types';
import { catchError, codesOf } from '../../format/test-helpers';

const BASE = {
  version: 1,
  sheet: {
    symbols: [
      { id: '00000001-41e6-4a4c-869a-82a4cd304787', device: 'pkg:a', x: 0, y: 0, rotation: 0 },
    ],
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

  it('parses resource references and explicit null values', () => {
    const document = parseSchematic(
      withProperties({
        firmware: { src: 'assets/fw.bin', mode: 'file' },
        logo: { src: 'iVBORw0KGgo=', mode: 'inline' },
        saved: null,
      }),
    );
    expect(document.sheet.symbols[0]?.properties).toEqual({
      firmware: { src: 'assets/fw.bin', mode: 'file' },
      logo: { src: 'iVBORw0KGgo=', mode: 'inline' },
      saved: null,
    });
  });

  it('rejects arrays, plain objects and non-finite numbers', () => {
    expect(
      codesOf(catchError(() => parseSchematic(withProperties({ a: [1] }))).diagnostics),
    ).toContain('schema/invalid-value');
    expect(
      codesOf(catchError(() => parseSchematic(withProperties({ a: { b: 1 } }))).diagnostics),
    ).toContain('schema/missing-field');
    expect(
      codesOf(
        catchError(() => parseSchematic(withProperties({ a: Number.POSITIVE_INFINITY })))
          .diagnostics,
      ),
    ).toContain('schema/invalid-value');
  });

  it('rejects resource references that break the #7 rules', () => {
    const rejected = (reference: unknown): readonly string[] =>
      codesOf(catchError(() => parseSchematic(withProperties({ asset: reference }))).diagnostics);
    for (const src of [
      '../escape.bin',
      '/abs.bin',
      'C:/drive.bin',
      'https://x/y.bin',
      'a\\b.bin',
    ]) {
      expect(rejected({ src, mode: 'file' })).toContain('schema/invalid-value');
    }
    expect(rejected({ src: 'oops', mode: 'nope' })).toContain('schema/invalid-value');
    expect(rejected({ src: 'a.bin' })).toContain('schema/missing-field');
    expect(rejected({ src: '', mode: 'file' })).toContain('schema/invalid-value');
    expect(rejected({ src: 'a.bin', mode: 'file', extra: 1 })).toContain('schema/unknown-field');
    expect(rejected([{ src: 'a.bin', mode: 'file' }])).toContain('schema/invalid-value');
  });

  it('round-trips resource references', () => {
    const document = parseSchematic(
      withProperties({ firmware: { src: 'assets/fw.bin', mode: 'file' }, saved: null }),
    );
    const text = serializeSchematic(document);
    expect(text).toContain('"mode": "file"');
    expect(parseSchematic(text)).toEqual(document);
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
