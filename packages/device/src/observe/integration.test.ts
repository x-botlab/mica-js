import { describe, expect, it } from 'vitest';
import {
  createPowerRuntime,
  createScheduler,
  type ElectricalPinInput,
  type PowerDefinition,
  type PowerRuntime,
  type Scheduler,
  type TopologyDefinition,
  type TopologyPinRef,
} from '@mica-js/core';
import type { ArrayRef, EntryRef, ScalarType, StateRef } from '@mica-js/ir';
import { createForTest, expectDeviceError, testDescription } from '../lifecycle/test-helpers';
import type { DeviceAPI, DeviceDescription, DeviceFactory } from '../types';

const MODEL = Object.freeze({
  kind: 'ideal-voltage' as const,
  minVoltage: 0,
  maxVoltage: 5,
  lowVoltage: 0,
  highVoltage: 5,
});

const PINS = {
  VDD: { kind: 'power', side: 'top' },
  GND: { kind: 'gnd', side: 'bottom' },
  IN: { kind: 'signal', side: 'left', powerDomain: 'io', levels: { low: 0.3, high: 0.7 } },
  CAP: { kind: 'signal', side: 'left', powerDomain: 'io', levels: { low: 0.3, high: 0.7 } },
} as const;

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

function analog(instanceId: string, pinName: string, voltage: number): ElectricalPinInput {
  return pinState(instanceId, pinName, {
    mode: 'analog',
    outputEnabled: true,
    voltageIntent: voltage,
  });
}

function pushPull(instanceId: string, pinName: string, high: boolean): ElectricalPinInput {
  return pinState(instanceId, pinName, {
    mode: 'push-pull',
    outputEnabled: true,
    digitalIntent: high,
  });
}

function signal(instanceId: string, pinName: string): TopologyPinRef {
  return { instanceId, pinName };
}

function circuit(): {
  readonly topology: TopologyDefinition;
  readonly pinStates: readonly ElectricalPinInput[];
} {
  return {
    topology: {
      pins: [
        { instanceId: 'psu', pinName: 'VCC', kind: 'power' },
        { instanceId: 'psu', pinName: 'GND', kind: 'gnd' },
        { instanceId: 'src', pinName: 'A', kind: 'signal' },
        { instanceId: 'src', pinName: 'B', kind: 'signal' },
        { instanceId: 'dev', pinName: 'VDD', kind: 'power' },
        { instanceId: 'dev', pinName: 'GND', kind: 'gnd' },
        { instanceId: 'dev', pinName: 'IN', kind: 'signal' },
        { instanceId: 'dev', pinName: 'CAP', kind: 'signal' },
      ],
      wires: [
        {
          wireId: 'supply',
          pins: [signal('psu', 'VCC'), signal('dev', 'VDD')],
        },
        {
          wireId: 'ground',
          pins: [signal('psu', 'GND'), signal('dev', 'GND')],
          globalGnd: true,
        },
        { wireId: 'trigger', pins: [signal('src', 'A'), signal('dev', 'IN')] },
        { wireId: 'capture', pins: [signal('src', 'B'), signal('dev', 'CAP')] },
      ],
      connections: [],
    },
    pinStates: [
      analog('psu', 'VCC', 5),
      pinState('psu', 'GND'),
      pushPull('src', 'A', false),
      pushPull('src', 'B', true),
      pinState('dev', 'VDD'),
      pinState('dev', 'GND'),
      pinState('dev', 'IN'),
      pinState('dev', 'CAP'),
    ],
  };
}

function powerDefinition(): PowerDefinition {
  return {
    topology: circuit().topology,
    devices: [
      {
        instanceId: 'dev',
        powerDomains: {
          io: { supply: 'VDD', ground: 'GND', voltage: { turnOn: 3, turnOff: 2 } },
        },
        pins: {
          IN: { powerDomain: 'io', levels: { low: 0.3, high: 0.7 } },
          CAP: { powerDomain: 'io', levels: { low: 0.3, high: 0.7 } },
        },
      },
    ],
  };
}

function description(): DeviceDescription {
  return testDescription({ pins: PINS }, 'acme:observe-integration');
}

interface Harness {
  readonly scheduler: Scheduler;
  readonly power: PowerRuntime;
  readonly instance: ReturnType<typeof createForTest>['instance'];
  readonly state: StateRef<'u32'>;
  readonly edges: ArrayRef<'u8'>;
  readonly captures: ArrayRef<'u32'>;
  readonly log: ArrayRef<'u32'>;
  readonly api: DeviceAPI;
  readonly entries: {
    readonly disable: EntryRef<readonly []>;
    readonly enableBoth: EntryRef<readonly []>;
    readonly enableRising: EntryRef<readonly []>;
    readonly mark: EntryRef<readonly []>;
  };
}

function harness(): Harness {
  const scheduler = createScheduler();
  const power = createPowerRuntime(scheduler, powerDefinition(), {
    instanceId: 'power',
    pinStates: circuit().pinStates,
  });
  let apiRef: DeviceAPI | undefined;
  let refs:
    | {
        readonly state: StateRef<'u32'>;
        readonly edges: ArrayRef<'u8'>;
        readonly captures: ArrayRef<'u32'>;
        readonly log: ArrayRef<'u32'>;
        readonly entries: Harness['entries'];
      }
    | undefined;

  const factory: DeviceFactory = (api) => {
    const trigger = api.ir.pin('IN');
    const capture = api.ir.pin('CAP');
    const count = api.ir.state('count', 'u32', 0);
    const edges = api.ir.array('edges', 'u8', [0, 0, 0, 0, 0, 0, 0, 0]);
    const captures = api.ir.array('captures', 'u32', [0, 0, 0, 0, 0, 0, 0, 0]);
    const log = api.ir.array('log', 'u32', [0, 0, 0, 0, 0, 0, 0, 0]);
    const logCount = api.ir.state('logCount', 'u32', 0);

    const onEdge = api.ir.entry('onEdge', ['u8', 'u32', 'u32']);
    onEdge.body((b, [edge, , captureLevel]) => {
      const index = b.state.load(count);
      const logIndex = b.state.load(logCount);
      b.array.store(edges, index, edge);
      b.array.store(captures, index, captureLevel);
      b.array.store(log, logIndex, b.const('u32', 1));
      b.state.store(count, b.int.add(index, b.const('u32', 1)));
      b.state.store(logCount, b.int.add(logIndex, b.const('u32', 1)));
      b.return([]);
    });

    const mark = api.ir.entry('mark', []);
    mark.body((b) => {
      const index = b.state.load(logCount);
      b.array.store(log, index, b.const('u32', 2));
      b.state.store(logCount, b.int.add(index, b.const('u32', 1)));
      b.return([]);
    });

    const observer = api.ir.observeDigital('edge', {
      trigger,
      captures: [trigger, capture],
      target: onEdge,
    });

    const disable = api.ir.entry('disable', []);
    disable.body((b) => {
      b.observe.configure(observer, { enabled: false, edges: 'both' });
      b.return([]);
    });
    const enableBoth = api.ir.entry('enableBoth', []);
    enableBoth.body((b) => {
      b.observe.configure(observer, { enabled: true, edges: 'both' });
      b.return([]);
    });
    const enableRising = api.ir.entry('enableRising', []);
    enableRising.body((b) => {
      b.observe.configure(observer, { enabled: true, edges: 'rising' });
      b.return([]);
    });

    const initialize = api.ir.lifecycle('initialize', []);
    initialize.body((b) => {
      b.observe.configure(observer, { enabled: true, edges: 'both' });
      b.return([]);
    });

    apiRef = api;
    refs = {
      state: count,
      edges,
      captures,
      log,
      entries: { disable, enableBoth, enableRising, mark },
    };
    return { initialize };
  };

  const { instance } = createForTest(
    factory,
    { instanceId: 'dev', pinHost: power },
    scheduler,
    description(),
  );
  scheduler.start({ until: 0 });
  if (apiRef === undefined || refs === undefined) throw new Error('Factory did not run');
  return { scheduler, power, instance, api: apiRef, ...refs };
}

function load(harness: Harness, ref: StateRef<'u32'>): number {
  return harness.instance.storage.loadState(ref);
}

function array<T extends ScalarType>(harness: Harness, ref: ArrayRef<T>, index: number): number {
  return Number(harness.instance.storage.loadArray(ref, index));
}

describe('device observation with the real scheduler, IR and power runtime', () => {
  it('delivers edge payloads, initializes the baseline without a false edge, and keeps captures by value', async () => {
    const fixture = harness();
    expect(load(fixture, fixture.state)).toBe(0);
    expect(fixture.instance.state).toBe('ready');

    fixture.power.updatePinStates([pushPull('src', 'A', true)]);
    fixture.scheduler.start();
    expect(load(fixture, fixture.state)).toBe(1);
    expect(array(fixture, fixture.edges, 0)).toBe(1);
    expect(array(fixture, fixture.captures, 0)).toBe(1);

    fixture.power.updatePinStates([pushPull('src', 'B', false)]);
    fixture.scheduler.start();
    fixture.power.updatePinStates([pushPull('src', 'A', false)]);
    fixture.scheduler.start();
    expect(load(fixture, fixture.state)).toBe(2);
    expect(array(fixture, fixture.edges, 1)).toBe(2);
    expect(array(fixture, fixture.captures, 1)).toBe(0);

    fixture.power.updatePinStates([pushPull('src', 'A', false)]);
    fixture.scheduler.start();
    expect(load(fixture, fixture.state)).toBe(2);

    // Queue a falling edge while CAP is 1, then change CAP before the ordinary entry runs.
    fixture.power.updatePinStates([pushPull('src', 'B', true)]);
    fixture.scheduler.start();
    fixture.power.updatePinStates([pushPull('src', 'A', true)]);
    fixture.scheduler.start();
    expect(load(fixture, fixture.state)).toBe(3);
    expect(array(fixture, fixture.captures, 2)).toBe(1);

    fixture.power.updatePinStates([pushPull('src', 'A', false)]);
    for (let index = 0; index < 8; index += 1) {
      if (fixture.power.sampleDigital(signal('dev', 'IN')).value !== 0) {
        fixture.scheduler.step();
      }
    }
    fixture.power.updatePinStates([pushPull('src', 'B', false)]);
    for (let index = 0; index < 8; index += 1) {
      if (fixture.power.sampleDigital(signal('src', 'B')).value !== 0) {
        fixture.scheduler.step();
      }
    }
    fixture.scheduler.start();
    expect(load(fixture, fixture.state)).toBe(4);
    expect(array(fixture, fixture.captures, 3)).toBe(1);
    expect(array(fixture, fixture.edges, 3)).toBe(2);
  });

  it('honors rising selection and reconfigure baselines', async () => {
    const fixture = harness();
    await fixture.api.post(fixture.entries.enableRising, []);
    fixture.scheduler.start();
    expect(load(fixture, fixture.state)).toBe(0);

    fixture.power.updatePinStates([pushPull('src', 'A', true)]);
    fixture.scheduler.start();
    expect(load(fixture, fixture.state)).toBe(1);
    fixture.power.updatePinStates([pushPull('src', 'A', false)]);
    fixture.scheduler.start();
    expect(load(fixture, fixture.state)).toBe(1);

    await fixture.api.post(fixture.entries.enableBoth, []);
    fixture.scheduler.start();
    expect(load(fixture, fixture.state)).toBe(1);
    fixture.power.updatePinStates([pushPull('src', 'A', true)]);
    fixture.scheduler.start();
    expect(load(fixture, fixture.state)).toBe(2);
  });

  it('suppresses delivery while gated and rebuilds the baseline after recovery', async () => {
    const fixture = harness();
    fixture.power.updatePinStates([pushPull('src', 'A', true)]);
    fixture.scheduler.start();
    expect(load(fixture, fixture.state)).toBe(1);

    fixture.power.updatePinStates([analog('psu', 'VCC', 0)]);
    fixture.scheduler.start();
    expect(load(fixture, fixture.state)).toBe(1);

    fixture.power.updatePinStates([analog('psu', 'VCC', 5)]);
    fixture.scheduler.start();
    expect(load(fixture, fixture.state)).toBe(1);

    fixture.power.updatePinStates([pushPull('src', 'A', false)]);
    fixture.scheduler.start();
    expect(load(fixture, fixture.state)).toBe(2);
    expect(array(fixture, fixture.edges, 1)).toBe(2);
  });

  it('stops capture when disabled and does not deliver retained configuration after re-enable', async () => {
    const fixture = harness();
    await fixture.api.post(fixture.entries.disable, []);
    fixture.scheduler.start();
    fixture.power.updatePinStates([pushPull('src', 'A', true)]);
    fixture.scheduler.start();
    expect(load(fixture, fixture.state)).toBe(0);

    await fixture.api.post(fixture.entries.enableBoth, []);
    fixture.scheduler.start();
    expect(load(fixture, fixture.state)).toBe(0);
    fixture.power.updatePinStates([pushPull('src', 'A', false)]);
    fixture.scheduler.start();
    expect(load(fixture, fixture.state)).toBe(1);
    expect(array(fixture, fixture.edges, 0)).toBe(2);
  });

  it('preserves both edges of a same-time pulse without advancing virtual time', () => {
    const fixture = harness();
    fixture.power.updatePinStates([pushPull('src', 'A', true)]);
    for (let index = 0; index < 8; index += 1) {
      if (fixture.power.sampleDigital(signal('dev', 'IN')).value !== 1) {
        fixture.scheduler.step();
      }
    }
    fixture.power.updatePinStates([pushPull('src', 'A', false)]);
    for (let index = 0; index < 8; index += 1) {
      if (fixture.power.sampleDigital(signal('dev', 'IN')).value !== 0) {
        fixture.scheduler.step();
      }
    }
    expect(fixture.scheduler.now).toBe(0);
    fixture.scheduler.start();
    expect(load(fixture, fixture.state)).toBe(2);
    expect(array(fixture, fixture.edges, 0)).toBe(1);
    expect(array(fixture, fixture.edges, 1)).toBe(2);
  });

  it('shares the ordinary queue with api.post in admission order', async () => {
    const fixture = harness();
    fixture.power.updatePinStates([pushPull('src', 'A', true)]);
    for (let index = 0; index < 8; index += 1) {
      if (fixture.power.sampleDigital(signal('dev', 'IN')).value !== 1) {
        fixture.scheduler.step();
      }
    }
    await fixture.api.post(fixture.entries.mark, []);
    fixture.scheduler.start();
    expect(load(fixture, fixture.state)).toBe(1);
    expect(array(fixture, fixture.log, 0)).toBe(1);
    expect(array(fixture, fixture.log, 1)).toBe(2);
  });

  it('rejects observation without a capable host and mismatched link signatures', () => {
    const scheduler = createScheduler();
    const power = createPowerRuntime(scheduler, powerDefinition(), {
      instanceId: 'power',
      pinStates: circuit().pinStates,
    });

    const link: DeviceFactory = (api) => {
      const trigger = api.ir.pin('IN');
      const target = api.ir.entry('wrong', ['u8', 'u32']);
      target.body((b) => b.return([]));
      api.ir.observeDigital('edge', { trigger, captures: [], target: target as never });
      return {};
    };
    expectDeviceError(
      () =>
        createForTest(
          link,
          { instanceId: 'dev', pinHost: power },
          createScheduler(),
          description(),
        ),
      'device/observe-binding',
    );

    const noHost: DeviceFactory = (api) => {
      const trigger = api.ir.pin('IN');
      const target = api.ir.entry('onEdge', ['u8']);
      target.body((b) => b.return([]));
      api.ir.observeDigital('edge', { trigger, captures: [], target });
      return {};
    };
    expectDeviceError(
      () => createForTest(noHost, { instanceId: 'dev' }, createScheduler(), description()),
      'device/observe-unavailable',
    );

    const bareHost = {
      pinIntent: (ref: TopologyPinRef) => pinState(ref.instanceId, ref.pinName),
      updatePinStates: () => undefined,
      sampleDigital: () => ({ value: 0 as const, ready: true, source: 'sampled' as const }),
    };
    expectDeviceError(
      () =>
        createForTest(
          noHost,
          { instanceId: 'dev', pinHost: bareHost },
          createScheduler(),
          description(),
        ),
      'device/observe-unavailable',
    );

    let closedApi: DeviceAPI | undefined;
    let closedTrigger: ReturnType<DeviceAPI['ir']['pin']> | undefined;
    let closedTarget: EntryRef<readonly ['u8']> | undefined;
    const closed: DeviceFactory = (api) => {
      closedApi = api;
      const trigger = api.ir.pin('IN');
      closedTrigger = trigger;
      const target = api.ir.entry('onEdge', ['u8']);
      closedTarget = target;
      target.body((b) => b.return([]));
      api.ir.observeDigital('edge', { trigger, captures: [], target });
      return {};
    };
    const closedInstance = createForTest(
      closed,
      { instanceId: 'dev', pinHost: power },
      createScheduler(),
      description(),
    ).instance;
    expectDeviceError(
      () =>
        closedApi!.ir.observeDigital('again', {
          trigger: closedTrigger!,
          captures: [],
          target: closedTarget!,
        }),
      'device/factory-closed',
    );
    closedInstance.destroy();
  });

  it('stops delivering after destroy', () => {
    const fixture = harness();
    fixture.instance.destroy();
    expect(fixture.instance.state).toBe('destroyed');
    expect(() => {
      fixture.power.updatePinStates([pushPull('src', 'A', true)]);
      fixture.scheduler.start();
    }).not.toThrow();
    expect(fixture.power.sampleDigital(signal('dev', 'IN')).value).toBe(1);
    fixture.instance.destroy();
  });
});
