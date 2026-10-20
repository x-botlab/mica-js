import { describe, expect, it } from 'vitest';
import type { SchematicDocument } from '../format/types';
import { catchError, codesOf } from '../format/test-helpers';
import { deriveSchematicTopology } from './derive';

function documentWith(
  symbols: SchematicDocument['sheet']['symbols'],
  wires: SchematicDocument['sheet']['wires'] = [],
): SchematicDocument {
  return { version: 1, id: 'builtin', sheet: { symbols, wires, junctions: [] } };
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

  it('uses properties.label when provided', () => {
    const topology = deriveSchematicTopology(
      documentWith(
        [
          {
            id: 'p1',
            device: 'builtin:power',
            x: 0,
            y: 0,
            rotation: 0,
            properties: { label: '3V3' },
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

  it('keeps labels unchanged', () => {
    const topology = deriveSchematicTopology(
      documentWith([{ id: 'L1', device: 'builtin:label', x: 0, y: 0, rotation: 0 }], WIRE),
    );
    expect(topology.nets[0]?.name).toBe('L1');
    expect(topology.nets[0]?.members).toEqual([{ kind: 'label', symbolId: 'L1' }]);
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
