import { describe, expect, it } from 'vitest';
import type { ElectricalPinInput } from '../electrical/types';
import { createScheduler } from '../scheduler/runtime';
import { SchedulerError } from '../scheduler/errors';
import type { Scheduler, SchedulerTarget } from '../scheduler/types';
import type {
  TopologyDefinition,
  TopologyExternalWire,
  TopologyPinDeclaration,
  TopologyPinRef,
} from '../topology/types';
import { createPowerRuntime, PowerFeedbackError } from './runtime';
import type {
  PowerDefinition,
  PowerDigitalPinChange,
  PowerDigitalSample,
  PowerDomainChange,
  PowerDomainObserver,
  PowerDomainSnapshot,
  PowerInputMode,
  PowerOptions,
  PowerRuntime,
} from './types';

const MODEL = Object.freeze({
  kind: 'ideal-voltage' as const,
  minVoltage: 0,
  maxVoltage: 5,
  lowVoltage: 0,
  highVoltage: 5,
});

type PinOverrides = Partial<Omit<ElectricalPinInput, 'instanceId' | 'pinName'>>;

function pinState(
  instanceId: string,
  pinName: string,
  overrides: PinOverrides = {},
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

interface Fixture {
  readonly scheduler: Scheduler;
  readonly power: PowerRuntime;
  readonly definition: PowerDefinition;
}

interface FixtureOptions {
  readonly inputMode?: PowerInputMode;
  readonly floating?: boolean;
  readonly maxPropagationRounds?: number;
  readonly observer?: PowerDomainObserver;
}

function fixture(options: FixtureOptions = {}): Fixture {
  const pins: TopologyPinDeclaration[] = [
    { instanceId: 'psu', pinName: 'VCC', kind: 'power' },
    { instanceId: 'psu', pinName: 'GND', kind: 'gnd' },
    { instanceId: 'psu', pinName: 'D', kind: 'signal' },
    { instanceId: 'mcu', pinName: 'VDD', kind: 'power' },
    { instanceId: 'mcu', pinName: 'GND', kind: 'gnd' },
    { instanceId: 'mcu', pinName: 'GND_BRIDGE', kind: 'gnd' },
    { instanceId: 'mcu', pinName: 'P0', kind: 'signal' },
    { instanceId: 'mcu', pinName: 'PUP', kind: 'signal' },
    { instanceId: 'mcu', pinName: 'OD', kind: 'signal' },
    { instanceId: 'mcu', pinName: 'AOUT', kind: 'signal' },
    { instanceId: 'mcu', pinName: 'DIN', kind: 'signal' },
    { instanceId: 'mcu', pinName: 'AIN', kind: 'signal' },
  ];
  const wires: TopologyExternalWire[] = [
    { wireId: 'vcc', pins: [signal('psu', 'VCC'), signal('mcu', 'VDD')] },
    {
      wireId: 'gnd',
      pins: [signal('psu', 'GND'), signal('mcu', 'GND_BRIDGE')],
      globalGnd: true,
    },
    { wireId: 'din', pins: [signal('psu', 'D'), signal('mcu', 'DIN')] },
  ];
  const topology: TopologyDefinition = {
    pins,
    wires,
    connections: [
      {
        instanceId: 'mcu',
        connectionId: 'gndLink',
        pins: ['GND', 'GND_BRIDGE'],
        initial: 'closed',
      },
    ],
  };
  const definition: PowerDefinition = {
    topology,
    devices: [
      {
        instanceId: 'mcu',
        powerDomains: {
          core: {
            supply: 'VDD',
            ground: 'GND',
            voltage: { turnOn: 3, turnOff: 2 },
          },
        },
        pins: {
          P0: { powerDomain: 'core' },
          PUP: { powerDomain: 'core' },
          OD: { powerDomain: 'core' },
          AOUT: { powerDomain: 'core' },
          DIN: { powerDomain: 'core', levels: { low: 0.3, high: 0.7 } },
          AIN: { powerDomain: 'core' },
        },
      },
    ],
  };
  const states: ElectricalPinInput[] = [
    analog('psu', 'VCC', 5),
    pinState('psu', 'GND'),
    analog('psu', 'D', 1.5),
    pinState('mcu', 'VDD'),
    pinState('mcu', 'GND'),
    pinState('mcu', 'GND_BRIDGE'),
    pushPull('mcu', 'P0', true),
    pinState('mcu', 'PUP', { pull: 'up' }),
    pinState('mcu', 'OD', {
      mode: 'open-drain',
      outputEnabled: true,
      digitalIntent: false,
    }),
    analog('mcu', 'AOUT', 2.5),
    pinState('mcu', 'DIN'),
    pinState('mcu', 'AIN'),
  ];
  const scheduler = createScheduler();
  const power = createPowerRuntime(scheduler, definition, {
    instanceId: 'power',
    pinStates: states,
    ...(options.floating === true ? { floating: { seed: 12345 } } : {}),
    ...(options.inputMode === undefined ? {} : { inputMode: options.inputMode }),
    ...(options.maxPropagationRounds === undefined
      ? {}
      : { maxPropagationRounds: options.maxPropagationRounds }),
    ...(options.observer === undefined ? {} : { observer: options.observer }),
  });
  return { scheduler, power, definition };
}

function network(power: PowerRuntime, instanceId: string, pinName: string) {
  const found = power.networkOf(signal(instanceId, pinName));
  expect(found).toBeDefined();
  return found!;
}

function run(scheduler: Scheduler): void {
  scheduler.start();
}

function setState(power: PowerRuntime, scheduler: Scheduler, state: ElectricalPinInput): void {
  power.updatePinStates([state]);
  run(scheduler);
}

function minimalInputs(): { definition: PowerDefinition; options: PowerOptions } {
  const definition: PowerDefinition = {
    topology: {
      pins: [
        { instanceId: 'd', pinName: 'VCC', kind: 'power' },
        { instanceId: 'd', pinName: 'GND', kind: 'gnd' },
        { instanceId: 'd', pinName: 'P0', kind: 'signal' },
      ],
      wires: [
        { wireId: 'vcc', pins: [signal('d', 'VCC')] },
        { wireId: 'gnd', pins: [signal('d', 'GND')], globalGnd: true },
      ],
      connections: [],
    },
    devices: [
      {
        instanceId: 'd',
        powerDomains: {
          core: { supply: 'VCC', ground: 'GND', voltage: { turnOn: 3, turnOff: 2 } },
        },
        pins: { P0: { powerDomain: 'core' } },
      },
    ],
  };
  const options: PowerOptions = {
    instanceId: 'power',
    pinStates: [pinState('d', 'VCC'), pinState('d', 'GND'), pinState('d', 'P0')],
  };
  return { definition, options };
}

function wrappedScheduler(
  real: Scheduler,
  failEnqueue = 0,
): {
  scheduler: Scheduler;
  created: string[];
  destroyed: string[];
} {
  const created: string[] = [];
  const destroyed: string[] = [];
  let remainingFailures = failEnqueue;
  const scheduler: Scheduler = {
    get now() {
      return real.now;
    },
    get state() {
      return real.state;
    },
    get error() {
      return real.error;
    },
    addInstance(definition) {
      const handle = real.addInstance(definition);
      created.push(definition.instanceId);
      return handle;
    },
    enqueueControl(instance, target, args) {
      if (remainingFailures > 0) {
        remainingFailures -= 1;
        throw new Error('enqueue failed');
      }
      real.enqueueControl(instance, target, args);
    },
    enqueueMessage(instance, target, args) {
      return real.enqueueMessage(instance, target, args);
    },
    destroyInstance(instance) {
      destroyed.push(instance.instanceId);
      real.destroyInstance(instance);
    },
    start(options) {
      return real.start(options);
    },
    pause() {
      real.pause();
    },
    step() {
      return real.step();
    },
  };
  return { scheduler, created, destroyed };
}

declare function setTimeout(callback: () => void, delay?: number): unknown;
const gc = (globalThis as unknown as { gc?: () => void }).gc;

async function collectGarbage(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    gc?.();
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  }
}

function weakObserver(): WeakRef<PowerDomainObserver> {
  return new WeakRef({ onPowerDomainChange() {} });
}

describe('power domains', () => {
  it('starts off, computes the initial on state, gates opening, then restores held intents', () => {
    const notifications: string[] = [];
    const { scheduler, power } = fixture({
      observer: {
        onPowerDomainChange(changes) {
          for (const change of changes) {
            notifications.push(
              `${change.instanceId}:${change.domainId}:${change.previousState}->${change.state}`,
            );
          }
        },
      },
    });

    expect(power.domain('mcu', 'core')).toMatchObject({
      state: 'on',
      voltage: 5,
      groundReady: true,
      dependenciesReady: true,
    });
    expect(power.pinGate(signal('mcu', 'P0'))).toMatchObject({
      domainId: 'core',
      ready: false,
      reason: 'opening',
    });
    expect(power.sampleDigital(signal('mcu', 'P0'))).toEqual({
      value: 0,
      ready: false,
      source: 'gated',
    });

    run(scheduler);
    expect(notifications).toEqual(['mcu:core:off->on']);
    expect(power.pinGate(signal('mcu', 'P0'))).toMatchObject({
      domainId: 'core',
      ready: true,
      reason: 'powered',
    });
    expect(network(power, 'mcu', 'P0').result).toMatchObject({
      state: 'driven',
      voltage: 5,
      strength: 'strong',
    });
    expect(network(power, 'mcu', 'PUP').result).toMatchObject({
      state: 'driven',
      voltage: 5,
      strength: 'weak',
    });
    expect(network(power, 'mcu', 'AOUT').result).toMatchObject({
      state: 'driven',
      voltage: 2.5,
      strength: 'strong',
    });
    expect(power.sampleDigital(signal('mcu', 'P0'))).toEqual({
      value: 1,
      ready: true,
      source: 'sampled',
    });
  });

  it('releases the network before notifying a power-down', () => {
    let releasedDuringNotification: string | undefined;
    const { scheduler, power } = fixture({
      observer: {
        onPowerDomainChange(changes) {
          if (changes.some((change) => change.state === 'off')) {
            releasedDuringNotification = power.networkOf(signal('mcu', 'P0'))?.result?.state;
          }
        },
      },
    });
    run(scheduler);
    setState(power, scheduler, analog('psu', 'VCC', 0));
    expect(releasedDuringNotification).toBe('floating');
  });

  it('notifies before opening a recovered domain', () => {
    let gateDuringNotification: ReturnType<PowerRuntime['pinGate']> | undefined;
    let networkDuringNotification: string | undefined;
    const { scheduler, power } = fixture({
      observer: {
        onPowerDomainChange(changes) {
          if (changes.some((change) => change.state === 'on')) {
            gateDuringNotification = power.pinGate(signal('mcu', 'P0'));
            networkDuringNotification = power.networkOf(signal('mcu', 'P0'))?.result?.state;
          }
        },
      },
    });
    run(scheduler);
    expect(gateDuringNotification).toMatchObject({ ready: false, reason: 'opening' });
    expect(networkDuringNotification).toBe('floating');
    expect(network(power, 'mcu', 'P0').result?.state).toBe('driven');
  });

  it('holds on through the hysteresis band and turns off at turnOff before recovering at turnOn', () => {
    const changes: string[] = [];
    const { scheduler, power } = fixture({
      observer: {
        onPowerDomainChange(items) {
          for (const item of items) changes.push(`${item.previousState}->${item.state}`);
        },
      },
    });
    run(scheduler);
    changes.length = 0;

    setState(power, scheduler, analog('psu', 'VCC', 2.5));
    expect(power.domain('mcu', 'core').state).toBe('on');
    expect(network(power, 'mcu', 'P0').result?.state).toBe('driven');

    setState(power, scheduler, analog('psu', 'VCC', 2));
    expect(power.domain('mcu', 'core').state).toBe('off');
    expect(power.domain('mcu', 'core').voltage).toBe(2);
    expect(changes).toEqual(['on->off']);
    expect(network(power, 'mcu', 'P0').result).toEqual({
      state: 'floating',
      digitalFallback: false,
      contributions: [],
    });
    expect(power.sampleDigital(signal('mcu', 'P0'))).toEqual({
      value: 0,
      ready: false,
      source: 'gated',
    });
    expect(power.pinIntent(signal('mcu', 'P0')).digitalIntent).toBe(true);

    setState(power, scheduler, analog('psu', 'VCC', 2.5));
    expect(power.domain('mcu', 'core').state).toBe('off');

    setState(power, scheduler, analog('psu', 'VCC', 3));
    expect(power.domain('mcu', 'core').state).toBe('on');
    expect(network(power, 'mcu', 'P0').result).toMatchObject({ state: 'driven', voltage: 5 });
    expect(changes).toEqual(['on->off', 'off->on']);
  });

  it('releases pulls and analog drives while off and reapplies the latest intent on recovery', () => {
    const { scheduler, power } = fixture();
    run(scheduler);

    expect(network(power, 'mcu', 'OD').result).toMatchObject({ state: 'driven', voltage: 0 });
    setState(power, scheduler, analog('psu', 'VCC', 0));
    expect(power.domain('mcu', 'core').state).toBe('off');
    expect(network(power, 'mcu', 'PUP').result).toEqual({
      state: 'floating',
      digitalFallback: false,
      contributions: [],
    });
    expect(network(power, 'mcu', 'OD').result).toEqual({
      state: 'floating',
      digitalFallback: false,
      contributions: [],
    });
    expect(network(power, 'mcu', 'AOUT').result).toEqual({
      state: 'floating',
      digitalFallback: false,
      contributions: [],
    });
    expect(power.sampleVoltage(signal('mcu', 'AOUT'))).toEqual({
      voltage: 0,
      ready: false,
      source: 'gated',
    });

    setState(power, scheduler, pushPull('mcu', 'P0', false));
    expect(power.pinIntent(signal('mcu', 'P0')).digitalIntent).toBe(false);
    expect(network(power, 'mcu', 'P0').result?.state).toBe('floating');

    setState(power, scheduler, analog('psu', 'VCC', 5));
    expect(power.domain('mcu', 'core').state).toBe('on');
    expect(network(power, 'mcu', 'P0').result).toMatchObject({ state: 'driven', voltage: 0 });
    expect(network(power, 'mcu', 'PUP').result).toMatchObject({ strength: 'weak', voltage: 5 });
    expect(network(power, 'mcu', 'OD').result).toMatchObject({ state: 'driven', voltage: 0 });
    expect(network(power, 'mcu', 'AOUT').result).toMatchObject({ voltage: 2.5 });
  });

  it('reports ground loss and restores by rerunning hysteresis from off', () => {
    const reasons: string[][] = [];
    const { scheduler, power } = fixture({
      observer: {
        onPowerDomainChange(changes) {
          for (const change of changes)
            if (change.state === 'off') reasons.push([...change.reasons]);
        },
      },
    });
    run(scheduler);

    power.submit({
      instanceId: 'mcu',
      connections: [{ connectionId: 'gndLink', state: 'open' }],
    });
    run(scheduler);
    expect(power.domain('mcu', 'core')).toMatchObject({
      state: 'off',
      voltage: null,
      groundReady: false,
    });
    expect(reasons).toEqual([['ground-not-ready']]);
    expect(power.pinGate(signal('mcu', 'P0')).reason).toBe('domain-off');

    power.submit({
      instanceId: 'mcu',
      connections: [{ connectionId: 'gndLink', state: 'closed' }],
    });
    run(scheduler);
    expect(power.domain('mcu', 'core')).toMatchObject({
      state: 'on',
      voltage: 5,
      groundReady: true,
    });
    expect(network(power, 'mcu', 'P0').result?.state).toBe('driven');

    setState(power, scheduler, analog('psu', 'VCC', 2.5));
    expect(power.domain('mcu', 'core').state).toBe('on');
    power.submit({
      instanceId: 'mcu',
      connections: [{ connectionId: 'gndLink', state: 'open' }],
    });
    run(scheduler);
    expect(power.domain('mcu', 'core').state).toBe('off');
    power.submit({
      instanceId: 'mcu',
      connections: [{ connectionId: 'gndLink', state: 'closed' }],
    });
    run(scheduler);
    expect(power.domain('mcu', 'core')).toMatchObject({ state: 'off', voltage: 2.5 });
    expect(reasons.at(-1)).toEqual(['ground-not-ready']);

    setState(power, scheduler, analog('psu', 'VCC', 3));
    expect(power.domain('mcu', 'core').state).toBe('on');
  });

  it('reports an indeterminate supply and recovers when the supply becomes definite', () => {
    const reasons: string[][] = [];
    const { scheduler, power } = fixture({
      observer: {
        onPowerDomainChange(changes) {
          for (const change of changes)
            if (change.state === 'off') reasons.push([...change.reasons]);
        },
      },
    });
    run(scheduler);

    setState(power, scheduler, pinState('psu', 'VCC'));
    expect(power.domain('mcu', 'core')).toMatchObject({
      state: 'off',
      voltage: null,
      groundReady: true,
    });
    expect(reasons).toEqual([['supply-indeterminate']]);

    setState(power, scheduler, analog('psu', 'VCC', 5));
    expect(power.domain('mcu', 'core').state).toBe('on');
  });

  it('uses inclusive turnOn and turnOff boundaries', () => {
    const { scheduler, power } = fixture();
    run(scheduler);
    setState(power, scheduler, analog('psu', 'VCC', 2));
    expect(power.domain('mcu', 'core').state).toBe('off');
    setState(power, scheduler, analog('psu', 'VCC', 3));
    expect(power.domain('mcu', 'core').state).toBe('on');
    setState(power, scheduler, analog('psu', 'VCC', 2));
    expect(power.domain('mcu', 'core').state).toBe('off');
  });
});

describe('power dependencies and notification order', () => {
  function dependencyFixture(observer: PowerDomainObserver): {
    scheduler: Scheduler;
    power: PowerRuntime;
  } {
    const pins: TopologyPinDeclaration[] = [
      { instanceId: 'psu', pinName: 'VA', kind: 'power' },
      { instanceId: 'psu', pinName: 'VB', kind: 'power' },
      { instanceId: 'psu', pinName: 'VC', kind: 'power' },
      { instanceId: 'psu', pinName: 'GND', kind: 'gnd' },
      { instanceId: 'mcu', pinName: 'VDD_A', kind: 'power' },
      { instanceId: 'mcu', pinName: 'VDD_B', kind: 'power' },
      { instanceId: 'mcu', pinName: 'VDD_C', kind: 'power' },
      { instanceId: 'mcu', pinName: 'GND', kind: 'gnd' },
      { instanceId: 'mcu2', pinName: 'VDD_Z', kind: 'power' },
      { instanceId: 'mcu2', pinName: 'GND', kind: 'gnd' },
    ];
    const wires: TopologyExternalWire[] = [
      { wireId: 'va', pins: [signal('psu', 'VA'), signal('mcu', 'VDD_A')] },
      { wireId: 'vb', pins: [signal('psu', 'VB'), signal('mcu', 'VDD_B')] },
      { wireId: 'vc', pins: [signal('psu', 'VC'), signal('mcu', 'VDD_C')] },
      {
        wireId: 'vz',
        pins: [signal('psu', 'VA'), signal('mcu2', 'VDD_Z')],
      },
      {
        wireId: 'gnd',
        pins: [signal('psu', 'GND'), signal('mcu', 'GND'), signal('mcu2', 'GND')],
        globalGnd: true,
      },
    ];
    const definition: PowerDefinition = {
      topology: { pins, wires, connections: [] },
      devices: [
        {
          instanceId: 'mcu',
          powerDomains: {
            a: { supply: 'VDD_A', ground: 'GND', voltage: { turnOn: 3, turnOff: 2 } },
            b: {
              supply: 'VDD_B',
              ground: 'GND',
              voltage: { turnOn: 1.5, turnOff: 1 },
              dependsOn: ['a'],
            },
            c: {
              supply: 'VDD_C',
              ground: 'GND',
              voltage: { turnOn: 1.5, turnOff: 1 },
              dependsOn: ['b'],
            },
            d: { supply: 'VDD_A', ground: 'GND', voltage: { turnOn: 3, turnOff: 2 } },
            e: { supply: 'VDD_A', ground: 'GND', voltage: { turnOn: 3, turnOff: 2 } },
          },
        },
        {
          instanceId: 'mcu2',
          powerDomains: {
            z: { supply: 'VDD_Z', ground: 'GND', voltage: { turnOn: 3, turnOff: 2 } },
          },
        },
      ],
    };
    const states: ElectricalPinInput[] = [
      analog('psu', 'VA', 5),
      analog('psu', 'VB', 5),
      analog('psu', 'VC', 5),
      pinState('psu', 'GND'),
      pinState('mcu', 'VDD_A'),
      pinState('mcu', 'VDD_B'),
      pinState('mcu', 'VDD_C'),
      pinState('mcu', 'GND'),
      pinState('mcu2', 'VDD_Z'),
      pinState('mcu2', 'GND'),
    ];
    const scheduler = createScheduler();
    const power = createPowerRuntime(scheduler, definition, {
      instanceId: 'power',
      pinStates: states,
      observer,
    });
    return { scheduler, power };
  }

  it('notifies down dependents first, then up prerequisites first, with stable peers', () => {
    const log: string[] = [];
    const { scheduler, power } = dependencyFixture({
      onPowerDomainChange(changes) {
        for (const change of changes)
          log.push(`${change.instanceId}:${change.domainId}:${change.state}`);
      },
    });
    run(scheduler);
    expect(log).toEqual(['mcu:a:on', 'mcu:d:on', 'mcu:e:on', 'mcu:b:on', 'mcu:c:on', 'mcu2:z:on']);
    log.length = 0;

    power.updatePinStates([analog('psu', 'VA', 0), analog('psu', 'VB', 0), analog('psu', 'VC', 0)]);
    run(scheduler);
    expect(log).toEqual([
      'mcu:c:off',
      'mcu:b:off',
      'mcu:a:off',
      'mcu:d:off',
      'mcu:e:off',
      'mcu2:z:off',
    ]);
    log.length = 0;

    power.updatePinStates([analog('psu', 'VA', 5), analog('psu', 'VB', 5), analog('psu', 'VC', 5)]);
    run(scheduler);
    expect(log).toEqual(['mcu:a:on', 'mcu:d:on', 'mcu:e:on', 'mcu:b:on', 'mcu:c:on', 'mcu2:z:on']);
  });

  it('reports dependency-off for dependents that lose their prerequisite', () => {
    const reasons = new Map<string, readonly string[]>();
    const { scheduler, power } = dependencyFixture({
      onPowerDomainChange(changes) {
        for (const change of changes) {
          if (change.state === 'off') reasons.set(change.domainId, [...change.reasons]);
        }
      },
    });
    run(scheduler);
    power.updatePinStates([analog('psu', 'VA', 0)]);
    run(scheduler);
    expect(reasons.get('a')).toEqual(['below-turn-off']);
    expect(reasons.get('b')).toEqual(['dependency-off']);
    expect(reasons.get('c')).toEqual(['dependency-off']);
    expect(reasons.get('d')).toEqual(['below-turn-off']);
    expect(reasons.get('z')).toEqual(['below-turn-off']);
    expect(power.domain('mcu', 'b')).toMatchObject({
      state: 'off',
      voltage: 5,
      dependenciesReady: false,
    });
    expect(power.domain('mcu', 'c')).toMatchObject({
      state: 'off',
      voltage: 5,
      dependenciesReady: false,
    });
  });

  it('orders all power-down notifications before power-up notifications in one batch', () => {
    const log: string[] = [];
    const definition: PowerDefinition = {
      topology: {
        pins: [
          { instanceId: 'd', pinName: 'VA', kind: 'power' },
          { instanceId: 'd', pinName: 'VB', kind: 'power' },
          { instanceId: 'd', pinName: 'GND', kind: 'gnd' },
        ],
        wires: [
          { wireId: 'va', pins: [signal('d', 'VA')] },
          { wireId: 'vb', pins: [signal('d', 'VB')] },
          { wireId: 'gnd', pins: [signal('d', 'GND')], globalGnd: true },
        ],
        connections: [],
      },
      devices: [
        {
          instanceId: 'd',
          powerDomains: {
            alpha: { supply: 'VA', ground: 'GND', voltage: { turnOn: 3, turnOff: 2 } },
            beta: { supply: 'VB', ground: 'GND', voltage: { turnOn: 3, turnOff: 2 } },
          },
        },
      ],
    };
    const scheduler = createScheduler();
    const power = createPowerRuntime(scheduler, definition, {
      instanceId: 'power',
      pinStates: [analog('d', 'VA', 5), analog('d', 'VB', 0), pinState('d', 'GND')],
      observer: {
        onPowerDomainChange(changes) {
          for (const change of changes) log.push(`${change.domainId}:${change.state}`);
        },
      },
    });
    run(scheduler);
    expect(power.domain('d', 'alpha').state).toBe('on');
    expect(power.domain('d', 'beta').state).toBe('off');
    log.length = 0;

    power.updatePinStates([analog('d', 'VA', 0), analog('d', 'VB', 5)]);
    run(scheduler);
    expect(log).toEqual(['alpha:off', 'beta:on']);
    expect(power.domain('d', 'alpha').state).toBe('off');
    expect(power.domain('d', 'beta').state).toBe('on');
  });

  it('keeps a dependent off when its own voltage is inside the hysteresis band after recovery', () => {
    const log: string[] = [];
    const { scheduler, power } = dependencyFixture({
      onPowerDomainChange(changes) {
        for (const change of changes) log.push(`${change.domainId}:${change.state}`);
      },
    });
    run(scheduler);
    log.length = 0;

    power.updatePinStates([analog('psu', 'VA', 0), analog('psu', 'VB', 0), analog('psu', 'VC', 0)]);
    run(scheduler);
    expect(power.domains('mcu').map((domain) => `${domain.domainId}:${domain.state}`)).toEqual([
      'a:off',
      'b:off',
      'c:off',
      'd:off',
      'e:off',
    ]);
    log.length = 0;

    power.updatePinStates([
      analog('psu', 'VA', 5),
      analog('psu', 'VB', 1.2),
      analog('psu', 'VC', 1.2),
    ]);
    run(scheduler);
    expect(power.domain('mcu', 'a').state).toBe('on');
    expect(power.domain('mcu', 'b').state).toBe('off');
    expect(power.domain('mcu', 'c').state).toBe('off');
    expect(log).toEqual(['a:on', 'd:on', 'e:on', 'z:on']);

    power.updatePinStates([analog('psu', 'VB', 1.5)]);
    run(scheduler);
    expect(power.domain('mcu', 'b').state).toBe('on');
    expect(power.domain('mcu', 'c').state).toBe('off');
    power.updatePinStates([analog('psu', 'VC', 1.5)]);
    run(scheduler);
    expect(power.domain('mcu', 'c').state).toBe('on');
  });
});

describe('power input interpretation and sampling', () => {
  it('interprets proportional levels at inclusive boundaries and keeps tri-state memory', () => {
    const { scheduler, power } = fixture();
    run(scheduler);
    const din = signal('mcu', 'DIN');

    setState(power, scheduler, analog('psu', 'D', 1.5));
    expect(power.sampleDigital(din)).toEqual({ value: 0, ready: true, source: 'sampled' });

    setState(power, scheduler, analog('psu', 'D', 2.5));
    expect(power.sampleDigital(din)).toEqual({ value: 0, ready: true, source: 'threshold-range' });

    setState(power, scheduler, analog('psu', 'D', 3.5));
    expect(power.sampleDigital(din)).toEqual({ value: 1, ready: true, source: 'sampled' });

    setState(power, scheduler, analog('psu', 'D', 2.5));
    expect(power.sampleDigital(din)).toEqual({ value: 1, ready: true, source: 'threshold-range' });
  });

  it('uses two-state high as the only split when configured', () => {
    const { scheduler, power } = fixture({ inputMode: 'two-state' });
    run(scheduler);
    const din = signal('mcu', 'DIN');

    setState(power, scheduler, analog('psu', 'D', 1.5));
    expect(power.sampleDigital(din)).toEqual({ value: 0, ready: true, source: 'sampled' });
    setState(power, scheduler, analog('psu', 'D', 2.6));
    expect(power.sampleDigital(din)).toEqual({ value: 0, ready: true, source: 'sampled' });
    setState(power, scheduler, analog('psu', 'D', 3.5));
    expect(power.sampleDigital(din)).toEqual({ value: 1, ready: true, source: 'sampled' });
    setState(power, scheduler, analog('psu', 'D', 2.6));
    expect(power.sampleDigital(din)).toEqual({ value: 0, ready: true, source: 'sampled' });
  });

  it('keeps logic memory through gating and floating while returning zero', () => {
    const { scheduler, power } = fixture();
    run(scheduler);
    const din = signal('mcu', 'DIN');

    setState(power, scheduler, analog('psu', 'D', 3.5));
    expect(power.sampleDigital(din)).toEqual({ value: 1, ready: true, source: 'sampled' });

    setState(power, scheduler, analog('psu', 'VCC', 0));
    expect(power.sampleDigital(din)).toEqual({ value: 0, ready: false, source: 'gated' });

    setState(power, scheduler, analog('psu', 'VCC', 5));
    expect(power.sampleDigital(din)).toEqual({ value: 1, ready: true, source: 'sampled' });

    setState(power, scheduler, analog('psu', 'D', 2.5));
    expect(power.sampleDigital(din)).toEqual({ value: 1, ready: true, source: 'threshold-range' });
  });

  it('reinterprets when the domain voltage changes while staying on', () => {
    const { scheduler, power } = fixture();
    run(scheduler);
    const din = signal('mcu', 'DIN');
    setState(power, scheduler, analog('psu', 'D', 2.9));
    expect(power.sampleDigital(din)).toEqual({ value: 0, ready: true, source: 'threshold-range' });
    setState(power, scheduler, analog('psu', 'VCC', 4));
    expect(power.domain('mcu', 'core')).toMatchObject({ state: 'on', voltage: 4 });
    expect(power.sampleDigital(din)).toEqual({ value: 1, ready: true, source: 'sampled' });
    setState(power, scheduler, analog('psu', 'VCC', 5));
    expect(power.sampleDigital(din)).toEqual({ value: 1, ready: true, source: 'threshold-range' });
  });

  it('does not write logic memory from an uncommitted queued pin update', () => {
    const pins: TopologyPinDeclaration[] = [
      { instanceId: 'src', pinName: 'VCC', kind: 'power' },
      { instanceId: 'src', pinName: 'GND', kind: 'gnd' },
      { instanceId: 'src', pinName: 'A', kind: 'signal' },
      { instanceId: 'dut', pinName: 'VDD', kind: 'power' },
      { instanceId: 'dut', pinName: 'GND', kind: 'gnd' },
      { instanceId: 'dut', pinName: 'D', kind: 'signal' },
      { instanceId: 'dut', pinName: 'PULL', kind: 'signal' },
    ];
    const wires: TopologyExternalWire[] = [
      { wireId: 'vcc', pins: [signal('src', 'VCC'), signal('dut', 'VDD')] },
      { wireId: 'gnd', pins: [signal('src', 'GND'), signal('dut', 'GND')], globalGnd: true },
      {
        wireId: 'data',
        pins: [signal('src', 'A'), signal('dut', 'D'), signal('dut', 'PULL')],
      },
    ];
    const definition: PowerDefinition = {
      topology: { pins, wires, connections: [] },
      devices: [
        {
          instanceId: 'dut',
          powerDomains: {
            core: { supply: 'VDD', ground: 'GND', voltage: { turnOn: 3, turnOff: 2 } },
          },
          pins: { D: { powerDomain: 'core' }, PULL: { powerDomain: 'core' } },
        },
      ],
    };
    const scheduler = createScheduler();
    const power = createPowerRuntime(scheduler, definition, {
      instanceId: 'power',
      pinStates: [
        analog('src', 'VCC', 5),
        pinState('src', 'GND'),
        analog('src', 'A', 2),
        pinState('dut', 'VDD'),
        pinState('dut', 'GND'),
        pinState('dut', 'D'),
        pinState('dut', 'PULL', {
          pull: 'up',
          model: {
            kind: 'ideal-voltage',
            minVoltage: 0,
            maxVoltage: 5,
            lowVoltage: 0,
            highVoltage: 1.5,
          },
        }),
      ],
    });
    run(scheduler);
    const d = signal('dut', 'D');
    expect(power.sampleDigital(d)).toEqual({ value: 0, ready: true, source: 'threshold-range' });

    power.updatePinStates([
      pinState('src', 'A'),
      pinState('dut', 'D', {
        model: {
          kind: 'ideal-voltage',
          minVoltage: 0,
          maxVoltage: 5,
          lowVoltage: 0,
          highVoltage: 1.9,
        },
      }),
    ]);
    run(scheduler);

    expect(network(power, 'dut', 'D').result).toMatchObject({
      state: 'driven',
      voltage: 1.5,
      strength: 'weak',
    });
    expect(power.sampleDigital(d)).toEqual({ value: 0, ready: true, source: 'threshold-range' });
  });

  it('returns the deterministic floating analog value and gates it while off', () => {
    const { scheduler, power } = fixture({ floating: true });
    run(scheduler);
    const ain = signal('mcu', 'AIN');
    const first = power.sampleVoltage(ain);
    expect(first.ready).toBe(true);
    expect(first.source).toBe('floating');
    expect(first.voltage).toBeGreaterThanOrEqual(0);
    expect(first.voltage).toBeLessThanOrEqual(5);
    expect(power.sampleVoltage(ain)).toEqual(first);

    setState(power, scheduler, analog('psu', 'VCC', 0));
    expect(power.sampleVoltage(ain)).toEqual({ voltage: 0, ready: false, source: 'gated' });
    setState(power, scheduler, analog('psu', 'VCC', 5));
    expect(power.sampleVoltage(ain).ready).toBe(true);
  });

  it('rejects floating analog sampling when floating is not configured', () => {
    const { scheduler, power } = fixture();
    run(scheduler);
    expect(() => power.sampleVoltage(signal('mcu', 'AIN'))).toThrow(/PowerOptions.floating/);
  });

  it('rejects sampling non-signal pins', () => {
    const { scheduler, power } = fixture();
    run(scheduler);
    expect(() => power.sampleDigital(signal('mcu', 'VDD'))).toThrow(/kind 'signal'/);
    expect(() => power.sampleVoltage(signal('mcu', 'GND'))).toThrow(/kind 'signal'/);
  });
});

describe('power digital pin observers', () => {
  function changesOn(
    changes: readonly PowerDigitalPinChange[],
    instanceId: string,
    pinName: string,
  ): PowerDigitalPinChange | undefined {
    return changes.find((change) => change.instanceId === instanceId && change.pinName === pinName);
  }

  it('notifies only changed pins after a completed resolution phase', () => {
    const { scheduler, power } = fixture();
    run(scheduler);
    const phases: (readonly PowerDigitalPinChange[])[] = [];
    const dispose = power.addDigitalPinObserver({
      onDigitalPinChange(changes) {
        phases.push(changes);
      },
    });

    setState(power, scheduler, analog('psu', 'D', 3.5));
    expect(phases).toHaveLength(1);
    expect(changesOn(phases[0]!, 'mcu', 'DIN')).toEqual({
      instanceId: 'mcu',
      pinName: 'DIN',
      sample: { value: 1, ready: true, source: 'sampled' },
    });
    expect(changesOn(phases[0]!, 'mcu', 'P0')).toBeUndefined();

    setState(power, scheduler, analog('psu', 'D', 3.6));
    expect(phases).toHaveLength(1);

    dispose();
    dispose();
    setState(power, scheduler, analog('psu', 'D', 1.5));
    expect(phases).toHaveLength(1);
  });

  it('reports gating and threshold changes as sample changes', () => {
    const { scheduler, power } = fixture();
    run(scheduler);
    const phases: (readonly PowerDigitalPinChange[])[] = [];
    power.addDigitalPinObserver({
      onDigitalPinChange(changes) {
        phases.push(changes);
      },
    });

    setState(power, scheduler, analog('psu', 'VCC', 0));
    const gated = changesOn(phases.at(-1)!, 'mcu', 'DIN');
    expect(gated?.sample).toEqual({ value: 0, ready: false, source: 'gated' });

    setState(power, scheduler, analog('psu', 'VCC', 5));
    const recovered = changesOn(phases.at(-1)!, 'mcu', 'DIN');
    expect(recovered?.sample).toEqual({ value: 0, ready: true, source: 'sampled' });

    setState(power, scheduler, analog('psu', 'D', 2.5));
    const indeterminate = changesOn(phases.at(-1)!, 'mcu', 'DIN');
    expect(indeterminate?.sample).toEqual({ value: 0, ready: true, source: 'threshold-range' });
  });

  it('reports one batch in topology declaration order, not sorted identity order', () => {
    const pins: TopologyPinDeclaration[] = [
      { instanceId: 'dev', pinName: 'Z', kind: 'signal' },
      { instanceId: 'dev', pinName: 'A', kind: 'signal' },
    ];
    const definition: PowerDefinition = {
      topology: { pins, wires: [], connections: [] },
      devices: [{ instanceId: 'dev', powerDomains: {} }],
    };
    const scheduler = createScheduler();
    const power = createPowerRuntime(scheduler, definition, {
      instanceId: 'power',
      pinStates: [pinState('dev', 'Z'), pinState('dev', 'A')],
    });
    run(scheduler);
    const batches: (readonly PowerDigitalPinChange[])[] = [];
    power.addDigitalPinObserver({
      onDigitalPinChange(changes) {
        batches.push(changes);
      },
    });

    power.updatePinStates([pushPull('dev', 'Z', true), pushPull('dev', 'A', true)]);
    run(scheduler);
    expect(batches).toHaveLength(1);
    expect(batches[0]!.map((change) => change.pinName)).toEqual(['Z', 'A']);
    expect(batches[0]!.map((change) => change.sample.value)).toEqual([1, 1]);
  });

  it('calls observers in registration order and unsubscribes independently', () => {
    const { scheduler, power } = fixture();
    run(scheduler);
    const calls: string[] = [];
    const disposeFirst = power.addDigitalPinObserver({
      onDigitalPinChange() {
        calls.push('first');
      },
    });
    power.addDigitalPinObserver({
      onDigitalPinChange() {
        calls.push('second');
      },
    });

    setState(power, scheduler, analog('psu', 'D', 3.5));
    expect(calls).toEqual(['first', 'second']);
    calls.length = 0;
    disposeFirst();
    disposeFirst();
    setState(power, scheduler, analog('psu', 'D', 1.5));
    expect(calls).toEqual(['second']);
  });

  it('calls observers in registration order and stops after the first failure', () => {
    const { scheduler, power } = fixture();
    run(scheduler);
    const calls: string[] = [];
    power.addDigitalPinObserver({
      onDigitalPinChange() {
        calls.push('first');
        throw new Error('observer failed');
      },
    });
    power.addDigitalPinObserver({
      onDigitalPinChange() {
        calls.push('second');
      },
    });

    power.updatePinStates([analog('psu', 'D', 3.5)]);
    expect(() => scheduler.start()).toThrow(/observer failed/);
    expect(calls).toEqual(['first']);
    expect(scheduler.error?.code).toBe('execution-failed');
    expect(power.sampleDigital(signal('mcu', 'DIN'))).toMatchObject({ value: 1 });
  });

  it('clears observers on destroy and rejects later registration', () => {
    const { scheduler, power } = fixture();
    run(scheduler);
    let calls = 0;
    power.addDigitalPinObserver({
      onDigitalPinChange() {
        calls += 1;
      },
    });
    power.destroy();
    expect(() => power.addDigitalPinObserver({ onDigitalPinChange() {} })).toThrow(/destroyed/);
    expect(calls).toBe(0);
    expect(() => scheduler.start()).not.toThrow();
  });
});

describe('power propagation order and budgets', () => {
  it('coalesces a delayed power-down notification with a queued pin update', () => {
    const seen: {
      state: string;
      snapshotState: string;
      gate: string;
      sample: PowerDigitalSample;
    }[] = [];
    const { scheduler, power } = fixture({
      observer: {
        onPowerDomainChange(changes, snapshot) {
          for (const change of changes) {
            const current = snapshot.find(
              (domain) =>
                domain.instanceId === change.instanceId && domain.domainId === change.domainId,
            ) as PowerDomainSnapshot;
            seen.push({
              state: change.state,
              snapshotState: current.state,
              gate: power.pinGate(signal('mcu', 'P0')).reason,
              sample: power.sampleDigital(signal('mcu', 'P0')),
            });
          }
        },
      },
    });
    run(scheduler);
    seen.length = 0;

    power.submit({
      instanceId: 'mcu',
      connections: [{ connectionId: 'gndLink', state: 'open' }],
    });
    power.updatePinStates([pushPull('mcu', 'P0', false)]);
    run(scheduler);

    expect(seen).toEqual([
      {
        state: 'off',
        snapshotState: 'off',
        gate: 'domain-off',
        sample: { value: 0, ready: false, source: 'gated' },
      },
    ]);
    expect(network(power, 'mcu', 'P0').result?.state).toBe('floating');
    expect(power.domain('mcu', 'core').state).toBe('off');
    expect(power.pinIntent(signal('mcu', 'P0')).digitalIntent).toBe(false);
  });

  it('does not notify an off state overwritten later in the same batch', () => {
    const callbacks: {
      changes: readonly PowerDomainChange[];
      snapshot: readonly PowerDomainSnapshot[];
    }[] = [];
    const { scheduler, power } = fixture({
      observer: {
        onPowerDomainChange(changes, snapshot) {
          callbacks.push({ changes: [...changes], snapshot: [...snapshot] });
        },
      },
    });
    run(scheduler);
    callbacks.length = 0;

    power.submit({
      instanceId: 'mcu',
      connections: [{ connectionId: 'gndLink', state: 'open' }],
    });
    power.submit({
      instanceId: 'mcu',
      connections: [{ connectionId: 'gndLink', state: 'closed' }],
    });
    run(scheduler);

    expect(power.domain('mcu', 'core')).toMatchObject({
      state: 'on',
      voltage: 5,
      groundReady: true,
    });
    expect(network(power, 'mcu', 'P0').result).toMatchObject({ state: 'driven', voltage: 5 });
    expect(callbacks).toEqual([]);
  });

  it('reapplies the latest held intent when a batch ends on', () => {
    const { scheduler, power } = fixture();
    run(scheduler);

    power.submit({
      instanceId: 'mcu',
      connections: [{ connectionId: 'gndLink', state: 'open' }],
    });
    power.updatePinStates([pushPull('mcu', 'P0', false)]);
    power.submit({
      instanceId: 'mcu',
      connections: [{ connectionId: 'gndLink', state: 'closed' }],
    });
    run(scheduler);

    expect(power.domain('mcu', 'core').state).toBe('on');
    expect(power.pinIntent(signal('mcu', 'P0')).digitalIntent).toBe(false);
    expect(network(power, 'mcu', 'P0').result).toMatchObject({ state: 'driven', voltage: 0 });
  });

  it('keeps every notified change consistent with its snapshot', () => {
    const callbacks: {
      changes: readonly PowerDomainChange[];
      snapshot: readonly PowerDomainSnapshot[];
    }[] = [];
    const { scheduler, power } = fixture({
      observer: {
        onPowerDomainChange(changes, snapshot) {
          callbacks.push({ changes: [...changes], snapshot: [...snapshot] });
        },
      },
    });
    run(scheduler);
    callbacks.length = 0;

    power.submit({
      instanceId: 'mcu',
      connections: [{ connectionId: 'gndLink', state: 'open' }],
    });
    power.updatePinStates([analog('psu', 'VCC', 2.5)]);
    run(scheduler);

    for (const callback of callbacks) {
      for (const change of callback.changes) {
        const current = callback.snapshot.find(
          (domain) =>
            domain.instanceId === change.instanceId && domain.domainId === change.domainId,
        ) as PowerDomainSnapshot;
        expect(change.state).toBe(current.state);
        expect(change.voltage).toBe(current.voltage);
        expect(change.groundReady).toBe(current.groundReady);
        expect(change.dependenciesReady).toBe(current.dependenciesReady);
      }
    }
    const downStates = callbacks
      .flatMap((callback) => [...callback.changes])
      .filter((change) => change.state === 'off');
    expect(downStates).toHaveLength(1);
    expect(new Set(downStates.map((change) => change.previousState))).toEqual(new Set(['on']));
  });

  it('runs network update, power notification and ordinary work in a deterministic order', () => {
    const log: string[] = [];
    const { scheduler, power } = fixture({
      observer: {
        onPowerDomainChange(changes) {
          log.push(`notify:${changes.map((change) => change.state).join(',')}`);
        },
      },
    });
    run(scheduler);
    log.length = 0;
    const target: SchedulerTarget = { name: 'host.event', kind: 'event', params: ['u32'] };
    const host = scheduler.addInstance({
      instanceId: 'host',
      targets: [target],
      executor: {
        execute(_target, args) {
          const step = args[0] as number;
          log.push(`event:${step}`);
          if (step === 1) power.updatePinStates([analog('psu', 'VCC', 0)]);
          if (step === 2) log.push(`sample:${power.sampleDigital(signal('mcu', 'P0')).value}`);
        },
      },
    });
    host.at(target, 0, [1]);
    host.at(target, 0, [2]);
    run(scheduler);
    expect(log).toEqual(['event:1', 'notify:off', 'event:2', 'sample:0']);
    expect(scheduler.now).toBe(0);
  });

  it('applies observer-submitted intents without synchronously re-entering ordinary work', () => {
    const log: string[] = [];
    let inObserver = false;
    const { scheduler, power } = fixture({
      observer: {
        onPowerDomainChange(changes) {
          inObserver = true;
          log.push(`notify:${changes[0]?.state}`);
          expect(log.includes('event:2')).toBe(false);
          power.updatePinStates([pushPull('mcu', 'P0', false)]);
          inObserver = false;
        },
      },
    });
    run(scheduler);
    expect(network(power, 'mcu', 'P0').result).toMatchObject({ state: 'driven', voltage: 0 });
    log.length = 0;
    const target: SchedulerTarget = { name: 'host.event', kind: 'event', params: ['u32'] };
    const host = scheduler.addInstance({
      instanceId: 'host',
      targets: [target],
      executor: {
        execute(_target, args) {
          const step = args[0] as number;
          log.push(`event:${step}`);
          if (step === 1) power.updatePinStates([analog('psu', 'VCC', 0)]);
          if (step === 2) {
            log.push(`driven:${network(power, 'mcu', 'P0').result?.state}`);
            expect(inObserver).toBe(false);
          }
        },
      },
    });
    host.at(target, 0, [1]);
    host.at(target, 0, [2]);
    run(scheduler);
    expect(log[0]).toBe('event:1');
    expect(log[1]).toBe('notify:off');
    expect(log).toContain('event:2');
  });

  it('resets the propagation budget when virtual time advances', () => {
    const { scheduler, power } = fixture({ maxPropagationRounds: 6 });
    run(scheduler);
    setState(power, scheduler, analog('psu', 'VCC', 0));
    expect(power.domain('mcu', 'core').state).toBe('off');
    expect(scheduler.now).toBe(0);

    scheduler.start({ until: 10 });
    expect(scheduler.now).toBe(10);
    setState(power, scheduler, analog('psu', 'VCC', 5));
    expect(power.domain('mcu', 'core').state).toBe('on');
  });

  it('honors a zero propagation budget with an explicit diagnostic', () => {
    const { scheduler } = fixture({ maxPropagationRounds: 0 });
    expect(() => run(scheduler)).toThrow(SchedulerError);
    expect(scheduler.state).toBe('faulted');
    expect(scheduler.error?.cause).toBeInstanceOf(PowerFeedbackError);
    expect((scheduler.error?.cause as PowerFeedbackError).rounds).toBe(1);
  });

  it('faults with a PowerFeedbackError when propagation does not converge', () => {
    let high = true;
    const { scheduler, power } = fixture({
      maxPropagationRounds: 6,
      observer: {
        onPowerDomainChange() {
          high = !high;
          power.updatePinStates([analog('psu', 'VCC', high ? 5 : 0)]);
        },
      },
    });
    let failure: unknown;
    try {
      run(scheduler);
    } catch (cause) {
      failure = cause;
    }
    expect(failure).toBeInstanceOf(SchedulerError);
    const schedulerError = failure as SchedulerError;
    expect(schedulerError.code).toBe('execution-failed');
    expect(schedulerError.cause).toBeInstanceOf(PowerFeedbackError);
    const feedback = schedulerError.cause as PowerFeedbackError;
    expect(feedback.timePs).toBe(0);
    expect(feedback.rounds).toBeGreaterThan(feedback.maxRounds);
    expect(feedback.maxRounds).toBe(6);
    expect(feedback.domains.some((domain) => domain.domainId === 'core')).toBe(true);
    expect(scheduler.state).toBe('faulted');
  });
});

describe('power runtime queries and lifecycle', () => {
  it('sorts domains, exposes empty instance views, and validates queried identities', () => {
    const { scheduler, power } = fixture();
    run(scheduler);
    expect(power.domains().map((domain) => `${domain.instanceId}:${domain.domainId}`)).toEqual([
      'mcu:core',
    ]);
    expect(power.domains('psu')).toEqual([]);
    expect(() => power.domain('mcu', 'missing')).toThrow(RangeError);
    expect(() => power.domains('missing')).toThrow(RangeError);
    expect(() => power.pinGate(signal('missing', 'P0'))).toThrow(RangeError);
  });

  it('keeps host powerReady for unbound pins and samples them with model thresholds', () => {
    const { scheduler, power } = fixture();
    run(scheduler);
    expect(power.pinGate(signal('psu', 'D'))).toEqual({
      instanceId: 'psu',
      pinName: 'D',
      domainId: null,
      ready: true,
      reason: 'no-domain',
    });
    expect(power.sampleDigital(signal('psu', 'D'))).toEqual({
      value: 0,
      ready: true,
      source: 'threshold-range',
    });
    setState(power, scheduler, pinState('psu', 'D', { powerReady: false }));
    expect(network(power, 'mcu', 'DIN').result?.state).toBe('floating');
    expect(power.sampleDigital(signal('psu', 'D'))).toEqual({
      value: 0,
      ready: true,
      source: 'floating',
    });
    expect(power.sampleDigital(signal('mcu', 'DIN'))).toEqual({
      value: 0,
      ready: true,
      source: 'floating',
    });
  });

  it('ignores the host powerReady field on domain-bound pins', () => {
    const { scheduler, power } = fixture();
    run(scheduler);
    setState(
      power,
      scheduler,
      pinState('mcu', 'P0', {
        mode: 'push-pull',
        outputEnabled: true,
        digitalIntent: true,
        powerReady: false,
      }),
    );
    expect(power.pinIntent(signal('mcu', 'P0')).powerReady).toBe(false);
    expect(network(power, 'mcu', 'P0').result).toMatchObject({ state: 'driven', voltage: 5 });
  });

  it('forwards connection, network, floating and refresh queries', () => {
    const withFloating = fixture({ floating: true });
    run(withFloating.scheduler);
    expect(withFloating.power.connectionState('mcu', 'gndLink')).toBe('closed');
    expect(withFloating.power.networks().length).toBeGreaterThan(0);
    expect(withFloating.power.floatingInput(signal('mcu', 'AIN'))).toBeDefined();
    withFloating.power.refresh();
    const refreshed = withFloating.scheduler.start();
    expect(refreshed.executed).toBeGreaterThan(0);
    expect(withFloating.power.domain('mcu', 'core').state).toBe('on');

    withFloating.power.submit({
      instanceId: 'mcu',
      connections: [{ connectionId: 'gndLink', state: 'open' }],
    });
    run(withFloating.scheduler);
    expect(withFloating.power.connectionState('mcu', 'gndLink')).toBe('open');
    expect(withFloating.power.domain('mcu', 'core').state).toBe('off');

    const withoutFloating = fixture();
    run(withoutFloating.scheduler);
    expect(withoutFloating.power.floatingInput(signal('mcu', 'AIN'))).toBeUndefined();
  });

  it('rejects an invalid pin-state batch without changing held intents', () => {
    const { scheduler, power } = fixture();
    run(scheduler);
    const before = power.pinIntent(signal('mcu', 'P0'));
    expect(() =>
      power.updatePinStates([pushPull('mcu', 'P0', false), pushPull('mcu', 'P0', true)]),
    ).toThrow(TypeError);
    expect(power.pinIntent(signal('mcu', 'P0'))).toEqual(before);
    expect(() =>
      power.updatePinStates([pushPull('mcu', 'P0', false), pinState('missing', 'X')]),
    ).toThrow(RangeError);
    expect(power.pinIntent(signal('mcu', 'P0'))).toEqual(before);
  });

  it('replaces and clears the single observer', () => {
    const first: string[] = [];
    const second: string[] = [];
    const { scheduler, power } = fixture({
      observer: {
        onPowerDomainChange(changes) {
          for (const change of changes) first.push(change.state);
        },
      },
    });
    run(scheduler);
    power.observe({
      onPowerDomainChange(changes) {
        for (const change of changes) second.push(change.state);
      },
    });
    setState(power, scheduler, analog('psu', 'VCC', 0));
    expect(first).toEqual(['on']);
    expect(second).toEqual(['off']);

    power.observe(undefined);
    setState(power, scheduler, analog('psu', 'VCC', 5));
    expect(first).toEqual(['on']);
    expect(second).toEqual(['off']);
  });

  it('destroys without leaving queued work', () => {
    const { scheduler, power } = fixture();
    run(scheduler);
    power.updatePinStates([analog('psu', 'VCC', 0)]);
    power.destroy();
    expect(scheduler.state).toBe('paused');
    expect(scheduler.start()).toMatchObject({ executed: 0, reason: 'empty' });
  });

  it('does not create a topology instance when the power instance id is taken', () => {
    const real = createScheduler();
    const dummyTarget: SchedulerTarget = { name: 'dummy', kind: 'control', params: [] };
    real.addInstance({
      instanceId: 'power',
      targets: [dummyTarget],
      executor: { execute() {} },
    });
    const { scheduler, created, destroyed } = wrappedScheduler(real);
    const inputs = minimalInputs();

    expect(() =>
      createPowerRuntime(scheduler, inputs.definition, {
        ...inputs.options,
        instanceId: 'power',
        topologyInstanceId: 'orphan-topology',
      }),
    ).toThrow(SchedulerError);
    expect(created).toEqual([]);
    expect(destroyed).toEqual([]);
    expect(real.start()).toMatchObject({ executed: 0, reason: 'empty' });
  });

  it('destroys both instances when the initial control enqueue fails', () => {
    const real = createScheduler();
    const { scheduler, created, destroyed } = wrappedScheduler(real, 1);
    const inputs = minimalInputs();

    expect(() =>
      createPowerRuntime(scheduler, inputs.definition, {
        ...inputs.options,
        topologyInstanceId: 'orphan-topology',
      }),
    ).toThrow(/enqueue failed/);
    expect(created).toEqual(['power', 'orphan-topology']);
    expect([...destroyed].sort()).toEqual(['orphan-topology', 'power'].sort());
    expect(real.start()).toMatchObject({ executed: 0, reason: 'empty' });
  });

  it('releases the construction observer after observe(undefined)', async () => {
    const weak = weakObserver();
    const inputs = minimalInputs();
    const power = createPowerRuntime(createScheduler(), inputs.definition, {
      ...inputs.options,
      observer: weak.deref()!,
    });

    power.observe(undefined);
    await collectGarbage();
    expect(weak.deref()).toBeUndefined();
    power.destroy();
  });

  it('clears the observer on destroy and rejects observe afterwards', async () => {
    const weak = weakObserver();
    const inputs = minimalInputs();
    const power = createPowerRuntime(createScheduler(), inputs.definition, {
      ...inputs.options,
      observer: weak.deref()!,
    });
    power.destroy();
    expect(() => power.observe(weak.deref()!)).toThrow(/destroyed/);

    await collectGarbage();
    expect(weak.deref()).toBeUndefined();
  });
});
