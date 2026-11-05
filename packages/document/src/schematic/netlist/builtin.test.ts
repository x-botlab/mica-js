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
    id: '00000008-4ab0-4ece-8091-de044c58c9ae',
    points: [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ],
  },
];

describe('builtin power and ground symbols', () => {
  it('names the net with the default VCC / GND labels', () => {
    const vcc = deriveSchematicTopology(
      documentWith(
        [
          {
            id: '00000006-11ec-46f9-8af3-ca654c22172a',
            device: 'builtin:power',
            x: 0,
            y: 0,
            rotation: 0,
          },
        ],
        WIRE,
      ),
    );
    expect(vcc.nets[0]?.name).toBe('VCC');

    const gnd = deriveSchematicTopology(
      documentWith(
        [
          {
            id: '00000003-11cb-4400-8ab0-9c1ca969e615',
            device: 'builtin:ground',
            x: 10,
            y: 0,
            rotation: 0,
          },
        ],
        WIRE,
      ),
    );
    expect(gnd.nets[0]?.name).toBe('GND');
  });

  it('uses the declared net name when provided', () => {
    const topology = deriveSchematicTopology(
      documentWith(
        [
          {
            id: '00000006-11ec-46f9-8af3-ca654c22172a',
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
    expect(topology.nets[0]?.members).toEqual([
      { kind: 'power', symbolId: '00000006-11ec-46f9-8af3-ca654c22172a' },
    ]);
  });

  it('reports conflicts between two naming symbols', () => {
    const error = catchError(() =>
      deriveSchematicTopology(
        documentWith(
          [
            {
              id: '00000006-11ec-46f9-8af3-ca654c22172a',
              device: 'builtin:power',
              x: 0,
              y: 0,
              rotation: 0,
            },
            {
              id: '00000003-11cb-4400-8ab0-9c1ca969e615',
              device: 'builtin:ground',
              x: 10,
              y: 0,
              rotation: 0,
            },
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
        [
          {
            id: '00000001-986d-45ab-84b6-b67319708dce',
            device: 'builtin:label',
            x: 0,
            y: 0,
            rotation: 0,
            net: 'SCL',
          },
        ],
        WIRE,
      ),
    );
    expect(topology.nets[0]?.name).toBe('SCL');
    expect(topology.nets[0]?.members).toEqual([
      { kind: 'label', symbolId: '00000001-986d-45ab-84b6-b67319708dce' },
    ]);
  });

  it('merges ports that share a net name across separate wires', () => {
    const topology = deriveSchematicTopology(
      documentWith(
        [
          {
            id: '00000006-11ec-46f9-8af3-ca654c22172a',
            device: 'builtin:power',
            net: 'VCC',
            x: 0,
            y: 0,
            rotation: 0,
          },
          {
            id: '00000007-9f73-4a95-8a30-8050062e7a2c',
            device: 'builtin:power',
            net: 'VCC',
            x: 100,
            y: 0,
            rotation: 0,
          },
        ],
        [
          ...WIRE,
          {
            id: '00000009-a914-47d5-84d1-8bafbe533ffb',
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
      { kind: 'power', symbolId: '00000006-11ec-46f9-8af3-ca654c22172a' },
      { kind: 'power', symbolId: '00000007-9f73-4a95-8a30-8050062e7a2c' },
    ]);
  });

  it('keeps same-named labels without any wire out of the netlist', () => {
    const topology = deriveSchematicTopology(
      documentWith([
        {
          id: '00000004-58c8-4974-8943-b00f84be79fc',
          device: 'builtin:label',
          net: 'SPARE',
          x: 0,
          y: 0,
          rotation: 0,
        },
        {
          id: '00000005-3abe-43ef-8e00-fe24590a3ea3',
          device: 'builtin:label',
          net: 'SPARE',
          x: 40,
          y: 0,
          rotation: 0,
        },
      ]),
    );
    expect(topology.nets).toEqual([]);
  });

  it('orders members label, power, ground, pin', () => {
    const topology = deriveSchematicTopology(
      documentWith(
        [
          { id: '0000000a-5bc1-4ded-8732-65a0a7acbf84', device: 'pkg:d', x: 0, y: 0, rotation: 0 },
          {
            id: '00000002-209f-41c0-8810-92374132c66e',
            device: 'builtin:ground',
            x: 10,
            y: 0,
            rotation: 0,
          },
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
