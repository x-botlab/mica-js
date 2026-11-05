import { describe, expect, it } from 'vitest';
import { parseSchematic } from './parse-schematic';
import { serializeSchematic } from './serialize';
import type { SchematicDocument } from '../../format/types';

const DOCUMENT: SchematicDocument = {
  version: 1,
  sheet: {
    symbols: [
      { id: '00000001-41e6-4a4c-869a-82a4cd304787', device: 'pkg:dev', x: 1.5, y: 2, rotation: 90 },
    ],
    wires: [
      {
        id: '00000002-9cf4-407f-8900-09a16d33a38c',
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
        "id": "00000001-41e6-4a4c-869a-82a4cd304787",
        "device": "pkg:dev",
        "x": 1.5,
        "y": 2,
        "rotation": 90
      }
    ],
    "wires": [
      {
        "id": "00000002-9cf4-407f-8900-09a16d33a38c",
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
