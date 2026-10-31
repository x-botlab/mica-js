import { describe, expect, test, vi } from 'vitest';
import type { EntryRef } from '@mica-js/ir';
import { Circuit, compileCircuit } from './index';
import type { DeviceDescription, DeviceInputIo, DeviceOutputIo } from './index';
import { deviceBoundaryOf } from './unified-ir/runtime/circuit';
import { createTestProbe } from './test-helpers/circuit-probe';

const electrical = { sources: { VDD: { voltage: 5 } }, interpretation: 'two-state' } as const;

function fixture() {
  const calls = vi.fn();
  let inputIo: DeviceInputIo;
  let outputIo: DeviceOutputIo;
  const description: DeviceDescription = {
    pins: { A: { kind: 'signal' }, B: { kind: 'signal' } },
    resistors: { body: { pins: ['A', 'B'] } },
    states: { ohms: { type: 'f64', initial: 1000 } },
    factory({ electrical }) {
      electrical.initializeResistor('body', { resistance: 1000, enabled: true });
      let entry: EntryRef<readonly ['f64']>;
      return {
        kernel({ module, bind, deviceId }) {
          entry = module.entry(`${deviceId}_resistance`, ['f64']);
          entry.body((b, [value]) => {
            const api = bind(b);
            api.resistor('body').setResistance(value);
            api.state<'f64'>('ohms').store(value);
            b.return([]);
          });
          return {};
        },
        applyInputs(io) {
          inputIo = io;
          const value = io.takeInput('ohms');
          if (value === undefined) return;
          calls(value);
          io.call(entry, [value as number]);
        },
        flushOutputs(io) {
          outputIo = io;
          io.publish('ohms', io.readState('ohms'));
        },
      };
    },
  };
  return {
    calls,
    inputIo: () => inputIo,
    outputIo: () => outputIo,
    input: {
      devices: [{ id: 'r', type: 'variable-resistor', description }],
      connections: [
        { from: 'r.A', to: 'VDD' },
        { from: 'r.B', to: 'GND' },
      ],
    },
  };
}

describe.each(['reference', 'jit'] as const)('%s boundary electrical entries', (engine) => {
  test('updates only on input, coalesces levels and generates no polling phase', () => {
    const f = fixture();
    const compiled = compileCircuit(f.input, electrical);
    expect(compiled.deviceMap.get('r')!.tick).toBeUndefined();
    expect(compiled.module.functions.some((fn) => fn.name === 'r_resistance')).toBe(true);
    const probe = createTestProbe(f.input, { engine, electrical });
    probe.boundary.deliverInputs('r', []);
    probe.runBatch(100);
    expect(f.calls).not.toHaveBeenCalled();
    probe.boundary.deliverInputs('r', [
      { port: 'ohms', payload: 1500 },
      { port: 'ohms', payload: 2000 },
    ]);
    expect(f.calls.mock.calls).toEqual([[2000]]);
    const current = probe.current('r.body');
    expect(current.state).toBe('determinate');
    if (current.state === 'determinate') expect(current.value).toBeCloseTo(0.0025, 12);
    probe.boundary.deliverInputs('r', []);
    probe.runBatch(100);
    expect(f.calls).toHaveBeenCalledTimes(1);
    probe.reset();
    const reset = probe.current('r.body');
    if (reset.state !== 'determinate') throw new Error('Expected reset current');
    expect(reset.value).toBeCloseTo(0.005, 12);
    probe.boundary.deliverInputs('r', [{ port: 'ohms', payload: 2000 }]);
    expect(f.calls).toHaveBeenCalledTimes(2);
  });

  test('rejects invalid entry arguments without changing resistance', () => {
    const f = fixture();
    const probe = createTestProbe(f.input, { engine, electrical });
    expect(() => probe.boundary.deliverInputs('r', [{ port: 'ohms', payload: 'bad' }])).toThrow(
      'Invalid execution arguments',
    );
    const current = probe.current('r.body');
    if (current.state !== 'determinate') throw new Error('Expected unchanged current');
    expect(current.value).toBeCloseTo(0.005, 12);
    expect(() => f.inputIo().takeInput('ohms')).toThrow('only valid during applyInputs');
  });

  test('captures numeric output and closes both IO surfaces at the boundary', () => {
    const f = fixture();
    const probe = createTestProbe(f.input, { engine, electrical });
    probe.boundary.deliverInputs('r', [{ port: 'ohms', payload: 2000 }]);
    expect(() => f.inputIo().takeInput('ohms')).toThrow('only valid during applyInputs');
    expect(() => f.inputIo().writeState('ohms', 3000)).toThrow('only valid during applyInputs');
    const publish = vi.fn();
    probe.boundary.publishOutputs('r', publish);
    expect(publish).toHaveBeenCalledWith('ohms', 2000);
    expect(() => f.outputIo().readState('ohms')).toThrow('only valid during flushOutputs');
    expect(() => f.outputIo().publish('ohms', 3000)).toThrow('only valid during flushOutputs');
  });

  test('closes the boundary when the owning circuit is disposed', async () => {
    const f = fixture();
    const circuit = await Circuit.create(f.input, { engine, electrical });
    circuit.dispose();
    const boundary = deviceBoundaryOf(circuit);
    expect(() => boundary.deliverInputs('r', [])).toThrow('disposed');
    expect(() => boundary.publishOutputs('r', vi.fn())).toThrow('disposed');
  });
});
