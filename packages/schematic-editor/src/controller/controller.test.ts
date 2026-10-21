import {
  POWER_DEVICE,
  SchematicError,
  createDeviceRegistry,
  parseDeviceReference,
  parseSchematic,
  symbolPinPosition,
  type Point,
  type SchematicDocument,
} from '@mica-js/core/schematic';
import { describe, expect, it } from 'vitest';
import { SchematicEditorController } from './controller';
import type { EditorSelection } from './types';

const devices = createDeviceRegistry([
  {
    packageId: 'pkg',
    devices: [
      {
        id: 'mcu',
        displayName: 'MCU',
        designatorPrefix: 'U',
        raw: {
          pins: { A: { side: 'left' }, B: { side: 'right' } },
          properties: {
            label: { type: 'string', default: 'U1' },
            speed: { type: 'number', default: 72, min: 1, max: 170, unit: 'MHz' },
            cores: { type: 'integer', default: 1, min: 1, max: 2 },
          },
        },
      },
      {
        id: 'resistor',
        displayName: 'Resistor',
        designatorPrefix: 'R',
        raw: { pins: { '1': { side: 'left' }, '2': { side: 'right' } } },
      },
    ],
  },
]);

function documentOf(sheet: {
  symbols?: readonly unknown[];
  wires?: readonly unknown[];
  junctions?: readonly unknown[];
}): SchematicDocument {
  return parseSchematic({
    version: 1,
    sheet: {
      symbols: sheet.symbols ?? [],
      wires: sheet.wires ?? [],
      junctions: sheet.junctions ?? [],
    },
  });
}

function createController(document = documentOf({})): SchematicEditorController {
  return new SchematicEditorController({ document, devices });
}

function wirePoints(controller: SchematicEditorController, id: string): readonly Point[] {
  const wire = controller.document.sheet.wires.find((candidate) => candidate.id === id);
  expect(wire).toBeDefined();
  return wire?.points ?? [];
}

describe('SchematicEditorController', () => {
  it('records one history step per edit and undoes in order', () => {
    const controller = createController(
      documentOf({ symbols: [{ id: 's1', device: 'pkg:mcu', x: 0, y: 0, rotation: 0 }] }),
    );
    controller.setSelection([{ kind: 'symbol', id: 's1' }]);
    controller.moveSelectionBy(10, 0);
    controller.moveSelectionBy(10, 0);

    expect(controller.document.sheet.symbols[0]?.x).toBe(20);
    expect(controller.state.canUndo).toBe(true);

    controller.undo();
    expect(controller.document.sheet.symbols[0]?.x).toBe(10);
    controller.undo();
    expect(controller.document.sheet.symbols[0]?.x).toBe(0);
    expect(controller.canUndo).toBe(false);

    controller.redo();
    expect(controller.document.sheet.symbols[0]?.x).toBe(10);
  });

  it('keeps document and selection intact when an edit fails', () => {
    const controller = createController(
      documentOf({ symbols: [{ id: 's1', device: 'pkg:mcu', x: 0, y: 0, rotation: 0 }] }),
    );
    controller.setSelection([{ kind: 'symbol', id: 's1' }]);
    const before = controller.document;

    expect(() => controller.dispatch({ type: 'remove-symbol', id: 'missing' })).toThrow(
      SchematicError,
    );
    expect(controller.document).toBe(before);
    expect(controller.selection).toEqual([{ kind: 'symbol', id: 's1' }]);
    expect(controller.state.lastError).toBeInstanceOf(SchematicError);

    controller.moveSelectionBy(5, 5);
    expect(controller.state.lastError).toBeUndefined();
  });

  it('records validation rejections in state.lastError', () => {
    const controller = createController(
      documentOf({
        symbols: [
          { id: 's1', device: 'pkg:mcu', x: 0, y: 0, rotation: 0 },
          { id: 's2', device: 'pkg:mcu', x: 20, y: 0, rotation: 0, designator: 'U2' },
        ],
      }),
    );
    // Duplicate designator: rejected before any mutation happened.
    expect(() => controller.renameDesignator('s1', 'U2')).toThrow(SchematicError);
    expect(controller.state.lastError?.message).toContain('already used');
    expect(controller.nextDesignator('pkg:mcu')).toBe('U1');

    // Rejections outside a transaction (bad reference, short wire) report the same way.
    expect(() => controller.placeDevice('nonsense')).toThrow(SchematicError);
    expect(controller.state.lastError?.message).toContain('Invalid device reference');
    expect(() => controller.addWire([{ x: 0, y: 0 }])).toThrow(SchematicError);
    expect(controller.state.lastError?.message).toContain('two points');

    controller.renameDesignator('s1', 'U1');
    expect(controller.state.lastError).toBeUndefined();
  });

  it('drops selection entries that no longer exist', () => {
    const controller = createController(
      documentOf({
        symbols: [{ id: 's1', device: 'pkg:mcu', x: 0, y: 0, rotation: 0 }],
        wires: [
          {
            id: 'w1',
            points: [
              { x: 0, y: 0 },
              { x: 10, y: 0 },
            ],
          },
        ],
      }),
    );
    controller.setSelection([
      { kind: 'symbol', id: 's1' },
      { kind: 'wire', id: 'w1' },
    ]);
    controller.deleteSelection();
    expect(controller.document.sheet.symbols).toEqual([]);
    expect(controller.document.sheet.wires).toEqual([]);
    expect(controller.selection).toEqual([]);
  });

  it('splits a host wire and creates a junction when a new wire ends on it', () => {
    const controller = createController(
      documentOf({
        wires: [
          {
            id: 'w1',
            points: [
              { x: 0, y: 0 },
              { x: 100, y: 0 },
            ],
          },
        ],
      }),
    );

    controller.addWire([
      { x: 50, y: 50 },
      { x: 50, y: 0 },
    ]);

    const junctions = controller.document.sheet.junctions;
    expect(junctions).toHaveLength(1);
    const junction = junctions[0];
    expect(junction?.x).toBe(50);
    expect(junction?.y).toBe(0);
    expect(junction?.wires).toHaveLength(3);

    const joined = wirePoints(controller, 'w1');
    expect(joined[0]).toEqual({ x: 0, y: 0 });
    expect(joined[joined.length - 1]).toEqual({ x: 50, y: 0 });
    const secondHalfId = junction?.wires.find((id) => id !== 'w1' && id !== 'w2');
    expect(secondHalfId).toBeDefined();
    expect(wirePoints(controller, secondHalfId!)[0]).toEqual({ x: 50, y: 0 });
    expect(wirePoints(controller, secondHalfId!)[1]).toEqual({ x: 100, y: 0 });
  });

  it('merges the junction back when the branch wire is deleted, and undo restores it', () => {
    const controller = createController(
      documentOf({
        wires: [
          {
            id: 'w1',
            points: [
              { x: 0, y: 0 },
              { x: 100, y: 0 },
            ],
          },
        ],
      }),
    );
    controller.addWire([
      { x: 50, y: 50 },
      { x: 50, y: 0 },
    ]);
    const wiresAfterAdd = controller.document.sheet.wires.length;
    const branchId = controller.document.sheet.wires.at(-1)?.id ?? '';
    expect(branchId).not.toBe('w1');

    controller.setSelection([{ kind: 'wire', id: branchId }]);
    controller.deleteSelection();

    expect(controller.document.sheet.junctions).toEqual([]);
    expect(controller.document.sheet.wires).toHaveLength(1);
    const merged = controller.document.sheet.wires[0];
    expect(merged?.id).toBe('w1');
    expect(merged?.points[0]).toEqual({ x: 0, y: 0 });
    expect(merged?.points[merged.points.length - 1]).toEqual({ x: 100, y: 0 });

    controller.undo();
    expect(controller.document.sheet.wires).toHaveLength(wiresAfterAdd);
    expect(controller.document.sheet.junctions).toHaveLength(1);
  });

  it('creates a junction on an existing wire through connectWireAt', () => {
    const controller = createController(
      documentOf({
        wires: [
          {
            id: 'w1',
            points: [
              { x: 0, y: 0 },
              { x: 100, y: 0 },
            ],
          },
          {
            id: 'w2',
            points: [
              { x: 50, y: -50 },
              { x: 50, y: 50 },
            ],
          },
        ],
      }),
    );

    const junctionId = controller.connectWireAt('w1', { x: 50, y: 0 }, 'w2');

    const junction = controller.document.sheet.junctions.find((item) => item.id === junctionId);
    expect(junction?.wires).toEqual(['w1', expect.any(String), 'w2']);
    expect(controller.state.canUndo).toBe(true);
    controller.undo();
    expect(controller.document.sheet.junctions).toEqual([]);
    expect(controller.document.sheet.wires).toHaveLength(2);
  });

  it('moves and deletes wire vertices', () => {
    const controller = createController(
      documentOf({
        wires: [
          {
            id: 'w1',
            points: [
              { x: 0, y: 0 },
              { x: 50, y: 0 },
              { x: 50, y: 50 },
            ],
          },
        ],
      }),
    );
    controller.setSelection([{ kind: 'vertex', wireId: 'w1', index: 2 }]);
    controller.moveSelectionBy(0, 10);
    expect(wirePoints(controller, 'w1')[2]).toEqual({ x: 50, y: 60 });

    controller.deleteSelection();
    expect(wirePoints(controller, 'w1')).toEqual([
      { x: 0, y: 0 },
      { x: 50, y: 0 },
    ]);
  });

  it('drags attached wire ends along when a symbol is moved', () => {
    const definition = devices.getDeviceSymbol(parseDeviceReference('pkg:mcu')!);
    const pin = definition?.pins['A'];
    expect(pin).toBeDefined();
    const start = { x: pin?.x ?? 0, y: pin?.y ?? 0 };
    const tail = { x: start.x - 40, y: start.y };
    const controller = createController(
      documentOf({
        symbols: [{ id: 's1', device: 'pkg:mcu', x: 0, y: 0, rotation: 0 }],
        wires: [{ id: 'w1', points: [start, tail] }],
      }),
    );

    controller.setSelection([{ kind: 'symbol', id: 's1' }]);
    controller.moveSelectionBy(10, 20);

    // The whole horizontal run shifts with the pin; the wire keeps its two points.
    const points = wirePoints(controller, 'w1');
    expect(points).toEqual([
      { x: start.x + 10, y: start.y + 20 },
      { x: tail.x, y: start.y + 20 },
    ]);

    controller.undo();
    expect(wirePoints(controller, 'w1')).toEqual([start, tail]);
  });

  it('rejects edits that would make a wire diagonal', () => {
    const controller = createController(
      documentOf({
        wires: [
          {
            id: 'w1',
            points: [
              { x: 0, y: 0 },
              { x: 50, y: 0 },
            ],
          },
        ],
      }),
    );
    controller.setSelection([{ kind: 'vertex', wireId: 'w1', index: 1 }]);
    expect(() => controller.moveSelectionBy(10, 10)).toThrow(SchematicError);
    expect(wirePoints(controller, 'w1')[1]).toEqual({ x: 50, y: 0 });
  });

  it('leaves junctions in place because they derive from wire geometry', () => {
    const controller = createController(
      documentOf({
        wires: [
          {
            id: 'w1',
            points: [
              { x: 0, y: 0 },
              { x: 50, y: 0 },
              { x: 100, y: 0 },
            ],
          },
          {
            id: 'w2',
            points: [
              { x: 50, y: 0 },
              { x: 50, y: 50 },
            ],
          },
        ],
        junctions: [{ id: 'j1', x: 50, y: 0, wires: ['w1', 'w2'] }],
      }),
    );
    const before = controller.document;
    controller.setSelection([{ kind: 'junction', id: 'j1' }]);
    controller.moveSelectionBy(0, 10);

    expect(controller.document).toBe(before);
    expect(controller.document.sheet.junctions[0]).toMatchObject({ x: 50, y: 0 });
  });

  it('rotates selected symbols in 90 degree steps', () => {
    const controller = createController(
      documentOf({ symbols: [{ id: 's1', device: 'pkg:mcu', x: 0, y: 0, rotation: 0 }] }),
    );
    controller.setSelection([{ kind: 'symbol', id: 's1' }]);
    controller.rotateSelection(90);
    expect(controller.document.sheet.symbols[0]?.rotation).toBe(90);
    controller.rotateSelection(-180);
    expect(controller.document.sheet.symbols[0]?.rotation).toBe(270);
  });

  it('carries connected wire ends, junctions and anchors around with the rotation', () => {
    // Pin A sits on the left edge of the generated symbol; attach a wire to it.
    const anchor = devices.getDeviceSymbol(parseDeviceReference('pkg:mcu')!);
    const pin = anchor?.pins['A'];
    expect(pin).toBeDefined();
    const symbol = { id: 's1', device: 'pkg:mcu', x: 0, y: 0, rotation: 0 } as const;
    const start = { x: symbol.x + (pin?.x ?? 0), y: symbol.y + (pin?.y ?? 0) };
    const controller = createController(
      documentOf({
        symbols: [
          symbol,
          { id: 'vcc', device: POWER_DEVICE, net: 'VCC', x: start.x, y: start.y, rotation: 0 },
        ],
        wires: [{ id: 'w1', points: [start, { x: start.x - 40, y: start.y }] }],
      }),
    );

    controller.setSelection([{ kind: 'symbol', id: 's1' }]);
    controller.rotateSelection(90);

    // Rotating 90° moves the left pin to the top: same distance, axis swapped.
    const rotated = devices.getDeviceSymbol(parseDeviceReference('pkg:mcu')!)?.pins['A'];
    const expected = {
      x: -(rotated?.y ?? 0),
      y: rotated?.x ?? 0,
    };
    expect(controller.document.sheet.wires[0]?.points[0]?.x).toBeCloseTo(expected.x, 9);
    expect(controller.document.sheet.wires[0]?.points[0]?.y).toBeCloseTo(expected.y, 9);
    const movedAnchor = controller.document.sheet.symbols[1];
    expect(movedAnchor?.x).toBeCloseTo(expected.x, 9);
    expect(movedAnchor?.y).toBeCloseTo(expected.y, 9);

    controller.undo();
    expect(controller.document.sheet.wires[0]?.points[0]).toEqual(start);
  });

  it('inspects symbols with declared property defaults and overrides', () => {
    const controller = createController(
      documentOf({
        symbols: [
          { id: 's1', device: 'pkg:mcu', x: 4, y: 6, rotation: 90, properties: { label: 'CPU' } },
        ],
      }),
    );
    controller.setSelection([{ kind: 'symbol', id: 's1' }]);
    const inspector = controller.inspect();
    expect(inspector?.kind).toBe('symbol');
    if (inspector?.kind !== 'symbol') {
      throw new Error('expected a symbol inspector');
    }
    expect(inspector.name).toBe('MCU');
    expect(inspector.builtin).toBe(false);
    expect({ x: inspector.x, y: inspector.y, rotation: inspector.rotation }).toEqual({
      x: 4,
      y: 6,
      rotation: 90,
    });
    expect(inspector.properties).toEqual([
      { key: 'label', type: 'string', defaultValue: 'U1', value: 'CPU' },
      { key: 'speed', type: 'number', defaultValue: 72, min: 1, max: 170, unit: 'MHz' },
      { key: 'cores', type: 'integer', defaultValue: 1, min: 1, max: 2 },
    ]);
  });

  it('inspects wires with their net name', () => {
    const controller = createController(
      documentOf({
        symbols: [{ id: 'vcc', device: POWER_DEVICE, net: 'VCC', x: 0, y: 0, rotation: 0 }],
        wires: [
          {
            id: 'w1',
            points: [
              { x: 0, y: 0 },
              { x: 50, y: 0 },
            ],
          },
        ],
      }),
    );
    controller.setSelection([{ kind: 'wire', id: 'w1' }]);
    const inspector = controller.inspect();
    expect(inspector?.kind).toBe('wire');
    if (inspector?.kind !== 'wire') {
      throw new Error('expected a wire inspector');
    }
    expect(inspector.netName).toBe('VCC');
    expect(inspector.points).toHaveLength(2);
  });

  it('returns no inspector for empty or junction selections', () => {
    const controller = createController(
      documentOf({
        wires: [
          {
            id: 'w1',
            points: [
              { x: 0, y: 0 },
              { x: 50, y: 0 },
              { x: 100, y: 0 },
            ],
          },
          {
            id: 'w2',
            points: [
              { x: 50, y: 0 },
              { x: 50, y: 50 },
            ],
          },
        ],
        junctions: [{ id: 'j1', x: 50, y: 0, wires: ['w1', 'w2'] }],
      }),
    );
    expect(controller.inspect()).toBeUndefined();
    controller.setSelection([{ kind: 'junction', id: 'j1' }]);
    expect(controller.inspect()).toBeUndefined();
  });

  it('writes and removes symbol properties', () => {
    const controller = createController(
      documentOf({ symbols: [{ id: 's1', device: 'pkg:mcu', x: 0, y: 0, rotation: 0 }] }),
    );
    controller.setSymbolProperty('s1', 'speed', 120);
    expect(controller.document.sheet.symbols[0]?.properties).toEqual({ speed: 120 });

    controller.removeSymbolProperty('s1', 'speed');
    expect(controller.document.sheet.symbols[0]?.properties).toBeUndefined();
    expect(() => controller.removeSymbolProperty('s1', 'speed')).toThrow(SchematicError);
  });

  it('rejects property values that break the device declaration', () => {
    const controller = createController(
      documentOf({ symbols: [{ id: 's1', device: 'pkg:mcu', x: 0, y: 0, rotation: 0 }] }),
    );
    expect(() => controller.setSymbolProperty('s1', 'speed', 999)).toThrow(SchematicError);
    expect(controller.state.lastError?.message).toContain('at most 170');
    expect(controller.document.sheet.symbols[0]?.properties).toBeUndefined();

    expect(() => controller.setSymbolProperty('s1', 'cores', 1.5)).toThrow(SchematicError);
    expect(controller.state.lastError?.message).toContain('safe integer');
  });

  it('notifies subscribers and stops after unsubscribing', () => {
    const controller = createController(
      documentOf({ symbols: [{ id: 's1', device: 'pkg:mcu', x: 0, y: 0, rotation: 0 }] }),
    );
    const tools: string[] = [];
    const unsubscribe = controller.subscribe((state) => tools.push(state.tool));
    controller.setTool('wire');
    controller.setTool('select');
    unsubscribe();
    controller.setTool('wire');
    expect(tools).toEqual(['wire', 'select']);
    expect(controller.tool).toBe('wire');
  });

  it('keeps the view read-only and out of history', () => {
    const view = {
      version: 1 as const,
      id: 'v1',
      schematic: 'board.sch',
      layout: {},
    };
    const controller = new SchematicEditorController({
      document: documentOf({
        symbols: [{ id: 's1', device: 'pkg:mcu', x: 0, y: 0, rotation: 0 }],
      }),
      view,
      devices,
    });
    expect('setPlacement' in controller).toBe(false);
    expect('applyViewCommand' in controller).toBe(false);

    controller.setSelection([{ kind: 'symbol', id: 's1' }]);
    controller.moveSelectionBy(5, 0);
    controller.undo();
    expect(controller.view).toBe(view);
  });

  it('drops the layout override for symbols edited in the session', () => {
    const view = {
      version: 1 as const,
      id: 'v1',
      schematic: 'board.sch',
      layout: {
        s1: { x: 100, y: 100, rotation: 0 },
        s2: { x: 200, y: 200, rotation: 90 },
      },
    };
    const controller = new SchematicEditorController({
      document: documentOf({
        symbols: [
          { id: 's1', device: 'pkg:mcu', x: 0, y: 0, rotation: 0 },
          { id: 's2', device: 'pkg:mcu', x: 40, y: 0, rotation: 0 },
        ],
      }),
      view,
      devices,
    });
    expect(controller.state.view?.layout).toEqual(view.layout);

    controller.setSelection([{ kind: 'symbol', id: 's1' }]);
    controller.rotateSelection(90);
    expect(controller.state.view?.layout).toEqual({ s2: view.layout.s2 });
    expect(controller.view?.layout).toEqual(view.layout);

    controller.reset(controller.document, { view });
    expect(controller.state.view?.layout).toEqual(view.layout);
  });

  it('applies grid display options without touching history', () => {
    const controller = createController(documentOf({}));
    controller.setDisplayOptions({ snap: false, gridSize: 20, gridSubdivisions: 4 });
    expect(controller.state.display).toEqual({
      grid: true,
      snap: false,
      labels: true,
      gridSize: 20,
      gridSubdivisions: 4,
    });
    expect(controller.canUndo).toBe(false);
  });

  it('ignores wire adds with fewer than two points', () => {
    const controller = createController(documentOf({}));
    expect(() => controller.addWire([{ x: 0, y: 0 }])).toThrow(SchematicError);
    expect(controller.document.sheet.wires).toEqual([]);
  });

  it('swaps the document as one undoable edit through replace', () => {
    const controller = createController(
      documentOf({ symbols: [{ id: 's1', device: 'pkg:mcu', x: 0, y: 0, rotation: 0 }] }),
    );
    const next = documentOf({
      symbols: [{ id: 's2', device: 'pkg:mcu', x: 50, y: 0, rotation: 0 }],
    });

    controller.replace(next);
    expect(controller.document.sheet.symbols.map((symbol) => symbol.id)).toEqual(['s2']);
    expect(controller.canUndo).toBe(true);

    controller.undo();
    expect(controller.document.sheet.symbols.map((symbol) => symbol.id)).toEqual(['s1']);
  });

  it('groups edits into one history step with transaction', () => {
    const controller = createController(documentOf({}));
    controller.transaction(() => {
      controller.addWire([
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ]);
      controller.dispatch({ type: 'add-symbol', device: 'pkg:mcu', x: 10, y: 0 });
    });
    expect(controller.document.sheet.wires).toHaveLength(1);
    expect(controller.document.sheet.symbols).toHaveLength(1);
    controller.undo();
    expect(controller.document.sheet.wires).toHaveLength(0);
    expect(controller.document.sheet.symbols).toHaveLength(0);
  });

  it('returns void from command methods', () => {
    const controller = createController(
      documentOf({ symbols: [{ id: 's1', device: 'pkg:mcu', x: 0, y: 0, rotation: 0 }] }),
    );
    const selection: EditorSelection[] = [{ kind: 'symbol', id: 's1' }];
    controller.setSelection(selection);
    expect(controller.moveSelectionBy(1, 1)).toBeUndefined();
    expect(controller.dispatch({ type: 'remove-symbol', id: 's1' })).toBeUndefined();
  });

  describe('wire segment drag', () => {
    it('slides a free segment with both of its vertices', () => {
      const controller = createController(
        documentOf({
          wires: [
            {
              id: 'w1',
              points: [
                { x: 0, y: 0 },
                { x: 50, y: 0 },
                { x: 50, y: 40 },
              ],
            },
          ],
        }),
      );

      controller.moveWireSegment('w1', 0, { x: 0, y: 10 });

      expect(wirePoints(controller, 'w1')).toEqual([
        { x: 0, y: 10 },
        { x: 50, y: 10 },
        { x: 50, y: 40 },
      ]);
      controller.undo();
      expect(wirePoints(controller, 'w1')[0]).toEqual({ x: 0, y: 0 });
    });

    it('slides the whole run of parallel segments so none of them goes diagonal', () => {
      const controller = createController(
        documentOf({
          wires: [
            {
              id: 'w1',
              points: [
                { x: 0, y: 0 },
                { x: 10, y: 0 },
                { x: 20, y: 0 },
                { x: 20, y: 30 },
              ],
            },
          ],
        }),
      );

      controller.moveWireSegment('w1', 0, { x: 0, y: 5 });

      expect(wirePoints(controller, 'w1')).toEqual([
        { x: 0, y: 5 },
        { x: 10, y: 5 },
        { x: 20, y: 5 },
        { x: 20, y: 30 },
      ]);
    });

    it('keeps a pin-attached end and bends the wire into a dogleg', () => {
      const symbol = { id: 's1', device: 'pkg:mcu', x: 0, y: 0, rotation: 0 };
      const reference = parseDeviceReference('pkg:mcu');
      if (reference === undefined) {
        throw new Error('The test device reference must parse.');
      }
      const anchor = devices.getDeviceSymbol(reference)?.pins['A'];
      expect(anchor).toBeDefined();
      const pin = symbolPinPosition(symbol, anchor ?? { x: 0, y: 0 });
      const controller = createController(
        documentOf({
          symbols: [symbol],
          wires: [
            {
              id: 'w1',
              points: [pin, { x: pin.x + 40, y: pin.y }, { x: pin.x + 40, y: pin.y + 40 }],
            },
          ],
        }),
      );

      const expected = [
        pin,
        { x: pin.x, y: pin.y + 10 },
        { x: pin.x + 40, y: pin.y + 10 },
        { x: pin.x + 40, y: pin.y + 40 },
      ];
      expect(controller.previewWireSegment('w1', 0, { x: 0, y: 10 })).toEqual(expected);
      expect(controller.previewWireSegment('w1', 0, { x: 0, y: 0 })).toBeUndefined();

      controller.moveWireSegment('w1', 0, { x: 0, y: 10 });
      expect(wirePoints(controller, 'w1')).toEqual(expected);
    });

    it('ignores unknown wires and segments', () => {
      const controller = createController(
        documentOf({
          wires: [
            {
              id: 'w1',
              points: [
                { x: 0, y: 0 },
                { x: 10, y: 0 },
              ],
            },
          ],
        }),
      );
      expect(() => controller.moveWireSegment('nope', 0, { x: 0, y: 10 })).not.toThrow();
      expect(() => controller.moveWireSegment('w1', 5, { x: 0, y: 10 })).not.toThrow();
      expect(wirePoints(controller, 'w1')).toEqual([
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ]);
    });
  });

  describe('device placement', () => {
    it('arms a device until the tool changes or the placement is cancelled', () => {
      const controller = createController(documentOf({}));
      controller.setTool('wire');

      controller.placeDevice('pkg:mcu');
      expect(controller.placingDevice).toBe('pkg:mcu');
      // Arming leaves the tool in select mode so the click places instead of drawing.
      expect(controller.tool).toBe('select');

      controller.cancelPlacement();
      expect(controller.placingDevice).toBeUndefined();

      controller.placeDevice('pkg:mcu');
      controller.setTool('wire');
      expect(controller.placingDevice).toBeUndefined();
      expect(controller.tool).toBe('wire');
    });

    it('rejects malformed device references without arming', () => {
      const controller = createController(documentOf({}));
      expect(() => controller.placeDevice('nonsense')).toThrow(SchematicError);
      expect(controller.placingDevice).toBeUndefined();
    });

    it('picks the first unused designator through the host factory', () => {
      const controller = createController(
        documentOf({
          symbols: [
            { id: 's1', device: 'pkg:mcu', x: 0, y: 0, rotation: 0, designator: 'U1' },
            { id: 's2', device: 'pkg:mcu', x: 20, y: 0, rotation: 0, designator: 'U3' },
          ],
        }),
      );
      expect(controller.nextDesignator('pkg:mcu')).toBe('U2');

      const custom = new SchematicEditorController({
        document: documentOf({}),
        devices,
        createDesignator: (device) => (device === 'pkg:mcu' ? 'IC1' : 'X1'),
      });
      expect(custom.nextDesignator('pkg:mcu')).toBe('IC1');
    });

    it('takes the prefix from the device definition by default', () => {
      const controller = createController(
        documentOf({
          symbols: [
            { id: 's1', device: 'pkg:resistor', x: 0, y: 0, rotation: 0, designator: 'R1' },
            { id: 's2', device: 'pkg:resistor', x: 20, y: 0, rotation: 0, designator: 'R2' },
          ],
        }),
      );
      expect(controller.nextDesignator('pkg:resistor')).toBe('R3');
      expect(controller.nextDesignator('pkg:mcu')).toBe('U1');
      // Unknown devices still get the global default prefix.
      expect(controller.nextDesignator('pkg:unknown')).toBe('U1');
    });
  });
});
