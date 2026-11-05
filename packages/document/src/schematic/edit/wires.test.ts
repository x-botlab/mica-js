import { describe, expect, it } from 'vitest';
import type { SchematicDocument } from '../../format/types';
import { catchError, codesOf } from '../../format/test-helpers';
import { mergeWiresAtJunction, splitWireAt } from './wires';

function makeDocument(): SchematicDocument {
  return {
    version: 1,
    sheet: {
      symbols: [],
      wires: [
        {
          id: '00000005-9cf4-407f-8900-09a16d33a38c',
          points: [
            { x: 0, y: 0 },
            { x: 10, y: 0 },
            { x: 10, y: 10 },
          ],
        },
        {
          id: '00000006-a914-47d5-84d1-8bafbe533ffb',
          points: [
            { x: 5, y: 0 },
            { x: 5, y: 5 },
          ],
        },
      ],
      junctions: [
        {
          id: '00000004-516c-48ac-8128-07f98c98ee13',
          x: 5,
          y: 0,
          wires: ['00000005-9cf4-407f-8900-09a16d33a38c', '00000006-a914-47d5-84d1-8bafbe533ffb'],
        },
      ],
    },
  };
}

describe('splitWireAt', () => {
  it('splits a wire and keeps the original id on the first half', () => {
    const result = splitWireAt(makeDocument(), '00000005-9cf4-407f-8900-09a16d33a38c', {
      x: 10,
      y: 5,
    });
    expect(result.firstWireId).toBe('00000005-9cf4-407f-8900-09a16d33a38c');
    expect(result.secondWireId).not.toBe('00000005-9cf4-407f-8900-09a16d33a38c');
    const first = result.document.sheet.wires.find(
      (wire) => wire.id === '00000005-9cf4-407f-8900-09a16d33a38c',
    );
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
      sheet: {
        symbols: [],
        wires: [
          {
            id: '00000005-9cf4-407f-8900-09a16d33a38c',
            points: [
              { x: 0, y: 0 },
              { x: 10, y: 0 },
              { x: 10, y: 10 },
            ],
          },
          {
            id: '00000006-a914-47d5-84d1-8bafbe533ffb',
            points: [
              { x: 10, y: 5 },
              { x: 15, y: 5 },
            ],
          },
        ],
        junctions: [
          {
            id: '00000004-516c-48ac-8128-07f98c98ee13',
            x: 10,
            y: 5,
            wires: ['00000005-9cf4-407f-8900-09a16d33a38c', '00000006-a914-47d5-84d1-8bafbe533ffb'],
          },
        ],
      },
    };
    const result = splitWireAt(document, '00000005-9cf4-407f-8900-09a16d33a38c', { x: 10, y: 2 });
    const junction = result.document.sheet.junctions.find(
      (item) => item.id === '00000004-516c-48ac-8128-07f98c98ee13',
    );
    expect(junction?.wires).toEqual([result.secondWireId, '00000006-a914-47d5-84d1-8bafbe533ffb']);
  });

  it('keeps junctions that lie on the first half', () => {
    const result = splitWireAt(makeDocument(), '00000005-9cf4-407f-8900-09a16d33a38c', {
      x: 10,
      y: 8,
    });
    const junction = result.document.sheet.junctions.find(
      (item) => item.id === '00000004-516c-48ac-8128-07f98c98ee13',
    );
    expect(junction?.wires).toEqual([
      '00000005-9cf4-407f-8900-09a16d33a38c',
      '00000006-a914-47d5-84d1-8bafbe533ffb',
    ]);
  });

  it('connects both halves when the junction sits exactly on the split point', () => {
    const result = splitWireAt(makeDocument(), '00000005-9cf4-407f-8900-09a16d33a38c', {
      x: 5,
      y: 0,
    });
    const junction = result.document.sheet.junctions.find(
      (item) => item.id === '00000004-516c-48ac-8128-07f98c98ee13',
    );
    expect(junction?.wires).toEqual([
      '00000005-9cf4-407f-8900-09a16d33a38c',
      result.secondWireId,
      '00000006-a914-47d5-84d1-8bafbe533ffb',
    ]);
  });

  it('rejects unknown wires and non-interior points', () => {
    expect(
      codesOf(catchError(() => splitWireAt(makeDocument(), 'nope', { x: 0, y: 0 })).diagnostics),
    ).toEqual(['edit/unknown-entity']);
    expect(
      codesOf(
        catchError(() =>
          splitWireAt(makeDocument(), '00000005-9cf4-407f-8900-09a16d33a38c', { x: 0, y: 0 }),
        ).diagnostics,
      ),
    ).toEqual(['wire/invalid-points']);
    expect(
      codesOf(
        catchError(() =>
          splitWireAt(makeDocument(), '00000005-9cf4-407f-8900-09a16d33a38c', { x: 50, y: 50 }),
        ).diagnostics,
      ),
    ).toEqual(['wire/invalid-points']);
  });

  it('round-trips with mergeWiresAtJunction', () => {
    const junctionId = '00000004-516c-48ac-8128-07f98c98ee13';
    const before = makeDocument();
    const split = splitWireAt(before, '00000005-9cf4-407f-8900-09a16d33a38c', { x: 10, y: 5 });
    const splitJunction = split.document.sheet.junctions.find((item) => item.id === junctionId);
    expect(splitJunction).toBeDefined();

    const merged = mergeWiresAtJunction(split.document, '00000004-516c-48ac-8128-07f98c98ee13');
    expect(merged).toBeUndefined();

    const newJunction = split.document.sheet.junctions[0];
    expect(newJunction?.id).toBe('00000004-516c-48ac-8128-07f98c98ee13');
  });
});

describe('mergeWiresAtJunction', () => {
  function splitDocument(): SchematicDocument {
    const split = splitWireAt(
      {
        version: 1,
        sheet: {
          symbols: [],
          wires: [
            {
              id: '00000005-9cf4-407f-8900-09a16d33a38c',
              points: [
                { x: 0, y: 0 },
                { x: 10, y: 0 },
              ],
            },
          ],
          junctions: [],
        },
      },
      '00000005-9cf4-407f-8900-09a16d33a38c',
      { x: 5, y: 0 },
    );
    return {
      ...split.document,
      sheet: {
        ...split.document.sheet,
        junctions: [
          {
            id: '00000004-516c-48ac-8128-07f98c98ee13',
            x: 5,
            y: 0,
            wires: [split.firstWireId, split.secondWireId],
          },
        ],
      },
    };
  }

  it('merges two collinear halves back into one wire', () => {
    const document = splitDocument();
    const result = mergeWiresAtJunction(document, '00000004-516c-48ac-8128-07f98c98ee13');
    expect(result?.wireId).toBe('00000005-9cf4-407f-8900-09a16d33a38c');
    expect(result?.document.sheet.junctions).toEqual([]);
    expect(result?.document.sheet.wires).toEqual([
      {
        id: '00000005-9cf4-407f-8900-09a16d33a38c',
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
    const result = mergeWiresAtJunction(reversed, '00000004-516c-48ac-8128-07f98c98ee13');
    expect(result?.document.sheet.wires[0]?.points).toEqual([
      { x: 0, y: 0 },
      { x: 5, y: 0 },
      { x: 10, y: 0 },
    ]);
  });

  it('does not merge non-collinear wires', () => {
    const document: SchematicDocument = {
      version: 1,
      sheet: {
        symbols: [],
        wires: [
          {
            id: '00000001-faa5-47fc-815d-1ddcb9eaeaea',
            points: [
              { x: 0, y: 0 },
              { x: 5, y: 0 },
            ],
          },
          {
            id: '00000002-e7c9-4d6d-89e9-2ffdad17b8bd',
            points: [
              { x: 5, y: 0 },
              { x: 5, y: 5 },
            ],
          },
        ],
        junctions: [
          {
            id: '00000003-dde9-4088-81be-f0894fe7b22a',
            x: 5,
            y: 0,
            wires: ['00000001-faa5-47fc-815d-1ddcb9eaeaea', '00000002-e7c9-4d6d-89e9-2ffdad17b8bd'],
          },
        ],
      },
    };
    expect(mergeWiresAtJunction(document, '00000003-dde9-4088-81be-f0894fe7b22a')).toBeUndefined();
  });

  it('ignores junctions with more than two wires', () => {
    const document = makeDocument();
    expect(mergeWiresAtJunction(document, '00000004-516c-48ac-8128-07f98c98ee13')).toBeUndefined();
  });

  it('rejects unknown junctions', () => {
    expect(
      codesOf(catchError(() => mergeWiresAtJunction(makeDocument(), 'nope')).diagnostics),
    ).toEqual(['edit/unknown-entity']);
  });
});
