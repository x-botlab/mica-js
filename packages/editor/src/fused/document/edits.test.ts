import { describe, expect, it } from 'vitest';
import { deriveFusedTopology } from '@mica-js/document/fused';
import type { FusedDocument } from '@mica-js/document/fused';
import { addLabel, addPlacedReference } from './edits';
import { LED, LED_MANIFEST } from './test-helpers';

function documentWithPins(): FusedDocument {
  return {
    version: 2,
    dependencies: {},
    instances: [
      { id: 'd1', device: LED, designator: 'D1', placement: { x: 0, y: 0, rotation: 0 } },
      { id: 'd2', device: LED, designator: 'D2', placement: { x: 20, y: 0, rotation: 0 } },
    ],
    nodes: [],
    wires: [],
    labels: [],
    references: [],
  };
}

describe('toolbar-placed reference symbols', () => {
  it('starts a power symbol on an explicit VCC net at 3.3 V and keeps ground at 0 V', () => {
    const placed = addPlacedReference(
      documentWithPins(),
      { kind: 'pin', instance: 'd1', pin: 'anode' },
      'power',
      90,
      () => 'power',
    );
    expect(placed.document.references).toEqual([
      {
        id: 'power',
        target: { kind: 'pin', instance: 'd1', pin: 'anode' },
        voltage: 3.3,
        symbol: 'power',
        rotation: 90,
        label: { name: 'VCC' },
      },
    ]);
    const grounded = addPlacedReference(
      placed.document,
      { kind: 'pin', instance: 'd2', pin: 'anode' },
      'ground',
      0,
      () => 'ground',
    );
    expect(grounded.document.references[1]).toEqual({
      id: 'ground',
      target: { kind: 'pin', instance: 'd2', pin: 'anode' },
      voltage: 0,
      symbol: 'ground',
    });
  });

  it('merges the placed power net with same-named labels at 3.3 V', () => {
    const placed = addPlacedReference(
      documentWithPins(),
      { kind: 'pin', instance: 'd1', pin: 'anode' },
      'power',
      0,
      () => 'power',
    );
    const labeled = addLabel(
      placed.document,
      { kind: 'pin', instance: 'd2', pin: 'anode' },
      'VCC',
      {},
      () => 'label',
    );
    const topology = deriveFusedTopology(labeled.document, new Map([[LED, LED_MANIFEST]]));
    expect(topology.nets).toHaveLength(1);
    expect(topology.nets[0]).toMatchObject({
      pins: [
        { instance: 'd1', pin: 'anode' },
        { instance: 'd2', pin: 'anode' },
      ],
      voltage: 3.3,
    });
  });
});
