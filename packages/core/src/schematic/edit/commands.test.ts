import { describe, expect, it } from 'vitest';
import { applySchematicCommand, type SchematicCommand } from './commands';
import type { EditEffect } from './commands';
import type { SchematicDocument } from '../format/types';
import { catchError, codesOf } from '../format/test-helpers';

/** Ids are generated as UUID v4 so they never collide with user-facing names. */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function makeDocument(): SchematicDocument {
  return {
    version: 1,
    id: 'board',
    sheet: {
      symbols: [
        { id: 's1', device: 'pkg:a', x: 0, y: 0, rotation: 0 },
        { id: 's2', device: 'pkg:b', x: 100, y: 0, rotation: 0 },
      ],
      wires: [
        {
          id: 'w1',
          points: [
            { x: 0, y: 0 },
            { x: 10, y: 0 },
          ],
        },
        {
          id: 'w2',
          points: [
            { x: 5, y: 0 },
            { x: 5, y: 10 },
          ],
        },
      ],
      junctions: [{ id: 'j1', x: 5, y: 0, wires: ['w1', 'w2'] }],
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
    applySchematicCommand(document, { type: 'remove-wire', id: 'w1' });
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
    expect(['w1', 'w2']).not.toContain(wireId);

    const withJunction = applySchematicCommand(withWire, {
      type: 'add-junction',
      x: 5,
      y: 0,
      wires: ['w1', 'w2'],
    });
    const junctionId = withJunction.sheet.junctions.at(-1)?.id;
    expect(junctionId).toMatch(UUID_V4);
    expect(junctionId).not.toBe('j1');
  });

  it('updates and removes symbols, wires and junctions', () => {
    const document = makeDocument();
    const updatedSymbol = applySchematicCommand(document, {
      type: 'update-symbol',
      id: 's1',
      x: 42,
      rotation: 90,
    });
    expect(updatedSymbol.sheet.symbols[0]).toMatchObject({ x: 42, y: 0, rotation: 90 });

    expect(
      applySchematicCommand(document, { type: 'remove-symbol', id: 's2' }).sheet.symbols,
    ).toHaveLength(1);
    expect(
      applySchematicCommand(document, { type: 'remove-junction', id: 'j1' }).sheet.junctions,
    ).toEqual([]);

    const removedWire = applySchematicCommand(document, { type: 'remove-wire', id: 'w1' });
    expect(removedWire.sheet.wires.map((wire) => wire.id)).toEqual(['w2']);
    expect(removedWire.sheet.junctions).toEqual([]);
  });

  it('reports cascaded junction removals through onEffect', () => {
    const effects: EditEffect[] = [];
    applySchematicCommand(
      makeDocument(),
      { type: 'remove-wire', id: 'w1' },
      {
        onEffect: (effect) => effects.push(effect),
      },
    );
    expect(effects).toEqual([{ kind: 'junction-removed', id: 'j1', reason: 'wire-removed' }]);
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
      codesOfCommand(makeDocument(), { type: 'add-junction', x: 0, y: 0, wires: ['w1'] }),
    ).toEqual(['schema/invalid-value']);
  });

  it('rejects junctions that reference unknown or duplicated wires', () => {
    expect(
      codesOfCommand(makeDocument(), { type: 'add-junction', x: 0, y: 0, wires: ['w1', 'nope'] }),
    ).toContain('junction/unknown-wire');
    expect(
      codesOfCommand(makeDocument(), { type: 'add-junction', x: 0, y: 0, wires: ['w1', 'w1'] }),
    ).toContain('junction/duplicate-wire');
  });

  it('rejects junctions that do not lie on their wires', () => {
    expect(
      codesOfCommand(makeDocument(), { type: 'add-junction', x: 50, y: 50, wires: ['w1', 'w2'] }),
    ).toEqual(['junction/off-wire']);
  });

  it('rejects wire geometry changes that detach a junction by default', () => {
    const error = catchError(() =>
      applySchematicCommand(makeDocument(), {
        type: 'set-wire-points',
        id: 'w1',
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
        id: 'w1',
        points: [
          { x: 100, y: 100 },
          { x: 110, y: 100 },
        ],
      },
      { onJunctionConflict: 'remove', onEffect: (effect) => effects.push(effect) },
    );
    expect(result.sheet.junctions).toEqual([]);
    expect(effects).toEqual([{ kind: 'junction-removed', id: 'j1', reason: 'junction-detached' }]);
  });

  it('keeps junctions when geometry still contains them', () => {
    const result = applySchematicCommand(makeDocument(), {
      type: 'set-wire-points',
      id: 'w1',
      points: [
        { x: -10, y: 0 },
        { x: 20, y: 0 },
      ],
    });
    expect(result.sheet.junctions).toHaveLength(1);
  });

  it('accepts a custom id factory', () => {
    const result = applySchematicCommand(
      makeDocument(),
      {
        type: 'add-wire',
        points: [
          { x: 0, y: 5 },
          { x: 1, y: 5 },
        ],
      },
      { createId: (kind) => `${kind}-custom` },
    );
    expect(result.sheet.wires.at(-1)?.id).toBe('wire-custom');
  });

  it('rejects unsupported commands', () => {
    expect(codesOfCommand(makeDocument(), { type: 'nope' } as unknown as SchematicCommand)).toEqual(
      ['edit/invalid-command'],
    );
  });
});
