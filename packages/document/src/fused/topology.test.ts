import { describe, expect, it } from 'vitest';
import { parseFusedDocument } from './document';
import { parseUnifiedManifest } from './manifest';
import { deriveFusedTopology } from './topology';
import type { FusedDocument } from './types/document';
import type { UnifiedDeviceManifest } from './types/manifest';
import {
  BUTTON_MANIFEST,
  INSTANCE_ID,
  LABEL_MANIFEST,
  NODE_ID,
  OTHER_INSTANCE_ID,
  catchError,
  codesOf,
  documentValue,
  instance,
  pointersOf,
  rfcExample,
} from './test-helpers';

const WIRE_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_WIRE_ID = '88888888-8888-4888-8888-888888888888';
const LABEL_ID = '44444444-4444-4444-8444-444444444444';
const OTHER_LABEL_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const REFERENCE_ID = '55555555-5555-4555-8555-555555555555';
const OTHER_REFERENCE_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

const NODE = { id: NODE_ID, kind: 'junction', x: 10, y: 16 };

function manifests(): Map<string, UnifiedDeviceManifest> {
  return new Map<string, UnifiedDeviceManifest>([
    ['example:button', parseUnifiedManifest(BUTTON_MANIFEST)],
    ['example:label', parseUnifiedManifest(LABEL_MANIFEST)],
  ]);
}

function documentOf(overrides: Record<string, unknown> = {}): FusedDocument {
  return parseFusedDocument(documentValue(overrides));
}

function pinEndpoint(pin: string, instanceId = INSTANCE_ID): Record<string, unknown> {
  return { kind: 'pin', instance: instanceId, pin };
}

function nodeEndpoint(node = NODE_ID): Record<string, unknown> {
  return { kind: 'node', node };
}

function label(id: string, target: Record<string, unknown>, name: string): Record<string, unknown> {
  return { id, target, name };
}

function reference(
  id: string,
  target: Record<string, unknown>,
  voltage: number,
): Record<string, unknown> {
  return { id, target, voltage };
}

describe('deriveFusedTopology', () => {
  it('derives the nets of the full RFC 0024 example from its manifests', () => {
    const document = parseFusedDocument(rfcExample('0024-fused-schematic.json'));
    const known = manifests();
    known.set('example:button', parseUnifiedManifest(rfcExample('0020-device-package.json')));

    const { nets } = deriveFusedTopology(document, known);

    expect(nets).toEqual([
      {
        id: `node:${NODE_ID}|pin:${INSTANCE_ID}/a1`,
        pins: [{ instance: INSTANCE_ID, pin: 'a1' }],
        voltage: 5,
      },
      {
        id: `pin:${INSTANCE_ID}/b1`,
        pins: [{ instance: INSTANCE_ID, pin: 'b1' }],
      },
    ]);
  });

  it('keeps pins of one device on separate nets', () => {
    const document = documentOf({
      labels: [
        label(LABEL_ID, pinEndpoint('a1'), 'SIG_A'),
        label(OTHER_LABEL_ID, pinEndpoint('b1'), 'SIG_B'),
      ],
    });

    const { nets } = deriveFusedTopology(document, manifests());

    expect(nets).toEqual([
      { id: `pin:${INSTANCE_ID}/a1`, pins: [{ instance: INSTANCE_ID, pin: 'a1' }] },
      { id: `pin:${INSTANCE_ID}/b1`, pins: [{ instance: INSTANCE_ID, pin: 'b1' }] },
    ]);
  });

  it('merges equal names into one net', () => {
    const document = documentOf({
      instances: [instance(), instance({ id: OTHER_INSTANCE_ID, designator: 'S2' })],
      labels: [
        label(LABEL_ID, pinEndpoint('a1'), 'SIG'),
        label(OTHER_LABEL_ID, pinEndpoint('a1', OTHER_INSTANCE_ID), 'SIG'),
      ],
    });

    const { nets } = deriveFusedTopology(document, manifests());

    expect(nets).toEqual([
      {
        id: `pin:${INSTANCE_ID}/a1|pin:${OTHER_INSTANCE_ID}/a1`,
        pins: [
          { instance: INSTANCE_ID, pin: 'a1' },
          { instance: OTHER_INSTANCE_ID, pin: 'a1' },
        ],
      },
    ]);
  });

  it('merges a name owned by a power symbol with an ordinary net label', () => {
    const document = documentOf({
      instances: [instance(), instance({ id: OTHER_INSTANCE_ID, designator: 'S2' })],
      nodes: [NODE],
      wires: [
        {
          id: WIRE_ID,
          from: pinEndpoint('a1'),
          to: nodeEndpoint(),
          bends: [],
        },
      ],
      labels: [label(LABEL_ID, pinEndpoint('a2', OTHER_INSTANCE_ID), 'VCC')],
      references: [
        {
          id: REFERENCE_ID,
          target: nodeEndpoint(),
          voltage: 5,
          symbol: 'power',
          label: { name: 'VCC' },
        },
      ],
    });

    const { nets } = deriveFusedTopology(document, manifests());

    expect(nets).toEqual([
      {
        id: `node:${NODE_ID}|pin:${INSTANCE_ID}/a1|pin:${OTHER_INSTANCE_ID}/a2`,
        pins: [
          { instance: INSTANCE_ID, pin: 'a1' },
          { instance: OTHER_INSTANCE_ID, pin: 'a2' },
        ],
        voltage: 5,
      },
    ]);
  });

  it('drops open pins and pin-free drawing components', () => {
    const document = documentOf({ nodes: [NODE] });

    expect(deriveFusedTopology(document, manifests()).nets).toEqual([]);
  });

  it('rejects conflicting names on one net', () => {
    const document = documentOf({
      nodes: [NODE],
      wires: [{ id: WIRE_ID, from: pinEndpoint('a1'), to: nodeEndpoint(), bends: [] }],
      labels: [
        label(LABEL_ID, pinEndpoint('a1'), 'VCC'),
        label(OTHER_LABEL_ID, nodeEndpoint(), 'GND'),
      ],
    });

    const error = catchError(() => deriveFusedTopology(document, manifests()));

    expect(codesOf(error)).toEqual(['net/naming-conflict']);
    expect(pointersOf(error)).toEqual(['/labels/1/name']);
  });

  it('rejects conflicting ideal voltages on one net', () => {
    const document = documentOf({
      nodes: [NODE],
      wires: [{ id: WIRE_ID, from: pinEndpoint('a1'), to: nodeEndpoint(), bends: [] }],
      references: [
        reference(REFERENCE_ID, nodeEndpoint(), 5),
        reference(OTHER_REFERENCE_ID, pinEndpoint('a1'), 3.3),
      ],
    });

    const error = catchError(() => deriveFusedTopology(document, manifests()));

    expect(codesOf(error)).toEqual(['net/reference-conflict']);
    expect(pointersOf(error)).toEqual(['/references/1/voltage']);
  });

  it('rejects conflicting voltages after merging equal names', () => {
    const document = documentOf({
      instances: [instance(), instance({ id: OTHER_INSTANCE_ID, designator: 'S2' })],
      labels: [
        label(LABEL_ID, pinEndpoint('a1'), 'VCC'),
        label(OTHER_LABEL_ID, pinEndpoint('a1', OTHER_INSTANCE_ID), 'VCC'),
      ],
      references: [
        reference(REFERENCE_ID, pinEndpoint('a1'), 5),
        reference(OTHER_REFERENCE_ID, pinEndpoint('a1', OTHER_INSTANCE_ID), 3.3),
      ],
    });

    const error = catchError(() => deriveFusedTopology(document, manifests()));

    expect(codesOf(error)).toEqual(['net/reference-conflict']);
  });

  it('accepts several references with the same voltage', () => {
    const document = documentOf({
      nodes: [NODE],
      wires: [{ id: WIRE_ID, from: pinEndpoint('a1'), to: nodeEndpoint(), bends: [] }],
      references: [
        reference(REFERENCE_ID, nodeEndpoint(), 5),
        reference(OTHER_REFERENCE_ID, pinEndpoint('a1'), 5),
      ],
    });

    const { nets } = deriveFusedTopology(document, manifests());

    expect(nets[0]?.voltage).toBe(5);
  });

  it('derives a net id that does not depend on the declared edge direction', () => {
    const forward = documentOf({
      nodes: [NODE],
      wires: [{ id: WIRE_ID, from: pinEndpoint('a1'), to: nodeEndpoint(), bends: [] }],
    });
    const backward = documentOf({
      nodes: [NODE],
      wires: [{ id: WIRE_ID, from: nodeEndpoint(), to: pinEndpoint('a1'), bends: [] }],
    });

    const expected = `node:${NODE_ID}|pin:${INSTANCE_ID}/a1`;
    expect(deriveFusedTopology(forward, manifests()).nets[0]?.id).toBe(expected);
    expect(deriveFusedTopology(backward, manifests()).nets[0]?.id).toBe(expected);
  });

  it('rejects an undeclared pin', () => {
    const document = documentOf({
      labels: [label(LABEL_ID, pinEndpoint('zz'), 'SIG')],
    });

    const error = catchError(() => deriveFusedTopology(document, manifests()));

    expect(codesOf(error)).toEqual(['device/unknown-pin']);
    expect(pointersOf(error)).toEqual(['/labels/0/target/pin']);
  });

  it('rejects an instance without a manifest', () => {
    const document = documentOf();

    const error = catchError(() => deriveFusedTopology(document, new Map()));

    expect(codesOf(error)).toEqual(['device/unresolved']);
    expect(pointersOf(error)).toEqual(['/instances/0/device']);
  });

  it('rejects a wire endpoint whose node disappeared', () => {
    const parsed = documentOf({
      nodes: [NODE],
      wires: [{ id: WIRE_ID, from: pinEndpoint('a1'), to: nodeEndpoint(), bends: [] }],
    });
    const broken: FusedDocument = { ...parsed, nodes: [] };

    const error = catchError(() => deriveFusedTopology(broken, manifests()));

    expect(codesOf(error)).toEqual(['connection/unknown-endpoint']);
    expect(pointersOf(error)).toEqual(['/wires/0/to/node']);
  });

  it('rejects a self edge that reached the derivation', () => {
    const parsed = documentOf();
    const broken: FusedDocument = {
      ...parsed,
      wires: [
        {
          id: WIRE_ID,
          from: { kind: 'pin', instance: INSTANCE_ID, pin: 'a1' },
          to: { kind: 'pin', instance: INSTANCE_ID, pin: 'a1' },
          bends: [],
        },
      ],
    };

    const error = catchError(() => deriveFusedTopology(broken, manifests()));

    expect(codesOf(error)).toEqual(['connection/self-edge']);
  });

  it('rejects a second wire between the same endpoints as a self edge', () => {
    const parsed = documentOf({
      nodes: [NODE],
      wires: [{ id: WIRE_ID, from: pinEndpoint('a1'), to: nodeEndpoint(), bends: [] }],
    });
    const duplicated: FusedDocument = {
      ...parsed,
      wires: [
        ...parsed.wires,
        {
          id: OTHER_WIRE_ID,
          from: { kind: 'pin', instance: INSTANCE_ID, pin: 'a1' },
          to: { kind: 'node', node: NODE_ID },
          bends: [],
        },
      ],
    };

    const { nets } = deriveFusedTopology(duplicated, manifests());

    expect(nets).toHaveLength(1);
  });
});
