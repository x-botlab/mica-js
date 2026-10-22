import { describe, expect, it } from 'vitest';
import type { CanvasDocument } from './types';
import { parseCanvas } from './parse';
import { serializeCanvas } from './serialize';

const ID_A = '3f6c1e28-9b47-4d05-8a71-2c5e0f9b6d13';
const ID_B = 'a17d5b90-4e2c-4f86-b3d9-7e1c8a2f5046';

const DOCUMENT: CanvasDocument = {
  version: 1,
  schematic: 'boards/ct107d.sch',
  widgets: [
    {
      id: ID_A,
      widget: 'builtin:image',
      x: 0,
      y: 0,
      width: 1024,
      height: 762,
      rotation: 0,
      properties: { image: { src: 'assets/ct107d-board.webp', mode: 'file' } },
    },
    {
      id: ID_B,
      widget: 'zerobit:segment-display',
      x: 512,
      y: 214,
      width: 196,
      height: 60,
      rotation: 0,
      properties: { digits: 8 },
      bindings: {
        value: { symbol: '5b8e2f14-9c03-4d7a-b6e1-2f4c8a9d0e57', port: 'segments' },
      },
    },
  ],
};

const SERIALIZED = `{
  "version": 1,
  "schematic": "boards/ct107d.sch",
  "widgets": [
    {
      "id": "3f6c1e28-9b47-4d05-8a71-2c5e0f9b6d13",
      "widget": "builtin:image",
      "x": 0,
      "y": 0,
      "width": 1024,
      "height": 762,
      "rotation": 0,
      "properties": {
        "image": {
          "src": "assets/ct107d-board.webp",
          "mode": "file"
        }
      }
    },
    {
      "id": "a17d5b90-4e2c-4f86-b3d9-7e1c8a2f5046",
      "widget": "zerobit:segment-display",
      "x": 512,
      "y": 214,
      "width": 196,
      "height": 60,
      "rotation": 0,
      "properties": {
        "digits": 8
      },
      "bindings": {
        "value": {
          "symbol": "5b8e2f14-9c03-4d7a-b6e1-2f4c8a9d0e57",
          "port": "segments"
        }
      }
    }
  ]
}
`;

describe('serializeCanvas', () => {
  it('writes the fixed field order with two-space indentation and a trailing newline', () => {
    expect(serializeCanvas(DOCUMENT)).toBe(SERIALIZED);
    expect(SERIALIZED.endsWith('}\n')).toBe(true);
  });

  it('writes the minimal document', () => {
    expect(serializeCanvas({ version: 1, widgets: [] })).toBe(
      '{\n  "version": 1,\n  "widgets": []\n}\n',
    );
  });

  it('omits schematic, properties and bindings when the document has none', () => {
    const text = serializeCanvas({
      version: 1,
      widgets: [
        {
          id: ID_A,
          widget: 'zerobit:keypad-key',
          x: 1,
          y: 2,
          width: 44,
          height: 44,
          rotation: 90,
        },
      ],
    });
    expect(text).not.toContain('"schematic"');
    expect(text).not.toContain('"properties"');
    expect(text).not.toContain('"bindings"');
  });

  it('writes empty properties and bindings that the document carries', () => {
    const text = serializeCanvas({
      version: 1,
      widgets: [
        {
          id: ID_A,
          widget: 'zerobit:keypad-key',
          x: 1,
          y: 2,
          width: 44,
          height: 44,
          rotation: 0,
          properties: {},
          bindings: {},
        },
      ],
    });
    expect(text).toContain('"properties": {}');
    expect(text).toContain('"bindings": {}');
  });

  it('keeps the widget order as the drawing order', () => {
    const text = serializeCanvas({
      version: 1,
      widgets: [
        { id: ID_B, widget: 'zerobit:keypad-key', x: 1, y: 2, width: 44, height: 44, rotation: 0 },
        { id: ID_A, widget: 'builtin:image', x: 1, y: 2, width: 10, height: 10, rotation: 0 },
      ],
    });
    expect(text.indexOf(ID_B)).toBeLessThan(text.indexOf(ID_A));
  });

  it('round-trips through parseCanvas', () => {
    expect(serializeCanvas(parseCanvas(SERIALIZED))).toBe(SERIALIZED);
    expect(parseCanvas(SERIALIZED)).toEqual(DOCUMENT);
  });

  it('keeps property key order so a round trip is byte-identical', () => {
    const text = `{
  "version": 1,
  "widgets": [
    {
      "id": "3f6c1e28-9b47-4d05-8a71-2c5e0f9b6d13",
      "widget": "builtin:image",
      "x": 0,
      "y": 0,
      "width": 10,
      "height": 10,
      "rotation": 0,
      "properties": {
        "z-index": 1,
        "alpha": 2
      }
    }
  ]
}
`;
    expect(serializeCanvas(parseCanvas(text))).toBe(text);
  });

  it('does not mutate the input document', () => {
    const snapshot = JSON.stringify(DOCUMENT);
    serializeCanvas(DOCUMENT);
    expect(JSON.stringify(DOCUMENT)).toBe(snapshot);
  });
});
