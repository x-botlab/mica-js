import { describe, expect, it } from 'vitest';
import type { ElectricalPinInput } from '../electrical/electrical-types';
import { createScheduler } from '../scheduler/scheduler';
import { SchedulerError } from '../scheduler/scheduler-error';
import type { Scheduler, SchedulerTarget } from '../scheduler/scheduler-types';
import type {
  TopologyDefinition,
  TopologyExternalWire,
  TopologyPinDeclaration,
  TopologyPinRef,
} from '../topology/topology-types';
import { createPowerRuntime, PowerFeedbackError } from './power';
import type {
  PowerDefinition,
  PowerDomainObserver,
  PowerInputMode,
  PowerRuntime,
} from './power-types';

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

describe('power propagation order and budgets', () => {
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
});
