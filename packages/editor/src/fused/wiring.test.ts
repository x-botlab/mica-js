import { describe, expect, it } from 'vitest';
import type { ConnectionWire, FusedDocument, Point2D } from '@mica-js/document/fused';
import { DeviceCache } from './devices';
import {
  endpointPoint,
  hasWireConnection,
  isOrthogonalPolyline,
  materializeAnchor,
  moveWireSegment,
  moveReference,
  orthogonalPath,
  routeDocumentWires,
  wirePolyline,
} from './wiring';
import type { WiringDevices } from './wiring';
import { connectedDocument, defaultPackages } from './document/test-helpers';
import { moveInstances } from './document/edits';

const LED_ID = '11111111-1111-4111-8111-111111111111';
const SWITCH_ID = '22222222-2222-4222-8222-222222222222';
const WIRE_ID = '33333333-3333-4333-8333-333333333333';

function idFactory(): () => string {
  let count = 0;
  return () => {
    count += 1;
    return `aaaaaaaa-aaaa-4aaa-8aaa-${String(count).padStart(12, '0')}`;
  };
}

async function prepare(document: FusedDocument): Promise<WiringDevices> {
  const packages = defaultPackages();
  const cache = new DeviceCache(packages.registry);
  const devices = await cache.prepareDocument(document);
  cache.dispose();
  return devices;
}

function documentWith(wire: ConnectionWire): FusedDocument {
  const packages = defaultPackages();
  const document = connectedDocument(packages);
  return { ...document, wires: [wire], nodes: [] };
}

function legs(points: readonly Point2D[]): boolean {
  return isOrthogonalPolyline(points);
}

describe('hasWireConnection', () => {
  it('recognizes both connected ends but leaves unused and coincident endpoints available', () => {
    const document = connectedDocument(defaultPackages());
    const wire = document.wires[0]!;
    expect(hasWireConnection(document, wire.from)).toBe(true);
    expect(hasWireConnection(document, wire.to)).toBe(true);
    expect(hasWireConnection(document, document.references[0]!.target)).toBe(false);
    expect(hasWireConnection(document, { kind: 'node', node: 'unwired' })).toBe(false);
    const free: FusedDocument = {
      ...document,
      nodes: [
        { id: 'unwired', kind: 'free', x: 0, y: 0 },
        { id: 'other', kind: 'free', x: 0, y: 0 },
      ],
      wires: [{ ...wire, from: { kind: 'node', node: 'other' } }],
    };
    expect(hasWireConnection(free, { kind: 'node', node: 'unwired' })).toBe(false);
  });
});

describe('orthogonalPath', () => {
  it('keeps aligned points and returns an empty path for no input', () => {
    expect(orthogonalPath([])).toEqual([]);
    expect(orthogonalPath([{ x: 3, y: 4 }])).toEqual([{ x: 3, y: 4 }]);
    expect(
      orthogonalPath([
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
      ]),
    ).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    ]);
  });

  describe('moveWireSegment', () => {
    function wired(bends: readonly Point2D[], end = { x: 20, y: 10 }): FusedDocument {
      return {
        ...documentWith({
          id: WIRE_ID,
          from: { kind: 'node', node: 'a' },
          to: { kind: 'node', node: 'b' },
          bends,
        }),
        nodes: [
          { id: 'a', kind: 'free', x: 0, y: 0 },
          { id: 'b', kind: 'free', ...end },
        ],
      };
    }

    it('slides only the chosen interior segment along its normal', () => {
      const document = wired([
        { x: 10, y: 0 },
        { x: 10, y: 10 },
      ]);
      const moved = moveWireSegment(document, new Map(), WIRE_ID, 1, { x: 3, y: 9 });
      expect(moved.wires[0]?.bends).toEqual([
        { x: 13, y: 0 },
        { x: 13, y: 10 },
      ]);
      expect(moved.nodes).toBe(document.nodes);
      expect(moved.wires[0]?.from).toBe(document.wires[0]?.from);
      expect(moved.wires[0]?.to).toBe(document.wires[0]?.to);
      expect(document.wires[0]?.bends).toEqual([
        { x: 10, y: 0 },
        { x: 10, y: 10 },
      ]);
    });

    describe('moveReference', () => {
      it('keeps a pin connected through a new node and wire, then reuses that node on later moves', async () => {
        const document = connectedDocument(defaultPackages());
        const devices = await prepare(document);
        const reference = document.references[0]!;
        const moved = moveReference(document, devices, reference.id, { x: 70, y: 30 }, idFactory());
        const target = moved.references[0]!.target;
        expect(target.kind).toBe('node');
        expect(moved.nodes).toHaveLength(document.nodes.length + 1);
        expect(moved.wires.at(-1)).toMatchObject({ from: reference.target, to: target });
        expect(moved.instances).toBe(document.instances);
        const again = moveReference(moved, devices, reference.id, { x: 75, y: 35 }, idFactory());
        expect(again.nodes).toHaveLength(moved.nodes.length);
        expect(again.wires).toHaveLength(moved.wires.length);
        expect(again.references[0]!.target).toEqual(target);
        expect(endpointPoint(again, devices, target)).toMatchObject({ x: 75, y: 35 });
        expect(
          again.wires.every((wire) => isOrthogonalPolyline(wirePolyline(again, devices, wire)!)),
        ).toBe(true);
      });

      it('leaves shared anchors and their other labels in place when a terminal is pulled away', () => {
        const referenceId = 'ref';
        const document: FusedDocument = {
          ...documentWith({
            id: WIRE_ID,
            from: { kind: 'node', node: 'a' },
            to: { kind: 'node', node: 'b' },
            bends: [],
          }),
          nodes: [
            { id: 'a', kind: 'junction', x: 0, y: 0 },
            { id: 'b', kind: 'free', x: 10, y: 0 },
          ],
          labels: [{ id: 'label', target: { kind: 'node', node: 'a' }, name: 'VCC' }],
          references: [
            {
              id: referenceId,
              target: { kind: 'node', node: 'a' },
              voltage: 5,
              symbol: 'power',
              rotation: 90,
            },
          ],
        };
        const moved = moveReference(document, new Map(), referenceId, { x: -5, y: 5 }, idFactory());
        expect(moved.nodes.find((value) => value.id === 'a')).toEqual(document.nodes[0]);
        expect(moved.labels).toBe(document.labels);
        expect(moved.wires[0]).toBe(document.wires[0]);
        expect(moved.wires.at(-1)?.from).toEqual({ kind: 'node', node: 'a' });
        expect(moved.references[0]?.rotation).toBe(90);
        expect(moveReference(document, new Map(), referenceId, { x: 0, y: 0 }, idFactory())).toBe(
          document,
        );
      });
    });

    it('adds doglegs rather than moving either anchor of a straight connected wire', () => {
      const document = wired([], { x: 20, y: 0 });
      const moved = moveWireSegment(document, new Map(), WIRE_ID, 0, { x: 0, y: 5 });
      expect(wirePolyline(moved, new Map(), moved.wires[0]!)).toEqual([
        { x: 0, y: 0 },
        { x: 0, y: 5 },
        { x: 20, y: 5 },
        { x: 20, y: 0 },
      ]);
      expect(moved.nodes).toBe(document.nodes);
    });

    it('ignores tangential motion and rejects stale segment indices', () => {
      const document = wired([], { x: 20, y: 0 });
      expect(moveWireSegment(document, new Map(), WIRE_ID, 0, { x: 5, y: 0 })).toBe(document);
      expect(() => moveWireSegment(document, new Map(), WIRE_ID, 4, { x: 0, y: 5 })).toThrow(
        'Invalid wire segment',
      );
    });
  });

  it('picks the long-axis elbow first', () => {
    expect(
      orthogonalPath([
        { x: 0, y: 0 },
        { x: 10, y: 6 },
      ]),
    ).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 6 },
    ]);
    expect(
      orthogonalPath([
        { x: 0, y: 0 },
        { x: 6, y: 10 },
      ]),
    ).toEqual([
      { x: 0, y: 0 },
      { x: 0, y: 10 },
      { x: 6, y: 10 },
    ]);
    expect(
      orthogonalPath([
        { x: 0, y: 0 },
        { x: 10, y: 10 },
      ]),
    ).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    ]);
  });

  it('collapses a retraced collinear leg', () => {
    expect(
      orthogonalPath([
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 5, y: 0 },
      ]),
    ).toEqual([
      { x: 0, y: 0 },
      { x: 5, y: 0 },
    ]);
  });

  it('reports whether a polyline is orthogonal', () => {
    expect(
      legs([
        { x: 0, y: 0 },
        { x: 0, y: 5 },
      ]),
    ).toBe(true);
    expect(
      legs([
        { x: 0, y: 0 },
        { x: 5, y: 5 },
      ]),
    ).toBe(false);
  });
});

describe('materializeAnchor', () => {
  it('passes an existing endpoint through without touching the document', async () => {
    const document = connectedDocument(defaultPackages());
    const devices = await prepare(document);
    const endpoint = { kind: 'pin' as const, instance: LED_ID, pin: 'anode' };

    const result = materializeAnchor(document, endpoint, devices, idFactory());
    expect(result.document).toBe(document);
    expect(result.endpoint).toEqual(endpoint);
  });

  it('resolves a point that lands on a pin or a node', async () => {
    const document = connectedDocument(defaultPackages());
    const devices = await prepare(document);
    const anode = endpointPoint(document, devices, {
      kind: 'pin',
      instance: LED_ID,
      pin: 'anode',
    })!;

    const onPin = materializeAnchor(document, anode, devices, idFactory());
    expect(onPin.document).toBe(document);
    expect(onPin.endpoint).toEqual({ kind: 'pin', instance: LED_ID, pin: 'anode' });

    const withNode: FusedDocument = {
      ...document,
      nodes: [{ id: '44444444-4444-4444-8444-444444444444', kind: 'free', x: 7, y: 9 }],
    };
    const onNode = materializeAnchor(withNode, { x: 7, y: 9 }, devices, idFactory());
    expect(onNode.document).toBe(withNode);
    expect(onNode.endpoint).toEqual({ kind: 'node', node: '44444444-4444-4444-8444-444444444444' });
  });

  it('creates a free node for a point away from any wire', async () => {
    const document = connectedDocument(defaultPackages());
    const devices = await prepare(document);

    const result = materializeAnchor(document, { x: 29, y: 30 }, devices, idFactory());
    expect(result.endpoint.kind).toBe('node');
    expect(result.document.nodes).toHaveLength(1);
    expect(result.document.nodes[0]).toMatchObject({ kind: 'free', x: 29, y: 30 });
    expect(result.document.wires).toBe(document.wires);
    expect(result.document.instances).toBe(document.instances);
    expect(document.nodes).toHaveLength(0);
  });

  it('splits a host wire at a tapped segment into two halves and one junction', async () => {
    const document = connectedDocument(defaultPackages());
    const devices = await prepare(document);
    const host = document.wires[0]!;

    const result = materializeAnchor(document, { x: 29, y: 10 }, devices, idFactory());
    const junction = result.document.nodes[0]!;
    expect(junction).toMatchObject({ kind: 'junction', x: 29, y: 10 });
    expect(result.endpoint).toEqual({ kind: 'node', node: junction.id });

    expect(result.document.wires).toHaveLength(2);
    expect(result.document.wires.map((wire) => wire.id)).not.toContain(host.id);
    const [left, right] = result.document.wires;
    expect(left?.from).toEqual(host.from);
    expect(left?.to).toEqual(result.endpoint);
    expect(left?.bends).toEqual([]);
    expect(right?.from).toEqual(result.endpoint);
    expect(right?.to).toEqual(host.to);
    expect(right?.bends).toEqual([{ x: 35, y: 10 }]);
    expect(new Set([left?.id, right?.id]).size).toBe(2);

    for (const wire of result.document.wires) {
      expect(legs(wirePolyline(result.document, devices, wire)!)).toBe(true);
    }
    // Unrelated ids, geometry and the source document stay untouched.
    expect(document.wires).toHaveLength(1);
    expect(document.nodes).toHaveLength(0);
    expect(result.document.instances).toBe(document.instances);
    expect(result.document.labels).toBe(document.labels);
    expect(result.document.references).toBe(document.references);
  });

  it('splits at an existing bend', async () => {
    const document = connectedDocument(defaultPackages());
    const devices = await prepare(document);

    const result = materializeAnchor(document, { x: 35, y: 10 }, devices, idFactory());
    const [left, right] = result.document.wires;
    expect(result.document.nodes[0]).toMatchObject({ kind: 'junction', x: 35, y: 10 });
    expect(left?.bends).toEqual([]);
    expect(right?.bends).toEqual([]);
    expect(left?.to).toEqual(result.endpoint);
    expect(right?.from).toEqual(result.endpoint);
  });

  it('does not treat a near miss as a tap', async () => {
    const document = connectedDocument(defaultPackages());
    const devices = await prepare(document);

    const result = materializeAnchor(document, { x: 29, y: 11 }, devices, idFactory());
    expect(result.document.nodes[0]).toMatchObject({ kind: 'free', x: 29, y: 11 });
    expect(result.document.wires).toBe(document.wires);
  });
});

describe('routeDocumentWires', () => {
  it('returns an already orthogonal document unchanged', async () => {
    const document = connectedDocument(defaultPackages());
    const devices = await prepare(document);
    expect(routeDocumentWires(document, devices)).toBe(document);
  });

  it('repairs a diagonal leg without touching the wire endpoints', async () => {
    const host: ConnectionWire = {
      id: WIRE_ID,
      from: { kind: 'pin', instance: LED_ID, pin: 'anode' },
      to: { kind: 'pin', instance: SWITCH_ID, pin: 'a' },
      bends: [{ x: 35, y: 15 }],
    };
    const document = documentWith(host);
    const devices = await prepare(document);

    const routed = routeDocumentWires(document, devices);
    const wire = routed.wires[0]!;
    expect(wire.id).toBe(host.id);
    expect(wire.from).toEqual(host.from);
    expect(wire.to).toEqual(host.to);
    expect(legs(wirePolyline(routed, devices, wire)!)).toBe(true);
  });

  it('translates the bends of a run that moves together', async () => {
    const host: ConnectionWire = {
      id: WIRE_ID,
      from: { kind: 'pin', instance: LED_ID, pin: 'cathode' },
      to: { kind: 'pin', instance: SWITCH_ID, pin: 'a' },
      bends: [{ x: 35, y: 10 }],
    };
    const document = documentWith(host);
    const devices = await prepare(document);
    expect(legs(wirePolyline(document, devices, host)!)).toBe(true);

    const moved = moveInstances(document, [LED_ID, SWITCH_ID], { x: 5, y: -3 });
    const routed = routeDocumentWires(moved, devices, document);
    const wire = routed.wires[0]!;
    expect(wire.bends).toEqual([{ x: 40, y: 7 }]);
    expect(legs(wirePolyline(routed, devices, wire)!)).toBe(true);
    expect(wirePolyline(routed, devices, wire)).toEqual([
      { x: 31, y: 7 },
      { x: 40, y: 7 },
      { x: 49, y: 7 },
    ]);
  });

  it('absorbs a single moved anchor and keeps the far anchor in place', async () => {
    const host: ConnectionWire = {
      id: WIRE_ID,
      from: { kind: 'pin', instance: LED_ID, pin: 'cathode' },
      to: { kind: 'pin', instance: SWITCH_ID, pin: 'a' },
      bends: [{ x: 35, y: 10 }],
    };
    const document = documentWith(host);
    const devices = await prepare(document);

    const moved = moveInstances(document, [SWITCH_ID], { x: 20, y: 15 });
    const routed = routeDocumentWires(moved, devices, document);
    const line = wirePolyline(routed, devices, routed.wires[0]!)!;
    expect(line[0]).toEqual({ x: 26, y: 10 });
    expect(line[line.length - 1]).toEqual({ x: 64, y: 25 });
    expect(legs(line)).toBe(true);
  });
});
