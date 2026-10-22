import { describe, expect, it } from 'vitest';
import type { SchematicDocument } from '../../format/types';
import { catchError, codesOf } from '../../format/test-helpers';
import { deriveSchematicTopology } from './derive';

function documentWith(
  symbols: SchematicDocument['sheet']['symbols'],
  wires: SchematicDocument['sheet']['wires'] = [],
): SchematicDocument {
  return { version: 1, sheet: { symbols, wires, junctions: [] } };
}

const WIRE = [
  {
    id: 'w',
    points: [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ],
  },
];

describe('builtin power and ground symbols', () => {
  it('names the net with the default VCC / GND labels', () => {
    const vcc = deriveSchematicTopology(
      documentWith([{ id: 'p1', device: 'builtin:power', x: 0, y: 0, rotation: 0 }], WIRE),
    );
    expect(vcc.nets[0]?.name).toBe('VCC');

    const gnd = deriveSchematicTopology(
      documentWith([{ id: 'g1', device: 'builtin:ground', x: 10, y: 0, rotation: 0 }], WIRE),
    );
    expect(gnd.nets[0]?.name).toBe('GND');
  });

  it('uses the declared net name when provided', () => {
    const topology = deriveSchematicTopology(
      documentWith(
        [
          {
            id: 'p1',
            device: 'builtin:power',
            x: 0,
            y: 0,
            rotation: 0,
            net: '3V3',
          },
        ],
        WIRE,
      ),
    );
    expect(topology.nets[0]?.name).toBe('3V3');
    expect(topology.nets[0]?.members).toEqual([{ kind: 'power', symbolId: 'p1' }]);
  });

  it('reports conflicts between two naming symbols', () => {
    const error = catchError(() =>
      deriveSchematicTopology(
        documentWith(
          [
            { id: 'p1', device: 'builtin:power', x: 0, y: 0, rotation: 0 },
            { id: 'g1', device: 'builtin:ground', x: 10, y: 0, rotation: 0 },
          ],
          WIRE,
        ),
      ),
    );
    expect(codesOf(error.diagnostics)).toEqual(['net/naming-conflict']);
    expect(error.message).toContain('VCC');
    expect(error.message).toContain('GND');
  });

  it('names the net with the label net name', () => {
    const topology = deriveSchematicTopology(
      documentWith(
        [{ id: 'L1', device: 'builtin:label', x: 0, y: 0, rotation: 0, net: 'SCL' }],
        WIRE,
      ),
    );
    expect(topology.nets[0]?.name).toBe('SCL');
    expect(topology.nets[0]?.members).toEqual([{ kind: 'label', symbolId: 'L1' }]);
  });

  it('merges ports that share a net name across separate wires', () => {
    const topology = deriveSchematicTopology(
      documentWith(
        [
          { id: 'p1', device: 'builtin:power', net: 'VCC', x: 0, y: 0, rotation: 0 },
          { id: 'p2', device: 'builtin:power', net: 'VCC', x: 100, y: 0, rotation: 0 },
        ],
        [
          ...WIRE,
          {
            id: 'w2',
            points: [
              { x: 100, y: 0 },
              { x: 140, y: 0 },
            ],
          },
        ],
      ),
    );
    expect(topology.nets).toHaveLength(1);
    expect(topology.nets[0]?.name).toBe('VCC');
    expect(topology.nets[0]?.wireIds).toHaveLength(2);
    expect(topology.nets[0]?.members).toEqual([
      { kind: 'power', symbolId: 'p1' },
      { kind: 'power', symbolId: 'p2' },
    ]);
  });

  it('keeps same-named labels without any wire out of the netlist', () => {
    const topology = deriveSchematicTopology(
      documentWith([
        { id: 'l1', device: 'builtin:label', net: 'SPARE', x: 0, y: 0, rotation: 0 },
        { id: 'l2', device: 'builtin:label', net: 'SPARE', x: 40, y: 0, rotation: 0 },
      ]),
    );
    expect(topology.nets).toEqual([]);
  });

  it('orders members label, power, ground, pin', () => {
    const topology = deriveSchematicTopology(
      documentWith(
        [
          { id: 'zz-pin', device: 'pkg:d', x: 0, y: 0, rotation: 0 },
          { id: 'g', device: 'builtin:ground', x: 10, y: 0, rotation: 0 },
        ],
        WIRE,
      ),
      {
        devices: {
          getDeviceSymbol: () => ({ name: 'D', pins: { A: { x: 0, y: 0 } } }),
          getDeviceName: () => 'D',
        },
      },
    );
    expect(topology.nets[0]?.members.map((member) => member.kind)).toEqual(['ground', 'pin']);
  });
});
