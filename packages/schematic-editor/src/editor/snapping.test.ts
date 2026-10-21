import { describe, expect, it } from 'vitest';
import {
  LABEL_STUB_LENGTH,
  labelStubAt,
  orthogonalWaypoints,
  snapDragOffset,
  type SnapContext,
} from './snapping';
import { SchematicEditorController } from '../controller/controller';
import { createDeviceRegistry, parseSchematic } from '@mica-js/core/schematic';
import { DEFAULT_DISPLAY_OPTIONS } from '../controller/types';

const devices = createDeviceRegistry([
  {
    packageId: 'pkg',
    devices: [
      {
        id: 'ne555',
        symbol: {
          name: 'NE555',
          bounds: { x: -40, y: -50, width: 80, height: 100 },
          pins: {
            TRIG: { x: -60, y: -20, side: 'left' },
            OUT: { x: 60, y: 0, side: 'right' },
            VCC: { x: 0, y: -70, side: 'top' },
            GND: { x: 0, y: 70 },
          },
        },
      },
    ],
  },
]);

function contextAt(rotation: number, wires: readonly unknown[] = []): SnapContext {
  return {
    controller: new SchematicEditorController({
      document: parseSchematic({
        version: 1,
        sheet: {
          symbols: [{ id: 'U1', device: 'pkg:ne555', x: 100, y: 100, rotation }],
          wires,
          junctions: [],
        },
      }),
      devices,
    }),
    devices,
    tolerance: 4,
  };
}

describe('labelStubAt', () => {
  it('adds a lead in the pin direction when a label lands on a pin', () => {
    // TRIG sits on the left edge, so the lead grows to the left.
    expect(labelStubAt(contextAt(0), { x: 40, y: 80 })).toEqual({
      pin: { x: 40, y: 80 },
      anchor: { x: 40 - LABEL_STUB_LENGTH, y: 80 },
      // Text grows to the left so it never lands on the symbol.
      rotation: 180,
      wire: [
        { x: 40, y: 80 },
        { x: 40 - LABEL_STUB_LENGTH, y: 80 },
      ],
    });
  });

  it('follows the symbol rotation', () => {
    // Rotated 90° the left pin points up, so the lead grows upwards.
    const stub = labelStubAt(contextAt(90), { x: 120, y: 40 });
    expect(stub?.pin).toEqual({ x: 120, y: 40 });
    expect(stub?.anchor.x).toBeCloseTo(120, 9);
    expect(stub?.anchor.y).toBeCloseTo(40 - LABEL_STUB_LENGTH, 9);
    expect(stub?.rotation).toBe(270);
  });

  it('infers the side for pins that do not declare one', () => {
    // GND sits on the bottom edge without an explicit side.
    const stub = labelStubAt(contextAt(0), { x: 100, y: 170 });
    expect(stub?.anchor).toEqual({ x: 100, y: 170 + LABEL_STUB_LENGTH });
    expect(stub?.rotation).toBe(90);
  });

  it('returns undefined away from pins', () => {
    expect(labelStubAt(contextAt(0), { x: 100, y: 100 })).toBeUndefined();
  });

  it('skips the lead when a wire already reaches the anchor', () => {
    // The existing wire covers the whole lead, so the label just binds to it.
    const stub = labelStubAt(
      contextAt(0, [
        {
          id: 'w1',
          points: [
            { x: 40, y: 80 },
            { x: 0, y: 80 },
          ],
        },
      ]),
      { x: 40, y: 80 },
    );
    expect(stub?.anchor).toEqual({ x: 40 - LABEL_STUB_LENGTH, y: 80 });
    expect(stub?.wire).toBeUndefined();
  });
});

describe('snapDragOffset', () => {
  const display = { ...DEFAULT_DISPLAY_OPTIONS, gridSize: 10 };

  it('lands the dragged anchor on the nearest grid intersection', () => {
    // Anchor starts off-grid at 483,197 and is dragged by (48,43).
    expect(snapDragOffset({ x: 483, y: 197 }, { x: 10, y: 10 }, { x: 58, y: 53 }, display)).toEqual(
      {
        x: 47,
        y: 43,
      },
    );
  });

  it('returns the raw delta when snapping is off', () => {
    const loose = { ...display, snap: false };
    expect(snapDragOffset({ x: 483, y: 197 }, { x: 10, y: 10 }, { x: 58, y: 53 }, loose)).toEqual({
      x: 48,
      y: 43,
    });
  });

  it('stays exact when the anchor is already on the grid', () => {
    expect(snapDragOffset({ x: 480, y: 200 }, { x: 0, y: 0 }, { x: 20, y: 30 }, display)).toEqual({
      x: 20,
      y: 30,
    });
  });
});

describe('orthogonalWaypoints', () => {
  it('returns the target alone when already aligned', () => {
    expect(orthogonalWaypoints({ x: 0, y: 0 }, { x: 0, y: 40 })).toEqual([{ x: 0, y: 40 }]);
    expect(orthogonalWaypoints({ x: 0, y: 0 }, { x: 40, y: 0 })).toEqual([{ x: 40, y: 0 }]);
  });

  it('routes horizontally first when the horizontal delta dominates', () => {
    expect(orthogonalWaypoints({ x: 0, y: 0 }, { x: 60, y: 20 })).toEqual([
      { x: 60, y: 0 },
      { x: 60, y: 20 },
    ]);
  });

  it('routes vertically first when the vertical delta dominates', () => {
    expect(orthogonalWaypoints({ x: 0, y: 0 }, { x: 20, y: 60 })).toEqual([
      { x: 0, y: 60 },
      { x: 20, y: 60 },
    ]);
  });

  it('only produces horizontal or vertical segments', () => {
    const path = [{ x: 10, y: 10 }, ...orthogonalWaypoints({ x: 10, y: 10 }, { x: 70, y: 40 })];
    for (let index = 1; index < path.length; index += 1) {
      const previous = path[index - 1]!;
      const current = path[index]!;
      expect(previous.x === current.x || previous.y === current.y).toBe(true);
    }
  });
});
