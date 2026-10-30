import { createIRInterpreter, createIRJIT, createIRModule, toNumber } from '@mica-js/ir';
import { describe, expect, expectTypeOf, test } from 'vitest';
import { prepareElectricalDevice } from './electrical-authoring';
import { GlobalResourceAllocator } from './unified-ir/compiler/allocator';
import { DeviceIRGenerator } from './unified-ir/compiler/device-gen';
import { allocateElectricalNetwork } from './unified-ir/compiler/electrical-network';
import { createElectricalOperations } from './unified-ir/compiler/electrical-operations';
import type { DeviceBehaviorApi, DeviceBehaviors, DeviceConfig } from './unified-ir/compiler/types';
import { MainLoopGenerator } from './unified-ir/compiler/mainloop-gen';
import { PIN_MODE } from './unified-ir/pin-space';
import { createModuleValidation } from './unified-ir/validation';

type Capture = (api: DeviceBehaviorApi, slot: number, name?: string) => void;
type CaptureCurrent = (api: DeviceBehaviorApi, slot: number, name: string) => void;

function fixture(
  engine: 'reference' | 'jit',
  action: (api: DeviceBehaviorApi, capture: Capture, current: CaptureCurrent) => void,
  interpretation: 'two-state' | 'retain-in-band' = 'two-state',
  withBehavior = true,
  updateAction?: (api: DeviceBehaviorApi) => void,
  useKernel = false,
) {
  const module = createIRModule();
  const observedDigital = module.array('observed_digital', 'bool', Array<boolean>(32).fill(false));
  const observedVoltage = module.array('observed_voltage', 'f64', Array<number>(32).fill(0));
  const observedCurrent = module.array('observed_current', 'f64', Array<number>(32).fill(0));
  const observedState = module.array('observed_state', 'u8', Array<number>(32).fill(1));
  const prepared = prepareElectricalDevice(
    {
      pins: {
        A: { kind: 'signal' },
        B: { kind: 'signal' },
        PASSIVE: { kind: 'signal' },
        HIGH: { kind: 'power' },
        LOW: { kind: 'gnd' },
      },
      resistors: { top: { pins: ['HIGH', 'A'] }, bottom: { pins: ['A', 'LOW'] } },
      connections: {
        bridge: { pins: ['A', 'B'], initial: 'open' },
        short: { pins: ['HIGH', 'LOW'], initial: 'open' },
      },
    },
    {},
    ({ electrical }): DeviceBehaviors | undefined => {
      for (const pin of ['A', 'B'])
        electrical.initializePin(pin, {
          drive: {
            reference: { source: 'VDD' },
            highResistance: 50,
            lowResistance: 100,
            analogResistance: 200,
          },
          bias: { reference: { source: 'VDD' }, upResistance: 10_000, downResistance: 20_000 },
          input: { reference: { source: 'VDD' }, low: 0.3, high: 0.7 },
        });
      electrical.initializeResistor('top', { resistance: 1000, enabled: false });
      electrical.initializeResistor('bottom', { resistance: 1000, enabled: false });
      return withBehavior
        ? {
            tick: (api) => action(api, capture, captureCurrent),
            update: (api) => {
              const state = api.state<'u32'>('updates');
              state.store(api.builder.int.add(state.load(), api.builder.const('u32', 1)));
              updateAction?.(api);
            },
          }
        : undefined;
    },
  );
  const allocation = allocateElectricalNetwork(
    [{ id: 'gpio', prepared }],
    { VDD: { voltage: 3.3 } },
    [
      [{ device: 'gpio', pin: 'HIGH' }, { source: 'VDD' }],
      [{ device: 'gpio', pin: 'LOW' }, { source: 'GND' }],
    ],
  );
  const electrical = createElectricalOperations(module, allocation, interpretation, 'el');
  const capture: Capture = (api, slot, name = 'A') => {
    const b = api.builder;
    const value = api.pin(name).sampleDigital();
    const node = allocation.pins.get('gpio')!.get(name)!.node;
    b.array.store(observedDigital, b.const('u32', slot), value);
    b.array.store(
      observedVoltage,
      b.const('u32', slot),
      b.array.load(electrical.solver.voltage, b.const('u32', node)),
    );
    b.array.store(
      observedState,
      b.const('u32', slot),
      b.array.load(electrical.solver.voltageState, b.const('u32', node)),
    );
  };
  const captureCurrent: CaptureCurrent = (api, slot, name) => {
    const b = api.builder;
    b.array.store(observedCurrent, b.const('u32', slot), api.resistor(name).sampleCurrent());
  };
  const device: DeviceConfig = {
    id: 'gpio',
    type: 'test-gpio',
    description: {
      pins: prepared.pinDeclarations,
      factory: () => undefined,
      states: { ticks: { type: 'u32', initial: 0 }, updates: { type: 'u32', initial: 0 } },
      ...(prepared.implementation === undefined
        ? {}
        : useKernel
          ? {
              kernel: ({ module, bind }) => {
                const tick = module.func('gpio_kernel_tick', { params: [], results: [] });
                const update = module.func('gpio_kernel_update', { params: [], results: [] });
                tick.body((b) => {
                  prepared.implementation?.tick?.(bind(b));
                  b.return([]);
                });
                update.body((b) => {
                  prepared.implementation?.update?.(bind(b));
                  b.return([]);
                });
                return { tick, update };
              },
            }
          : { behaviors: prepared.implementation }),
    },
  };
  const resources = new GlobalResourceAllocator(module).allocate([device]);
  const generated = new DeviceIRGenerator({ module, ...resources, electrical }).generate(device);
  const loop = new MainLoopGenerator(module, electrical).generate([generated.entry]);
  const validation = createModuleValidation(module);
  const runtime =
    engine === 'reference'
      ? createIRInterpreter(module, { validation, maxSteps: 10_000_000 })
      : createIRJIT(module, { validation, maxSteps: 10_000_000, jit: { tierUpThreshold: 0 } });
  const run = (ref = generated.entry.tick) => {
    if (ref !== undefined)
      runtime.execute(ref, [], { instanceId: 'electrical-operations', virtualTime: 0 });
  };
  run(electrical.ensure);
  return {
    generated,
    run: () => run(),
    step: () => run(loop.tick),
    batch: (count: number) =>
      runtime.execute(loop.batch, [count], { instanceId: 'electrical-operations', virtualTime: 0 }),
    progress: () => runtime.storage.loadState(loop.progress),
    physical: (name: string) => {
      const node = allocation.pins.get('gpio')!.get(name)!.node;
      return {
        voltage: toNumber(runtime.storage.loadArray(electrical.solver.voltage, node)),
        state: runtime.storage.loadArray(electrical.solver.voltageState, node),
      };
    },
    state: (name: string) => {
      const slot = resources.states.devices.get('gpio')!.get(name)!;
      return runtime.storage.loadArray(slot.array, slot.index);
    },
    sample: (slot: number) => ({
      digital: runtime.storage.loadArray(observedDigital, slot),
      voltage: toNumber(runtime.storage.loadArray(observedVoltage, slot)),
      state: runtime.storage.loadArray(observedState, slot),
    }),
    sampledCurrent: (slot: number) => toNumber(runtime.storage.loadArray(observedCurrent, slot)),
    fault: () => runtime.storage.loadState(electrical.solver.fault),
    resistance: (name: string) =>
      toNumber(
        runtime.storage.loadArray(
          electrical.solver.resistance,
          allocation.resistors.get('gpio')!.get(name)!,
        ),
      ),
    factors: () => runtime.storage.loadState(electrical.solver.factorizations),
    matrixVersion: () => runtime.storage.loadState(electrical.solver.matrixVersion),
    topologyVersion: () => runtime.storage.loadState(electrical.solver.topologyVersion),
    rhsVersion: () => runtime.storage.loadState(electrical.solver.rhsVersion),
  };
}

for (const engine of ['reference', 'jit'] as const)
  describe(`electrical operations (${engine})`, () => {
    test('samples declared branch current after edits without raw memory access', () => {
      const p = fixture(engine, (api, _capture, current) => {
        const b = api.builder;
        const top = api.resistor('top');
        const bottom = api.resistor('bottom');
        current(api, 0, 'top');
        top.setEnabled(b.const('bool', true));
        bottom.setEnabled(b.const('bool', true));
        current(api, 1, 'top');
        top.setResistance(b.const('f64', 3000));
        current(api, 2, 'top');
        current(api, 3, 'bottom');
        bottom.setEnabled(b.const('bool', false));
        current(api, 4, 'bottom');
        current(api, 5, 'top');
        top.setEnabled(b.const('bool', false));
        current(api, 6, 'top');
      });
      p.run();
      expect(p.fault()).toBe(0);
      const expected = [0, 3.3 / 2000, 3.3 / 4000, 3.3 / 4000, 0, 0, 0];
      expected.forEach((value, slot) => expect(p.sampledCurrent(slot)).toBeCloseTo(value, 12));
    });

    test('keeps high-Z, enable, and intent readiness independent', () => {
      const p = fixture(engine, (api, capture) => {
        const pin = api.pin('A');
        const b = api.builder;
        capture(api, 0);
        pin.configure(PIN_MODE.pushPull);
        capture(api, 1);
        pin.setOutputEnabled(b.const('bool', true));
        capture(api, 2);
        pin.writeDigital(b.const('bool', true));
        capture(api, 3);
        pin.setOutputEnabled(b.const('bool', false));
        capture(api, 4);
        pin.setOutputEnabled(b.const('bool', true));
        capture(api, 5);
        pin.configure(PIN_MODE.highZ);
        capture(api, 6);
        pin.configure(PIN_MODE.pushPull);
        capture(api, 7);
      });
      p.run();
      expect(p.fault()).toBe(0);
      for (const slot of [0, 1, 2, 4, 6])
        expect(p.sample(slot)).toMatchObject({ digital: false, state: 1 });
      for (const slot of [3, 5, 7])
        expect(p.sample(slot)).toEqual({ digital: true, voltage: 3.3, state: 0 });
    });

    test('keeps bias active when disabled, high-Z or waiting for an intent', () => {
      const p = fixture(engine, (api, capture) => {
        const pin = api.pin('A');
        const b = api.builder;
        pin.setPull('up');
        capture(api, 0);
        pin.configure(PIN_MODE.pushPull);
        pin.setOutputEnabled(b.const('bool', true));
        capture(api, 1);
        pin.writeDigital(b.const('bool', false));
        capture(api, 2);
        pin.setOutputEnabled(b.const('bool', false));
        capture(api, 3);
        pin.setPull('down');
        capture(api, 4);
        pin.setPull('none');
        capture(api, 5);
      });
      p.run();
      expect(p.fault()).toBe(0);
      for (const slot of [0, 1, 3]) expect(p.sample(slot).voltage).toBeCloseTo(3.3, 12);
      expect(p.sample(2).voltage).toBeCloseTo(3.3 / 101, 12);
      expect(p.sample(4)).toEqual({ digital: false, voltage: 0, state: 0 });
      expect(p.sample(5).state).toBe(1);
    });

    test('models open-drain release and actual contention, not the output latch', () => {
      const p = fixture(engine, (api, capture) => {
        const pin = api.pin('A');
        const b = api.builder;
        pin.configure(PIN_MODE.openDrain);
        pin.setOutputEnabled(b.const('bool', true));
        pin.writeDigital(b.const('bool', true));
        capture(api, 0);
        pin.setPull('up');
        capture(api, 1);
        pin.writeDigital(b.const('bool', false));
        capture(api, 2);
        pin.writeDigital(b.const('bool', true));
        capture(api, 3);
        pin.setPull('none');
        capture(api, 4);
      });
      p.run();
      expect(p.fault()).toBe(0);
      expect(p.sample(0).state).toBe(1);
      expect(p.sample(1).digital).toBe(true);
      expect(p.sample(2).voltage).toBeCloseTo(3.3 / 101, 12);
      expect(p.sample(3).digital).toBe(true);
      expect(p.sample(4).state).toBe(1);
    });

    test('preserves separate analog/digital readiness and reuses factors for voltage-only writes', () => {
      const p = fixture(engine, (api, capture) => {
        const pin = api.pin('A');
        const b = api.builder;
        pin.configure(PIN_MODE.analog);
        pin.setOutputEnabled(b.const('bool', true));
        capture(api, 0);
        pin.writeDigital(b.const('bool', true));
        capture(api, 1);
        pin.writeVoltage(b.const('f64', 1.2));
        capture(api, 2);
        pin.writeVoltage(b.const('f64', 2.5));
        capture(api, 3);
        pin.writeVoltage(b.const('f64', -0.2));
        capture(api, 4);
        pin.writeVoltage(b.const('f64', 4.5));
        capture(api, 5);
      });
      p.run();
      expect(p.fault()).toBe(0);
      expect(p.sample(0).state).toBe(1);
      expect(p.sample(1).state).toBe(1);
      for (const [slot, voltage] of [
        [2, 1.2],
        [3, 2.5],
        [4, -0.2],
        [5, 4.5],
      ])
        expect(p.sample(slot!).voltage).toBeCloseTo(voltage!, 12);
      expect(p.factors()).toBe(2);
      expect(p.rhsVersion()).toBe(3);
    });

    test('samples each related write and applies simulation-wide input interpretation', () => {
      const p = fixture(
        engine,
        (api, capture) => {
          const pin = api.pin('A');
          const b = api.builder;
          pin.configure(PIN_MODE.analog);
          pin.setOutputEnabled(b.const('bool', true));
          pin.writeVoltage(b.const('f64', 3));
          capture(api, 0);
          pin.writeVoltage(b.const('f64', 1.5));
          capture(api, 1);
          pin.writeVoltage(b.const('f64', 0.5));
          capture(api, 2);
          pin.writeVoltage(b.const('f64', 1.5));
          capture(api, 3);
        },
        'retain-in-band',
      );
      p.run();
      expect([0, 1, 2, 3].map((slot) => p.sample(slot).digital)).toEqual([
        true,
        true,
        false,
        false,
      ]);
    });

    test('two-state interpretation does not retain a high result in the threshold band', () => {
      const p = fixture(engine, (api, capture) => {
        const pin = api.pin('A');
        const b = api.builder;
        pin.configure(PIN_MODE.analog);
        pin.setOutputEnabled(b.const('bool', true));
        pin.writeVoltage(b.const('f64', 3));
        capture(api, 0);
        pin.writeVoltage(b.const('f64', 1.5));
        capture(api, 1);
      });
      p.run();
      expect(p.sample(0).digital).toBe(true);
      expect(p.sample(1).digital).toBe(false);
    });

    test('updates related input memory even when only a different input is sampled', () => {
      const p = fixture(
        engine,
        (api, capture) => {
          const pin = api.pin('A');
          const b = api.builder;
          pin.configure(PIN_MODE.analog);
          pin.setOutputEnabled(b.const('bool', true));
          pin.writeVoltage(b.const('f64', 3));
          capture(api, 0, 'B');
          pin.writeVoltage(b.const('f64', 1.5));
          capture(api, 1);
        },
        'retain-in-band',
      );
      p.run();
      expect(p.sample(0).digital).toBe(false);
      expect(p.sample(1).digital).toBe(true);
    });

    test('retains per-pin memory across floating input without letting another pin change it', () => {
      const p = fixture(
        engine,
        (api, capture) => {
          const pin = api.pin('A');
          const b = api.builder;
          pin.configure(PIN_MODE.analog);
          pin.setOutputEnabled(b.const('bool', true));
          pin.writeVoltage(b.const('f64', 3));
          capture(api, 0);
          pin.setOutputEnabled(b.const('bool', false));
          capture(api, 1);
          api.pin('B').setPull('down');
          capture(api, 2, 'B');
          pin.writeVoltage(b.const('f64', 1.5));
          pin.setOutputEnabled(b.const('bool', true));
          capture(api, 3);
        },
        'retain-in-band',
      );
      p.run();
      expect(p.sample(0).digital).toBe(true);
      expect(p.sample(1).digital).toBe(false);
      expect(p.sample(2).digital).toBe(false);
      expect(p.sample(3).digital).toBe(true);
    });

    test('commits an atomic digital group with one invalidation and no intermediate solve', () => {
      const p = fixture(engine, (api, capture) => {
        const b = api.builder;
        for (const name of ['A', 'B']) {
          api.pin(name).configure(PIN_MODE.pushPull);
          api.pin(name).setOutputEnabled(b.const('bool', true));
        }
        api.applyConnections(['bridge'], [b.const('bool', true)]);
        api.writeDigitalGroup(['A', 'B'], [b.const('bool', true), b.const('bool', false)]);
        capture(api, 0);
        api.writeDigitalGroup(['A', 'B'], [b.const('bool', false), b.const('bool', true)]);
        capture(api, 1);
      });
      p.run();
      expect(p.fault()).toBe(0);
      expect(p.sample(0).voltage).toBeCloseTo(2.2, 12);
      expect(p.sample(1).voltage).toBeCloseTo(2.2, 12);
      expect(p.matrixVersion()).toBe(2);
      expect(p.topologyVersion()).toBe(1);
    });

    test('commits a potentiometer patch atomically and skips no-op invalidations', () => {
      const p = fixture(engine, (api, capture) => {
        const b = api.builder;
        api.resistor('top').setEnabled(b.const('bool', true));
        api.resistor('bottom').setEnabled(b.const('bool', true));
        capture(api, 0);
        api.applyResistors(['top', 'bottom'], [b.const('f64', 3000), b.const('f64', 1000)]);
        capture(api, 1);
        api.applyResistors(['top', 'bottom'], [b.const('f64', 3000), b.const('f64', 1000)]);
        capture(api, 2);
      });
      p.run();
      expect(p.fault()).toBe(0);
      expect(p.sample(0).voltage).toBeCloseTo(1.65, 12);
      expect(p.sample(1).voltage).toBeCloseTo(0.825, 12);
      expect(p.sample(2)).toEqual(p.sample(1));
      expect(p.matrixVersion()).toBe(3);
      expect(p.factors()).toBe(3);
    });

    test.each([0, -1, NaN, Infinity])(
      'validates the entire resistance patch before writing (%s)',
      (bad) => {
        const p = fixture(engine, (api) => {
          const b = api.builder;
          api.applyResistors(['top', 'bottom'], [b.const('f64', 3000), b.const('f64', bad)]);
        });
        p.run();
        expect(p.fault()).toBe(1);
        expect(p.resistance('top')).toBe(1000);
        expect(p.resistance('bottom')).toBe(1000);
        expect(p.matrixVersion()).toBe(0);
      },
    );

    test.each([NaN, Infinity, -Infinity])('does not commit nonfinite analog intent (%s)', (bad) => {
      const p = fixture(engine, (api, capture) => {
        const b = api.builder;
        const pin = api.pin('A');
        pin.configure(PIN_MODE.analog);
        pin.setOutputEnabled(b.const('bool', true));
        pin.writeVoltage(b.const('f64', 1.2));
        capture(api, 0);
        pin.writeVoltage(b.const('f64', bad));
        pin.writeVoltage(b.const('f64', 2.5));
        capture(api, 1);
      });
      p.run();
      expect(p.fault()).toBe(1);
      expect(p.sample(0).voltage).toBeCloseTo(1.2, 12);
      expect(p.sample(1)).toEqual(p.sample(0));
    });

    test('commits symmetric contacts and keeps the last complete sample on a source conflict', () => {
      const p = fixture(engine, (api, capture) => {
        const b = api.builder;
        api.pin('A').setPull('up');
        api.applyConnections(['bridge'], [b.const('bool', true)]);
        capture(api, 0, 'B');
        api.applyConnections(['short'], [b.const('bool', true)]);
        capture(api, 1, 'B');
        api.applyConnections(['bridge'], [b.const('bool', false)]);
        capture(api, 2, 'B');
      });
      p.run();
      expect(p.fault()).toBe(2);
      expect(p.sample(0).digital).toBe(true);
      expect(p.sample(1)).toEqual(p.sample(0));
      expect(p.sample(2)).toEqual(p.sample(0));
      expect(p.topologyVersion()).toBe(2);
    });

    test('stops a batch at the failed electrical phase and records only completed ticks', () => {
      const p = fixture(engine, (api) => {
        const b = api.builder;
        const ticks = api.state<'u32'>('ticks');
        const next = b.int.add(ticks.load(), b.const('u32', 1));
        ticks.store(next);
        api.applyConnections(['short'], [b.int.cmp('eq', next, b.const('u32', 3))]);
      });
      p.batch(10);
      expect(p.fault()).toBe(2);
      expect(p.progress()).toBe(2);
      expect(p.state('ticks')).toBe(3);
      expect(p.state('updates')).toBe(2);
      p.batch(10);
      expect(p.progress()).toBe(0);
      expect(p.state('ticks')).toBe(3);
      expect(p.state('updates')).toBe(2);
      p.step();
      expect(p.progress()).toBe(0);
      expect(p.state('ticks')).toBe(3);
    });

    test('counts successful steps and batches and preserves step/batch behavior', () => {
      const action = (api: DeviceBehaviorApi, capture: Capture) => {
        const b = api.builder;
        const ticks = api.state<'u32'>('ticks');
        ticks.store(b.int.add(ticks.load(), b.const('u32', 1)));
        const pin = api.pin('A');
        pin.configure(PIN_MODE.pushPull);
        pin.setOutputEnabled(b.const('bool', true));
        pin.writeDigital(b.bool.not(pin.readDrivenDigital()));
        capture(api, 0);
      };
      const steps = fixture(engine, action);
      const batch = fixture(engine, action);
      for (let i = 0; i < 7; i++) {
        steps.step();
        expect(steps.progress()).toBe(1);
      }
      batch.batch(7);
      expect(batch.progress()).toBe(7);
      expect(steps.sample(0)).toEqual(batch.sample(0));
      expect(steps.state('ticks')).toBe(7);
      expect(batch.state('updates')).toBe(7);
      batch.batch(0);
      expect(batch.progress()).toBe(0);
      expect(batch.state('updates')).toBe(7);
    });

    test('resolves writes from update before completing the tick', () => {
      const p = fixture(
        engine,
        () => {},
        'two-state',
        true,
        (api) => api.pin('A').setPull('up'),
      );
      p.step();
      expect(p.fault()).toBe(0);
      expect(p.progress()).toBe(1);
      expect(p.physical('A').state).toBe(0);
      expect(p.physical('A').voltage).toBeCloseTo(3.3, 12);
      expect(p.factors()).toBe(2);
    });

    test('keeps failed update effects but does not count the failed tick', () => {
      const p = fixture(
        engine,
        () => {},
        'two-state',
        true,
        (api) => api.applyConnections(['short'], [api.builder.const('bool', true)]),
      );
      p.batch(5);
      expect(p.fault()).toBe(2);
      expect(p.progress()).toBe(0);
      expect(p.state('updates')).toBe(1);
      p.step();
      expect(p.state('updates')).toBe(1);
      expect(p.progress()).toBe(0);
    });

    test('does not count or run update after an invalid atomic patch', () => {
      const p = fixture(engine, (api) =>
        api.applyResistors(
          ['top', 'bottom'],
          [api.builder.const('f64', 2000), api.builder.const('f64', 0)],
        ),
      );
      p.batch(4);
      expect(p.fault()).toBe(1);
      expect(p.progress()).toBe(0);
      expect(p.state('updates')).toBe(0);
      expect(p.resistance('top')).toBe(1000);
      expect(p.resistance('bottom')).toBe(1000);
    });

    test('lets a kernel bind the same typed operations without accessing electrical memories', () => {
      const p = fixture(
        engine,
        (api, capture) => {
          const pin = api.pin('A');
          pin.configure(PIN_MODE.pushPull);
          pin.setOutputEnabled(api.builder.const('bool', true));
          pin.writeDigital(api.builder.const('bool', true));
          capture(api, 0);
        },
        'two-state',
        true,
        undefined,
        true,
      );
      p.step();
      expect(p.fault()).toBe(0);
      expect(p.sample(0).digital).toBe(true);
      expect(p.progress()).toBe(1);
      expect(p.state('updates')).toBe(1);
    });

    test('allows a passive factory with no tick and does not install push-pull initialization', () => {
      const p = fixture(engine, () => {}, 'two-state', false);
      expect(p.generated.entry.initialize).toBeUndefined();
      expect(p.generated.entry.tick).toBeUndefined();
      p.run();
      expect(p.fault()).toBe(0);
    });
  });

test('exposes typed operations instead of raw electrical memory to kernels and behaviors', () => {
  expectTypeOf<DeviceBehaviorApi>().not.toHaveProperty('memory');
  fixture('jit', (api) => {
    expect(api).not.toHaveProperty('memory');
  });
  const module = createIRModule();
  const prepared = prepareElectricalDevice(
    { pins: { P: { kind: 'signal' } } },
    {},
    () => undefined,
  );
  const allocation = allocateElectricalNetwork([{ id: 'passive', prepared }], {}, []);
  const electrical = createElectricalOperations(module, allocation, 'two-state', 'guard');
  const device: DeviceConfig = {
    id: 'passive',
    type: 'test-passive',
    description: {
      pins: prepared.pinDeclarations,
      factory: () => undefined,
      kernel: (context) => {
        expectTypeOf<typeof context>().not.toHaveProperty('memory');
        expect(context).not.toHaveProperty('memory');
        expect(context.bind).toBeTypeOf('function');
        return {};
      },
    },
  };
  const resources = new GlobalResourceAllocator(module).allocate([device]);
  expect(() =>
    new DeviceIRGenerator({ module, ...resources, electrical }).generate(device),
  ).not.toThrow();
});

test.each([
  (api: DeviceBehaviorApi) => api.applyConnections([], []),
  (api: DeviceBehaviorApi) => api.writeDigitalGroup([], []),
  (api: DeviceBehaviorApi) => api.applyResistors([], []),
  (api: DeviceBehaviorApi) => api.pin('PASSIVE').writeDigital(api.builder.const('bool', true)),
  (api: DeviceBehaviorApi) => api.pin('PASSIVE').sampleDigital(),
  (api: DeviceBehaviorApi) => api.pin('PASSIVE').setPull('up'),
  (api: DeviceBehaviorApi) => api.pin('A').configure(255),
  (api: DeviceBehaviorApi) => api.resistor('other-device.top'),
  (api: DeviceBehaviorApi) =>
    api.applyResistors(
      ['top', 'top'],
      [api.builder.const('f64', 1000), api.builder.const('f64', 2000)],
    ),
  (api: DeviceBehaviorApi) => api.applyResistors(['top'], []),
  (api: DeviceBehaviorApi) => api.applyConnections(['unknown'], [api.builder.const('bool', true)]),
  (api: DeviceBehaviorApi) =>
    api.writeDigitalGroup(
      ['A', 'PASSIVE'],
      [api.builder.const('bool', true), api.builder.const('bool', true)],
    ),
])('rejects unauthorized or malformed electrical instructions while building IR', (action) => {
  expect(() => fixture('jit', action)).toThrow();
});
