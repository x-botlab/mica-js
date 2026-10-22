import { describe, expect, it } from 'vitest';
import { catchError, codesOf } from '../format/test-helpers';
import type { SchematicDocument } from '../format/types';
import { applyCanvasCommand } from './edit';
import type { CanvasDocument } from './format/types';

const schematic: SchematicDocument = {
  version: 1,
  sheet: {
    symbols: [{ id: 's1', device: 'pkg:a', x: 0, y: 0, rotation: 0 }],
    wires: [],
    junctions: [],
  },
};

function makeCanvas(): CanvasDocument {
  return {
    version: 1,
    id: 'c',
    schematic: 'schematic.sch',
    layout: { s1: { x: 10, y: 20, rotation: 0 } },
  };
}

function codesOfCanvas(
  canvas: CanvasDocument,
  command: Parameters<typeof applyCanvasCommand>[1],
  options = {},
): readonly string[] {
  return codesOf(catchError(() => applyCanvasCommand(canvas, command, options)).diagnostics);
}

describe('applyCanvasCommand', () => {
  it('sets and preserves placement rotation', () => {
    const moved = applyCanvasCommand(makeCanvas(), {
      type: 'set-placement',
      symbolId: 's1',
      x: 1,
      y: 2,
      rotation: 90,
    });
    expect(moved.layout['s1']).toEqual({ x: 1, y: 2, rotation: 90 });

    const kept = applyCanvasCommand(moved, { type: 'set-placement', symbolId: 's1', x: 3, y: 4 });
    expect(kept.layout['s1']).toEqual({ x: 3, y: 4, rotation: 90 });
  });

  it('creates placements for symbols that had none', () => {
    const canvas = applyCanvasCommand(makeCanvas(), {
      type: 'set-placement',
      symbolId: 's1',
      x: 5,
      y: 6,
    });
    expect(canvas.layout['s1']).toEqual({ x: 5, y: 6, rotation: 0 });
  });

  it('does not mutate the input canvas', () => {
    const canvas = makeCanvas();
    const snapshot = JSON.stringify(canvas);
    applyCanvasCommand(canvas, { type: 'remove-placement', symbolId: 's1' });
    expect(JSON.stringify(canvas)).toBe(snapshot);
  });

  it('removes placements', () => {
    expect(
      applyCanvasCommand(makeCanvas(), { type: 'remove-placement', symbolId: 's1' }).layout,
    ).toEqual({});
    expect(codesOfCanvas(makeCanvas(), { type: 'remove-placement', symbolId: 'nope' })).toEqual([
      'edit/unknown-entity',
    ]);
  });

  it('binds another schematic file', () => {
    expect(
      applyCanvasCommand(makeCanvas(), { type: 'bind-schematic', schematic: 'other.sch' })
        .schematic,
    ).toBe('other.sch');
    expect(codesOfCanvas(makeCanvas(), { type: 'bind-schematic', schematic: '' })).toEqual([
      'schema/invalid-value',
    ]);
  });

  it('validates symbol ids against the bound schematic', () => {
    expect(
      codesOfCanvas(
        makeCanvas(),
        { type: 'set-placement', symbolId: 'missing', x: 0, y: 0 },
        { schematic },
      ),
    ).toEqual(['canvas/unknown-symbol']);
    expect(
      applyCanvasCommand(
        makeCanvas(),
        { type: 'set-placement', symbolId: 's1', x: 0, y: 0 },
        { schematic },
      ).layout['s1'],
    ).toEqual({ x: 0, y: 0, rotation: 0 });
  });

  it('rejects empty symbol ids and unsupported commands', () => {
    expect(
      codesOfCanvas(makeCanvas(), { type: 'set-placement', symbolId: '', x: 0, y: 0 }),
    ).toEqual(['schema/invalid-value']);
    expect(
      codesOfCanvas(makeCanvas(), { type: 'nope' } as unknown as Parameters<
        typeof applyCanvasCommand
      >[1]),
    ).toEqual(['edit/invalid-command']);
  });
});
