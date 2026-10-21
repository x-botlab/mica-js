import { describe, expect, it } from 'vitest';
import { parseSchematic } from './parse-schematic';
import { serializeSchematic } from './serialize';
import type { SchematicDocument } from './types';

const DOCUMENT: SchematicDocument = {
  version: 1,
  sheet: {
    symbols: [{ id: 's1', device: 'pkg:dev', x: 1.5, y: 2, rotation: 90 }],
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
};

describe('serializeSchematic', () => {
  it('writes the fixed field order with two-space indentation and a trailing newline', () => {
    expect(serializeSchematic(DOCUMENT)).toBe(`{
  "version": 1,
  "sheet": {
    "symbols": [
      {
        "id": "s1",
        "device": "pkg:dev",
        "x": 1.5,
        "y": 2,
        "rotation": 90
      }
    ],
    "wires": [
      {
        "id": "w1",
        "points": [
          {
            "x": 0,
            "y": 0
          },
          {
            "x": 10,
            "y": 0
          }
        ]
      }
    ],
    "junctions": []
  }
}
`);
  });

  it('round-trips through parseSchematic', () => {
    expect(parseSchematic(serializeSchematic(DOCUMENT))).toEqual(DOCUMENT);
  });

  it('does not mutate the input document', () => {
    const snapshot = JSON.stringify(DOCUMENT);
    serializeSchematic(DOCUMENT);
    expect(JSON.stringify(DOCUMENT)).toBe(snapshot);
  });
});
