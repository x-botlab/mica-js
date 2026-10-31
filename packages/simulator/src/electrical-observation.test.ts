import { createIRInterpreter, createIRJIT, createIRModule, toNumber } from '@mica-js/ir';
import { prepareElectricalDevice } from './electrical-authoring';
import { allocateElectricalNetwork } from './unified-ir/compiler/electrical-network';
import { createElectricalOperations } from './unified-ir/compiler/electrical-operations';
import { createModuleValidation } from './unified-ir/validation';
import type { ArrayRef, FunctionRef } from '@mica-js/ir';
import { describe, expect, test } from 'vitest';
import { PIN_MODE, compileCircuit } from './index';
import type { DeviceDescription } from './index';
import { createTestProbe } from './test-helpers/circuit-probe';

const electrical = {
  sources: { VDD: { voltage: 3.3 } },
  interpretation: 'two-state',
  floatingSeed: 12345,
} as const;
function analogFixture(engine: 'reference' | 'jit', initialSupply = 3.3, deviceId = 'device-1') {
  let observed!: ArrayRef<'f64'>;
  let sample!: FunctionRef<readonly [], readonly []>;
  let drive!: FunctionRef<readonly [], readonly []>;
  let release!: FunctionRef<readonly [], readonly []>;
  const description: DeviceDescription = {
    pins: { AIN: { kind: 'signal' } },
    factory: ({ electrical }) => {
      electrical.initializePin('AIN', {
        input: { reference: { source: 'VDD' }, low: 0.3, high: 0.7 },
        drive: { reference: { source: 'VDD' }, highResistance: 50, lowResistance: 50 },
      });
    },
    kernel: ({ module, bind }) => {
      observed = module.array('observed', 'f64', [0, 0]);
      sample = module.func('sample', { params: [], results: [] });
      drive = module.func('drive', { params: [], results: [] });
      release = module.func('release', { params: [], results: [] });
      sample.body((b) => {
        const pin = bind(b).pin('AIN');
        b.array.store(observed, b.const('u32', 0), pin.sampleVoltage());
        b.array.store(observed, b.const('u32', 1), pin.sampleVoltage());
        b.return([]);
      });
      drive.body((b) => {
        const pin = bind(b).pin('AIN');
        pin.configure(PIN_MODE.pushPull);
        pin.setOutputEnabled(b.const('bool', true));
        pin.writeDigital(b.const('bool', true));
        b.return([]);
      });
      release.body((b) => {
        bind(b).pin('AIN').configure(PIN_MODE.highZ);
        b.return([]);
      });
      return {};
    },
  };
  const module = createIRModule();
  const prepared = prepareElectricalDevice(description, {}, description.factory!);
  const allocation = allocateElectricalNetwork(
    [{ id: deviceId, prepared }],
    { VDD: { voltage: initialSupply } },
    [],
  );
  const operations = createElectricalOperations(module, allocation, 'two-state', 'test', 12345);
  description.kernel!({ module, bind: (b) => operations.bindDevice(deviceId, b) } as Parameters<
    NonNullable<DeviceDescription['kernel']>
  >[0]);
  operations.finalize();
  const validation = createModuleValidation(module);
  const runtime =
    engine === 'reference'
      ? createIRInterpreter(module, { validation })
      : createIRJIT(module, { validation, jit: { tierUpThreshold: 0 } });
  const run = (fn: FunctionRef<readonly [], readonly []>) =>
    runtime.execute(fn, [], { instanceId: 'test', virtualTime: 0 });
  run(operations.ensure);
  return {
    run,
    solve: () => run(operations.ensure),
    drive,
    release,
    sample: (time: number) => {
      runtime.storage.storeArray(operations.clock, 0, time >>> 0);
      runtime.storage.storeArray(operations.clock, 1, Math.floor(time / 0x100000000));
      run(sample);
      const value = toNumber(runtime.storage.loadArray(observed, 0));
      expect(runtime.storage.loadArray(observed, 0)).toEqual(
        runtime.storage.loadArray(observed, 1),
      );
      return value;
    },
    supply: (enabled: boolean, value = 3.3) => {
      runtime.storage.storeArray(operations.solver.sourceEnabled, 1, enabled);
      runtime.storage.storeArray(operations.solver.sourceVoltage, 1, value);
      run(operations.solver.invalidate.rhs);
    },
    physicalState: () =>
      runtime.storage.loadArray(
        operations.solver.voltageState,
        allocation.pins.get(deviceId)!.get('AIN')!.node,
      ),
  };
}

test('generates floating helpers only for analog reads, sharing repeated reads of the same pin', () => {
  const compile = (analog: boolean) => {
    const description: DeviceDescription = {
      pins: { A: { kind: 'signal' }, B: { kind: 'signal' } },
      states: { sampled: { type: 'f64', initial: 0 }, digital: { type: 'bool', initial: false } },
      factory: ({ electrical }) => {
        for (const name of ['A', 'B'])
          electrical.initializePin(name, {
            input: { reference: { source: 'VDD' }, low: 0.3, high: 0.7 },
          });
        return {
          update: (api) => {
            api.state<'bool'>('digital').store(api.pin('B').sampleDigital());
            if (analog)
              api
                .state<'f64'>('sampled')
                .store(
                  api.builder.float.add(api.pin('A').sampleVoltage(), api.pin('A').sampleVoltage()),
                );
          },
        };
      },
    };
    return compileCircuit(
      { devices: [{ id: 'sensor', type: 'sensor', description }], connections: [] },
      electrical,
    );
  };
  expect(compile(false).functions.filter((name) => name.includes('_analog_'))).toEqual([]);
  const functions = compile(true).functions;
  expect(functions.filter((name) => name.endsWith('_sample'))).toEqual([
    'electrical_analog_0_sample',
  ]);
  expect(functions.filter((name) => name.includes('_analog_1'))).toEqual([]);
});

describe.each(['reference', 'jit'] as const)('%s analog observations', (engine) => {
  test('tracks physical floating episodes before the first analog read', () => {
    const fixture = analogFixture(engine);
    fixture.run(fixture.drive);
    fixture.solve();
    fixture.run(fixture.release);
    fixture.solve();
    expect(fixture.sample(0)).toBeCloseTo(1.155351, 6);
  });
  test('matches both mica-floating-v2 RFC episodes, including high time bits and repeated reads', () => {
    const fixture = analogFixture(engine);
    const times = [0, 100, 101, 4294967296, 7200000000000000];
    const first = [0.31208, 0.31327, 0.271498, 0.22421, 0.177746];
    const second = [1.155351, 1.046522, 1.067295, 1.087303, 1.055952];
    for (let i = 0; i < times.length; i++)
      expect(fixture.sample(times[i]!)).toBeCloseTo(first[i]!, 6);
    expect(fixture.physicalState()).toBe(1);
    fixture.run(fixture.drive);
    expect(fixture.sample(100)).toBe(3.3);
    fixture.run(fixture.release);
    for (let i = 0; i < times.length; i++)
      expect(fixture.sample(times[i]!)).toBeCloseTo(second[i]!, 6);
    expect(fixture.physicalState()).toBe(1);
  });

  test('gates to positive zero without changing episode identity and clamps to current supply', () => {
    const fixture = analogFixture(engine);
    const value = fixture.sample(100);
    fixture.supply(false);
    expect(Object.is(fixture.sample(100), 0)).toBe(true);
    fixture.supply(true);
    expect(fixture.sample(100)).toBe(value);
    fixture.supply(true, 0.01);
    expect(fixture.sample(100)).toBeLessThanOrEqual(0.01);
    expect(fixture.sample(100)).toBeGreaterThanOrEqual(0);
    fixture.supply(true, 0);
    expect(Object.is(fixture.sample(100), 0)).toBe(true);
  });

  test('delays initialization until supply readiness and counts gated physical floating transitions', () => {
    const fixture = analogFixture(engine, 0);
    expect(fixture.sample(0)).toBe(0);
    fixture.supply(true, 3.3);
    expect(fixture.sample(0)).toBeCloseTo(0.31208, 6);
    fixture.supply(true, 0);
    fixture.run(fixture.drive);
    expect(fixture.sample(0)).toBe(0);
    expect(fixture.physicalState()).toBe(0);
    fixture.run(fixture.release);
    expect(fixture.sample(0)).toBe(0);
    expect(fixture.physicalState()).toBe(1);
    fixture.supply(true, 3.3);
    expect(fixture.sample(0)).toBeCloseTo(1.155351, 6);
  });

  test('advances the analog clock by actual picoseconds in step/batch and wraps without precision loss', () => {
    const description: DeviceDescription = {
      pins: { AIN: { kind: 'signal' } },
      states: { sampled: { type: 'f64', initial: 0 } },
      factory: ({ electrical }) => {
        electrical.initializePin('AIN', {
          input: { reference: { source: 'VDD' }, low: 0.3, high: 0.7 },
        });
        return {
          update: (api) => api.state<'f64'>('sampled').store(api.pin('AIN').sampleVoltage()),
        };
      },
    };
    const input = { devices: [{ id: 'sensor', type: 'sensor', description }], connections: [] };
    const a = createTestProbe(input, { engine, electrical });
    const b = createTestProbe(input, { engine, electrical });
    const expected = analogFixture(engine, 3.3, 'sensor');
    const read = () => a.readState('sensor', 'sampled');
    a.step(4294967396);
    a.step(17);
    b.runBatch(1, 4294967396);
    b.runBatch(1, 17);
    expect(a.virtualTime).toBe(4294967413);
    expect(read()).toBe(b.readState('sensor', 'sampled'));
    expect(read()).toBe(expected.sample(4294967396));
    a.reset();
    a.runBatch(2, Number.MAX_SAFE_INTEGER);
    expect(a.virtualTime).toBe(Number.MAX_SAFE_INTEGER - 1);
    a.step();
    expect(read()).toBe(expected.sample(Number.MAX_SAFE_INTEGER - 1));
    expect(() => a.step(0)).toThrow('picoseconds');
    expect(() => a.runBatch(1, NaN)).toThrow('picoseconds');
  });

  test('rejects missing input capability and invalid floating seeds before factory execution', () => {
    let calls = 0;
    const description: DeviceDescription = {
      pins: { A: { kind: 'signal' } },
      factory: () => {
        calls++;
        return {
          tick: (api) => {
            api.pin('A').sampleVoltage();
          },
        };
      },
    };
    const input = { devices: [{ id: 'sensor', type: 'sensor', description }], connections: [] };
    for (const floatingSeed of [-1, 0x100000000, 1.5, NaN])
      expect(() =>
        createTestProbe(input, { engine, electrical: { ...electrical, floatingSeed } }),
      ).toThrow('floatingSeed');
    expect(calls).toBe(0);
    expect(() => createTestProbe(input, { engine, electrical })).toThrow('input capability');
  });

  test('uses actual voltage in-band and keeps step/batch/reset deterministic', () => {
    const description: DeviceDescription = {
      pins: { A: { kind: 'signal' } },
      states: { sampled: { type: 'f64', initial: 0 } },
      factory: ({ electrical }) => {
        electrical.initializePin('A', {
          input: { reference: { source: 'VDD' }, low: 0.3, high: 0.7 },
        });
        return { update: (api) => api.state<'f64'>('sampled').store(api.pin('A').sampleVoltage()) };
      },
    };
    const input = { devices: [{ id: 'sensor', type: 'sensor', description }], connections: [] };
    const a = createTestProbe(input, { engine, electrical });
    const b = createTestProbe(input, { engine, electrical });
    for (let i = 0; i < 5; i++) a.step();
    b.runBatch(5);
    expect(a.readState('sensor', 'sampled')).toBe(b.readState('sensor', 'sampled'));
    expect(a.voltage('sensor.A')).toEqual({ state: 'floating' });
    a.reset();
    a.runBatch(5);
    expect(a.readState('sensor', 'sampled')).toBe(b.readState('sensor', 'sampled'));
    const driven = createTestProbe(
      { ...input, connections: [{ from: 'sensor.A', to: 'MID' }] },
      {
        engine,
        electrical: { ...electrical, sources: { VDD: { voltage: 3.3 }, MID: { voltage: 1.6 } } },
      },
    );
    driven.step();
    expect(driven.readState('sensor', 'sampled')).toBe(1.6);
    expect(driven.digital('sensor.A')).toBe(false);
  });
});
