import { describe, expect, it } from 'vitest';
import type { Diagnostic } from '../../format/diagnostics';
import { catchError } from '../../format/test-helpers';
import type { CanvasDocument, CanvasWidgetInstance } from '../format/types';
import { CANVAS_VERSION } from '../format/types';
import type { CanvasBindingCatalog, CanvasPortDescriptor } from './catalog';
import { assertCanvasBindings, validateCanvasBindings } from './validate';

const SCHEMATIC = 'boards/board.sch';
const WIDGET_REF = 'zerobit:screen';
const SYMBOL_ID = '5b8e2f14-9c03-4d7a-b6e1-2f4c8a9d0e57';
const MISSING_SYMBOL_ID = '0d3a7c61-2f58-4b90-8e47-a61c5d9f3b28';
const ID_A = '3f6c1e28-9b47-4d05-8a71-2c5e0f9b6d13';
const ID_B = 'a17d5b90-4e2c-4f86-b3d9-7e1c8a2f5046';

const WIDGET_DEFINITION = {
  ports: {
    value: { direction: 'input', type: 'bytes<segments>' },
    click: { direction: 'output', type: 'boolean' },
    pixels: { direction: 'input', type: 'bytes' },
    point: { direction: 'input', type: 'vec2d' },
  },
  propertyKeys: ['digits', 'brightness'],
} as const satisfies {
  ports: Readonly<Record<string, CanvasPortDescriptor>>;
  propertyKeys: readonly string[];
};

const SYMBOLS = {
  [SYMBOL_ID]: {
    segments: { direction: 'output', type: 'bytes<segments>' },
    D0: { direction: 'input', type: 'boolean' },
    SEG_IN: { direction: 'input', type: 'bytes<segments>' },
    RGB: { direction: 'input', type: 'bytes<rgb565>' },
    RAW: { direction: 'output', type: 'bytes<rgb565>' },
    POS: { direction: 'output', type: 'number' },
    OUT: { direction: 'output', type: 'boolean' },
  },
} as const satisfies Readonly<Record<string, Readonly<Record<string, CanvasPortDescriptor>>>>;

interface CatalogOptions {
  readonly schematics?: readonly string[];
  readonly symbols?: Readonly<Record<string, Readonly<Record<string, CanvasPortDescriptor>>>>;
}

/** In-memory catalog; the validator must work off this interface alone. */
function makeCatalog(options: CatalogOptions = {}): CanvasBindingCatalog {
  const schematics = new Set(options.schematics ?? [SCHEMATIC]);
  const symbols: Readonly<Record<string, Readonly<Record<string, CanvasPortDescriptor>>>> =
    options.symbols ?? SYMBOLS;
  return {
    widgetDefinition: (ref) => (ref === WIDGET_REF ? WIDGET_DEFINITION : undefined),
    hasSchematic: (path) => schematics.has(path),
    hasSymbol: (symbolId) => Object.prototype.hasOwnProperty.call(symbols, symbolId),
    symbolPort: (symbolId, port) => symbols[symbolId]?.[port],
  };
}

function makeInstance(overrides: Partial<CanvasWidgetInstance> = {}): CanvasWidgetInstance {
  return {
    id: ID_A,
    widget: WIDGET_REF,
    x: 0,
    y: 0,
    width: 100,
    height: 50,
    rotation: 0,
    ...overrides,
  };
}

function withSchematic(...widgets: CanvasWidgetInstance[]): CanvasDocument {
  return { version: CANVAS_VERSION, schematic: SCHEMATIC, widgets };
}

function withoutSchematic(...widgets: CanvasWidgetInstance[]): CanvasDocument {
  return { version: CANVAS_VERSION, widgets };
}

function codesOf(diagnostics: readonly Diagnostic[]): readonly string[] {
  return diagnostics.map((diagnostic) => diagnostic.code);
}

/** Asserts that `code` is the only diagnostic and that it points at `pointer`. */
function expectOnly(diagnostics: readonly Diagnostic[], code: string, pointer: string): void {
  expect(codesOf(diagnostics)).toEqual([code]);
  expect(diagnostics[0]?.pointer).toBe(pointer);
}

describe('validateCanvasBindings', () => {
  it('produces no diagnostics without a catalog', () => {
    const document = withSchematic(
      makeInstance({
        widget: 'zerobit:missing',
        properties: { nope: true },
        bindings: {
          value: { symbol: MISSING_SYMBOL_ID, port: 'nope' },
          nope: { symbol: MISSING_SYMBOL_ID, port: 'nope' },
        },
      }),
    );
    expect(validateCanvasBindings(document)).toEqual([]);
    expect(validateCanvasBindings(document, { skipWidgets: true })).toEqual([]);
  });

  it('accepts a widget input bound to a device output', () => {
    const document = withSchematic(
      makeInstance({
        properties: { digits: 8 },
        bindings: { value: { symbol: SYMBOL_ID, port: 'segments' } },
      }),
    );
    expect(validateCanvasBindings(document, { catalog: makeCatalog() })).toEqual([]);
  });

  it('accepts a widget output bound to a device input', () => {
    const document = withSchematic(
      makeInstance({ bindings: { click: { symbol: SYMBOL_ID, port: 'D0' } } }),
    );
    expect(validateCanvasBindings(document, { catalog: makeCatalog() })).toEqual([]);
  });

  it('reports an unloaded schematic and skips every symbol check', () => {
    const document = withSchematic(
      makeInstance({
        bindings: {
          value: { symbol: MISSING_SYMBOL_ID, port: 'segments' },
          click: { symbol: SYMBOL_ID, port: 'D0' },
        },
      }),
    );
    const diagnostics = validateCanvasBindings(document, {
      catalog: makeCatalog({ schematics: [], symbols: {} }),
    });
    expectOnly(diagnostics, 'canvas/unknown-schematic', '/schematic');
  });

  it('reports an unknown widget without cascading into its ports', () => {
    const document = withSchematic(
      makeInstance({
        widget: 'zerobit:missing',
        properties: { nope: true },
        bindings: { nope: { symbol: SYMBOL_ID, port: 'segments' } },
      }),
    );
    expectOnly(
      validateCanvasBindings(document, { catalog: makeCatalog() }),
      'canvas/unknown-widget',
      '/widgets/0/widget',
    );
  });

  it('reports an unknown property', () => {
    const document = withSchematic(makeInstance({ properties: { nope: true } }));
    expectOnly(
      validateCanvasBindings(document, { catalog: makeCatalog() }),
      'canvas/unknown-property',
      '/widgets/0/properties/nope',
    );
  });

  it('reports an unknown widget port', () => {
    const document = withSchematic(
      makeInstance({ bindings: { nope: { symbol: SYMBOL_ID, port: 'segments' } } }),
    );
    expectOnly(
      validateCanvasBindings(document, { catalog: makeCatalog() }),
      'canvas/unknown-port',
      '/widgets/0/bindings/nope',
    );
  });

  it('reports an unknown symbol without cascading into its ports', () => {
    const document = withSchematic(
      makeInstance({ bindings: { value: { symbol: MISSING_SYMBOL_ID, port: 'segments' } } }),
    );
    expectOnly(
      validateCanvasBindings(document, { catalog: makeCatalog() }),
      'canvas/unknown-symbol',
      '/widgets/0/bindings/value/symbol',
    );
  });

  it('reports an unknown device port', () => {
    const document = withSchematic(
      makeInstance({ bindings: { value: { symbol: SYMBOL_ID, port: 'nope' } } }),
    );
    expectOnly(
      validateCanvasBindings(document, { catalog: makeCatalog() }),
      'canvas/unknown-target-port',
      '/widgets/0/bindings/value/port',
    );
  });

  it('rejects two ports with the same direction', () => {
    const document = withSchematic(
      makeInstance({ bindings: { value: { symbol: SYMBOL_ID, port: 'SEG_IN' } } }),
    );
    const diagnostics = validateCanvasBindings(document, { catalog: makeCatalog() });
    expectOnly(diagnostics, 'topic/type-mismatch', '/widgets/0/bindings/value');
    expect(diagnostics[0]?.message).toContain(
      'Widget port "value" (input, bytes<segments>) cannot bind to device port "SEG_IN" (input, bytes<segments>)',
    );
  });

  it('rejects a widget output bound to a device output', () => {
    const document = withSchematic(
      makeInstance({ bindings: { click: { symbol: SYMBOL_ID, port: 'OUT' } } }),
    );
    expectOnly(
      validateCanvasBindings(document, { catalog: makeCatalog() }),
      'topic/type-mismatch',
      '/widgets/0/bindings/click',
    );
  });

  it('rejects a payload type mismatch with complementary directions', () => {
    const document = withSchematic(
      makeInstance({ bindings: { click: { symbol: SYMBOL_ID, port: 'RGB' } } }),
    );
    const diagnostics = validateCanvasBindings(document, { catalog: makeCatalog() });
    expectOnly(diagnostics, 'topic/type-mismatch', '/widgets/0/bindings/click');
    expect(diagnostics[0]?.message).toContain('payload types must match');
  });

  it('rejects bytes against bytes<rgb565>', () => {
    const document = withSchematic(
      makeInstance({ bindings: { pixels: { symbol: SYMBOL_ID, port: 'RAW' } } }),
    );
    expectOnly(
      validateCanvasBindings(document, { catalog: makeCatalog() }),
      'topic/type-mismatch',
      '/widgets/0/bindings/pixels',
    );
  });

  it('rejects vec2d against number', () => {
    const document = withSchematic(
      makeInstance({ bindings: { point: { symbol: SYMBOL_ID, port: 'POS' } } }),
    );
    expectOnly(
      validateCanvasBindings(document, { catalog: makeCatalog() }),
      'topic/type-mismatch',
      '/widgets/0/bindings/point',
    );
  });

  it('collects every problem of one instance instead of stopping at the first', () => {
    const document = withSchematic(
      makeInstance({
        properties: { nope: true },
        bindings: {
          value: { symbol: SYMBOL_ID, port: 'D0' },
          click: { symbol: SYMBOL_ID, port: 'RGB' },
          nope: { symbol: SYMBOL_ID, port: 'nope' },
        },
      }),
    );
    const diagnostics = validateCanvasBindings(document, { catalog: makeCatalog() });
    expect(codesOf(diagnostics)).toHaveLength(6);
    expect(codesOf(diagnostics)).toEqual(
      expect.arrayContaining([
        'canvas/unknown-property',
        'canvas/unknown-port',
        'canvas/unknown-target-port',
        'topic/type-mismatch',
      ]),
    );
    expect(codesOf(diagnostics).filter((code) => code === 'topic/type-mismatch')).toHaveLength(3);
  });

  it('aggregates problems from every instance', () => {
    const document = withSchematic(
      makeInstance({ properties: { nope: true } }),
      makeInstance({ id: ID_B, properties: { other: true } }),
    );
    const diagnostics = validateCanvasBindings(document, { catalog: makeCatalog() });
    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: 'canvas/unknown-property',
        pointer: '/widgets/0/properties/nope',
      }),
      expect.objectContaining({
        code: 'canvas/unknown-property',
        pointer: '/widgets/1/properties/other',
      }),
    ]);
  });

  it('checks only widget-side facts when the document has no schematic', () => {
    const document = withoutSchematic(
      makeInstance({
        properties: { nope: true },
        bindings: {
          nope: { symbol: MISSING_SYMBOL_ID, port: 'segments' },
          value: { symbol: MISSING_SYMBOL_ID, port: 'nope' },
        },
      }),
    );
    const diagnostics = validateCanvasBindings(document, { catalog: makeCatalog() });
    expect(codesOf(diagnostics)).toEqual(['canvas/unknown-property', 'canvas/unknown-port']);
    expect(diagnostics.map((diagnostic) => diagnostic.pointer)).toEqual([
      '/widgets/0/properties/nope',
      '/widgets/0/bindings/nope',
    ]);
  });

  it('checks only device-side facts when widgets are skipped', () => {
    const document = withSchematic(
      makeInstance({
        widget: 'zerobit:missing',
        properties: { nope: true },
        bindings: { nope: { symbol: MISSING_SYMBOL_ID, port: 'segments' } },
      }),
    );
    const diagnostics = validateCanvasBindings(document, {
      catalog: makeCatalog(),
      skipWidgets: true,
    });
    expect(codesOf(diagnostics)).toEqual(['canvas/unknown-symbol']);
  });

  it('still checks the device side of a valid binding when widgets are skipped', () => {
    const document = withSchematic(
      makeInstance({
        properties: { nope: true },
        bindings: { value: { symbol: SYMBOL_ID, port: 'segments' } },
      }),
    );
    expect(validateCanvasBindings(document, { catalog: makeCatalog(), skipWidgets: true })).toEqual(
      [],
    );
  });

  it('does not mutate the document', () => {
    const document = withSchematic(
      makeInstance({
        properties: { nope: true },
        bindings: { value: { symbol: MISSING_SYMBOL_ID, port: 'segments' } },
      }),
    );
    const snapshot = JSON.stringify(document);
    validateCanvasBindings(document, { catalog: makeCatalog() });
    expect(JSON.stringify(document)).toBe(snapshot);
  });
});

describe('assertCanvasBindings', () => {
  it('throws a SchematicError carrying every diagnostic', () => {
    const document = withSchematic(
      makeInstance({
        properties: { nope: true },
        bindings: { value: { symbol: MISSING_SYMBOL_ID, port: 'segments' } },
      }),
    );
    const options = { catalog: makeCatalog() };
    const error = catchError(() => assertCanvasBindings(document, options));
    expect(error.diagnostics).toEqual(validateCanvasBindings(document, options));
    expect(codesOf(error.diagnostics)).toEqual([
      'canvas/unknown-property',
      'canvas/unknown-symbol',
    ]);
  });

  it('does not throw when every binding is valid', () => {
    const document = withSchematic(
      makeInstance({ bindings: { value: { symbol: SYMBOL_ID, port: 'segments' } } }),
    );
    expect(() => assertCanvasBindings(document, { catalog: makeCatalog() })).not.toThrow();
  });

  it('does not throw without a catalog', () => {
    const document = withSchematic(
      makeInstance({ bindings: { value: { symbol: MISSING_SYMBOL_ID, port: 'segments' } } }),
    );
    expect(() => assertCanvasBindings(document)).not.toThrow();
  });
});
