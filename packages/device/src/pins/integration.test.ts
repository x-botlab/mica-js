import { describe, expect, it } from 'vitest';
import {
  createPowerRuntime,
  createScheduler,
  ElectricalConflictError,
  type ElectricalPinInput,
  type PowerDefinition,
  type PowerRuntime,
  type TopologyDefinition,
} from '@mica-js/core';
import type { EntryRef, StateRef } from '@mica-js/ir';
import { DeviceError } from '../errors';
import { createForTest, testDescription } from '../lifecycle/test-helpers';
import type { DeviceDescription, DeviceFactory, DevicePinHost } from '../types';

const MODEL = {
  kind: 'ideal-voltage' as const,
  minVoltage: 0,
  maxVoltage: 5,
  lowVoltage: 0,
  highVoltage: 5,
};

const DEVICE_PINS = {
  VDD: { kind: 'power', side: 'top' },
  GND: { kind: 'gnd', side: 'bottom' },
  OUT: { kind: 'signal', side: 'right' },
  IN: { kind: 'signal', side: 'left', powerDomain: 'io', levels: { low: 0.3, high: 0.7 } },
} as const;

function description(withConflict = false): DeviceDescription {
  return testDescription({ pins: DEVICE_PINS }, withConflict ? 'acme:conflict' : 'acme:mcu');
}

function pinState(
  instanceId: string,
  pinName: string,
  overrides: Partial<ElectricalPinInput> = {},
): ElectricalPinInput {
  return {
    instanceId,
    pinName,
    powerReady: true,
    mode: 'high-z',
    outputEnabled: false,
    pull: 'none',
    model: MODEL,
    ...overrides,
  };
}

function circuit(conflict: boolean): {
  readonly topology: TopologyDefinition;
  readonly deviceInstanceIds: readonly string[];
  readonly pinStates: readonly ElectricalPinInput[];
} {
  const pins = [
    { instanceId: 'psu', pinName: 'VCC', kind: 'power' as const },
    { instanceId: 'psu', pinName: 'GND', kind: 'gnd' as const },
    { instanceId: 'sw', pinName: 'G1', kind: 'gnd' as const },
    { instanceId: 'sw', pinName: 'G2', kind: 'gnd' as const },
    { instanceId: 'dev', pinName: 'VDD', kind: 'power' as const },
    { instanceId: 'dev', pinName: 'GND', kind: 'gnd' as const },
    { instanceId: 'dev', pinName: 'OUT', kind: 'signal' as const },
    { instanceId: 'dev', pinName: 'IN', kind: 'signal' as const },
    ...(conflict ? [{ instanceId: 'rly', pinName: 'OUT', kind: 'signal' as const }] : []),
  ];
  const ioPins = [
    { instanceId: 'dev', pinName: 'OUT' },
    { instanceId: 'dev', pinName: 'IN' },
    ...(conflict ? [{ instanceId: 'rly', pinName: 'OUT' }] : []),
  ];
  return {
    topology: {
      pins,
      wires: [
        {
          wireId: 'supply',
          pins: [
            { instanceId: 'psu', pinName: 'VCC' },
            { instanceId: 'dev', pinName: 'VDD' },
          ],
        },
        {
          wireId: 'ground',
          pins: [
            { instanceId: 'psu', pinName: 'GND' },
            { instanceId: 'sw', pinName: 'G1' },
          ],
          globalGnd: true,
        },
        {
          wireId: 'deviceGround',
          pins: [
            { instanceId: 'sw', pinName: 'G2' },
            { instanceId: 'dev', pinName: 'GND' },
          ],
        },
        { wireId: 'io', pins: ioPins },
      ],
      connections: [
        {
          instanceId: 'sw',
          connectionId: 'gnd',
          pins: ['G1', 'G2'],
          initial: 'closed',
        },
      ],
    },
    deviceInstanceIds: ['dev'],
    pinStates: [
      pinState('psu', 'VCC', {
        mode: 'analog',
        outputEnabled: true,
        voltageIntent: 5,
      }),
      pinState('psu', 'GND'),
      pinState('sw', 'G1'),
      pinState('sw', 'G2'),
      pinState('dev', 'VDD'),
      pinState('dev', 'GND'),
      pinState('dev', 'OUT', { powerReady: false }),
      pinState('dev', 'IN', { powerReady: false }),
      ...(conflict ? [pinState('rly', 'OUT')] : []),
    ],
  };
}

function definition(conflict: boolean): PowerDefinition {
  const { topology } = circuit(conflict);
  return {
    topology,
    devices: [
      {
        instanceId: 'dev',
        powerDomains: {
          io: { supply: 'VDD', ground: 'GND', voltage: { turnOn: 3, turnOff: 2 } },
        },
        pins: {
          OUT: { powerDomain: 'io' },
          IN: { powerDomain: 'io', levels: { low: 0.3, high: 0.7 } },
        },
      },
    ],
  };
}

function powerFor(scheduler: ReturnType<typeof createScheduler>, conflict = false): PowerRuntime {
  return createPowerRuntime(scheduler, definition(conflict), {
    instanceId: 'power',
    pinStates: circuit(conflict).pinStates,
  });
}

function psu(voltage: number): ElectricalPinInput {
  return pinState('psu', 'VCC', {
    mode: 'analog',
    outputEnabled: true,
    voltageIntent: voltage,
  });
}

interface Captures {
  readonly same: StateRef<'u32'>;
  readonly states: readonly StateRef<'u32'>[];
}

function schedulerFactory(): {
  readonly factory: DeviceFactory;
  readonly captures: () => Captures;
} {
  let captures: Captures | undefined;
  const factory: DeviceFactory = (api) => {
    const out = api.ir.pin('OUT');
    const input = api.ir.pin('IN');
    const same = api.ir.state('sameEntry', 'u32', 99);
    const states: StateRef<'u32'>[] = [];
    const entries: EntryRef<readonly []>[] = [];
    for (let index = 0; index < 8; index += 1) {
      const state = api.ir.state(`s${index}`, 'u32', 99);
      const entry = api.ir.entry(`capture${index}`, []);
      entries.push(entry);
      states.push(state);
      entry.body((b) => {
        b.state.store(state, b.pin.sampleDigital(input));
        b.return([]);
      });
    }
    const initialize = api.ir.lifecycle('initialize', []);
    initialize.body((b) => {
      b.pin.configure(out, { mode: 'push-pull', outputEnabled: true, pull: 'none' });
      b.pin.writeDigital(out, b.const('bool', true));
      b.state.store(same, b.pin.sampleDigital(out));
      entries.forEach((entry, index) => {
        b.event.at(entry, b.const('f64', (index + 1) * 1000), []);
      });
      b.return([]);
    });
    captures = { same, states };
    return { initialize };
  };
  return {
    factory,
    captures: () => {
      if (captures === undefined) throw new Error('Factory did not run');
      return captures;
    },
  };
}

function load(
  instance: ReturnType<typeof createForTest>['instance'],
  state: StateRef<'u32'>,
): number {
  return instance.storage.loadState(state);
}

describe('device pin I/O with the real scheduler, IR and power runtime', () => {
  it('drives and samples through control phases, holding intent across gating', () => {
    const scheduler = createScheduler();
    const power = powerFor(scheduler);
    const { factory, captures } = schedulerFactory();
    const { instance } = createForTest(
      factory,
      { instanceId: 'dev', pinHost: power },
      scheduler,
      description(),
    );
    const refs = captures();
    // #12 initial state is submitted at link, before initialize runs.
    const initial = power.pinIntent({ instanceId: 'dev', pinName: 'OUT' });
    expect(initial).toMatchObject({ mode: 'high-z', outputEnabled: false, pull: 'none' });
    expect('digitalIntent' in initial).toBe(false);

    scheduler.start({ until: 1000 });
    expect(instance.state).toBe('ready');
    // Same-entry sampling sees the previous committed interpretation, not the just-written intent.
    expect(load(instance, refs.same)).toBe(0);
    expect(load(instance, refs.states[0]!)).toBe(1);

    power.updatePinStates([psu(0)]);
    scheduler.start({ until: 2000 });
    expect(load(instance, refs.states[1]!)).toBe(0);
    const held = power.pinIntent({ instanceId: 'dev', pinName: 'OUT' });
    expect(held).toMatchObject({ mode: 'push-pull', outputEnabled: true, digitalIntent: true });
    expect(power.sampleDigital({ instanceId: 'dev', pinName: 'OUT' })).toMatchObject({
      value: 0,
      ready: false,
      source: 'gated',
    });

    power.updatePinStates([psu(5)]);
    scheduler.start({ until: 3000 });
    expect(load(instance, refs.states[2]!)).toBe(1);

    // Hysteresis: 2.5 V is between turnOff and turnOn, so the domain stays on.
    power.updatePinStates([psu(2.5)]);
    scheduler.start({ until: 4000 });
    expect(load(instance, refs.states[3]!)).toBe(1);

    power.updatePinStates([psu(1.5)]);
    scheduler.start({ until: 5000 });
    expect(load(instance, refs.states[4]!)).toBe(0);

    power.updatePinStates([psu(3.1)]);
    scheduler.start({ until: 6000 });
    expect(load(instance, refs.states[5]!)).toBe(1);

    power.submit({
      instanceId: 'sw',
      connections: [{ connectionId: 'gnd', state: 'open' }],
    });
    scheduler.start({ until: 7000 });
    expect(load(instance, refs.states[6]!)).toBe(0);

    power.submit({
      instanceId: 'sw',
      connections: [{ connectionId: 'gnd', state: 'closed' }],
    });
    scheduler.start({ until: 8000 });
    expect(load(instance, refs.states[7]!)).toBe(1);
    instance.destroy();
    // Destroy restores the host's pre-device intent instead of leaving a drive behind.
    expect(power.pinIntent({ instanceId: 'dev', pinName: 'OUT' })).toMatchObject({
      mode: 'high-z',
      outputEnabled: false,
      pull: 'none',
    });
    power.destroy();
  });

  it('keeps the held intent separate from the actual open-drain network state', () => {
    const scheduler = createScheduler();
    const power = powerFor(scheduler);
    let states: readonly StateRef<'u32'>[] | undefined;
    const factory: DeviceFactory = (api) => {
      const out = api.ir.pin('OUT');
      const input = api.ir.pin('IN');
      const first = api.ir.state('first', 'u32', 99);
      const second = api.ir.state('second', 'u32', 99);
      const capture0 = api.ir.entry('capture0', []);
      const capture1 = api.ir.entry('capture1', []);
      const pushPull = api.ir.entry('pushPull', []);
      capture0.body((b) => {
        b.state.store(first, b.pin.sampleDigital(input));
        b.return([]);
      });
      capture1.body((b) => {
        b.state.store(second, b.pin.sampleDigital(input));
        b.return([]);
      });
      pushPull.body((b) => {
        b.pin.configure(out, { mode: 'push-pull', outputEnabled: true, pull: 'none' });
        b.event.at(capture1, b.const('f64', 3000), []);
        b.return([]);
      });
      const initialize = api.ir.lifecycle('initialize', []);
      initialize.body((b) => {
        b.pin.configure(out, { mode: 'open-drain', outputEnabled: true, pull: 'none' });
        b.pin.writeDigital(out, b.const('bool', true));
        b.event.at(capture0, b.const('f64', 1000), []);
        b.event.at(pushPull, b.const('f64', 2000), []);
        b.return([]);
      });
      states = [first, second];
      return { initialize };
    };
    const { instance } = createForTest(
      factory,
      { instanceId: 'dev', pinHost: power },
      scheduler,
      description(),
    );
    scheduler.start({ until: 1000 });
    const refs = states!;
    expect(load(instance, refs[0]!)).toBe(0);
    expect(power.pinIntent({ instanceId: 'dev', pinName: 'OUT' })).toMatchObject({
      mode: 'open-drain',
      outputEnabled: true,
      digitalIntent: true,
    });
    scheduler.start({ until: 3000 });
    expect(load(instance, refs[1]!)).toBe(1);
  });

  it('keeps pin operations when the connection surface decorates function bodies', () => {
    const scheduler = createScheduler();
    const power = powerFor(scheduler);
    const factory: DeviceFactory = (api) => {
      const out = api.ir.pin('OUT');
      const contact = api.ir.connection('contact');
      void contact;
      const initialize = api.ir.lifecycle('initialize', []);
      initialize.body((b) => {
        b.pin.configure(out, { mode: 'push-pull', outputEnabled: true, pull: 'none' });
        b.pin.writeDigital(out, b.const('bool', true));
        b.return([]);
      });
      return { initialize };
    };
    const description = testDescription(
      {
        pins: DEVICE_PINS,
        connections: { contact: { pins: ['OUT', 'IN'], initial: 'open' } },
      },
      'acme:mcu-pins-connection',
    );
    createForTest(factory, { instanceId: 'dev', pinHost: power }, scheduler, description);
    scheduler.start({ until: 1000 });
    expect(power.pinIntent({ instanceId: 'dev', pinName: 'OUT' })).toMatchObject({
      mode: 'push-pull',
      outputEnabled: true,
      digitalIntent: true,
    });
  });

  it('reports conflicting strong drivers through ElectricalConflictError', () => {
    const scheduler = createScheduler();
    const power = powerFor(scheduler, true);
    const { factory } = schedulerFactory();
    createForTest(factory, { instanceId: 'dev', pinHost: power }, scheduler, description(true));
    scheduler.start({ until: 1000 });
    expect(scheduler.error).toBeUndefined();
    power.updatePinStates([
      pinState('rly', 'OUT', {
        mode: 'analog',
        outputEnabled: true,
        voltageIntent: 0,
      }),
    ]);
    expect(() => scheduler.start({ until: 2000 })).toThrow();
    expect(scheduler.error?.code).toBe('execution-failed');
    expect(scheduler.error?.cause).toBeInstanceOf(ElectricalConflictError);
  });

  it('rejects pin I/O without a host and for pins unknown to the host', () => {
    const scheduler = createScheduler();
    const { factory } = schedulerFactory();
    let error: unknown;
    try {
      createForTest(factory, { instanceId: 'dev' }, scheduler, description());
    } catch (cause) {
      error = cause;
    }
    expect(error).toBeInstanceOf(DeviceError);
    expect((error as DeviceError).code).toBe('device/pin-io-unavailable');

    const otherScheduler = createScheduler();
    const minimal: PowerDefinition = {
      topology: {
        pins: [
          { instanceId: 'dev', pinName: 'VDD', kind: 'power' },
          { instanceId: 'dev', pinName: 'GND', kind: 'gnd' },
        ],
        wires: [],
        connections: [],
      },
      devices: [{ instanceId: 'dev', powerDomains: {} }],
    };
    const host = createPowerRuntime(otherScheduler, minimal, {
      instanceId: 'power-min',
      pinStates: [pinState('dev', 'VDD'), pinState('dev', 'GND')],
    });
    let missing: unknown;
    try {
      createForTest(
        factory,
        { instanceId: 'dev', pinHost: host as DevicePinHost },
        otherScheduler,
        description(),
      );
    } catch (cause) {
      missing = cause;
    }
    expect(missing).toBeInstanceOf(DeviceError);
    expect((missing as DeviceError).code).toBe('device/pin-io-unavailable');
  });

  it('rejects an unknown pin id at factory time', () => {
    const scheduler = createScheduler();
    const power = powerFor(scheduler);
    const factory: DeviceFactory = (api) => {
      api.ir.pin('NOPE');
      return {};
    };
    let error: unknown;
    try {
      createForTest(factory, { instanceId: 'dev', pinHost: power }, scheduler, description());
    } catch (cause) {
      error = cause;
    }
    expect(error).toBeInstanceOf(DeviceError);
    expect((error as DeviceError).code).toBe('device/pin-unknown');
  });

  it('rejects power/gnd pin I/O while building the factory', () => {
    const scheduler = createScheduler();
    const power = powerFor(scheduler);
    const factory: DeviceFactory = (api) => {
      const vdd = api.ir.pin('VDD');
      const initialize = api.ir.lifecycle('initialize', []);
      initialize.body((b) => {
        b.pin.writeDigital(vdd, b.const('bool', true));
        b.return([]);
      });
      return { initialize };
    };
    let error: unknown;
    try {
      createForTest(factory, { instanceId: 'dev', pinHost: power }, scheduler, description());
    } catch (cause) {
      error = cause;
    }
    expect(error).toBeInstanceOf(DeviceError);
    expect((error as DeviceError).code).toBe('device/factory-failed');
  });
});
