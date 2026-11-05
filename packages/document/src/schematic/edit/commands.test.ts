import { describe, expect, it } from 'vitest';
import { applySchematicCommand, type SchematicCommand } from './commands';
import type { EditEffect } from './commands';
import { createDeviceRegistry } from '../device/registry';
import type { SchematicDocument } from '../../format/types';
import { catchError, codesOf } from '../../format/test-helpers';

/** Ids are generated as UUID v4 so they never collide with user-facing names. */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function makeDocument(): SchematicDocument {
  return {
    version: 1,
    sheet: {
      symbols: [
        { id: '00000002-41e6-4a4c-869a-82a4cd304787', device: 'pkg:a', x: 0, y: 0, rotation: 0 },
        { id: '00000003-dfe1-4ed9-83d0-30ddf7887781', device: 'pkg:b', x: 100, y: 0, rotation: 0 },
      ],
      wires: [
        {
          id: '00000004-9cf4-407f-8900-09a16d33a38c',
          points: [
            { x: 0, y: 0 },
            { x: 10, y: 0 },
          ],
        },
        {
          id: '00000005-a914-47d5-84d1-8bafbe533ffb',
          points: [
            { x: 5, y: 0 },
            { x: 5, y: 10 },
          ],
        },
      ],
      junctions: [
        {
          id: '00000001-516c-48ac-8128-07f98c98ee13',
          x: 5,
          y: 0,
          wires: ['00000004-9cf4-407f-8900-09a16d33a38c', '00000005-a914-47d5-84d1-8bafbe533ffb'],
        },
      ],
    },
  };
}

function codesOfCommand(
  document: SchematicDocument,
  command: SchematicCommand,
  options = {},
): readonly string[] {
  return codesOf(catchError(() => applySchematicCommand(document, command, options)).diagnostics);
}

describe('applySchematicCommand', () => {
  it('does not mutate the input document', () => {
    const document = makeDocument();
    const snapshot = JSON.stringify(document);
    applySchematicCommand(document, {
      type: 'remove-wire',
      id: '00000004-9cf4-407f-8900-09a16d33a38c',
    });
    expect(JSON.stringify(document)).toBe(snapshot);
  });

  it('adds symbols with generated ids and default rotation', () => {
    const result = applySchematicCommand(makeDocument(), {
      type: 'add-symbol',
      device: 'pkg:c',
      x: 1,
      y: 2,
    });
    const added = result.sheet.symbols.at(-1);
    expect(added).toMatchObject({ device: 'pkg:c', x: 1, y: 2, rotation: 0 });
    expect(added?.id).toMatch(UUID_V4);
    expect(result.sheet.symbols.filter((symbol) => symbol.id === added?.id)).toHaveLength(1);
  });

  it('adds wires and junctions', () => {
    const withWire = applySchematicCommand(makeDocument(), {
      type: 'add-wire',
      points: [
        { x: 20, y: 0 },
        { x: 30, y: 0 },
      ],
    });
    const wireId = withWire.sheet.wires.at(-1)?.id;
    expect(wireId).toMatch(UUID_V4);
    expect([
      '00000004-9cf4-407f-8900-09a16d33a38c',
      '00000005-a914-47d5-84d1-8bafbe533ffb',
    ]).not.toContain(wireId);

    const withJunction = applySchematicCommand(withWire, {
      type: 'add-junction',
      x: 5,
      y: 0,
      wires: ['00000004-9cf4-407f-8900-09a16d33a38c', '00000005-a914-47d5-84d1-8bafbe533ffb'],
    });
    const junctionId = withJunction.sheet.junctions.at(-1)?.id;
    expect(junctionId).toMatch(UUID_V4);
    expect(junctionId).not.toBe('00000001-516c-48ac-8128-07f98c98ee13');
  });

  it('updates and removes symbols, wires and junctions', () => {
    const document = makeDocument();
    const updatedSymbol = applySchematicCommand(document, {
      type: 'update-symbol',
      id: '00000002-41e6-4a4c-869a-82a4cd304787',
      x: 42,
      rotation: 90,
    });
    expect(updatedSymbol.sheet.symbols[0]).toMatchObject({ x: 42, y: 0, rotation: 90 });

    expect(
      applySchematicCommand(document, {
        type: 'remove-symbol',
        id: '00000003-dfe1-4ed9-83d0-30ddf7887781',
      }).sheet.symbols,
    ).toHaveLength(1);
    expect(
      applySchematicCommand(document, {
        type: 'remove-junction',
        id: '00000001-516c-48ac-8128-07f98c98ee13',
      }).sheet.junctions,
    ).toEqual([]);

    const removedWire = applySchematicCommand(document, {
      type: 'remove-wire',
      id: '00000004-9cf4-407f-8900-09a16d33a38c',
    });
    expect(removedWire.sheet.wires.map((wire) => wire.id)).toEqual([
      '00000005-a914-47d5-84d1-8bafbe533ffb',
    ]);
    expect(removedWire.sheet.junctions).toEqual([]);
  });

  it('reports cascaded junction removals through onEffect', () => {
    const effects: EditEffect[] = [];
    applySchematicCommand(
      makeDocument(),
      { type: 'remove-wire', id: '00000004-9cf4-407f-8900-09a16d33a38c' },
      {
        onEffect: (effect) => effects.push(effect),
      },
    );
    expect(effects).toEqual([
      {
        kind: 'junction-removed',
        id: '00000001-516c-48ac-8128-07f98c98ee13',
        reason: 'wire-removed',
      },
    ]);
  });

  it('rejects unknown entities', () => {
    expect(codesOfCommand(makeDocument(), { type: 'remove-wire', id: 'nope' })).toEqual([
      'edit/unknown-entity',
    ]);
    expect(codesOfCommand(makeDocument(), { type: 'remove-symbol', id: 'nope' })).toEqual([
      'edit/unknown-entity',
    ]);
  });

  it('rejects invalid device references', () => {
    expect(
      codesOfCommand(makeDocument(), { type: 'add-symbol', device: 'invalid', x: 0, y: 0 }),
    ).toEqual(['device/invalid-reference']);
  });

  it('rejects wires with fewer than two points', () => {
    expect(codesOfCommand(makeDocument(), { type: 'add-wire', points: [{ x: 0, y: 0 }] })).toEqual([
      'wire/invalid-points',
    ]);
  });

  it('rejects junctions with fewer than two wires', () => {
    expect(
      codesOfCommand(makeDocument(), {
        type: 'add-junction',
        x: 0,
        y: 0,
        wires: ['00000004-9cf4-407f-8900-09a16d33a38c'],
      }),
    ).toEqual(['schema/invalid-value']);
  });

  it('rejects junctions that reference unknown or duplicated wires', () => {
    expect(
      codesOfCommand(makeDocument(), {
        type: 'add-junction',
        x: 0,
        y: 0,
        wires: ['00000004-9cf4-407f-8900-09a16d33a38c', 'nope'],
      }),
    ).toContain('junction/unknown-wire');
    expect(
      codesOfCommand(makeDocument(), {
        type: 'add-junction',
        x: 0,
        y: 0,
        wires: ['00000004-9cf4-407f-8900-09a16d33a38c', '00000004-9cf4-407f-8900-09a16d33a38c'],
      }),
    ).toContain('junction/duplicate-wire');
  });

  it('rejects junctions that do not lie on their wires', () => {
    expect(
      codesOfCommand(makeDocument(), {
        type: 'add-junction',
        x: 50,
        y: 50,
        wires: ['00000004-9cf4-407f-8900-09a16d33a38c', '00000005-a914-47d5-84d1-8bafbe533ffb'],
      }),
    ).toEqual(['junction/off-wire']);
  });

  it('rejects wire geometry changes that detach a junction by default', () => {
    const error = catchError(() =>
      applySchematicCommand(makeDocument(), {
        type: 'set-wire-points',
        id: '00000004-9cf4-407f-8900-09a16d33a38c',
        points: [
          { x: 100, y: 100 },
          { x: 110, y: 100 },
        ],
      }),
    );
    expect(codesOf(error.diagnostics)).toEqual(['junction/off-wire']);
  });

  it('cascades detached junctions when configured', () => {
    const effects: EditEffect[] = [];
    const result = applySchematicCommand(
      makeDocument(),
      {
        type: 'set-wire-points',
        id: '00000004-9cf4-407f-8900-09a16d33a38c',
        points: [
          { x: 100, y: 100 },
          { x: 110, y: 100 },
        ],
      },
      { onJunctionConflict: 'remove', onEffect: (effect) => effects.push(effect) },
    );
    expect(result.sheet.junctions).toEqual([]);
    expect(effects).toEqual([
      {
        kind: 'junction-removed',
        id: '00000001-516c-48ac-8128-07f98c98ee13',
        reason: 'junction-detached',
      },
    ]);
  });

  it('keeps junctions when geometry still contains them', () => {
    const result = applySchematicCommand(makeDocument(), {
      type: 'set-wire-points',
      id: '00000004-9cf4-407f-8900-09a16d33a38c',
      points: [
        { x: -10, y: 0 },
        { x: 20, y: 0 },
      ],
    });
    expect(result.sheet.junctions).toHaveLength(1);
  });

  it('accepts a custom id factory', () => {
    const customId = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
    const result = applySchematicCommand(
      makeDocument(),
      {
        type: 'add-wire',
        points: [
          { x: 0, y: 5 },
          { x: 1, y: 5 },
        ],
      },
      { createId: () => customId },
    );
    expect(result.sheet.wires.at(-1)?.id).toBe(customId);
  });

  it('rejects unsupported commands', () => {
    expect(codesOfCommand(makeDocument(), { type: 'nope' } as unknown as SchematicCommand)).toEqual(
      ['edit/invalid-command'],
    );
  });
});

describe('property declaration checks', () => {
  const devices = createDeviceRegistry([
    {
      packageId: 'pkg',
      devices: [
        {
          id: 'a',
          raw: {
            pins: { P1: { side: 'left' } },
            properties: {
              speed: { type: 'number', default: 72, min: 1, max: 170, unit: 'MHz' },
              cores: { type: 'integer', default: 1, min: 1, max: 2 },
              accent: { type: 'color', default: '#3B82F6' },
              firmware: { type: 'binary', maxBytes: 1024 },
              saved: { type: 'string', nullable: true },
            },
          },
        },
      ],
    },
  ]);
  const options = { devices };

  function documentWithSymbol(): SchematicDocument {
    return {
      version: 1,
      sheet: {
        symbols: [
          { id: '00000002-41e6-4a4c-869a-82a4cd304787', device: 'pkg:a', x: 0, y: 0, rotation: 0 },
        ],
        wires: [],
        junctions: [],
      },
    };
  }

  it('rejects values outside the declared type or range', () => {
    const codes = codesOfCommand(
      documentWithSymbol(),
      {
        type: 'set-symbol-property',
        id: '00000002-41e6-4a4c-869a-82a4cd304787',
        key: 'speed',
        value: 999,
      },
      options,
    );
    expect(codes).toEqual(['schema/invalid-value']);
    expect(
      codesOfCommand(
        documentWithSymbol(),
        {
          type: 'set-symbol-property',
          id: '00000002-41e6-4a4c-869a-82a4cd304787',
          key: 'cores',
          value: 1.5,
        },
        options,
      ),
    ).toEqual(['schema/invalid-type']);
    expect(
      codesOfCommand(
        documentWithSymbol(),
        {
          type: 'set-symbol-property',
          id: '00000002-41e6-4a4c-869a-82a4cd304787',
          key: 'accent',
          value: 'blue',
        },
        options,
      ),
    ).toEqual(['schema/invalid-value']);
  });

  it('accepts values that satisfy the declaration and canonicalizes colors', () => {
    const result = applySchematicCommand(
      documentWithSymbol(),
      {
        type: 'set-symbol-property',
        id: '00000002-41e6-4a4c-869a-82a4cd304787',
        key: 'accent',
        value: '#ff8800',
      },
      options,
    );
    expect(result.sheet.symbols[0]?.properties).toEqual({ accent: '#FF8800' });

    const firmware = applySchematicCommand(
      result,
      {
        type: 'set-symbol-property',
        id: '00000002-41e6-4a4c-869a-82a4cd304787',
        key: 'firmware',
        value: { src: 'assets/fw.bin', mode: 'file' },
      },
      options,
    );
    expect(firmware.sheet.symbols[0]?.properties).toMatchObject({
      firmware: { src: 'assets/fw.bin', mode: 'file' },
    });

    const cleared = applySchematicCommand(
      firmware,
      {
        type: 'set-symbol-property',
        id: '00000002-41e6-4a4c-869a-82a4cd304787',
        key: 'saved',
        value: null,
      },
      options,
    );
    expect(cleared.sheet.symbols[0]?.properties).toMatchObject({ saved: null });
  });

  it('checks properties passed to add-symbol', () => {
    expect(
      codesOfCommand(
        documentWithSymbol(),
        { type: 'add-symbol', device: 'pkg:a', x: 0, y: 0, properties: { cores: 5 } },
        options,
      ),
    ).toEqual(['schema/invalid-value']);
  });
});
