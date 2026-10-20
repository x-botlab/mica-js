import { describe, expect, it } from 'vitest';
import { createDeviceRegistry } from '../device/registry';
import type { SchematicDocument } from '../format/types';
import { findJunctionCandidates, hitTestSchematic } from './query';

const devices = createDeviceRegistry([
  {
    packageId: 'pkg',
    devices: [
      {
        id: 'chip',
        symbol: {
          name: 'Chip',
          pins: { A: { x: 0, y: 0 }, B: { x: 10, y: 0 } },
          bounds: { x: -5, y: -5, width: 20, height: 10 },
        },
      },
    ],
  },
]);

function makeDocument(overrides: Partial<SchematicDocument['sheet']> = {}): SchematicDocument {
  return {
    version: 1,
    id: 'hit',
    sheet: {
      symbols: [{ id: 's1', device: 'pkg:chip', x: 100, y: 100, rotation: 0 }],
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
            { x: 5, y: -5 },
            { x: 5, y: 5 },
          ],
        },
      ],
      junctions: [{ id: 'j1', x: 5, y: 0, wires: ['w1', 'w2'] }],
      ...overrides,
    },
  };
}

describe('hitTestSchematic', () => {
  it('prefers junctions over everything else', () => {
    expect(hitTestSchematic(makeDocument(), { x: 5, y: 0 }, { devices })).toEqual({
      kind: 'junction',
      id: 'j1',
    });
  });

  it('finds pins before wires', () => {
    const document = makeDocument({
      symbols: [{ id: 's1', device: 'pkg:chip', x: 0, y: 0, rotation: 0 }],
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
    });
    expect(hitTestSchematic(document, { x: 0, y: 0 }, { devices })).toEqual({
      kind: 'pin',
      symbolId: 's1',
      pinId: 'A',
    });
  });

  it('reports the wire segment index', () => {
    expect(hitTestSchematic(makeDocument(), { x: 10, y: 5 }, { devices })).toEqual({
      kind: 'wire',
      id: 'w1',
      segment: 1,
    });
  });

  it('finds symbol bodies', () => {
    expect(hitTestSchematic(makeDocument(), { x: 105, y: 103 }, { devices })).toEqual({
      kind: 'symbol',
      id: 's1',
    });
  });

  it('can skip symbol bodies', () => {
    expect(
      hitTestSchematic(makeDocument(), { x: 105, y: 103 }, { devices, includeSymbols: false }),
    ).toBeUndefined();
  });

  it('returns undefined when nothing is hit', () => {
    expect(hitTestSchematic(makeDocument(), { x: -40, y: -40 }, { devices })).toBeUndefined();
  });

  it('honours tolerance', () => {
    expect(hitTestSchematic(makeDocument(), { x: 10.4, y: 5 }, { devices })).toBeUndefined();
    expect(
      hitTestSchematic(makeDocument(), { x: 10.4, y: 5 }, { devices, tolerance: 0.5 }),
    ).toEqual({
      kind: 'wire',
      id: 'w1',
      segment: 1,
    });
  });

  it('falls back to the symbol origin without device geometry', () => {
    expect(hitTestSchematic(makeDocument(), { x: 100, y: 100 })).toEqual({
      kind: 'symbol',
      id: 's1',
    });
  });
});

describe('findJunctionCandidates', () => {
  it('finds crossings and contact points', () => {
    const document = makeDocument({
      symbols: [],
      junctions: [],
      wires: [
        {
          id: 'a',
          points: [
            { x: 0, y: 0 },
            { x: 10, y: 0 },
          ],
        },
        {
          id: 'b',
          points: [
            { x: 5, y: -5 },
            { x: 5, y: 5 },
          ],
        },
        {
          id: 'c',
          points: [
            { x: 10, y: 0 },
            { x: 20, y: 0 },
          ],
        },
      ],
    });
    expect(findJunctionCandidates(document)).toEqual([
      { point: { x: 5, y: 0 }, wireIds: ['a', 'b'] },
      { point: { x: 10, y: 0 }, wireIds: ['a', 'c'] },
    ]);
  });

  it('excludes positions that already have a junction', () => {
    const document = makeDocument({ symbols: [] });
    expect(findJunctionCandidates(document)).toEqual([]);
  });

  it('detects collinear overlaps at shared endpoints', () => {
    const document = makeDocument({
      symbols: [],
      junctions: [],
      wires: [
        {
          id: 'a',
          points: [
            { x: 0, y: 0 },
            { x: 10, y: 0 },
          ],
        },
        {
          id: 'b',
          points: [
            { x: 10, y: 0 },
            { x: 20, y: 0 },
          ],
        },
      ],
    });
    expect(findJunctionCandidates(document)).toEqual([
      { point: { x: 10, y: 0 }, wireIds: ['a', 'b'] },
    ]);
  });

  it('returns no candidates for separated wires', () => {
    const document = makeDocument({
      symbols: [],
      junctions: [],
      wires: [
        {
          id: 'a',
          points: [
            { x: 0, y: 0 },
            { x: 10, y: 0 },
          ],
        },
        {
          id: 'b',
          points: [
            { x: 0, y: 20 },
            { x: 10, y: 20 },
          ],
        },
      ],
    });
    expect(findJunctionCandidates(document)).toEqual([]);
  });

  it('respects tolerance', () => {
    const document = makeDocument({
      symbols: [],
      junctions: [],
      wires: [
        {
          id: 'a',
          points: [
            { x: 0, y: 0 },
            { x: 10, y: 0 },
          ],
        },
        {
          id: 'b',
          points: [
            { x: 10.2, y: 0 },
            { x: 20, y: 0 },
          ],
        },
      ],
    });
    expect(findJunctionCandidates(document)).toEqual([]);
    expect(findJunctionCandidates(document, { tolerance: 0.5 })).toEqual([
      { point: { x: 10, y: 0 }, wireIds: ['a', 'b'] },
    ]);
  });
});
