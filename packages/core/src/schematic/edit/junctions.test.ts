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
      id: 'w1',
      points: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ],
    },
    {
      id: 'w2',
      points: [
        { x: 10, y: 0 },
        { x: 10, y: 10 },
      ],
    },
  ],
  junctions: [
    { id: 'j1', x: 10, y: 0, wires: ['w1', 'w2'] },
    { id: 'j2', x: 20, y: 0, wires: ['w1', 'w2'] },
  ],
});

describe('joinJunctionAt', () => {
  it('adds a wire that ends on an existing junction', () => {
    expect(joinJunctionAt(DOCUMENT, 'w3', { x: 10, y: 0 })).toEqual({
      id: 'j1',
      wires: ['w1', 'w2', 'w3'],
    });
  });

  it('ignores points without a junction and wires already joined', () => {
    expect(joinJunctionAt(DOCUMENT, 'w3', { x: 30, y: 0 })).toBeUndefined();
    expect(joinJunctionAt(DOCUMENT, 'w1', { x: 10, y: 0 })).toBeUndefined();
  });
});

describe('planJunctionRelease', () => {
  it('drops the wire from junctions it no longer touches', () => {
    expect(
      planJunctionRelease(DOCUMENT, 'w1', [
        { x: 0, y: 0 },
        { x: 0, y: 10 },
      ]),
    ).toEqual([
      { id: 'j1', wires: undefined },
      { id: 'j2', wires: undefined },
    ]);
  });

  it('keeps junctions that still lie on the new geometry', () => {
    expect(
      planJunctionRelease(DOCUMENT, 'w1', [
        { x: 0, y: 10 },
        { x: 10, y: 10 },
        { x: 10, y: 0 },
      ]),
    ).toEqual([{ id: 'j2', wires: undefined }]);
  });

  it('removes a junction that would keep fewer than two wires', () => {
    const document = documentOf({
      wires: DOCUMENT.sheet.wires,
      junctions: [{ id: 'j1', x: 10, y: 0, wires: ['w1'] }],
    });
    expect(planJunctionRelease(document, 'w1', [{ x: 0, y: 5 }])).toEqual([
      { id: 'j1', wires: undefined },
    ]);
  });
});
