import { describe, expect, it } from 'vitest';
import { compileCircuit, type DeviceDescription } from './index';
import { PIN_MODE } from '../pin-space';
import { createTestProbe } from '../../test-helpers/circuit-probe';
import { TEST_ELECTRICAL } from './test-helpers';

function driver(level: boolean): DeviceDescription {
  return {
    pins: { out: { kind: 'signal' } },
    factory: ({ electrical }) => {
      electrical.initializePin('out', {
        drive: { reference: { source: 'VDD' }, highResistance: 50, lowResistance: 50 },
        input: { reference: { source: 'VDD' }, low: 0.3, high: 0.7 },
      });
      return {
        initialize: (api) => {
          const pin = api.pin('out');
          pin.configure(PIN_MODE.pushPull);
          pin.setOutputEnabled(api.builder.const('bool', true));
          pin.writeDigital(api.builder.const('bool', level));
        },
      };
    },
  };
}

const input = () => ({
  devices: [{ id: 'drive', type: 'gpio', description: driver(true) }],
  connections: [],
});

describe('resistive-only compilation', () => {
  it('requires an explicit interpretation even for pinless devices', () => {
    expect(() => compileCircuit(input())).toThrow('explicit digital interpretation');
    expect(() =>
      compileCircuit({
        devices: [
          { id: 'empty', type: 'empty', description: { pins: {}, factory: () => undefined } },
        ],
        connections: [],
      }),
    ).toThrow('explicit digital interpretation');
  });

  it('requires paired factories for every device, not only resistors', () => {
    expect(() =>
      compileCircuit(
        {
          devices: [
            {
              id: 'old',
              type: 'old',
              description: {
                pins: {},
                behaviors: { tick: () => undefined },
              } as unknown as DeviceDescription,
            },
          ],
          connections: [],
        },
        TEST_ELECTRICAL,
      ),
    ).toThrow('paired electrical factory');
  });

  it('emits no legacy public topology or boolean pin memories', () => {
    const compiled = compileCircuit(input(), TEST_ELECTRICAL);
    expect(compiled).not.toHaveProperty('netlist');
    expect(compiled).not.toHaveProperty('memory');
    const memories = compiled.module.memories.map((memory) => memory.name);
    for (const name of ['pin_mode', 'pin_output', 'pin_input'])
      expect(memories).not.toContain(name);
    expect(compiled.functions.some((name) => name.startsWith('solve_net_'))).toBe(false);
    expect(compiled.functions).toContain('electrical_ensure');
  });

  it('accepts no implicit VCC source', () => {
    expect(() =>
      compileCircuit(
        { ...input(), connections: [{ from: 'drive.out', to: 'VCC' }] },
        { sources: { VDD: { voltage: 5 } }, interpretation: 'two-state' },
      ),
    ).toThrow('Unknown electrical endpoint');
  });

  it.each(['missing.out', 'drive.missing', 'not-a-pin'])(
    'rejects unknown endpoint %s',
    (endpoint) => {
      expect(() =>
        compileCircuit(
          { ...input(), connections: [{ from: 'drive.out', to: endpoint }] },
          TEST_ELECTRICAL,
        ),
      ).toThrow();
    },
  );

  it('rejects malformed options and boolean rails', () => {
    expect(() =>
      compileCircuit(input(), { ...TEST_ELECTRICAL, ...{ rails: { VCC: true } } }),
    ).toThrow('boolean rails');
    expect(() => compileCircuit(input(), { ...TEST_ELECTRICAL, floatingSeed: -1 })).toThrow('u32');
    expect(() =>
      compileCircuit(input(), { ...TEST_ELECTRICAL, sources: { VDD: { voltage: Number.NaN } } }),
    ).toThrow('Invalid voltage source');
  });
});

for (const engine of ['reference', 'jit'] as const) {
  it(`${engine}: opposing finite-impedance outputs produce a voltage divider, not a boolean OR`, () => {
    const probe = createTestProbe(
      {
        devices: [
          { id: 'high', type: 'gpio', description: driver(true) },
          { id: 'low', type: 'gpio', description: driver(false) },
        ],
        connections: [{ from: 'high.out', to: 'low.out' }],
      },
      { engine, electrical: TEST_ELECTRICAL },
    );
    expect(probe.voltage('high.out')).toEqual({ state: 'determinate', value: 2.5 });
    expect(probe.driven('high.out')).toBe(true);
    expect(probe.driven('low.out')).toBe(false);
    const current = probe.current({ kind: 'drive', device: 'high', pin: 'out' });
    expect(current.state).toBe('determinate');
    if (current.state === 'determinate') expect(Math.abs(current.value)).toBeCloseTo(0.05, 12);
    probe.runBatch(3);
    expect(probe.voltage('low.out')).toEqual({ state: 'determinate', value: 2.5 });
  });

  it(`${engine}: an output tied to ground has finite current instead of a legacy power-short rejection`, () => {
    const probe = createTestProbe(
      { ...input(), connections: [{ from: 'drive.out', to: 'GND' }] },
      { engine, electrical: TEST_ELECTRICAL },
    );
    expect(probe.voltage('drive.out')).toEqual({ state: 'determinate', value: 0 });
    const current = probe.current({ kind: 'drive', device: 'drive', pin: 'out' });
    expect(current.state).toBe('determinate');
    if (current.state === 'determinate') expect(Math.abs(current.value)).toBeCloseTo(0.1, 12);
  });
}
