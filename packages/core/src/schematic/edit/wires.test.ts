import { describe, expect, it } from 'vitest';
import type { SchematicDocument } from '../format/types';
import { catchError, codesOf } from '../format/test-helpers';
import { mergeWiresAtJunction, splitWireAt } from './wires';

function makeDocument(): SchematicDocument {
  return {
    version: 1,
    id: 'wires',
    sheet: {
      symbols: [],
      wires: [
        {
          id: 'w1',
          points: [
            { x: 0, y: 0 },
            { x: 10, y: 0 },
            { x: 10, y: 10 },
          ],
        },
        {
          id: 'w2',
          points: [
            { x: 5, y: 0 },
            { x: 5, y: 5 },
          ],
        },
      ],
      junctions: [{ id: 'j1', x: 5, y: 0, wires: ['w1', 'w2'] }],
    },
  };
}

describe('splitWireAt', () => {
  it('splits a wire and keeps the original id on the first half', () => {
    const result = splitWireAt(makeDocument(), 'w1', { x: 10, y: 5 });
    expect(result.firstWireId).toBe('w1');
    expect(result.secondWireId).not.toBe('w1');
    const first = result.document.sheet.wires.find((wire) => wire.id === 'w1');
    const second = result.document.sheet.wires.find((wire) => wire.id === result.secondWireId);
    expect(first?.points).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 5 },
    ]);
    expect(second?.points).toEqual([
      { x: 10, y: 5 },
      { x: 10, y: 10 },
    ]);
  });

  it('re-points junctions that only lie on the second half', () => {
    const document: SchematicDocument = {
      version: 1,
      id: 'split',
      sheet: {
        symbols: [],
        wires: [
          {
            id: 'w1',
            points: [
              { x: 0, y: 0 },
              { x: 10, y: 0 },
              { x: 10, y: 10 },
            ],
          },
          {
            id: 'w2',
            points: [
              { x: 10, y: 5 },
              { x: 15, y: 5 },
            ],
          },
        ],
        junctions: [{ id: 'j1', x: 10, y: 5, wires: ['w1', 'w2'] }],
      },
    };
    const result = splitWireAt(document, 'w1', { x: 10, y: 2 });
    const junction = result.document.sheet.junctions.find((item) => item.id === 'j1');
    expect(junction?.wires).toEqual([result.secondWireId, 'w2']);
  });

  it('keeps junctions that lie on the first half', () => {
    const result = splitWireAt(makeDocument(), 'w1', { x: 10, y: 8 });
    const junction = result.document.sheet.junctions.find((item) => item.id === 'j1');
    expect(junction?.wires).toEqual(['w1', 'w2']);
  });

  it('connects both halves when the junction sits exactly on the split point', () => {
    const result = splitWireAt(makeDocument(), 'w1', { x: 5, y: 0 });
    const junction = result.document.sheet.junctions.find((item) => item.id === 'j1');
    expect(junction?.wires).toEqual(['w1', result.secondWireId, 'w2']);
  });

  it('rejects unknown wires and non-interior points', () => {
    expect(
      codesOf(catchError(() => splitWireAt(makeDocument(), 'nope', { x: 0, y: 0 })).diagnostics),
    ).toEqual(['edit/unknown-entity']);
    expect(
      codesOf(catchError(() => splitWireAt(makeDocument(), 'w1', { x: 0, y: 0 })).diagnostics),
    ).toEqual(['wire/invalid-points']);
    expect(
      codesOf(catchError(() => splitWireAt(makeDocument(), 'w1', { x: 50, y: 50 })).diagnostics),
    ).toEqual(['wire/invalid-points']);
  });

  it('round-trips with mergeWiresAtJunction', () => {
    const junctionId = 'j1';
    const before = makeDocument();
    const split = splitWireAt(before, 'w1', { x: 10, y: 5 });
    const splitJunction = split.document.sheet.junctions.find((item) => item.id === junctionId);
    expect(splitJunction).toBeDefined();

    const merged = mergeWiresAtJunction(split.document, 'j1');
    expect(merged).toBeUndefined();

    const newJunction = split.document.sheet.junctions[0];
    expect(newJunction?.id).toBe('j1');
  });
});

describe('mergeWiresAtJunction', () => {
  function splitDocument(): SchematicDocument {
    const split = splitWireAt(
      {
        version: 1,
        id: 'merge',
        sheet: {
          symbols: [],
          wires: [
            {
              id: 'w1',
              points: [
                { x: 0, y: 0 },
                { x: 10, y: 0 },
              ],
            },
          ],
          junctions: [],
        },
      },
      'w1',
      { x: 5, y: 0 },
    );
    return {
      ...split.document,
      sheet: {
        ...split.document.sheet,
        junctions: [{ id: 'j1', x: 5, y: 0, wires: [split.firstWireId, split.secondWireId] }],
      },
    };
  }

  it('merges two collinear halves back into one wire', () => {
    const document = splitDocument();
    const result = mergeWiresAtJunction(document, 'j1');
    expect(result?.wireId).toBe('w1');
    expect(result?.document.sheet.junctions).toEqual([]);
    expect(result?.document.sheet.wires).toEqual([
      {
        id: 'w1',
        points: [
          { x: 0, y: 0 },
          { x: 5, y: 0 },
          { x: 10, y: 0 },
        ],
      },
    ]);
  });

  it('merges reversed orientation', () => {
    const document = splitDocument();
    const [, second] = document.sheet.wires;
    if (second === undefined) {
      throw new Error('expected a split wire');
    }
    const reversed: SchematicDocument = {
      ...document,
      sheet: {
        ...document.sheet,
        wires: [document.sheet.wires[0]!, { id: second.id, points: [...second.points].reverse() }],
      },
    };
    const result = mergeWiresAtJunction(reversed, 'j1');
    expect(result?.document.sheet.wires[0]?.points).toEqual([
      { x: 0, y: 0 },
      { x: 5, y: 0 },
      { x: 10, y: 0 },
    ]);
  });

  it('does not merge non-collinear wires', () => {
    const document: SchematicDocument = {
      version: 1,
      id: 'bend',
      sheet: {
        symbols: [],
        wires: [
          {
            id: 'a',
            points: [
              { x: 0, y: 0 },
              { x: 5, y: 0 },
            ],
          },
          {
            id: 'b',
            points: [
              { x: 5, y: 0 },
              { x: 5, y: 5 },
            ],
          },
        ],
        junctions: [{ id: 'j', x: 5, y: 0, wires: ['a', 'b'] }],
      },
    };
    expect(mergeWiresAtJunction(document, 'j')).toBeUndefined();
  });

  it('ignores junctions with more than two wires', () => {
    const document = makeDocument();
    expect(mergeWiresAtJunction(document, 'j1')).toBeUndefined();
  });

  it('rejects unknown junctions', () => {
    expect(
      codesOf(catchError(() => mergeWiresAtJunction(makeDocument(), 'nope')).diagnostics),
    ).toEqual(['edit/unknown-entity']);
  });
});
