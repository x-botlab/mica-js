import {
  LABEL_DEVICE,
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
  const wire = controller.getDocument().sheet.wires.find((candidate) => candidate.id === id);
  expect(wire).toBeDefined();
  return wire?.points ?? [];
}

describe('SchematicEditorController', () => {
  it('records one history step per edit and undoes in order', () => {
    const controller = createController(
      documentOf({
        symbols: [
          {
            id: '00000003-41e6-4a4c-869a-82a4cd304787',
            device: 'pkg:mcu',
            x: 0,
            y: 0,
            rotation: 0,
          },
        ],
      }),
    );
    controller.setSelection([{ kind: 'symbol', id: '00000003-41e6-4a4c-869a-82a4cd304787' }]);
    controller.moveSelectionBy(10, 0);
    controller.moveSelectionBy(10, 0);

    expect(controller.getDocument().sheet.symbols[0]?.x).toBe(20);
    expect(controller.getState().canUndo).toBe(true);

    controller.undo();
    expect(controller.getDocument().sheet.symbols[0]?.x).toBe(10);
    controller.undo();
    expect(controller.getDocument().sheet.symbols[0]?.x).toBe(0);
    expect(controller.getCanUndo()).toBe(false);

    controller.redo();
    expect(controller.getDocument().sheet.symbols[0]?.x).toBe(10);
  });

  it('keeps document and selection intact when an edit fails', () => {
    const controller = createController(
      documentOf({
        symbols: [
          {
            id: '00000003-41e6-4a4c-869a-82a4cd304787',
            device: 'pkg:mcu',
            x: 0,
            y: 0,
            rotation: 0,
          },
        ],
      }),
    );
    controller.setSelection([{ kind: 'symbol', id: '00000003-41e6-4a4c-869a-82a4cd304787' }]);
    const before = controller.getDocument();

    expect(() => controller.dispatch({ type: 'remove-symbol', id: 'missing' })).toThrow(
      SchematicError,
    );
    expect(controller.getDocument()).toBe(before);
    expect(controller.getSelection()).toEqual([
      { kind: 'symbol', id: '00000003-41e6-4a4c-869a-82a4cd304787' },
    ]);
    expect(controller.getState().lastError).toBeInstanceOf(SchematicError);

    controller.moveSelectionBy(5, 5);
    expect(controller.getState().lastError).toBeUndefined();
  });

  it('records validation rejections in state.lastError', () => {
    const controller = createController(
      documentOf({
        symbols: [
          {
            id: '00000003-41e6-4a4c-869a-82a4cd304787',
            device: 'pkg:mcu',
            x: 0,
            y: 0,
            rotation: 0,
          },
          {
            id: '00000004-dfe1-4ed9-83d0-30ddf7887781',
            device: 'pkg:mcu',
            x: 20,
            y: 0,
            rotation: 0,
            designator: 'U2',
          },
        ],
      }),
    );
    // Duplicate designator: rejected before any mutation happened.
    expect(() => controller.renameDesignator('00000003-41e6-4a4c-869a-82a4cd304787', 'U2')).toThrow(
      SchematicError,
    );
    expect(controller.getState().lastError?.message).toContain('already used');
    expect(controller.nextDesignator('pkg:mcu')).toBe('U1');

    // Rejections outside a transaction (bad reference, short wire) report the same way.
    expect(() => controller.placeDevice('nonsense')).toThrow(SchematicError);
    expect(controller.getState().lastError?.message).toContain('Invalid device reference');
    expect(() => controller.addWire([{ x: 0, y: 0 }])).toThrow(SchematicError);
    expect(controller.getState().lastError?.message).toContain('two points');

    controller.renameDesignator('00000003-41e6-4a4c-869a-82a4cd304787', 'U1');
    expect(controller.getState().lastError).toBeUndefined();
  });

  it('drops selection entries that no longer exist', () => {
    const controller = createController(
      documentOf({
        symbols: [
          {
            id: '00000003-41e6-4a4c-869a-82a4cd304787',
            device: 'pkg:mcu',
            x: 0,
            y: 0,
            rotation: 0,
          },
        ],
        wires: [
          {
            id: '00000006-9cf4-407f-8900-09a16d33a38c',
            points: [
              { x: 0, y: 0 },
              { x: 10, y: 0 },
            ],
          },
        ],
      }),
    );
    controller.setSelection([
      { kind: 'symbol', id: '00000003-41e6-4a4c-869a-82a4cd304787' },
      { kind: 'wire', id: '00000006-9cf4-407f-8900-09a16d33a38c' },
    ]);
    controller.deleteSelection();
    expect(controller.getDocument().sheet.symbols).toEqual([]);
    expect(controller.getDocument().sheet.wires).toEqual([]);
    expect(controller.getSelection()).toEqual([]);
  });

  it('splits a host wire and creates a junction when a new wire ends on it', () => {
    const controller = createController(
      documentOf({
        wires: [
          {
            id: '00000006-9cf4-407f-8900-09a16d33a38c',
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

    const junctions = controller.getDocument().sheet.junctions;
    expect(junctions).toHaveLength(1);
    const junction = junctions[0];
    expect(junction?.x).toBe(50);
    expect(junction?.y).toBe(0);
    expect(junction?.wires).toHaveLength(3);

    const joined = wirePoints(controller, '00000006-9cf4-407f-8900-09a16d33a38c');
    expect(joined[0]).toEqual({ x: 0, y: 0 });
    expect(joined[joined.length - 1]).toEqual({ x: 50, y: 0 });
    const secondHalfId = junction?.wires.find(
      (id) =>
        id !== '00000006-9cf4-407f-8900-09a16d33a38c' &&
        id !== '00000007-a914-47d5-84d1-8bafbe533ffb',
    );
    expect(secondHalfId).toBeDefined();
    expect(wirePoints(controller, secondHalfId!)[0]).toEqual({ x: 50, y: 0 });
    expect(wirePoints(controller, secondHalfId!)[1]).toEqual({ x: 100, y: 0 });
  });

  it('merges the junction back when the branch wire is deleted, and undo restores it', () => {
    const controller = createController(
      documentOf({
        wires: [
          {
            id: '00000006-9cf4-407f-8900-09a16d33a38c',
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
    const wiresAfterAdd = controller.getDocument().sheet.wires.length;
    const branchId = controller.getDocument().sheet.wires.at(-1)?.id ?? '';
    expect(branchId).not.toBe('00000006-9cf4-407f-8900-09a16d33a38c');

    controller.setSelection([{ kind: 'wire', id: branchId }]);
    controller.deleteSelection();

    expect(controller.getDocument().sheet.junctions).toEqual([]);
    expect(controller.getDocument().sheet.wires).toHaveLength(1);
    const merged = controller.getDocument().sheet.wires[0];
    expect(merged?.id).toBe('00000006-9cf4-407f-8900-09a16d33a38c');
    expect(merged?.points[0]).toEqual({ x: 0, y: 0 });
    expect(merged?.points[merged.points.length - 1]).toEqual({ x: 100, y: 0 });

    controller.undo();
    expect(controller.getDocument().sheet.wires).toHaveLength(wiresAfterAdd);
    expect(controller.getDocument().sheet.junctions).toHaveLength(1);
  });

  it('deletes a rubber-band selection around a T connection, junction included', () => {
    const controller = createController(
      documentOf({
        wires: [
          {
            id: '00000006-9cf4-407f-8900-09a16d33a38c',
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
    const junction = controller.getDocument().sheet.junctions[0];
    expect(junction).toBeDefined();

    controller.setSelection([
      ...controller
        .getDocument()
        .sheet.wires.map((wire) => ({ kind: 'wire' as const, id: wire.id })),
      { kind: 'junction', id: junction?.id ?? '' },
    ]);
    expect(() => controller.deleteSelection()).not.toThrow();

    expect(controller.getDocument().sheet.wires).toEqual([]);
    expect(controller.getDocument().sheet.junctions).toEqual([]);
    expect(controller.getSelection()).toEqual([]);
    expect(controller.getState().lastError).toBeUndefined();
  });

  it('keeps the through wire when a T junction and its branch are deleted together', () => {
    const controller = createController(
      documentOf({
        wires: [
          {
            id: '00000006-9cf4-407f-8900-09a16d33a38c',
            points: [
              { x: 0, y: 0 },
              { x: 50, y: 0 },
              { x: 100, y: 0 },
            ],
          },
          {
            id: '00000007-a914-47d5-84d1-8bafbe533ffb',
            points: [
              { x: 50, y: 0 },
              { x: 50, y: 50 },
            ],
          },
        ],
        junctions: [
          {
            id: '00000001-516c-48ac-8128-07f98c98ee13',
            x: 50,
            y: 0,
            wires: ['00000006-9cf4-407f-8900-09a16d33a38c', '00000007-a914-47d5-84d1-8bafbe533ffb'],
          },
        ],
      }),
    );

    controller.setSelection([
      { kind: 'wire', id: '00000007-a914-47d5-84d1-8bafbe533ffb' },
      { kind: 'junction', id: '00000001-516c-48ac-8128-07f98c98ee13' },
    ]);
    controller.deleteSelection();

    expect(controller.getDocument().sheet.wires.map((wire) => wire.id)).toEqual([
      '00000006-9cf4-407f-8900-09a16d33a38c',
    ]);
    expect(controller.getDocument().sheet.junctions).toEqual([]);
    expect(controller.getState().lastError).toBeUndefined();
  });

  it('caches state until something changes', () => {
    const controller = createController(
      documentOf({
        symbols: [
          {
            id: '00000003-41e6-4a4c-869a-82a4cd304787',
            device: 'pkg:mcu',
            x: 0,
            y: 0,
            rotation: 0,
          },
        ],
      }),
    );
    expect(controller.getState()).toBe(controller.getState());
    expect(controller.getRenderState()).toBe(controller.getRenderState());
    expect(controller.getRenderState().document).toBe(controller.getDocument());

    const before = controller.getState();
    controller.setSelection([{ kind: 'symbol', id: '00000003-41e6-4a4c-869a-82a4cd304787' }]);
    expect(controller.getState()).not.toBe(before);
  });

  it('stretches the connected wire when a net label moves', () => {
    const controller = createController(
      documentOf({
        symbols: [
          {
            id: '00000002-58c8-4974-8943-b00f84be79fc',
            device: LABEL_DEVICE,
            net: 'D0',
            x: 0,
            y: 0,
            rotation: 0,
          },
        ],
        wires: [
          {
            id: '00000006-9cf4-407f-8900-09a16d33a38c',
            points: [
              { x: 0, y: 0 },
              { x: 50, y: 0 },
            ],
          },
        ],
      }),
    );

    controller.setSelection([{ kind: 'symbol', id: '00000002-58c8-4974-8943-b00f84be79fc' }]);
    // Perpendicular: the original run stays and the label gets its own segment.
    controller.moveSelectionBy(0, -10);
    expect(controller.getDocument().sheet.symbols[0]).toMatchObject({ x: 0, y: -10 });
    expect(controller.getDocument().sheet.wires[0]?.points).toEqual([
      { x: 0, y: -10 },
      { x: 0, y: 0 },
      { x: 50, y: 0 },
    ]);

    // Along the wire: only the length changes.
    controller.moveSelectionBy(-10, 0);
    expect(controller.getDocument().sheet.wires[0]?.points).toEqual([
      { x: -10, y: -10 },
      { x: 0, y: -10 },
      { x: 0, y: 0 },
      { x: 50, y: 0 },
    ]);
  });

  it('joins an existing junction when a new wire ends on it', () => {
    const controller = createController(
      documentOf({
        wires: [
          {
            id: '00000006-9cf4-407f-8900-09a16d33a38c',
            points: [
              { x: 0, y: 0 },
              { x: 50, y: 0 },
            ],
          },
          {
            id: '00000007-a914-47d5-84d1-8bafbe533ffb',
            points: [
              { x: 50, y: 0 },
              { x: 50, y: 50 },
            ],
          },
        ],
        junctions: [
          {
            id: '00000001-516c-48ac-8128-07f98c98ee13',
            x: 50,
            y: 0,
            wires: ['00000006-9cf4-407f-8900-09a16d33a38c', '00000007-a914-47d5-84d1-8bafbe533ffb'],
          },
        ],
      }),
    );

    controller.addWire([
      { x: 50, y: 0 },
      { x: 100, y: 0 },
    ]);

    const branchId = controller.getDocument().sheet.wires.at(-1)?.id;
    expect(branchId).toBeDefined();
    expect(controller.getDocument().sheet.junctions).toEqual([
      {
        id: '00000001-516c-48ac-8128-07f98c98ee13',
        x: 50,
        y: 0,
        wires: [
          '00000006-9cf4-407f-8900-09a16d33a38c',
          '00000007-a914-47d5-84d1-8bafbe533ffb',
          branchId,
        ],
      },
    ]);
    expect(controller.getDocument().sheet.wires).toHaveLength(3);
  });

  it('creates a junction on an existing wire through connectWireAt', () => {
    const controller = createController(
      documentOf({
        wires: [
          {
            id: '00000006-9cf4-407f-8900-09a16d33a38c',
            points: [
              { x: 0, y: 0 },
              { x: 100, y: 0 },
            ],
          },
          {
            id: '00000007-a914-47d5-84d1-8bafbe533ffb',
            points: [
              { x: 50, y: -50 },
              { x: 50, y: 50 },
            ],
          },
        ],
      }),
    );

    const junctionId = controller.connectWireAt(
      '00000006-9cf4-407f-8900-09a16d33a38c',
      { x: 50, y: 0 },
      '00000007-a914-47d5-84d1-8bafbe533ffb',
    );

    const junction = controller
      .getDocument()
      .sheet.junctions.find((item) => item.id === junctionId);
    expect(junction?.wires).toEqual([
      '00000006-9cf4-407f-8900-09a16d33a38c',
      expect.any(String),
      '00000007-a914-47d5-84d1-8bafbe533ffb',
    ]);
    expect(controller.getState().canUndo).toBe(true);
    controller.undo();
    expect(controller.getDocument().sheet.junctions).toEqual([]);
    expect(controller.getDocument().sheet.wires).toHaveLength(2);
  });

  it('moves and deletes wire vertices', () => {
    const controller = createController(
      documentOf({
        wires: [
          {
            id: '00000006-9cf4-407f-8900-09a16d33a38c',
            points: [
              { x: 0, y: 0 },
              { x: 50, y: 0 },
              { x: 50, y: 50 },
            ],
          },
        ],
      }),
    );
    controller.setSelection([
      { kind: 'vertex', wireId: '00000006-9cf4-407f-8900-09a16d33a38c', index: 2 },
    ]);
    controller.moveSelectionBy(0, 10);
    expect(wirePoints(controller, '00000006-9cf4-407f-8900-09a16d33a38c')[2]).toEqual({
      x: 50,
      y: 60,
    });

    controller.deleteSelection();
    expect(wirePoints(controller, '00000006-9cf4-407f-8900-09a16d33a38c')).toEqual([
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
        symbols: [
          {
            id: '00000003-41e6-4a4c-869a-82a4cd304787',
            device: 'pkg:mcu',
            x: 0,
            y: 0,
            rotation: 0,
          },
        ],
        wires: [{ id: '00000006-9cf4-407f-8900-09a16d33a38c', points: [start, tail] }],
      }),
    );

    controller.setSelection([{ kind: 'symbol', id: '00000003-41e6-4a4c-869a-82a4cd304787' }]);
    controller.moveSelectionBy(10, 20);

    // The whole horizontal run shifts with the pin; the wire keeps its two points.
    const points = wirePoints(controller, '00000006-9cf4-407f-8900-09a16d33a38c');
    expect(points).toEqual([
      { x: start.x + 10, y: start.y + 20 },
      { x: tail.x, y: start.y + 20 },
    ]);

    controller.undo();
    expect(wirePoints(controller, '00000006-9cf4-407f-8900-09a16d33a38c')).toEqual([start, tail]);
  });

  it('rejects edits that would make a wire diagonal', () => {
    const controller = createController(
      documentOf({
        wires: [
          {
            id: '00000006-9cf4-407f-8900-09a16d33a38c',
            points: [
              { x: 0, y: 0 },
              { x: 50, y: 0 },
            ],
          },
        ],
      }),
    );
    controller.setSelection([
      { kind: 'vertex', wireId: '00000006-9cf4-407f-8900-09a16d33a38c', index: 1 },
    ]);
    expect(() => controller.moveSelectionBy(10, 10)).toThrow(SchematicError);
    expect(wirePoints(controller, '00000006-9cf4-407f-8900-09a16d33a38c')[1]).toEqual({
      x: 50,
      y: 0,
    });
  });

  it('leaves junctions in place because they derive from wire geometry', () => {
    const controller = createController(
      documentOf({
        wires: [
          {
            id: '00000006-9cf4-407f-8900-09a16d33a38c',
            points: [
              { x: 0, y: 0 },
              { x: 50, y: 0 },
              { x: 100, y: 0 },
            ],
          },
          {
            id: '00000007-a914-47d5-84d1-8bafbe533ffb',
            points: [
              { x: 50, y: 0 },
              { x: 50, y: 50 },
            ],
          },
        ],
        junctions: [
          {
            id: '00000001-516c-48ac-8128-07f98c98ee13',
            x: 50,
            y: 0,
            wires: ['00000006-9cf4-407f-8900-09a16d33a38c', '00000007-a914-47d5-84d1-8bafbe533ffb'],
          },
        ],
      }),
    );
    const before = controller.getDocument();
    controller.setSelection([{ kind: 'junction', id: '00000001-516c-48ac-8128-07f98c98ee13' }]);
    controller.moveSelectionBy(0, 10);

    expect(controller.getDocument()).toBe(before);
    expect(controller.getDocument().sheet.junctions[0]).toMatchObject({ x: 50, y: 0 });
  });

  it('rotates selected symbols in 90 degree steps', () => {
    const controller = createController(
      documentOf({
        symbols: [
          {
            id: '00000003-41e6-4a4c-869a-82a4cd304787',
            device: 'pkg:mcu',
            x: 0,
            y: 0,
            rotation: 0,
          },
        ],
      }),
    );
    controller.setSelection([{ kind: 'symbol', id: '00000003-41e6-4a4c-869a-82a4cd304787' }]);
    controller.rotateSelection(90);
    expect(controller.getDocument().sheet.symbols[0]?.rotation).toBe(90);
    controller.rotateSelection(-180);
    expect(controller.getDocument().sheet.symbols[0]?.rotation).toBe(270);
  });

  it('carries connected wire ends, junctions and anchors around with the rotation', () => {
    // Pin A sits on the left edge of the generated symbol; attach a wire to it.
    const anchor = devices.getDeviceSymbol(parseDeviceReference('pkg:mcu')!);
    const pin = anchor?.pins['A'];
    expect(pin).toBeDefined();
    const symbol = {
      id: '00000003-41e6-4a4c-869a-82a4cd304787',
      device: 'pkg:mcu',
      x: 0,
      y: 0,
      rotation: 0,
    } as const;
    const start = { x: symbol.x + (pin?.x ?? 0), y: symbol.y + (pin?.y ?? 0) };
    const controller = createController(
      documentOf({
        symbols: [
          symbol,
          {
            id: '00000005-dd15-4f04-822f-760f856e96a3',
            device: POWER_DEVICE,
            net: 'VCC',
            x: start.x,
            y: start.y,
            rotation: 0,
          },
        ],
        wires: [
          {
            id: '00000006-9cf4-407f-8900-09a16d33a38c',
            points: [start, { x: start.x - 40, y: start.y }],
          },
        ],
      }),
    );

    controller.setSelection([{ kind: 'symbol', id: '00000003-41e6-4a4c-869a-82a4cd304787' }]);
    controller.rotateSelection(90);

    // Rotating 90° moves the left pin to the top: same distance, axis swapped.
    const rotated = devices.getDeviceSymbol(parseDeviceReference('pkg:mcu')!)?.pins['A'];
    const expected = {
      x: -(rotated?.y ?? 0),
      y: rotated?.x ?? 0,
    };
    expect(controller.getDocument().sheet.wires[0]?.points[0]?.x).toBeCloseTo(expected.x, 9);
    expect(controller.getDocument().sheet.wires[0]?.points[0]?.y).toBeCloseTo(expected.y, 9);
    const movedAnchor = controller.getDocument().sheet.symbols[1];
    expect(movedAnchor?.x).toBeCloseTo(expected.x, 9);
    expect(movedAnchor?.y).toBeCloseTo(expected.y, 9);

    controller.undo();
    expect(controller.getDocument().sheet.wires[0]?.points[0]).toEqual(start);
  });

  it('inspects symbols with declared property defaults and overrides', () => {
    const controller = createController(
      documentOf({
        symbols: [
          {
            id: '00000003-41e6-4a4c-869a-82a4cd304787',
            device: 'pkg:mcu',
            x: 4,
            y: 6,
            rotation: 90,
            properties: { label: 'CPU' },
          },
        ],
      }),
    );
    controller.setSelection([{ kind: 'symbol', id: '00000003-41e6-4a4c-869a-82a4cd304787' }]);
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
        symbols: [
          {
            id: '00000005-dd15-4f04-822f-760f856e96a3',
            device: POWER_DEVICE,
            net: 'VCC',
            x: 0,
            y: 0,
            rotation: 0,
          },
        ],
        wires: [
          {
            id: '00000006-9cf4-407f-8900-09a16d33a38c',
            points: [
              { x: 0, y: 0 },
              { x: 50, y: 0 },
            ],
          },
        ],
      }),
    );
    controller.setSelection([{ kind: 'wire', id: '00000006-9cf4-407f-8900-09a16d33a38c' }]);
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
            id: '00000006-9cf4-407f-8900-09a16d33a38c',
            points: [
              { x: 0, y: 0 },
              { x: 50, y: 0 },
              { x: 100, y: 0 },
            ],
          },
          {
            id: '00000007-a914-47d5-84d1-8bafbe533ffb',
            points: [
              { x: 50, y: 0 },
              { x: 50, y: 50 },
            ],
          },
        ],
        junctions: [
          {
            id: '00000001-516c-48ac-8128-07f98c98ee13',
            x: 50,
            y: 0,
            wires: ['00000006-9cf4-407f-8900-09a16d33a38c', '00000007-a914-47d5-84d1-8bafbe533ffb'],
          },
        ],
      }),
    );
    expect(controller.inspect()).toBeUndefined();
    controller.setSelection([{ kind: 'junction', id: '00000001-516c-48ac-8128-07f98c98ee13' }]);
    expect(controller.inspect()).toBeUndefined();
  });

  it('writes and removes symbol properties', () => {
    const controller = createController(
      documentOf({
        symbols: [
          {
            id: '00000003-41e6-4a4c-869a-82a4cd304787',
            device: 'pkg:mcu',
            x: 0,
            y: 0,
            rotation: 0,
          },
        ],
      }),
    );
    controller.setSymbolProperty('00000003-41e6-4a4c-869a-82a4cd304787', 'speed', 120);
    expect(controller.getDocument().sheet.symbols[0]?.properties).toEqual({ speed: 120 });

    controller.removeSymbolProperty('00000003-41e6-4a4c-869a-82a4cd304787', 'speed');
    expect(controller.getDocument().sheet.symbols[0]?.properties).toBeUndefined();
    expect(() =>
      controller.removeSymbolProperty('00000003-41e6-4a4c-869a-82a4cd304787', 'speed'),
    ).toThrow(SchematicError);
  });

  it('rejects property values that break the device declaration', () => {
    const controller = createController(
      documentOf({
        symbols: [
          {
            id: '00000003-41e6-4a4c-869a-82a4cd304787',
            device: 'pkg:mcu',
            x: 0,
            y: 0,
            rotation: 0,
          },
        ],
      }),
    );
    expect(() =>
      controller.setSymbolProperty('00000003-41e6-4a4c-869a-82a4cd304787', 'speed', 999),
    ).toThrow(SchematicError);
    expect(controller.getState().lastError?.message).toContain('at most 170');
    expect(controller.getDocument().sheet.symbols[0]?.properties).toBeUndefined();

    expect(() =>
      controller.setSymbolProperty('00000003-41e6-4a4c-869a-82a4cd304787', 'cores', 1.5),
    ).toThrow(SchematicError);
    expect(controller.getState().lastError?.message).toContain('safe integer');
  });

  it('notifies subscribers and stops after unsubscribing', () => {
    const controller = createController(
      documentOf({
        symbols: [
          {
            id: '00000003-41e6-4a4c-869a-82a4cd304787',
            device: 'pkg:mcu',
            x: 0,
            y: 0,
            rotation: 0,
          },
        ],
      }),
    );
    const tools: string[] = [];
    const unsubscribe = controller.subscribe((state) => tools.push(state.tool));
    controller.setTool('wire');
    controller.setTool('select');
    unsubscribe();
    controller.setTool('wire');
    expect(tools).toEqual(['wire', 'select']);
    expect(controller.getTool()).toBe('wire');
  });

  it('applies grid display options without touching history', () => {
    const controller = createController(documentOf({}));
    controller.setDisplayOptions({ snap: false, gridSize: 20, gridSubdivisions: 4 });
    expect(controller.getState().display).toEqual({
      grid: true,
      snap: false,
      labels: true,
      gridSize: 20,
      gridSubdivisions: 4,
    });
    expect(controller.getCanUndo()).toBe(false);
  });

  it('ignores wire adds with fewer than two points', () => {
    const controller = createController(documentOf({}));
    expect(() => controller.addWire([{ x: 0, y: 0 }])).toThrow(SchematicError);
    expect(controller.getDocument().sheet.wires).toEqual([]);
  });

  it('swaps the document as one undoable edit through replace', () => {
    const controller = createController(
      documentOf({
        symbols: [
          {
            id: '00000003-41e6-4a4c-869a-82a4cd304787',
            device: 'pkg:mcu',
            x: 0,
            y: 0,
            rotation: 0,
          },
        ],
      }),
    );
    const next = documentOf({
      symbols: [
        { id: '00000004-dfe1-4ed9-83d0-30ddf7887781', device: 'pkg:mcu', x: 50, y: 0, rotation: 0 },
      ],
    });

    controller.replace(next);
    expect(controller.getDocument().sheet.symbols.map((symbol) => symbol.id)).toEqual([
      '00000004-dfe1-4ed9-83d0-30ddf7887781',
    ]);
    expect(controller.getCanUndo()).toBe(true);

    controller.undo();
    expect(controller.getDocument().sheet.symbols.map((symbol) => symbol.id)).toEqual([
      '00000003-41e6-4a4c-869a-82a4cd304787',
    ]);
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
    expect(controller.getDocument().sheet.wires).toHaveLength(1);
    expect(controller.getDocument().sheet.symbols).toHaveLength(1);
    controller.undo();
    expect(controller.getDocument().sheet.wires).toHaveLength(0);
    expect(controller.getDocument().sheet.symbols).toHaveLength(0);
  });

  it('returns void from command methods', () => {
    const controller = createController(
      documentOf({
        symbols: [
          {
            id: '00000003-41e6-4a4c-869a-82a4cd304787',
            device: 'pkg:mcu',
            x: 0,
            y: 0,
            rotation: 0,
          },
        ],
      }),
    );
    const selection: EditorSelection[] = [
      { kind: 'symbol', id: '00000003-41e6-4a4c-869a-82a4cd304787' },
    ];
    controller.setSelection(selection);
    expect(controller.moveSelectionBy(1, 1)).toBeUndefined();
    expect(
      controller.dispatch({ type: 'remove-symbol', id: '00000003-41e6-4a4c-869a-82a4cd304787' }),
    ).toBeUndefined();
  });

  describe('wire segment drag', () => {
    it('slides a free segment with both of its vertices', () => {
      const controller = createController(
        documentOf({
          wires: [
            {
              id: '00000006-9cf4-407f-8900-09a16d33a38c',
              points: [
                { x: 0, y: 0 },
                { x: 50, y: 0 },
                { x: 50, y: 40 },
              ],
            },
          ],
        }),
      );

      controller.moveWireSegment('00000006-9cf4-407f-8900-09a16d33a38c', 0, { x: 0, y: 10 });

      expect(wirePoints(controller, '00000006-9cf4-407f-8900-09a16d33a38c')).toEqual([
        { x: 0, y: 10 },
        { x: 50, y: 10 },
        { x: 50, y: 40 },
      ]);
      controller.undo();
      expect(wirePoints(controller, '00000006-9cf4-407f-8900-09a16d33a38c')[0]).toEqual({
        x: 0,
        y: 0,
      });
    });

    it('slides the whole run of parallel segments so none of them goes diagonal', () => {
      const controller = createController(
        documentOf({
          wires: [
            {
              id: '00000006-9cf4-407f-8900-09a16d33a38c',
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

      controller.moveWireSegment('00000006-9cf4-407f-8900-09a16d33a38c', 0, { x: 0, y: 5 });

      expect(wirePoints(controller, '00000006-9cf4-407f-8900-09a16d33a38c')).toEqual([
        { x: 0, y: 5 },
        { x: 10, y: 5 },
        { x: 20, y: 5 },
        { x: 20, y: 30 },
      ]);
    });

    it('keeps a pin-attached end and bends the wire into a dogleg', () => {
      const symbol = {
        id: '00000003-41e6-4a4c-869a-82a4cd304787',
        device: 'pkg:mcu',
        x: 0,
        y: 0,
        rotation: 0,
      };
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
              id: '00000006-9cf4-407f-8900-09a16d33a38c',
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
      expect(
        controller.previewWireSegment('00000006-9cf4-407f-8900-09a16d33a38c', 0, { x: 0, y: 10 }),
      ).toEqual(expected);
      expect(
        controller.previewWireSegment('00000006-9cf4-407f-8900-09a16d33a38c', 0, { x: 0, y: 0 }),
      ).toBeUndefined();

      controller.moveWireSegment('00000006-9cf4-407f-8900-09a16d33a38c', 0, { x: 0, y: 10 });
      expect(wirePoints(controller, '00000006-9cf4-407f-8900-09a16d33a38c')).toEqual(expected);
    });

    it('ignores unknown wires and segments', () => {
      const controller = createController(
        documentOf({
          wires: [
            {
              id: '00000006-9cf4-407f-8900-09a16d33a38c',
              points: [
                { x: 0, y: 0 },
                { x: 10, y: 0 },
              ],
            },
          ],
        }),
      );
      expect(() => controller.moveWireSegment('nope', 0, { x: 0, y: 10 })).not.toThrow();
      expect(() =>
        controller.moveWireSegment('00000006-9cf4-407f-8900-09a16d33a38c', 5, { x: 0, y: 10 }),
      ).not.toThrow();
      expect(wirePoints(controller, '00000006-9cf4-407f-8900-09a16d33a38c')).toEqual([
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
      expect(controller.getPlacingDevice()).toBe('pkg:mcu');
      // Arming leaves the tool in select mode so the click places instead of drawing.
      expect(controller.getTool()).toBe('select');

      controller.cancelPlacement();
      expect(controller.getPlacingDevice()).toBeUndefined();

      controller.placeDevice('pkg:mcu');
      controller.setTool('wire');
      expect(controller.getPlacingDevice()).toBeUndefined();
      expect(controller.getTool()).toBe('wire');
    });

    it('rejects malformed device references without arming', () => {
      const controller = createController(documentOf({}));
      expect(() => controller.placeDevice('nonsense')).toThrow(SchematicError);
      expect(controller.getPlacingDevice()).toBeUndefined();
    });

    it('picks the first unused designator through the host factory', () => {
      const controller = createController(
        documentOf({
          symbols: [
            {
              id: '00000003-41e6-4a4c-869a-82a4cd304787',
              device: 'pkg:mcu',
              x: 0,
              y: 0,
              rotation: 0,
              designator: 'U1',
            },
            {
              id: '00000004-dfe1-4ed9-83d0-30ddf7887781',
              device: 'pkg:mcu',
              x: 20,
              y: 0,
              rotation: 0,
              designator: 'U3',
            },
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
            {
              id: '00000003-41e6-4a4c-869a-82a4cd304787',
              device: 'pkg:resistor',
              x: 0,
              y: 0,
              rotation: 0,
              designator: 'R1',
            },
            {
              id: '00000004-dfe1-4ed9-83d0-30ddf7887781',
              device: 'pkg:resistor',
              x: 20,
              y: 0,
              rotation: 0,
              designator: 'R2',
            },
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
