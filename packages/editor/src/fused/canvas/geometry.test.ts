import { describe, expect, it } from 'vitest';
import type { FusedDocument, FusedInstance, Geometry2D } from '@mica-js/document/fused';
import {
  findBodyOverlaps,
  designatorPosition,
  localToScene,
  pickInstance,
  pickAnnotation,
  pickDoubleClickTarget,
  pickPins,
  pickWireSegment,
  pickText,
  referenceBounds,
  textDragOffset,
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

  it('picks a rotated terminal symbol and its label using its electrical anchor', () => {
    const doc: FusedDocument = {
      ...document(),
      nodes: [{ id: 'anchor', kind: 'free', x: 10, y: 20 }],
      references: [
        {
          id: 'power',
          target: { kind: 'node', node: 'anchor' },
          voltage: 5,
          symbol: 'power',
          rotation: 90,
          label: { name: 'VCC', offset: { x: 3, y: -1 } },
        },
      ],
    };
    expect(pickAnnotation(doc, devices(), { x: 11, y: 20 }, 0.01)).toEqual({
      kind: 'reference',
      id: 'power',
    });
    expect(pickAnnotation(doc, devices(), { x: 11, y: 23.5 }, 0.01)).toEqual({
      kind: 'reference',
      id: 'power',
    });
    expect(pickAnnotation(doc, devices(), { x: 9, y: 19 }, 0.01)).toBeUndefined();
    const labeled: FusedDocument = {
      ...doc,
      references: [],
      labels: [{ id: 'net', target: { kind: 'node', node: 'anchor' }, name: 'SIGNAL' }],
    };
    expect(pickAnnotation(labeled, devices(), { x: 11, y: 19.5 }, 0.01)).toEqual({
      kind: 'label',
      id: 'net',
    });
  });

  it('picks the closest nonzero wire leg with its persisted segment index', () => {
    const doc: FusedDocument = {
      ...document(),
      nodes: [
        { id: 'a', kind: 'free', x: 0, y: 0 },
        { id: 'b', kind: 'free', x: 20, y: 10 },
      ],
      wires: [
        {
          id: 'wire',
          from: { kind: 'node', node: 'a' },
          to: { kind: 'node', node: 'b' },
          bends: [
            { x: 0, y: 0 },
            { x: 10, y: 0 },
            { x: 10, y: 10 },
          ],
        },
      ],
    };
    expect(pickWireSegment(doc, devices(), { x: 10.1, y: 5 }, 0.2)).toMatchObject({
      wireId: 'wire',
      segment: 2,
    });
    expect(pickWireSegment(doc, devices(), { x: 5, y: 5 }, 0.2)).toBeUndefined();
  });

  it('picks and moves a designator independently in a rotated flexible device', () => {
    const flexible: Geometry2D = { ...geometry, sizing: 'flexible' };
    const placed: FusedInstance = {
      ...instance('a', 10, 20, 90),
      designator: 'U1',
      placement: { x: 10, y: 20, rotation: 90, width: 20, height: 15 },
    };
    const doc = document(placed);
    const target = { kind: 'designator' as const, id: 'a' };
    const offset = textDragOffset(doc, devices(flexible), target, { x: -6, y: 4 });
    expect(offset.x).toBeCloseTo(2);
    expect(offset.y).toBeCloseTo(2);
    const anchor = designatorPosition(placed, flexible);
    expect(pickText(doc, devices(flexible), { x: anchor.x + 0.5, y: anchor.y - 1 }, 10)).toEqual(
      target,
    );
    const moved = designatorPosition({ ...placed, designatorOffset: offset }, flexible);
    expect(moved.x - anchor.x).toBeCloseTo(-6);
    expect(moved.y - anchor.y).toBeCloseTo(4);
  });

  it('converts a rotated terminal net-name drag without moving its symbol', () => {
    const doc: FusedDocument = {
      ...document(),
      nodes: [{ id: 'a', kind: 'free', x: 10, y: 20 }],
      references: [
        {
          id: 'ref',
          target: { kind: 'node', node: 'a' },
          voltage: 5,
          rotation: 90,
          label: { name: 'VCC', offset: { x: 3, y: -1 } },
        },
      ],
    };
    const target = { kind: 'reference' as const, id: 'ref' };
    expect(pickText(doc, devices(), { x: 11, y: 23.5 }, 10)).toEqual(target);
    const offset = textDragOffset(doc, devices(), target, { x: 0, y: 2 });
    expect(offset.x).toBeCloseTo(5);
    expect(offset.y).toBeCloseTo(-1);
  });

  it('keeps ground picking confined to the symbol without an invisible label hit area', () => {
    const ground = {
      id: 'gnd',
      target: { kind: 'node' as const, node: 'a' },
      voltage: 0,
      symbol: 'ground' as const,
      label: { name: 'GND', offset: { x: 10, y: -1 } },
    };
    const doc: FusedDocument = {
      ...document(),
      nodes: [{ id: 'a', kind: 'free', x: 0, y: 0 }],
      references: [ground],
    };
    expect(referenceBounds(ground)).toEqual({ x: -0.7, y: -1.8, width: 1.4, height: 1.8 });
    expect(pickAnnotation(doc, devices(), { x: 0, y: -1 }, 0.01)).toEqual({
      kind: 'reference',
      id: 'gnd',
    });
    expect(pickText(doc, devices(), { x: 10.5, y: -1.2 }, 10)).toBeUndefined();
    expect(pickAnnotation(doc, devices(), { x: 10.5, y: -1.2 }, 0.01)).toBeUndefined();
  });

  it('picks the same power, ground, label and device objects a double click configures', () => {
    const doc: FusedDocument = {
      ...document({ ...instance('body', 40, 40), designator: 'U1' }),
      nodes: [
        { id: 'power-node', kind: 'free', x: 10, y: 20 },
        { id: 'ground-node', kind: 'free', x: 30, y: 20 },
        { id: 'label-node', kind: 'free', x: 10, y: 5 },
      ],
      references: [
        {
          id: 'power',
          target: { kind: 'node', node: 'power-node' },
          voltage: 3.3,
          symbol: 'power',
          rotation: 90,
          label: { name: 'VCC', offset: { x: 3, y: -1 } },
        },
        {
          id: 'ground',
          target: { kind: 'node', node: 'ground-node' },
          voltage: 0,
          symbol: 'ground',
        },
      ],
      labels: [{ id: 'net', target: { kind: 'node', node: 'label-node' }, name: 'SIGNAL' }],
    };
    expect(pickDoubleClickTarget(doc, devices(), { x: 11, y: 20 }, 10)).toEqual({
      kind: 'reference',
      id: 'power',
    });
    expect(pickDoubleClickTarget(doc, devices(), { x: 11, y: 23.5 }, 10)).toEqual({
      kind: 'reference',
      id: 'power',
    });
    expect(pickDoubleClickTarget(doc, devices(), { x: 30, y: 19 }, 10)).toEqual({
      kind: 'reference',
      id: 'ground',
    });
    expect(pickDoubleClickTarget(doc, devices(), { x: 11, y: 4.4 }, 10)).toEqual({
      kind: 'label',
      id: 'net',
    });
    expect(pickDoubleClickTarget(doc, devices(), { x: 40.5, y: 39 }, 10)).toEqual({
      kind: 'instance',
      id: 'body',
    });
    expect(pickDoubleClickTarget(doc, devices(), { x: 43, y: 41 }, 10)).toEqual({
      kind: 'instance',
      id: 'body',
    });
    expect(pickDoubleClickTarget(doc, devices(), { x: 100, y: 100 }, 10)).toBeUndefined();
  });

  it('lets an annotation symbol win over the device body it overlaps on double click', () => {
    const doc: FusedDocument = {
      ...document(instance('body')),
      nodes: [{ id: 'anchor', kind: 'free', x: 3, y: 1 }],
      references: [
        {
          id: 'power',
          target: { kind: 'node', node: 'anchor' },
          voltage: 3.3,
          symbol: 'power',
        },
      ],
    };
    expect(pickDoubleClickTarget(doc, devices(), { x: 3, y: 1 }, 10)).toEqual({
      kind: 'reference',
      id: 'power',
    });
  });
});
