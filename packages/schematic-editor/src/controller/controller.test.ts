import {
  POWER_DEVICE,
  SchematicError,
  createDeviceRegistry,
  parseSchematic,
  type Point,
  type SchematicDocument,
} from '@mica/core/schematic';
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
        raw: {
          pins: { A: { side: 'left' }, B: { side: 'right' } },
          properties: {
            label: { type: 'string', default: 'U1' },
            speed: { type: 'number', default: 72 },
          },
        },
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
    id: 'board',
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

    controller.setSelection([{ kind: 'wire', id: 'w2' }]);
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
    controller.setSelection([{ kind: 'vertex', wireId: 'w1', index: 1 }]);
    controller.moveSelectionBy(10, 10);
    expect(wirePoints(controller, 'w1')[1]).toEqual({ x: 60, y: 10 });

    controller.deleteSelection();
    expect(wirePoints(controller, 'w1')).toEqual([
      { x: 0, y: 0 },
      { x: 50, y: 50 },
    ]);
  });

  it('moves a junction together with the wire points that meet it', () => {
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
    controller.setSelection([{ kind: 'junction', id: 'j1' }]);
    controller.moveSelectionBy(0, 10);

    const junction = controller.document.sheet.junctions[0];
    expect(junction?.y).toBe(10);
    expect(wirePoints(controller, 'w1')[1]).toEqual({ x: 50, y: 10 });
    expect(wirePoints(controller, 'w2')[0]).toEqual({ x: 50, y: 10 });
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
      { key: 'label', type: 'string', value: 'CPU', defaultValue: 'U1' },
      { key: 'speed', type: 'number', value: undefined, defaultValue: 72 },
    ]);
  });

  it('inspects wires with their net name', () => {
    const controller = createController(
      documentOf({
        symbols: [{ id: 'vcc', device: POWER_DEVICE, x: 0, y: 0, rotation: 0, properties: {} }],
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

  it('applies grid display options without touching history', () => {
    const controller = createController(documentOf({}));
    controller.setDisplayOptions({ snap: false, gridSize: 20 });
    expect(controller.state.display).toEqual({
      grid: true,
      snap: false,
      labels: true,
      gridSize: 20,
    });
    expect(controller.canUndo).toBe(false);
  });

  it('ignores wire adds with fewer than two points', () => {
    const controller = createController(documentOf({}));
    expect(() => controller.addWire([{ x: 0, y: 0 }])).toThrow(SchematicError);
    expect(controller.document.sheet.wires).toEqual([]);
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
});
