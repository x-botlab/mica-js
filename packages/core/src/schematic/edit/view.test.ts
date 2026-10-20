import { describe, expect, it } from 'vitest';
import type { SchematicDocument, SchematicViewDocument } from '../format/types';
import { catchError, codesOf } from '../format/test-helpers';
import { applyViewCommand } from './view';

const schematic: SchematicDocument = {
  version: 1,
  id: 'board',
  sheet: {
    symbols: [{ id: 's1', device: 'pkg:a', x: 0, y: 0, rotation: 0 }],
    wires: [],
    junctions: [],
  },
};

function makeView(): SchematicViewDocument {
  return {
    version: 1,
    id: 'view',
    schematic: 'schematic.sch',
    layout: { s1: { x: 10, y: 20, rotation: 0 } },
  };
}

function codesOfView(
  view: SchematicViewDocument,
  command: Parameters<typeof applyViewCommand>[1],
  options = {},
): readonly string[] {
  return codesOf(catchError(() => applyViewCommand(view, command, options)).diagnostics);
}

describe('applyViewCommand', () => {
  it('sets and preserves placement rotation', () => {
    const moved = applyViewCommand(makeView(), {
      type: 'set-placement',
      symbolId: 's1',
      x: 1,
      y: 2,
      rotation: 90,
    });
    expect(moved.layout['s1']).toEqual({ x: 1, y: 2, rotation: 90 });

    const kept = applyViewCommand(moved, { type: 'set-placement', symbolId: 's1', x: 3, y: 4 });
    expect(kept.layout['s1']).toEqual({ x: 3, y: 4, rotation: 90 });
  });

  it('creates placements for symbols that had none', () => {
    const view = applyViewCommand(makeView(), {
      type: 'set-placement',
      symbolId: 's1',
      x: 5,
      y: 6,
    });
    expect(view.layout['s1']).toEqual({ x: 5, y: 6, rotation: 0 });
  });

  it('does not mutate the input view', () => {
    const view = makeView();
    const snapshot = JSON.stringify(view);
    applyViewCommand(view, { type: 'remove-placement', symbolId: 's1' });
    expect(JSON.stringify(view)).toBe(snapshot);
  });

  it('removes placements', () => {
    expect(
      applyViewCommand(makeView(), { type: 'remove-placement', symbolId: 's1' }).layout,
    ).toEqual({});
    expect(codesOfView(makeView(), { type: 'remove-placement', symbolId: 'nope' })).toEqual([
      'edit/unknown-entity',
    ]);
  });

  it('binds another schematic file', () => {
    expect(
      applyViewCommand(makeView(), { type: 'bind-schematic', schematic: 'other.sch' }).schematic,
    ).toBe('other.sch');
    expect(codesOfView(makeView(), { type: 'bind-schematic', schematic: '' })).toEqual([
      'schema/invalid-value',
    ]);
  });

  it('validates symbol ids against the bound schematic', () => {
    expect(
      codesOfView(
        makeView(),
        { type: 'set-placement', symbolId: 'missing', x: 0, y: 0 },
        { schematic },
      ),
    ).toEqual(['view/unknown-symbol']);
    expect(
      applyViewCommand(
        makeView(),
        { type: 'set-placement', symbolId: 's1', x: 0, y: 0 },
        { schematic },
      ).layout['s1'],
    ).toEqual({ x: 0, y: 0, rotation: 0 });
  });

  it('rejects empty symbol ids and unsupported commands', () => {
    expect(codesOfView(makeView(), { type: 'set-placement', symbolId: '', x: 0, y: 0 })).toEqual([
      'schema/invalid-value',
    ]);
    expect(
      codesOfView(makeView(), { type: 'nope' } as unknown as Parameters<
        typeof applyViewCommand
      >[1]),
    ).toEqual(['edit/invalid-command']);
  });
});
