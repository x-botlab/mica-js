import { describe, expect, it } from 'vitest';
import type { SchematicDocument } from '../../format/types';
import { joinJunctionAt, planJunctionRelease } from './junctions';

function documentOf(sheet: {
  wires?: readonly unknown[];
  junctions?: readonly unknown[];
}): SchematicDocument {
  return {
    version: 1,
    sheet: { symbols: [], wires: sheet.wires ?? [], junctions: sheet.junctions ?? [] },
  } as SchematicDocument;
}

const DOCUMENT = documentOf({
  wires: [
    {
      id: '00000003-9cf4-407f-8900-09a16d33a38c',
      points: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ],
    },
    {
      id: '00000004-a914-47d5-84d1-8bafbe533ffb',
      points: [
        { x: 10, y: 0 },
        { x: 10, y: 10 },
      ],
    },
  ],
  junctions: [
    {
      id: '00000001-516c-48ac-8128-07f98c98ee13',
      x: 10,
      y: 0,
      wires: ['00000003-9cf4-407f-8900-09a16d33a38c', '00000004-a914-47d5-84d1-8bafbe533ffb'],
    },
    {
      id: '00000002-ed34-4df4-8117-b46a9780568a',
      x: 20,
      y: 0,
      wires: ['00000003-9cf4-407f-8900-09a16d33a38c', '00000004-a914-47d5-84d1-8bafbe533ffb'],
    },
  ],
});

describe('joinJunctionAt', () => {
  it('adds a wire that ends on an existing junction', () => {
    expect(
      joinJunctionAt(DOCUMENT, '00000005-f25c-4a8c-8be1-1c60e8fb777f', { x: 10, y: 0 }),
    ).toEqual({
      id: '00000001-516c-48ac-8128-07f98c98ee13',
      wires: [
        '00000003-9cf4-407f-8900-09a16d33a38c',
        '00000004-a914-47d5-84d1-8bafbe533ffb',
        '00000005-f25c-4a8c-8be1-1c60e8fb777f',
      ],
    });
  });

  it('ignores points without a junction and wires already joined', () => {
    expect(
      joinJunctionAt(DOCUMENT, '00000005-f25c-4a8c-8be1-1c60e8fb777f', { x: 30, y: 0 }),
    ).toBeUndefined();
    expect(
      joinJunctionAt(DOCUMENT, '00000003-9cf4-407f-8900-09a16d33a38c', { x: 10, y: 0 }),
    ).toBeUndefined();
  });
});

describe('planJunctionRelease', () => {
  it('drops the wire from junctions it no longer touches', () => {
    expect(
      planJunctionRelease(DOCUMENT, '00000003-9cf4-407f-8900-09a16d33a38c', [
        { x: 0, y: 0 },
        { x: 0, y: 10 },
      ]),
    ).toEqual([
      { id: '00000001-516c-48ac-8128-07f98c98ee13', wires: undefined },
      { id: '00000002-ed34-4df4-8117-b46a9780568a', wires: undefined },
    ]);
  });

  it('keeps junctions that still lie on the new geometry', () => {
    expect(
      planJunctionRelease(DOCUMENT, '00000003-9cf4-407f-8900-09a16d33a38c', [
        { x: 0, y: 10 },
        { x: 10, y: 10 },
        { x: 10, y: 0 },
      ]),
    ).toEqual([{ id: '00000002-ed34-4df4-8117-b46a9780568a', wires: undefined }]);
  });

  it('removes a junction that would keep fewer than two wires', () => {
    const document = documentOf({
      wires: DOCUMENT.sheet.wires,
      junctions: [
        {
          id: '00000001-516c-48ac-8128-07f98c98ee13',
          x: 10,
          y: 0,
          wires: ['00000003-9cf4-407f-8900-09a16d33a38c'],
        },
      ],
    });
    expect(
      planJunctionRelease(document, '00000003-9cf4-407f-8900-09a16d33a38c', [{ x: 0, y: 5 }]),
    ).toEqual([{ id: '00000001-516c-48ac-8128-07f98c98ee13', wires: undefined }]);
  });
});
