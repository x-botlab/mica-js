import { SchematicError, parseSchematic, type SchematicDocument } from '@mica-js/core/schematic';
import { describe, expect, it } from 'vitest';
import {
  SCHEMATIC_CLIPBOARD_FORMAT,
  SCHEMATIC_CLIPBOARD_MIME,
  SCHEMATIC_CLIPBOARD_VERSION,
  createSchematicClipboard,
  parseSchematicClipboard,
  serializeSchematicClipboard,
} from './clipboard';

const symbolId = '00000003-41e6-4a4c-869a-82a4cd304787';
const wireId = '00000006-9cf4-407f-8900-09a16d33a38c';
const branchWireId = '00000007-a914-47d5-84d1-8bafbe533ffb';
const junctionId = '00000001-516c-48ac-8128-07f98c98ee13';

function documentOf(sheet: {
  symbols?: readonly unknown[];
  wires?: readonly unknown[];
  junctions?: readonly unknown[];
}): SchematicDocument {
  return parseSchematic({
    version: 1,
    sheet: {
      symbols: sheet.symbols ?? [],
      wires: sheet.wires ?? [],
      junctions: sheet.junctions ?? [],
    },
  });
}

function drawing(): SchematicDocument {
  return documentOf({
    symbols: [{ id: symbolId, device: 'pkg:mcu', x: 10, y: 20, rotation: 90 }],
    wires: [
      {
        id: wireId,
        points: [
          { x: 0, y: 0 },
          { x: 50, y: 0 },
        ],
      },
      {
        id: branchWireId,
        points: [
          { x: 50, y: 0 },
          { x: 50, y: 50 },
        ],
      },
    ],
    junctions: [{ id: junctionId, x: 50, y: 0, wires: [wireId, branchWireId] }],
  });
}

describe('createSchematicClipboard', () => {
  it('normalizes reference and vertex selections to whole elements', () => {
    const clipboard = createSchematicClipboard(drawing(), [
      { kind: 'reference', symbolId },
      { kind: 'vertex', wireId, index: 1 },
    ]);

    expect(clipboard?.symbols).toEqual([
      { id: symbolId, device: 'pkg:mcu', x: 10, y: 20, rotation: 90 },
    ]);
    expect(clipboard?.wires).toEqual([
      {
        id: wireId,
        points: [
          { x: 0, y: 0 },
          { x: 50, y: 0 },
        ],
      },
    ]);
    // The branch wire was not copied, so its junction cannot come along.
    expect(clipboard?.junctions).toEqual([]);
  });

  it('copies a junction only when every wire it joins is copied', () => {
    const both = createSchematicClipboard(drawing(), [
      { kind: 'wire', id: wireId },
      { kind: 'wire', id: branchWireId },
    ]);
    expect(both?.junctions).toEqual([
      { id: junctionId, x: 50, y: 0, wires: [wireId, branchWireId] },
    ]);

    const dangling = createSchematicClipboard(drawing(), [
      { kind: 'wire', id: wireId },
      { kind: 'junction', id: junctionId },
    ]);
    expect(dangling?.wires).toHaveLength(1);
    expect(dangling?.junctions).toEqual([]);
  });

  it('drops targets the document no longer contains and reports empty selections', () => {
    expect(
      createSchematicClipboard(drawing(), [{ kind: 'symbol', id: 'missing' }]),
    ).toBeUndefined();
    expect(
      createSchematicClipboard(drawing(), [
        { kind: 'symbol', id: symbolId },
        { kind: 'symbol', id: symbolId },
      ])?.symbols,
    ).toHaveLength(1);
  });

  it('reads without touching the document', () => {
    const document = drawing();
    const sheet = document.sheet;
    createSchematicClipboard(document, [
      { kind: 'symbol', id: symbolId },
      { kind: 'wire', id: wireId },
    ]);
    expect(document.sheet).toBe(sheet);
    expect(document.sheet.symbols).toHaveLength(1);
  });
});

describe('serializeSchematicClipboard', () => {
  it('round-trips a payload through JSON', () => {
    const clipboard = createSchematicClipboard(drawing(), [
      { kind: 'symbol', id: symbolId },
      { kind: 'wire', id: wireId },
      { kind: 'wire', id: branchWireId },
    ]);
    expect(clipboard).toBeDefined();
    if (clipboard === undefined) {
      throw new Error('expected a payload');
    }

    const parsed = parseSchematicClipboard(serializeSchematicClipboard(clipboard));
    expect(parsed).toEqual(clipboard);
    expect(parsed.format).toBe(SCHEMATIC_CLIPBOARD_FORMAT);
    expect(parsed.version).toBe(SCHEMATIC_CLIPBOARD_VERSION);
    expect(SCHEMATIC_CLIPBOARD_MIME).toBe('application/x-mica-schematic+json');
  });
});

describe('parseSchematicClipboard', () => {
  function payload(patch: Record<string, unknown> = {}): string {
    return JSON.stringify({
      format: SCHEMATIC_CLIPBOARD_FORMAT,
      version: SCHEMATIC_CLIPBOARD_VERSION,
      symbols: [],
      wires: [],
      junctions: [],
      ...patch,
    });
  }

  function codeOf(text: string): string | undefined {
    try {
      parseSchematicClipboard(text);
    } catch (error) {
      expect(error).toBeInstanceOf(SchematicError);
      return error instanceof SchematicError ? error.code : undefined;
    }
    return undefined;
  }

  it('rejects text that is not JSON', () => {
    expect(codeOf('not json')).toBe('json/invalid');
  });

  it('rejects foreign payloads, other versions and non-array elements', () => {
    expect(codeOf(JSON.stringify({ hello: 'world' }))).toBe('schema/invalid-value');
    expect(codeOf(JSON.stringify({ ...JSON.parse(payload()), format: 'other' }))).toBe(
      'schema/invalid-value',
    );
    expect(codeOf(JSON.stringify({ ...JSON.parse(payload()), version: 2 }))).toBe(
      'schema/unsupported-version',
    );
    expect(codeOf(JSON.stringify({ ...JSON.parse(payload()), symbols: {} }))).toBe(
      'schema/invalid-type',
    );
  });

  it('rejects payloads over the element or coordinate budget', () => {
    expect(codeOf(payload({ symbols: Array.from({ length: 10_001 }, () => ({})) }))).toBe(
      'schema/invalid-value',
    );
    expect(
      codeOf(
        payload({
          symbols: [{ id: symbolId, device: 'pkg:mcu', x: 2_000_000, y: 0, rotation: 0 }],
        }),
      ),
    ).toBe('schema/invalid-value');
    expect(
      codeOf(
        payload({
          wires: [
            {
              id: wireId,
              points: [
                { x: 0, y: 0 },
                { x: -2_000_000, y: 0 },
              ],
            },
          ],
        }),
      ),
    ).toBe('schema/invalid-value');
  });

  it('normalizes through the .sch contract instead of trusting the payload', () => {
    const parsed = parseSchematicClipboard(payload({ extra: 'top-level fields are ignored' }));
    expect(parsed.symbols).toEqual([]);

    expect(() =>
      parseSchematicClipboard(
        payload({
          symbols: [{ id: symbolId, device: 'pkg:mcu', x: 0, y: 0, rotation: 0, extra: 1 }],
        }),
      ),
    ).toThrow(SchematicError);
  });
});
