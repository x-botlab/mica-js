import { describe, expect, it } from 'vitest';
import {
  LABEL_STUB_LENGTH,
  labelStubAt,
  orthogonalWaypoints,
  snapDragOffset,
  snapForWire,
  wireBodyPointAt,
  wireWaypoints,
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
          symbols: [
            {
              id: '00000001-a735-469a-8b9b-a233ec702fe3',
              device: 'pkg:ne555',
              x: 100,
              y: 100,
              rotation,
            },
          ],
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
          id: '00000002-9cf4-407f-8900-09a16d33a38c',
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

  it('keeps an off-grid anchor in its row when the drag is horizontal', () => {
    // Anchor at y = 197 must not snap to 200 just because the pointer wobbled by 1 unit.
    expect(snapDragOffset({ x: 483, y: 197 }, { x: 10, y: 10 }, { x: 58, y: 11 }, display)).toEqual(
      { x: 47, y: 0 },
    );
  });

  it('keeps an off-grid anchor in its column when the drag is vertical', () => {
    expect(snapDragOffset({ x: 483, y: 197 }, { x: 10, y: 10 }, { x: 12, y: 53 }, display)).toEqual(
      { x: 0, y: 43 },
    );
  });
});

function wireContext(wires: readonly unknown[]): SnapContext {
  return {
    controller: new SchematicEditorController({
      document: parseSchematic({
        version: 1,
        sheet: { symbols: [], wires, junctions: [] },
      }),
      devices,
    }),
    devices,
    tolerance: 4,
  };
}

describe('snapForWire', () => {
  const wire = {
    id: '00000002-9cf4-407f-8900-09a16d33a38c',
    points: [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    ],
  };

  it('projects onto the closest point of a nearby wire', () => {
    // 3 units above the run: inside the 8-unit snap radius, so it lands on the wire (y = 0)
    // while x keeps the grid instead of the raw 47.
    expect(snapForWire(wireContext([wire]), { x: 47, y: 3 })).toEqual({ x: 50, y: 0 });
  });

  it('keeps the grid along a vertical host', () => {
    const vertical = {
      id: '00000003-b1f0-4a57-8bd0-31f3b6ecb53f',
      points: [
        { x: 40, y: 0 },
        { x: 40, y: 100 },
      ],
    };
    // 3 units beside the run: x takes the host's own 40, y snaps from 47 to the grid.
    expect(snapForWire(wireContext([vertical]), { x: 43, y: 47 })).toEqual({ x: 40, y: 50 });
  });

  it('keeps the grid when no wire is near', () => {
    expect(snapForWire(wireContext([wire]), { x: 47, y: 30 })).toEqual({ x: 50, y: 30 });
  });

  it('prefers a wire endpoint over the wire body', () => {
    expect(snapForWire(wireContext([wire]), { x: 2, y: 1 })).toEqual({ x: 0, y: 0 });
  });

  it('leaves the projection unrounded when snapping is off', () => {
    const context = wireContext([wire]);
    context.controller.setDisplayOptions({ snap: false });
    expect(snapForWire(context, { x: 47, y: 3 })).toEqual({ x: 47, y: 0 });
  });
});

describe('wireBodyPointAt', () => {
  const shortRun = {
    id: '00000004-6a3f-4f0e-9d6a-2a7b1f9f0f2e',
    points: [
      { x: 0, y: 0 },
      { x: 17, y: 0 },
    ],
  };

  it('snaps along the run when the grid point still sits on it', () => {
    expect(wireBodyPointAt(wireContext([shortRun]), { x: 13, y: 3 })).toEqual({ x: 10, y: 0 });
  });

  it('keeps the projection when the grid falls past the end of the run', () => {
    // The run ends at x = 17 between grid lines: 20 would leave the host, so stay at 16.
    expect(wireBodyPointAt(wireContext([shortRun]), { x: 16, y: 3 })).toEqual({ x: 16, y: 0 });
  });

  it('returns undefined when every run is out of reach', () => {
    expect(wireBodyPointAt(wireContext([]), { x: 47, y: 3 })).toBeUndefined();
  });
});

describe('wireWaypoints', () => {
  it('matches the plain elbow when no wire is under the target', () => {
    expect(wireWaypoints({ x: 0, y: 0 }, { x: 60, y: 20 }, undefined)).toEqual(
      orthogonalWaypoints({ x: 0, y: 0 }, { x: 60, y: 20 }),
    );
  });

  it('approaches a vertical wire horizontally', () => {
    // Landing on x = 60 must keep the last leg horizontal so it taps in perpendicularly.
    expect(wireWaypoints({ x: 0, y: 0 }, { x: 60, y: 25 }, 'vertical')).toEqual([
      { x: 0, y: 25 },
      { x: 60, y: 25 },
    ]);
  });

  it('approaches a horizontal wire vertically', () => {
    expect(wireWaypoints({ x: 0, y: 0 }, { x: 60, y: 25 }, 'horizontal')).toEqual([
      { x: 60, y: 0 },
      { x: 60, y: 25 },
    ]);
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
