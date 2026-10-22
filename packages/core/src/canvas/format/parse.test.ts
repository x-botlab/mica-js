import { describe, expect, it } from 'vitest';
import { catchError } from '../../format/test-helpers';
import { parseCanvas } from './parse';
import type { CanvasWidgetInstance } from './types';

const ID_A = '3f6c1e28-9b47-4d05-8a71-2c5e0f9b6d13';
const ID_B = 'a17d5b90-4e2c-4f86-b3d9-7e1c8a2f5046';

const MINIMAL = '{ "version": 1, "widgets": [] }';

const EXAMPLE = `{
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
      "properties": { "digits": 8 },
      "bindings": {
        "value": { "symbol": "5b8e2f14-9c03-4d7a-b6e1-2f4c8a9d0e57", "port": "segments" }
      }
    }
  ]
}`;

function baseWidget(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ID_A,
    widget: 'builtin:image',
    x: 0,
    y: 0,
    width: 100,
    height: 50,
    rotation: 0,
    ...overrides,
  };
}

function baseDocument(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { version: 1, widgets: [baseWidget()], ...overrides };
}

function codesOf(input: string | unknown): readonly string[] {
  return catchError(() => parseCanvas(input)).diagnostics.map((diagnostic) => diagnostic.code);
}

function expectDiagnostic(input: string | unknown, code: string, pointer: string): void {
  expect(catchError(() => parseCanvas(input)).diagnostics).toContainEqual(
    expect.objectContaining({ code, pointer }),
  );
}

describe('parseCanvas', () => {
  it('parses the minimal document', () => {
    expect(parseCanvas(MINIMAL)).toEqual({ version: 1, widgets: [] });
  });

  it('parses the example from the proposal', () => {
    const canvas = parseCanvas(EXAMPLE);
    expect(canvas.version).toBe(1);
    expect(canvas.schematic).toBe('boards/ct107d.sch');
    expect(canvas.widgets).toHaveLength(2);
    expect(canvas.widgets[1]).toEqual({
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
    });
  });

  it('keeps the widget order, which is the drawing order', () => {
    const canvas = parseCanvas({
      version: 1,
      widgets: [baseWidget(), baseWidget({ id: ID_B, widget: 'zerobit:keypad-key' })],
    });
    expect(canvas.widgets.map((widget) => widget.id)).toEqual([ID_A, ID_B]);
  });

  it('keeps empty properties and bindings maps', () => {
    const canvas = parseCanvas({
      version: 1,
      widgets: [baseWidget({ properties: {}, bindings: {} })],
    });
    expect(canvas.widgets[0]?.properties).toEqual({});
    expect(canvas.widgets[0]?.bindings).toEqual({});
  });

  it('accepts object input as well as JSON text', () => {
    expect(parseCanvas({ version: 1, widgets: [] })).toEqual(parseCanvas(MINIMAL));
  });

  it('rejects invalid JSON', () => {
    expect(codesOf('{')).toContain('json/invalid');
  });

  it('rejects documents that are not objects', () => {
    expectDiagnostic([], 'json/not-object', '');
  });

  it('rejects unknown top-level fields', () => {
    expectDiagnostic(baseDocument({ extra: 1 }), 'schema/unknown-field', '/extra');
  });

  it('rejects unsupported versions', () => {
    expectDiagnostic(baseDocument({ version: 2 }), 'schema/unsupported-version', '/version');
    expectDiagnostic(baseDocument({ version: '1' }), 'schema/invalid-type', '/version');
    expectDiagnostic(baseDocument({ version: 1.5 }), 'schema/invalid-value', '/version');
  });

  it('requires widgets to be an array', () => {
    expectDiagnostic({ version: 1 }, 'schema/missing-field', '/widgets');
    expectDiagnostic({ version: 1, widgets: {} }, 'schema/invalid-type', '/widgets');
  });

  it('requires every widget instance to be an object', () => {
    expectDiagnostic({ version: 1, widgets: [null] }, 'schema/invalid-type', '/widgets/0');
  });

  it('rejects unknown instance fields', () => {
    expectDiagnostic(
      { version: 1, widgets: [baseWidget({ mirror: true })] },
      'schema/unknown-field',
      '/widgets/0/mirror',
    );
  });

  it('requires uuid v4 instance ids', () => {
    expectDiagnostic(
      { version: 1, widgets: [baseWidget({ id: '' })] },
      'schema/invalid-value',
      '/widgets/0/id',
    );
    expectDiagnostic(
      { version: 1, widgets: [baseWidget({ id: 'widget-1' })] },
      'schema/invalid-value',
      '/widgets/0/id',
    );
    expectDiagnostic(
      { version: 1, widgets: [baseWidget({ id: '3f6c1e28-9b47-1d05-8a71-2c5e0f9b6d13' })] },
      'schema/invalid-value',
      '/widgets/0/id',
    );
    expectDiagnostic(
      { version: 1, widgets: [baseWidget({ id: 42 })] },
      'schema/invalid-type',
      '/widgets/0/id',
    );
  });

  it('accepts uppercase uuid v4 instance ids', () => {
    const canvas = parseCanvas({ version: 1, widgets: [baseWidget({ id: ID_A.toUpperCase() })] });
    expect(canvas.widgets[0]?.id).toBe(ID_A.toUpperCase());
  });

  it('rejects duplicate instance ids', () => {
    expectDiagnostic(
      { version: 1, widgets: [baseWidget(), baseWidget()] },
      'id/duplicate',
      '/widgets/1/id',
    );
  });

  it('requires a widget reference of the form package:widget or builtin:widget', () => {
    for (const reference of [
      'segment-display',
      'zerobit:segment_display',
      'Builtin:image',
      'zerobit:',
      ':image',
    ]) {
      expectDiagnostic(
        { version: 1, widgets: [baseWidget({ widget: reference })] },
        'schema/invalid-value',
        '/widgets/0/widget',
      );
    }
  });

  it('accepts kebab-case widget references', () => {
    const canvas = parseCanvas({
      version: 1,
      widgets: [baseWidget({ widget: 'zerobit:segment-display' })],
    });
    expect(canvas.widgets[0]?.widget).toBe('zerobit:segment-display');
  });

  it('requires finite geometry and positive sizes', () => {
    expectDiagnostic(
      { version: 1, widgets: [baseWidget({ width: 0 })] },
      'schema/invalid-value',
      '/widgets/0/width',
    );
    expectDiagnostic(
      { version: 1, widgets: [baseWidget({ height: -1 })] },
      'schema/invalid-value',
      '/widgets/0/height',
    );
    expectDiagnostic(
      { version: 1, widgets: [baseWidget({ x: Number.POSITIVE_INFINITY })] },
      'schema/invalid-value',
      '/widgets/0/x',
    );
    expectDiagnostic(
      { version: 1, widgets: [baseWidget({ rotation: Number.NaN })] },
      'schema/invalid-value',
      '/widgets/0/rotation',
    );
    expectDiagnostic(
      { version: 1, widgets: [baseWidget({ x: '0' })] },
      'schema/invalid-type',
      '/widgets/0/x',
    );
  });

  it('requires every geometry field', () => {
    const widget = baseWidget();
    delete widget['y'];
    expectDiagnostic({ version: 1, widgets: [widget] }, 'schema/missing-field', '/widgets/0/y');
  });

  it('requires properties to be an object with non-empty keys', () => {
    expectDiagnostic(
      { version: 1, widgets: [baseWidget({ properties: [] })] },
      'schema/invalid-type',
      '/widgets/0/properties',
    );
    expectDiagnostic(
      { version: 1, widgets: [baseWidget({ properties: { '': 1 } })] },
      'schema/invalid-value',
      '/widgets/0/properties',
    );
  });

  it('keeps property values as data, whatever their shape', () => {
    const properties = {
      image: { src: 'assets/board.webp', mode: 'file' },
      digits: 8,
      hidden: false,
      cleared: null,
      options: [1, 'two'],
    };
    const canvas = parseCanvas({ version: 1, widgets: [baseWidget({ properties })] });
    expect(canvas.widgets[0]?.properties).toEqual(properties);
  });

  it('requires bindings to be an object of symbol/port targets', () => {
    expectDiagnostic(
      { version: 1, widgets: [baseWidget({ bindings: [] })] },
      'schema/invalid-type',
      '/widgets/0/bindings',
    );
    expectDiagnostic(
      { version: 1, widgets: [baseWidget({ bindings: { press: 's1.key' } })] },
      'schema/invalid-type',
      '/widgets/0/bindings/press',
    );
    expectDiagnostic(
      { version: 1, widgets: [baseWidget({ bindings: { press: { symbol: 's1' } } })] },
      'schema/missing-field',
      '/widgets/0/bindings/press/port',
    );
    expectDiagnostic(
      { version: 1, widgets: [baseWidget({ bindings: { press: { symbol: '', port: 'key' } } })] },
      'schema/invalid-value',
      '/widgets/0/bindings/press/symbol',
    );
    expectDiagnostic(
      {
        version: 1,
        widgets: [baseWidget({ bindings: { press: { symbol: 's1', port: 'key', widget: 'x1' } } })],
      },
      'schema/unknown-field',
      '/widgets/0/bindings/press/widget',
    );
    expectDiagnostic(
      { version: 1, widgets: [baseWidget({ bindings: { '': { symbol: 's1', port: 'key' } } })] },
      'schema/invalid-value',
      '/widgets/0/bindings',
    );
  });

  it('requires the schematic reference to be a non-empty string', () => {
    expectDiagnostic(baseDocument({ schematic: '' }), 'schema/invalid-value', '/schematic');
    expectDiagnostic(baseDocument({ schematic: 3 }), 'schema/invalid-type', '/schematic');
  });

  it('reports every diagnostic in one error', () => {
    const error = catchError(() =>
      parseCanvas({
        version: 2,
        extra: true,
        widgets: [
          baseWidget({ id: 'nope', width: 0 }),
          baseWidget({ id: ID_B, widget: 'Bad Widget' }),
        ],
      }),
    );
    const codes = error.diagnostics.map((diagnostic) => diagnostic.code);
    expect(codes).toEqual(
      expect.arrayContaining([
        'schema/unknown-field',
        'schema/unsupported-version',
        'schema/invalid-value',
      ]),
    );
    expect(codes).toHaveLength(5);
  });

  it('does not mutate the input document', () => {
    const input = {
      version: 1,
      schematic: 'boards/ct107d.sch',
      widgets: [
        baseWidget({
          properties: { image: { src: 'assets/board.webp', mode: 'file' } },
          bindings: { value: { symbol: 's1', port: 'segments' } },
        }),
      ],
    };
    const snapshot = JSON.stringify(input);
    parseCanvas(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it('returns a document that does not alias the input', () => {
    const input = {
      version: 1,
      widgets: [
        baseWidget({
          properties: { image: { src: 'assets/board.webp', mode: 'file' } },
          bindings: { value: { symbol: 's1', port: 'segments' } },
        }),
      ],
    };
    const canvas = parseCanvas(input);
    const widgets = canvas.widgets as CanvasWidgetInstance[];
    const instance = widgets[0] as {
      x: number;
      properties: Record<string, { src: string }>;
      bindings: Record<string, { symbol: string }>;
    };
    instance.x = 999;
    instance.properties['image']!.src = 'other.webp';
    instance.bindings['value'] = { symbol: 'changed' };
    widgets.pop();

    expect(input.widgets[0]?.x).toBe(0);
    expect((input.widgets[0]?.properties as Record<string, { src: string }>)['image']).toEqual({
      src: 'assets/board.webp',
      mode: 'file',
    });
    expect(
      (input.widgets[0]?.bindings as Record<string, { symbol: string }>)['value']?.symbol,
    ).toBe('s1');
    expect(input.widgets).toHaveLength(1);
  });
});
