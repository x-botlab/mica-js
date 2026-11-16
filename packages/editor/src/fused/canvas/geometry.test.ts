import { describe, expect, it } from 'vitest';
import type { FusedDocument, FusedInstance, Geometry2D } from '@mica-js/document/fused';
import {
  findBodyOverlaps,
  localToScene,
  pickInstance,
  pickPins,
  sceneToLocal,
  type ICanvasDevice,
} from './geometry';

const geometry: Geometry2D = {
  sizing: 'physical',
  bounds: { x: -2, y: -1, width: 10, height: 5 },
  bodyBounds: { x: 0, y: 0, width: 6, height: 2 },
  pins: { p: { position: { x: 0, y: 0 }, outward: { x: -1, y: 0 } } },
};
function instance(id: string, x = 0, y = 0, rotation = 0): FusedInstance {
  return { id, device: 'test:device', placement: { x, y, rotation } };
}
function document(...instances: FusedInstance[]): FusedDocument {
  return {
    version: 2,
    dependencies: {},
    instances,
    nodes: [],
    wires: [],
    labels: [],
    references: [],
  };
}
function devices(value = geometry): ReadonlyMap<string, ICanvasDevice> {
  return new Map([
    [
      'test:device',
      {
        geometry: value,
        manifest: {
          publisher: 'test',
          name: 'device',
          version: '1.0.0',
          displayName: 'Device',
          engines: { mica: '^1.0.0' },
          view2d: { geometry: value },
        },
      },
    ],
  ]);
}

describe('fused canvas geometry', () => {
  it('uses the same rotated local origin for drawing, pins and business input', () => {
    const placed = instance('a', 10, 20, 90);
    const point = localToScene(placed, geometry, { x: 4, y: 2 });
    expect(point.x).toBeCloseTo(8);
    expect(point.y).toBeCloseTo(24);
    const local = sceneToLocal(placed, geometry, point);
    expect(local.x).toBeCloseTo(4);
    expect(local.y).toBeCloseTo(2);
  });
  it('maps flexible bounds to the resized placement before rotating', () => {
    const flexible: Geometry2D = { ...geometry, sizing: 'flexible' };
    const placed = {
      ...instance('a', 10, 20, 90),
      placement: { x: 10, y: 20, rotation: 90, width: 20, height: 15 },
    };
    const point = localToScene(placed, flexible, { x: 3, y: 1.5 });
    expect(point.x).toBeCloseTo(2.5);
    expect(point.y).toBeCloseTo(30);
    const local = sceneToLocal(placed, flexible, point);
    expect(local.x).toBeCloseTo(3);
    expect(local.y).toBeCloseTo(1.5);
  });
  it('keeps coincident pins as distinct candidates and skips hidden business targets', () => {
    const doc = document(instance('a'), instance('b'));
    expect(pickPins(doc, devices(), { x: 0, y: 0 }, 0.1).map((hit) => hit.endpoint)).toEqual([
      { kind: 'pin', instance: 'a', pin: 'p' },
      { kind: 'pin', instance: 'b', pin: 'p' },
    ]);
    expect(pickInstance(doc, devices(), { x: 0, y: 0 }, (value) => value.id === 'a')?.id).toBe('a');
    expect(pickInstance(doc, devices(), { x: 0, y: 0 }, () => false)).toBeUndefined();
  });
  it('checks actual bodies, allows touching edges and ignores overlapping drawing bounds', () => {
    expect(findBodyOverlaps(document(instance('a'), instance('b', 6)), devices())).toEqual([]);
    expect(findBodyOverlaps(document(instance('a'), instance('b', 5.9)), devices())).toHaveLength(
      1,
    );
  });
  it('does not confuse rotated bounding boxes with overlapping bodies', () => {
    const narrow = { ...geometry, bodyBounds: { x: 0, y: 0, width: 10, height: 1 } };
    expect(
      findBodyOverlaps(document(instance('a', 0, 0, 45), instance('b', 0, 2, 45)), devices(narrow)),
    ).toEqual([]);
    expect(
      findBodyOverlaps(
        document(instance('a', 0, 0, 45), instance('b', 0, 0.5, 45)),
        devices(narrow),
      ),
    ).toHaveLength(1);
  });
});
