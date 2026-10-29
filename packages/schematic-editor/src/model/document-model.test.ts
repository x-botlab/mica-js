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
import { DocumentModel } from '../index';
import {
  SCHEMATIC_CLIPBOARD_FORMAT,
  SCHEMATIC_CLIPBOARD_VERSION,
  type SchematicClipboard,
} from './clipboard';
import { buildInspector } from './inspector';
import type { EditorSelection, Inspector } from '../types';

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

function createModel(document = documentOf({})): DocumentModel {
  return new DocumentModel({ value: document, devices });
}

function wirePoints(model: DocumentModel, id: string): readonly Point[] {
  const wire = model.getValue().sheet.wires.find((candidate) => candidate.id === id);
  expect(wire).toBeDefined();
  return wire?.points ?? [];
}

function inspect(model: DocumentModel, selection: readonly EditorSelection[]): Inspector {
  return buildInspector(model.getValue(), selection, {
    devices,
    topology: () => model.getTopology(),
  });
}

describe('DocumentModel', () => {
  it('records one history step per edit and undoes in order', () => {
    const model = createModel(
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
    model.moveTargets(selection, 10, 0);
    model.moveTargets(selection, 10, 0);

    expect(model.getValue().sheet.symbols[0]?.x).toBe(20);
    expect(model.getCanUndo()).toBe(true);

    model.undo();
    expect(model.getValue().sheet.symbols[0]?.x).toBe(10);
    model.undo();
    expect(model.getValue().sheet.symbols[0]?.x).toBe(0);
    expect(model.getCanUndo()).toBe(false);

    model.redo();
    expect(model.getValue().sheet.symbols[0]?.x).toBe(10);
  });

  it('keeps the document intact when an edit fails', () => {
    const model = createModel(
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
    const before = model.getValue();

    expect(() => model.applyCommand({ type: 'remove-symbol', id: 'missing' })).toThrow(
      SchematicError,
    );
    expect(model.getValue()).toBe(before);
    expect(model.getLastError()).toBeInstanceOf(SchematicError);

    model.moveTargets([{ kind: 'symbol', id: '00000003-41e6-4a4c-869a-82a4cd304787' }], 5, 5);
    expect(model.getLastError()).toBeUndefined();
  });

  it('records validation rejections in state.lastError', () => {
    const model = createModel(
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
    expect(() => model.renameDesignator('00000003-41e6-4a4c-869a-82a4cd304787', 'U2')).toThrow(
      SchematicError,
    );
    expect(model.getLastError()?.message).toContain('already used');
    expect(model.nextDesignator('pkg:mcu')).toBe('U1');

    // Rejections outside a transaction (unknown symbol, short wire) report the same way.
    expect(() => model.applyCommand({ type: 'remove-symbol', id: 'missing' })).toThrow(
      SchematicError,
    );
    expect(model.getLastError()).toBeInstanceOf(SchematicError);
    expect(() => model.addWire([{ x: 0, y: 0 }])).toThrow(SchematicError);
    expect(model.getLastError()?.message).toContain('two points');

    model.renameDesignator('00000003-41e6-4a4c-869a-82a4cd304787', 'U1');
    expect(model.getLastError()).toBeUndefined();
  });

  it('removes every targeted element', () => {
    const model = createModel(
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
    model.removeTargets([
      { kind: 'symbol', id: '00000003-41e6-4a4c-869a-82a4cd304787' },
      { kind: 'wire', id: '00000006-9cf4-407f-8900-09a16d33a38c' },
    ]);
    expect(model.getValue().sheet.symbols).toEqual([]);
    expect(model.getValue().sheet.wires).toEqual([]);
    expect(model.getCanUndo()).toBe(true);
  });

  it('splits a host wire and creates a junction when a new wire ends on it', () => {
    const model = createModel(
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

    model.addWire([
      { x: 50, y: 50 },
      { x: 50, y: 0 },
    ]);

    const junctions = model.getValue().sheet.junctions;
    expect(junctions).toHaveLength(1);
    const junction = junctions[0];
    expect(junction?.x).toBe(50);
    expect(junction?.y).toBe(0);
    expect(junction?.wires).toHaveLength(3);

    const joined = wirePoints(model, '00000006-9cf4-407f-8900-09a16d33a38c');
    expect(joined[0]).toEqual({ x: 0, y: 0 });
    expect(joined[joined.length - 1]).toEqual({ x: 50, y: 0 });
    const secondHalfId = junction?.wires.find(
      (id) =>
        id !== '00000006-9cf4-407f-8900-09a16d33a38c' &&
        id !== '00000007-a914-47d5-84d1-8bafbe533ffb',
    );
    expect(secondHalfId).toBeDefined();
    expect(wirePoints(model, secondHalfId!)[0]).toEqual({ x: 50, y: 0 });
    expect(wirePoints(model, secondHalfId!)[1]).toEqual({ x: 100, y: 0 });
  });

  it('merges the junction back when the branch wire is deleted, and undo restores it', () => {
    const model = createModel(
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
    model.addWire([
      { x: 50, y: 50 },
      { x: 50, y: 0 },
    ]);
    const wiresAfterAdd = model.getValue().sheet.wires.length;
    const branchId = model.getValue().sheet.wires.at(-1)?.id ?? '';
    expect(branchId).not.toBe('00000006-9cf4-407f-8900-09a16d33a38c');

    model.removeTargets([{ kind: 'wire', id: branchId }]);

    expect(model.getValue().sheet.junctions).toEqual([]);
    expect(model.getValue().sheet.wires).toHaveLength(1);
    const merged = model.getValue().sheet.wires[0];
    expect(merged?.id).toBe('00000006-9cf4-407f-8900-09a16d33a38c');
    expect(merged?.points[0]).toEqual({ x: 0, y: 0 });
    expect(merged?.points[merged.points.length - 1]).toEqual({ x: 100, y: 0 });

    model.undo();
    expect(model.getValue().sheet.wires).toHaveLength(wiresAfterAdd);
    expect(model.getValue().sheet.junctions).toHaveLength(1);
  });

  it('deletes a rubber-band selection around a T connection, junction included', () => {
    const model = createModel(
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
    model.addWire([
      { x: 50, y: 50 },
      { x: 50, y: 0 },
    ]);
    const junction = model.getValue().sheet.junctions[0];
    expect(junction).toBeDefined();

    model.removeTargets([
      ...model.getValue().sheet.wires.map((wire) => ({ kind: 'wire' as const, id: wire.id })),
      { kind: 'junction', id: junction?.id ?? '' },
    ]);

    expect(model.getValue().sheet.wires).toEqual([]);
    expect(model.getValue().sheet.junctions).toEqual([]);
    expect(model.getLastError()).toBeUndefined();
  });

  it('keeps the through wire when a T junction and its branch are deleted together', () => {
    const model = createModel(
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

    model.removeTargets([
      { kind: 'wire', id: '00000007-a914-47d5-84d1-8bafbe533ffb' },
      { kind: 'junction', id: '00000001-516c-48ac-8128-07f98c98ee13' },
    ]);

    expect(model.getValue().sheet.wires.map((wire) => wire.id)).toEqual([
      '00000006-9cf4-407f-8900-09a16d33a38c',
    ]);
    expect(model.getValue().sheet.junctions).toEqual([]);
    expect(model.getLastError()).toBeUndefined();
  });

  it('stretches the connected wire when a net label moves', () => {
    const model = createModel(
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

    const selection: EditorSelection[] = [
      { kind: 'symbol', id: '00000002-58c8-4974-8943-b00f84be79fc' },
    ];
    // Perpendicular: the original run stays and the label gets its own segment.
    model.moveTargets(selection, 0, -10);
    expect(model.getValue().sheet.symbols[0]).toMatchObject({ x: 0, y: -10 });
    expect(model.getValue().sheet.wires[0]?.points).toEqual([
      { x: 0, y: -10 },
      { x: 0, y: 0 },
      { x: 50, y: 0 },
    ]);

    // Along the wire: only the length changes.
    model.moveTargets(selection, -10, 0);
    expect(model.getValue().sheet.wires[0]?.points).toEqual([
      { x: -10, y: -10 },
      { x: 0, y: -10 },
      { x: 0, y: 0 },
      { x: 50, y: 0 },
    ]);
  });

  it('joins an existing junction when a new wire ends on it', () => {
    const model = createModel(
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

    model.addWire([
      { x: 50, y: 0 },
      { x: 100, y: 0 },
    ]);

    const branchId = model.getValue().sheet.wires.at(-1)?.id;
    expect(branchId).toBeDefined();
    expect(model.getValue().sheet.junctions).toEqual([
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
    expect(model.getValue().sheet.wires).toHaveLength(3);
  });

  it('creates a junction on an existing wire through connectWireAt', () => {
    const model = createModel(
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

    const junctionId = model.connectWireAt(
      '00000006-9cf4-407f-8900-09a16d33a38c',
      { x: 50, y: 0 },
      '00000007-a914-47d5-84d1-8bafbe533ffb',
    );

    const junction = model.getValue().sheet.junctions.find((item) => item.id === junctionId);
    expect(junction?.wires).toEqual([
      '00000006-9cf4-407f-8900-09a16d33a38c',
      expect.any(String),
      '00000007-a914-47d5-84d1-8bafbe533ffb',
    ]);
    expect(model.getCanUndo()).toBe(true);
    model.undo();
    expect(model.getValue().sheet.junctions).toEqual([]);
    expect(model.getValue().sheet.wires).toHaveLength(2);
  });

  it('moves and deletes wire vertices', () => {
    const model = createModel(
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
    const vertex: EditorSelection = {
      kind: 'vertex',
      wireId: '00000006-9cf4-407f-8900-09a16d33a38c',
      index: 2,
    };
    model.moveTargets([vertex], 0, 10);
    expect(wirePoints(model, '00000006-9cf4-407f-8900-09a16d33a38c')[2]).toEqual({
      x: 50,
      y: 60,
    });

    model.removeTargets([vertex]);
    expect(wirePoints(model, '00000006-9cf4-407f-8900-09a16d33a38c')).toEqual([
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
    const model = createModel(
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

    model.moveTargets([{ kind: 'symbol', id: '00000003-41e6-4a4c-869a-82a4cd304787' }], 10, 20);

    // The whole horizontal run shifts with the pin; the wire keeps its two points.
    const points = wirePoints(model, '00000006-9cf4-407f-8900-09a16d33a38c');
    expect(points).toEqual([
      { x: start.x + 10, y: start.y + 20 },
      { x: tail.x, y: start.y + 20 },
    ]);

    model.undo();
    expect(wirePoints(model, '00000006-9cf4-407f-8900-09a16d33a38c')).toEqual([start, tail]);
  });

  it('rejects edits that would make a wire diagonal', () => {
    const model = createModel(
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
    const vertex: EditorSelection = {
      kind: 'vertex',
      wireId: '00000006-9cf4-407f-8900-09a16d33a38c',
      index: 1,
    };
    expect(() => model.moveTargets([vertex], 10, 10)).toThrow(SchematicError);
    expect(wirePoints(model, '00000006-9cf4-407f-8900-09a16d33a38c')[1]).toEqual({
      x: 50,
      y: 0,
    });
  });

  it('leaves junctions in place because they derive from wire geometry', () => {
    const model = createModel(
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
    const before = model.getValue();
    model.moveTargets([{ kind: 'junction', id: '00000001-516c-48ac-8128-07f98c98ee13' }], 0, 10);

    expect(model.getValue()).toBe(before);
    expect(model.getValue().sheet.junctions[0]).toMatchObject({ x: 50, y: 0 });
  });

  it('rotates selected symbols in 90 degree steps', () => {
    const model = createModel(
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
    model.rotateTargets(selection, 90);
    expect(model.getValue().sheet.symbols[0]?.rotation).toBe(90);
    model.rotateTargets(selection, -180);
    expect(model.getValue().sheet.symbols[0]?.rotation).toBe(270);
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
    const model = createModel(
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

    model.rotateTargets([{ kind: 'symbol', id: '00000003-41e6-4a4c-869a-82a4cd304787' }], 90);

    // Rotating 90° moves the left pin to the top: same distance, axis swapped.
    const rotated = devices.getDeviceSymbol(parseDeviceReference('pkg:mcu')!)?.pins['A'];
    const expected = {
      x: -(rotated?.y ?? 0),
      y: rotated?.x ?? 0,
    };
    expect(model.getValue().sheet.wires[0]?.points[0]?.x).toBeCloseTo(expected.x, 9);
    expect(model.getValue().sheet.wires[0]?.points[0]?.y).toBeCloseTo(expected.y, 9);
    const movedAnchor = model.getValue().sheet.symbols[1];
    expect(movedAnchor?.x).toBeCloseTo(expected.x, 9);
    expect(movedAnchor?.y).toBeCloseTo(expected.y, 9);

    model.undo();
    expect(model.getValue().sheet.wires[0]?.points[0]).toEqual(start);
  });

  it('inspects symbols with declared property defaults and overrides', () => {
    const model = createModel(
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
    const inspector = inspect(model, [
      { kind: 'symbol', id: '00000003-41e6-4a4c-869a-82a4cd304787' },
    ]);
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
    const model = createModel(
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
    const inspector = inspect(model, [
      { kind: 'wire', id: '00000006-9cf4-407f-8900-09a16d33a38c' },
    ]);
    expect(inspector?.kind).toBe('wire');
    if (inspector?.kind !== 'wire') {
      throw new Error('expected a wire inspector');
    }
    expect(inspector.netName).toBe('VCC');
    expect(inspector.points).toHaveLength(2);
  });

  it('returns no inspector for empty or junction selections', () => {
    const model = createModel(
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
    expect(inspect(model, [])).toBeUndefined();
    expect(
      inspect(model, [{ kind: 'junction', id: '00000001-516c-48ac-8128-07f98c98ee13' }]),
    ).toBeUndefined();
  });

  it('writes and removes symbol properties', () => {
    const model = createModel(
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
    model.setSymbolProperty('00000003-41e6-4a4c-869a-82a4cd304787', 'speed', 120);
    expect(model.getValue().sheet.symbols[0]?.properties).toEqual({ speed: 120 });

    model.removeSymbolProperty('00000003-41e6-4a4c-869a-82a4cd304787', 'speed');
    expect(model.getValue().sheet.symbols[0]?.properties).toBeUndefined();
    expect(() =>
      model.removeSymbolProperty('00000003-41e6-4a4c-869a-82a4cd304787', 'speed'),
    ).toThrow(SchematicError);
  });

  it('rejects property values that break the device declaration', () => {
    const model = createModel(
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
      model.setSymbolProperty('00000003-41e6-4a4c-869a-82a4cd304787', 'speed', 999),
    ).toThrow(SchematicError);
    expect(model.getLastError()?.message).toContain('at most 170');
    expect(model.getValue().sheet.symbols[0]?.properties).toBeUndefined();

    expect(() =>
      model.setSymbolProperty('00000003-41e6-4a4c-869a-82a4cd304787', 'cores', 1.5),
    ).toThrow(SchematicError);
    expect(model.getLastError()?.message).toContain('safe integer');
  });

  it('notifies content subscribers and stops after disposing the subscription', () => {
    const model = createModel(documentOf({}));
    const documents: SchematicDocument[] = [];
    const subscription = model.onDidChangeContent((document) => documents.push(document));
    model.applyCommand({ type: 'add-symbol', device: 'pkg:mcu', x: 0, y: 0 });
    model.applyCommand({ type: 'add-symbol', device: 'pkg:mcu', x: 20, y: 0 });
    subscription.dispose();
    model.applyCommand({ type: 'add-symbol', device: 'pkg:mcu', x: 40, y: 0 });
    expect(documents).toHaveLength(2);
    expect(documents[0]?.sheet.symbols).toHaveLength(1);
    expect(documents[1]?.sheet.symbols).toHaveLength(2);
    expect(model.getValue().sheet.symbols).toHaveLength(3);
  });

  it('reports rejected edits on their own channel and keeps the content', () => {
    const model = createModel(
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
    const documents: SchematicDocument[] = [];
    const errors: SchematicError[] = [];
    model.onDidChangeContent((document) => documents.push(document));
    model.onDidRejectEdit((error) => errors.push(error));

    expect(() =>
      model.setSymbolProperty('00000003-41e6-4a4c-869a-82a4cd304787', 'speed', 999),
    ).toThrow(SchematicError);
    expect(documents).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain('at most 170');
  });

  it('disposes its events with dispose', () => {
    const model = createModel(documentOf({}));
    const documents: SchematicDocument[] = [];
    model.onDidChangeContent((document) => documents.push(document));
    model.dispose();
    model.applyCommand({ type: 'add-symbol', device: 'pkg:mcu', x: 0, y: 0 });
    expect(documents).toEqual([]);
    expect(model.getValue().sheet.symbols).toHaveLength(1);
  });

  it('starts from an empty sheet or from .sch text and rejects invalid text', () => {
    const empty = new DocumentModel();
    expect(empty.getValue()).toEqual({
      version: 1,
      sheet: { symbols: [], wires: [], junctions: [] },
    });
    expect(empty.getCanUndo()).toBe(false);

    const text = JSON.stringify(documentOf({}));
    expect(new DocumentModel({ value: text }).getValue()).toEqual(documentOf({}));
    expect(() => new DocumentModel({ value: '{"version":2}' })).toThrow(SchematicError);
  });

  it('ignores wire adds with fewer than two points', () => {
    const model = createModel(documentOf({}));
    expect(() => model.addWire([{ x: 0, y: 0 }])).toThrow(SchematicError);
    expect(model.getValue().sheet.wires).toEqual([]);
  });

  it('resets history when setValue replaces the content', () => {
    const model = createModel(
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
    model.moveTargets([{ kind: 'symbol', id: '00000003-41e6-4a4c-869a-82a4cd304787' }], 10, 0);
    expect(model.getCanUndo()).toBe(true);

    const next = documentOf({});
    model.setValue(next);
    expect(model.getValue()).toBe(next);
    expect(model.getCanUndo()).toBe(false);
    expect(model.getLastError()).toBeUndefined();
  });

  it('swaps the document as one undoable edit through setValue', () => {
    const model = createModel(
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

    model.setValue(next, { keepHistory: true });
    expect(model.getValue().sheet.symbols.map((symbol) => symbol.id)).toEqual([
      '00000004-dfe1-4ed9-83d0-30ddf7887781',
    ]);
    expect(model.getCanUndo()).toBe(true);

    model.undo();
    expect(model.getValue().sheet.symbols.map((symbol) => symbol.id)).toEqual([
      '00000003-41e6-4a4c-869a-82a4cd304787',
    ]);
  });

  it('groups edits into one history step with transaction', () => {
    const model = createModel(documentOf({}));
    model.transaction(() => {
      model.addWire([
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ]);
      model.applyCommand({ type: 'add-symbol', device: 'pkg:mcu', x: 10, y: 0 });
    });
    expect(model.getValue().sheet.wires).toHaveLength(1);
    expect(model.getValue().sheet.symbols).toHaveLength(1);
    model.undo();
    expect(model.getValue().sheet.wires).toHaveLength(0);
    expect(model.getValue().sheet.symbols).toHaveLength(0);
  });

  it('rolls back the whole transaction when one edit fails', () => {
    const model = createModel(documentOf({}));
    expect(() =>
      model.transaction(() => {
        model.applyCommand({ type: 'add-symbol', device: 'pkg:mcu', x: 10, y: 0 });
        model.applyCommand({ type: 'remove-symbol', id: 'missing' });
      }),
    ).toThrow(SchematicError);
    expect(model.getValue().sheet.symbols).toEqual([]);
    expect(model.getCanUndo()).toBe(false);
    expect(model.getLastError()).toBeInstanceOf(SchematicError);
  });

  it('returns void from command methods', () => {
    const model = createModel(
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
    expect(model.moveTargets(selection, 1, 1)).toBeUndefined();
    expect(
      model.applyCommand({ type: 'remove-symbol', id: '00000003-41e6-4a4c-869a-82a4cd304787' }),
    ).toBeUndefined();
  });

  describe('wire segment drag', () => {
    it('slides a free segment with both of its vertices', () => {
      const model = createModel(
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

      model.moveWireSegment('00000006-9cf4-407f-8900-09a16d33a38c', 0, { x: 0, y: 10 });

      expect(wirePoints(model, '00000006-9cf4-407f-8900-09a16d33a38c')).toEqual([
        { x: 0, y: 10 },
        { x: 50, y: 10 },
        { x: 50, y: 40 },
      ]);
      model.undo();
      expect(wirePoints(model, '00000006-9cf4-407f-8900-09a16d33a38c')[0]).toEqual({
        x: 0,
        y: 0,
      });
    });

    it('slides the whole run of parallel segments so none of them goes diagonal', () => {
      const model = createModel(
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

      model.moveWireSegment('00000006-9cf4-407f-8900-09a16d33a38c', 0, { x: 0, y: 5 });

      expect(wirePoints(model, '00000006-9cf4-407f-8900-09a16d33a38c')).toEqual([
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
      const model = createModel(
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
        model.previewWireSegment('00000006-9cf4-407f-8900-09a16d33a38c', 0, { x: 0, y: 10 }),
      ).toEqual(expected);
      expect(
        model.previewWireSegment('00000006-9cf4-407f-8900-09a16d33a38c', 0, { x: 0, y: 0 }),
      ).toBeUndefined();

      model.moveWireSegment('00000006-9cf4-407f-8900-09a16d33a38c', 0, { x: 0, y: 10 });
      expect(wirePoints(model, '00000006-9cf4-407f-8900-09a16d33a38c')).toEqual(expected);
    });

    it('ignores unknown wires and segments', () => {
      const model = createModel(
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
      expect(() => model.moveWireSegment('nope', 0, { x: 0, y: 10 })).not.toThrow();
      expect(() =>
        model.moveWireSegment('00000006-9cf4-407f-8900-09a16d33a38c', 5, { x: 0, y: 10 }),
      ).not.toThrow();
      expect(wirePoints(model, '00000006-9cf4-407f-8900-09a16d33a38c')).toEqual([
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ]);
    });
  });

  describe('designators', () => {
    it('picks the first unused designator through the host factory', () => {
      const model = createModel(
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
      expect(model.nextDesignator('pkg:mcu')).toBe('U2');

      const custom = new DocumentModel({
        value: documentOf({}),
        devices,
        createDesignator: (device) => (device === 'pkg:mcu' ? 'IC1' : 'X1'),
      });
      expect(custom.nextDesignator('pkg:mcu')).toBe('IC1');
    });

    it('takes the prefix from the device definition by default', () => {
      const model = createModel(
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
      expect(model.nextDesignator('pkg:resistor')).toBe('R3');
      expect(model.nextDesignator('pkg:mcu')).toBe('U1');
      // Unknown devices still get the global default prefix.
      expect(model.nextDesignator('pkg:unknown')).toBe('U1');
    });
  });

  describe('clipboard', () => {
    const mcuId = '00000003-41e6-4a4c-869a-82a4cd304787';
    const labelId = '00000005-1f4e-4b1b-9a3a-0f0c2c5c7e21';
    const throughWireId = '00000006-9cf4-407f-8900-09a16d33a38c';
    const branchWireId = '00000007-a914-47d5-84d1-8bafbe533ffb';
    const junctionId = '00000001-516c-48ac-8128-07f98c98ee13';

    function sourceDocument(): SchematicDocument {
      return documentOf({
        symbols: [
          {
            id: mcuId,
            device: 'pkg:mcu',
            x: 10,
            y: 20,
            rotation: 90,
            properties: { label: 'CPU' },
            reference: { x: 3, y: 4 },
            designator: 'U7',
          },
          { id: labelId, device: LABEL_DEVICE, x: 30, y: 20, rotation: 0, net: 'CLK' },
        ],
        wires: [
          {
            id: throughWireId,
            points: [
              { x: 0, y: 0 },
              { x: 50, y: 0 },
            ],
          },
          {
            id: branchWireId,
            points: [
              { x: 50, y: 0 },
              { x: 50, y: 50 },
            ],
          },
        ],
        junctions: [{ id: junctionId, x: 50, y: 0, wires: [throughWireId, branchWireId] }],
      });
    }

    function copyEverything(model: DocumentModel): ReturnType<DocumentModel['copy']> {
      return model.copy([
        { kind: 'symbol', id: mcuId },
        { kind: 'symbol', id: labelId },
        { kind: 'wire', id: throughWireId },
        { kind: 'wire', id: branchWireId },
        { kind: 'junction', id: junctionId },
      ]);
    }

    it('pastes into an empty document keeping geometry offsets, rotation, properties and net', () => {
      const payload = copyEverything(createModel(sourceDocument()));
      expect(payload).toBeDefined();
      if (payload === undefined) {
        throw new Error('expected a payload');
      }

      const model = createModel(documentOf({}));
      const targets = model.paste(payload, { at: { x: 100, y: 200 } });

      const symbols = model.getValue().sheet.symbols;
      expect(symbols).toHaveLength(2);
      expect(symbols[0]).toMatchObject({
        device: 'pkg:mcu',
        x: 110,
        y: 220,
        rotation: 90,
        properties: { label: 'CPU' },
        reference: { x: 3, y: 4 },
        designator: 'U1',
      });
      expect(symbols[1]).toMatchObject({ device: LABEL_DEVICE, x: 130, y: 220, net: 'CLK' });
      expect(symbols[1]?.designator).toBeUndefined();
      expect(symbols[1]?.id).not.toBe(labelId);
      expect(model.getValue().sheet.wires[0]?.points).toEqual([
        { x: 100, y: 200 },
        { x: 150, y: 200 },
      ]);
      expect(targets).toEqual([
        { kind: 'symbol', id: symbols[0]?.id },
        { kind: 'symbol', id: symbols[1]?.id },
        { kind: 'wire', id: model.getValue().sheet.wires[0]?.id },
        { kind: 'wire', id: model.getValue().sheet.wires[1]?.id },
      ]);
    });

    it('regenerates ids and designators and points junctions at the pasted wires', () => {
      const model = createModel(sourceDocument());
      const payload = copyEverything(model);
      if (payload === undefined) {
        throw new Error('expected a payload');
      }

      const targets = model.paste(payload, { offset: { x: 0, y: 0 } });

      const { symbols, wires, junctions } = model.getValue().sheet;
      expect(symbols).toHaveLength(4);
      expect(wires).toHaveLength(4);
      expect(junctions).toHaveLength(2);
      expect(new Set(symbols.map((symbol) => symbol.id)).size).toBe(4);
      expect(new Set(wires.map((wire) => wire.id)).size).toBe(4);
      expect(new Set(junctions.map((junction) => junction.id)).size).toBe(2);

      const pastedSymbolIds = new Set(
        targets.flatMap((target) => (target.kind === 'symbol' ? [target.id] : [])),
      );
      const pastedWireIds = new Set(
        targets.flatMap((target) => (target.kind === 'wire' ? [target.id] : [])),
      );
      const pastedSymbols = symbols.filter((symbol) => pastedSymbolIds.has(symbol.id));
      // The copied component keeps its old designator ('U7') on the original; the paste gets the
      // first free one.
      expect(pastedSymbols.map((symbol) => symbol.designator)).toEqual(['U1', undefined]);

      const pastedJunction = junctions.find((junction) =>
        junction.wires.every((wireId) => pastedWireIds.has(wireId)),
      );
      expect(pastedJunction?.wires).toHaveLength(2);
      expect(pastedJunction?.wires).not.toContain(throughWireId);
    });

    it('commits a paste as one history step', () => {
      const model = createModel(sourceDocument());
      const before = model.getValue();
      const payload = copyEverything(model);
      if (payload === undefined) {
        throw new Error('expected a payload');
      }

      model.paste(payload);
      expect(model.getValue()).not.toBe(before);
      expect(model.getCanUndo()).toBe(true);

      model.undo();
      expect(model.getValue()).toBe(before);
      expect(model.getCanRedo()).toBe(true);
    });

    it('ignores empty payloads without touching history', () => {
      const model = createModel(documentOf({}));
      const empty: SchematicClipboard = {
        format: SCHEMATIC_CLIPBOARD_FORMAT,
        version: SCHEMATIC_CLIPBOARD_VERSION,
        symbols: [],
        wires: [],
        junctions: [],
      };
      expect(model.paste(empty)).toEqual([]);
      expect(model.getCanUndo()).toBe(false);
    });

    it('cuts as one history step and restores elements and designators on undo', () => {
      const model = createModel(sourceDocument());
      const clipboard = model.cut([
        { kind: 'symbol', id: mcuId },
        { kind: 'wire', id: throughWireId },
      ]);

      expect(clipboard?.symbols).toHaveLength(1);
      expect(model.getValue().sheet.symbols.map((symbol) => symbol.designator)).toEqual([
        undefined,
      ]);
      expect(model.getValue().sheet.wires).toHaveLength(1);
      expect(model.getCanUndo()).toBe(true);

      model.undo();
      expect(model.getValue().sheet.symbols.map((symbol) => symbol.designator)).toEqual([
        'U7',
        undefined,
      ]);
      expect(model.getValue().sheet.wires).toHaveLength(2);
    });

    it('copies nothing and deletes nothing when the selection has no elements', () => {
      const model = createModel(sourceDocument());
      expect(model.cut([])).toBeUndefined();
      expect(model.cut([{ kind: 'symbol', id: 'missing' }])).toBeUndefined();
      expect(model.getCanUndo()).toBe(false);
      expect(model.getValue().sheet.symbols).toHaveLength(2);
    });

    it('duplicates one grid step away and leaves the clipboard alone', () => {
      const model = createModel(
        documentOf({
          symbols: [{ id: mcuId, device: 'pkg:mcu', x: 0, y: 0, rotation: 0, designator: 'U1' }],
        }),
      );

      const targets = model.duplicate([{ kind: 'symbol', id: mcuId }]);

      expect(targets).toHaveLength(1);
      const symbols = model.getValue().sheet.symbols;
      expect(symbols).toHaveLength(2);
      expect(symbols[1]).toMatchObject({ x: 10, y: 10, designator: 'U2' });
      expect(model.getCanUndo()).toBe(true);

      model.undo();
      expect(model.getValue().sheet.symbols).toHaveLength(1);
    });
  });
});
