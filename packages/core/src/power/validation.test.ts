import { describe, expect, it } from 'vitest';
import type { ElectricalPinInput } from '../electrical/types';
import { createScheduler } from '../scheduler/runtime';
import type { TopologyDefinition } from '../topology/types';
import { createPowerRuntime } from './runtime';
import type { PowerDefinition, PowerDomainObserver, PowerInputMode, PowerOptions } from './types';

const MODEL = Object.freeze({
  kind: 'ideal-voltage' as const,
  minVoltage: 0,
  maxVoltage: 5,
  lowVoltage: 0,
  highVoltage: 5,
});

interface MutableDomain {
  supply: string;
  ground: string;
  voltage: { turnOn: number; turnOff: number };
  dependsOn?: string[];
}

interface MutableDevice {
  instanceId: string;
  powerDomains: Record<string, MutableDomain>;
  pins?: Record<string, { powerDomain?: string; levels?: { low: number; high: number } }>;
}

interface MutableDefinition {
  topology: TopologyDefinition;
  devices: MutableDevice[];
}

interface MutableOptions {
  instanceId: string;
  topologyInstanceId?: string;
  pinStates: ElectricalPinInput[];
  floating?: { seed: number };
  inputMode?: PowerInputMode;
  maxPropagationRounds?: number;
  observer?: PowerDomainObserver;
}

function state(
  instanceId: string,
  pinName: string,
  overrides: Partial<Omit<ElectricalPinInput, 'instanceId' | 'pinName'>> = {},
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

function baseDefinition(): MutableDefinition {
  return {
    topology: {
      pins: [
        { instanceId: 'd', pinName: 'VCC', kind: 'power' },
        { instanceId: 'd', pinName: 'GND', kind: 'gnd' },
        { instanceId: 'd', pinName: 'P0', kind: 'signal' },
      ],
      wires: [
        { wireId: 'vcc', pins: [{ instanceId: 'd', pinName: 'VCC' }] },
        { wireId: 'gnd', pins: [{ instanceId: 'd', pinName: 'GND' }], globalGnd: true },
      ],
      connections: [],
    },
    devices: [
      {
        instanceId: 'd',
        powerDomains: {
          core: {
            supply: 'VCC',
            ground: 'GND',
            voltage: { turnOn: 3, turnOff: 2 },
          },
        },
        pins: {
          P0: { powerDomain: 'core', levels: { low: 0.3, high: 0.7 } },
        },
      },
    ],
  };
}

function baseOptions(): MutableOptions {
  return {
    instanceId: 'power',
    pinStates: [state('d', 'VCC'), state('d', 'GND'), state('d', 'P0')],
  };
}

function definition(): MutableDefinition {
  return structuredClone(baseDefinition());
}

function options(): MutableOptions {
  return structuredClone(baseOptions());
}

function expectInvalid(
  definitionValue: unknown,
  optionsValue: unknown,
  error: typeof TypeError | typeof RangeError,
): void {
  const scheduler = createScheduler();
  expect(() =>
    createPowerRuntime(scheduler, definitionValue as PowerDefinition, optionsValue as PowerOptions),
  ).toThrow(error);
}

describe('power static validation', () => {
  it('accepts the base declaration and derived defaults', () => {
    const scheduler = createScheduler();
    const runtime = createPowerRuntime(scheduler, baseDefinition(), baseOptions());
    expect(runtime.inputMode).toBe('three-state');
    expect(runtime.domain('d', 'core')).toMatchObject({ state: 'off', voltage: null });
    runtime.destroy();
  });

  it('rejects malformed definition containers', () => {
    expectInvalid(null, options(), TypeError);
    const withUnknown = definition() as MutableDefinition & { extra?: boolean };
    withUnknown.extra = true;
    expectInvalid(withUnknown, options(), TypeError);
    const badDevices = definition() as unknown as Record<string, unknown>;
    badDevices.devices = 'x';
    expectInvalid(badDevices, options(), TypeError);
  });

  it('rejects unknown and duplicate devices', () => {
    const unknown = definition();
    unknown.devices[0]!.instanceId = 'missing';
    expectInvalid(unknown, options(), RangeError);

    const duplicate = definition();
    duplicate.devices.push(structuredClone(duplicate.devices[0]!));
    expectInvalid(duplicate, options(), TypeError);
  });

  it('rejects malformed domain containers and references', () => {
    const missingDomains = definition();
    delete (missingDomains.devices[0] as Partial<MutableDevice>).powerDomains;
    expectInvalid(missingDomains, options(), TypeError);

    const arrayDomains = definition() as unknown as Record<string, unknown>;
    (arrayDomains.devices as MutableDevice[])[0]!.powerDomains = [] as never;
    expectInvalid(arrayDomains, options(), TypeError);

    const emptyId = definition();
    emptyId.devices[0]!.powerDomains[''] = emptyId.devices[0]!.powerDomains.core!;
    expectInvalid(emptyId, options(), RangeError);

    const unknownSupply = definition();
    unknownSupply.devices[0]!.powerDomains.core!.supply = 'NOPE';
    expectInvalid(unknownSupply, options(), RangeError);

    const wrongSupplyKind = definition();
    wrongSupplyKind.devices[0]!.powerDomains.core!.supply = 'GND';
    expectInvalid(wrongSupplyKind, options(), RangeError);

    const wrongGroundKind = definition();
    wrongGroundKind.devices[0]!.powerDomains.core!.ground = 'VCC';
    expectInvalid(wrongGroundKind, options(), RangeError);

    const unknownField = definition() as unknown as Record<string, unknown>;
    (unknownField.devices as MutableDevice[])[0]!.powerDomains.core = {
      ...(unknownField.devices as MutableDevice[])[0]!.powerDomains.core!,
      extra: true,
    } as never;
    expectInvalid(unknownField, options(), TypeError);
  });

  it('enforces threshold and dependency rules', () => {
    const inverted = definition();
    inverted.devices[0]!.powerDomains.core!.voltage = { turnOn: 2, turnOff: 2 };
    expectInvalid(inverted, options(), RangeError);

    const negative = definition();
    negative.devices[0]!.powerDomains.core!.voltage = { turnOn: 3, turnOff: -1 };
    expectInvalid(negative, options(), RangeError);

    const nan = definition();
    nan.devices[0]!.powerDomains.core!.voltage = { turnOn: Number.NaN, turnOff: 2 };
    expectInvalid(nan, options(), TypeError);

    const infinite = definition();
    infinite.devices[0]!.powerDomains.core!.voltage = { turnOn: 3, turnOff: Infinity };
    expectInvalid(infinite, options(), TypeError);

    const missingDependency = definition();
    missingDependency.devices[0]!.powerDomains.core!.dependsOn = ['missing'];
    expectInvalid(missingDependency, options(), RangeError);

    const selfDependency = definition();
    selfDependency.devices[0]!.powerDomains.core!.dependsOn = ['core'];
    expectInvalid(selfDependency, options(), RangeError);

    const duplicateDependency = definition();
    duplicateDependency.devices[0]!.powerDomains.other = {
      supply: 'VCC',
      ground: 'GND',
      voltage: { turnOn: 3, turnOff: 2 },
    };
    duplicateDependency.devices[0]!.powerDomains.core!.dependsOn = ['other', 'other'];
    expectInvalid(duplicateDependency, options(), TypeError);

    const notArray = definition();
    (notArray.devices[0]!.powerDomains.core as unknown as Record<string, unknown>).dependsOn =
      'core';
    expectInvalid(notArray, options(), TypeError);

    const cycle = definition();
    cycle.devices[0]!.powerDomains.a = {
      supply: 'VCC',
      ground: 'GND',
      voltage: { turnOn: 3, turnOff: 2 },
      dependsOn: ['b'],
    };
    cycle.devices[0]!.powerDomains.b = {
      supply: 'VCC',
      ground: 'GND',
      voltage: { turnOn: 3, turnOff: 2 },
      dependsOn: ['a'],
    };
    expectInvalid(cycle, options(), RangeError);
  });

  it('validates pin bindings and levels', () => {
    const unknownPin = definition();
    unknownPin.devices[0]!.pins!.NOPE = { powerDomain: 'core' };
    expectInvalid(unknownPin, options(), RangeError);

    const powerPin = definition();
    powerPin.devices[0]!.pins!.VCC = { powerDomain: 'core' };
    expectInvalid(powerPin, options(), RangeError);

    const unknownDomain = definition();
    unknownDomain.devices[0]!.pins!.P0 = { powerDomain: 'missing' };
    expectInvalid(unknownDomain, options(), RangeError);

    const levelsWithoutDomain = definition();
    levelsWithoutDomain.devices[0]!.pins!.P0 = { levels: { low: 0.3, high: 0.7 } };
    expectInvalid(levelsWithoutDomain, options(), RangeError);

    const badLow = definition();
    badLow.devices[0]!.pins!.P0!.levels = { low: -0.1, high: 0.7 };
    expectInvalid(badLow, options(), RangeError);

    const badHigh = definition();
    badHigh.devices[0]!.pins!.P0!.levels = { low: 0.3, high: 1.1 };
    expectInvalid(badHigh, options(), RangeError);

    const inverted = definition();
    inverted.devices[0]!.pins!.P0!.levels = { low: 0.7, high: 0.3 };
    expectInvalid(inverted, options(), RangeError);

    const nan = definition();
    nan.devices[0]!.pins!.P0!.levels = { low: Number.NaN, high: 0.7 };
    expectInvalid(nan, options(), TypeError);

    const unknownBindingField = definition() as unknown as Record<string, unknown>;
    (unknownBindingField.devices as MutableDevice[])[0]!.pins!.P0 = {
      powerDomain: 'core',
      extra: true,
    } as never;
    expectInvalid(unknownBindingField, options(), TypeError);
  });

  it('validates the pin-state snapshot and option fields', () => {
    const missingPinStates = options() as unknown as Record<string, unknown>;
    delete missingPinStates.pinStates;
    expectInvalid(definition(), missingPinStates, TypeError);

    const notArray = options() as unknown as Record<string, unknown>;
    notArray.pinStates = 'x';
    expectInvalid(definition(), notArray, TypeError);

    const missing = options();
    missing.pinStates = [state('d', 'VCC'), state('d', 'GND')];
    expectInvalid(definition(), missing, RangeError);

    const extra = options();
    extra.pinStates.push(state('d', 'EXTRA'));
    expectInvalid(definition(), extra, RangeError);

    const duplicate = options();
    duplicate.pinStates.push(state('d', 'VCC'));
    expectInvalid(definition(), duplicate, TypeError);

    const unknownOption = options() as unknown as Record<string, unknown>;
    unknownOption.extra = true;
    expectInvalid(definition(), unknownOption, TypeError);

    const sameInstance = options();
    sameInstance.topologyInstanceId = 'power';
    expectInvalid(definition(), sameInstance, RangeError);

    const badMode = options();
    badMode.inputMode = 'four-state' as PowerInputMode;
    expectInvalid(definition(), badMode, TypeError);

    const negativeRounds = options();
    negativeRounds.maxPropagationRounds = -1;
    expectInvalid(definition(), negativeRounds, RangeError);

    const fractionalRounds = options();
    fractionalRounds.maxPropagationRounds = 1.5;
    expectInvalid(definition(), fractionalRounds, RangeError);

    const badSeed = options();
    badSeed.floating = { seed: -1 };
    expectInvalid(definition(), badSeed, RangeError);

    const badObserver = options();
    badObserver.observer = {} as PowerDomainObserver;
    expectInvalid(definition(), badObserver, TypeError);
  });

  it('accepts a prototype observer and rejects invalid electrical pin states', () => {
    const observer = new (class {
      onPowerDomainChange(): void {
        // no-op
      }
    })();
    const withObserver = options();
    withObserver.observer = observer;
    const scheduler = createScheduler();
    const runtime = createPowerRuntime(scheduler, definition(), withObserver);
    runtime.destroy();

    const badState = options();
    badState.pinStates[0] = {
      ...state('d', 'VCC'),
      mode: 'invalid' as ElectricalPinInput['mode'],
    };
    expectInvalid(definition(), badState, TypeError);
  });
});
