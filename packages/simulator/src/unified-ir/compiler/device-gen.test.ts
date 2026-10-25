import { describe, expect, it } from 'vitest';
import { createIRInterpreter, validateIR } from '@mica-js/ir';
import type {
  IRExecutionContext,
  IRInterpreter,
  ScalarType,
  StorageValue,
  Value,
} from '@mica-js/ir';
import { PIN_MODE } from '../pin-space';
import {
  UnifiedIRCompilerError,
  compileCircuit,
  type CompiledCircuit,
  type DeviceBehaviorApi,
  type DeviceConfig,
  type DevicePinDescription,
  type UnifiedIRCompilerErrorCode,
} from './index';

const CONTEXT: IRExecutionContext = Object.freeze({
  instanceId: 'device-gen-pin-group-test',
  virtualTime: 0,
});

function runtimeOf(compiled: CompiledCircuit): IRInterpreter {
  return createIRInterpreter(compiled.module, {
    validation: compiled.validation,
    maxSteps: Number.MAX_SAFE_INTEGER,
  });
}

function initialize(compiled: CompiledCircuit, runtime: IRInterpreter): void {
  runtime.execute(compiled.entryPoints.refs.initialize, [], CONTEXT);
}

function tick(compiled: CompiledCircuit, runtime: IRInterpreter): void {
  runtime.execute(compiled.entryPoints.refs.tick, [], CONTEXT);
}

function pinOutputOf(compiled: CompiledCircuit, runtime: IRInterpreter, endpoint: string): boolean {
  const pin = compiled.pinMap.get(endpoint);
  if (pin === undefined) throw new Error(`Unknown pin ${endpoint}`);
  return runtime.storage.loadArray(compiled.memory.output, pin) === true;
}

function pinModeOf(compiled: CompiledCircuit, runtime: IRInterpreter, endpoint: string): number {
  const pin = compiled.pinMap.get(endpoint);
  if (pin === undefined) throw new Error(`Unknown pin ${endpoint}`);
  return Number(runtime.storage.loadArray(compiled.memory.mode, pin));
}

function stateOf(
  compiled: CompiledCircuit,
  runtime: IRInterpreter,
  deviceId: string,
  name: string,
): StorageValue<ScalarType> {
  const slot = compiled.deviceMap.get(deviceId)?.states.get(name);
  if (slot === undefined) throw new Error(`Device "${deviceId}" has no state "${name}"`);
  return runtime.storage.loadArray(slot.array, slot.index);
}

function pinsOf(
  names: readonly string[],
  direction: 'input' | 'output',
): Readonly<Record<string, DevicePinDescription>> {
  return Object.fromEntries(names.map((name) => [name, { direction }]));
}

/** Packs the driven levels of `names` back into one u32, LSB first. */
function packOutputs(
  compiled: CompiledCircuit,
  runtime: IRInterpreter,
  deviceId: string,
  names: readonly string[],
): number {
  let packed = 0;
  for (const [bit, name] of names.entries()) {
    if (pinOutputOf(compiled, runtime, `${deviceId}.${name}`)) packed += 2 ** bit;
  }
  return packed;
}

function expectCompilerError(
  run: () => unknown,
  code: UnifiedIRCompilerErrorCode,
): UnifiedIRCompilerError {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(UnifiedIRCompilerError);
  const failure = caught as UnifiedIRCompilerError;
  expect(failure.code).toBe(code);
  return failure;
}

const DATA_PINS = ['D0', 'D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7'] as const;

describe('pin groups (RFC 0004)', () => {
  it('writes a byte to the group, least significant pin first', () => {
    const lcd: DeviceConfig = {
      id: 'lcd1',
      type: 'test-parallel-lcd',
      description: {
        pins: pinsOf(DATA_PINS, 'output'),
        behaviors: {
          initialize: (api) => {
            const port = api.pinGroup(DATA_PINS);
            for (const name of DATA_PINS) port.pin(name).configure(PIN_MODE.pushPull);
            // 0xA5 = 0b1010_0101, so D0 = 1, D1 = 0, ...
            port.writeDigital(0xa5);
          },
        },
      },
    };
    const compiled = compileCircuit({ devices: [lcd], connections: [] });
    const runtime = runtimeOf(compiled);
    initialize(compiled, runtime);

    // Bit i of 0xA5, from the least significant bit upwards.
    const expected = [1, 0, 1, 0, 0, 1, 0, 1];
    for (const [bit, name] of DATA_PINS.entries()) {
      expect(pinOutputOf(compiled, runtime, `lcd1.${name}`)).toBe(expected[bit] === 1);
      expect(pinModeOf(compiled, runtime, `lcd1.${name}`)).toBe(PIN_MODE.pushPull);
    }
    expect(packOutputs(compiled, runtime, 'lcd1', DATA_PINS)).toBe(0xa5);
    expect(validateIR(compiled.module, compiled.validation).ok).toBe(true);
  });

  it('writes every bit of a 32-pin group, including bit 31', () => {
    const names = Array.from({ length: 32 }, (_, bit) => `D${bit}`);
    const bus: DeviceConfig = {
      id: 'bus1',
      type: 'test-32-bit-bus',
      description: {
        pins: pinsOf(names, 'output'),
        behaviors: {
          initialize: (api) => {
            const port = api.pinGroup(names);
            for (const name of names) port.pin(name).configure(PIN_MODE.pushPull);
            port.writeDigital(0x8000_0001);
          },
        },
      },
    };
    const compiled = compileCircuit({ devices: [bus], connections: [] });
    const runtime = runtimeOf(compiled);
    initialize(compiled, runtime);

    expect(pinOutputOf(compiled, runtime, 'bus1.D0')).toBe(true);
    expect(pinOutputOf(compiled, runtime, 'bus1.D1')).toBe(false);
    expect(pinOutputOf(compiled, runtime, 'bus1.D30')).toBe(false);
    expect(pinOutputOf(compiled, runtime, 'bus1.D31')).toBe(true);
    expect(packOutputs(compiled, runtime, 'bus1', names)).toBe(0x8000_0001);
  });

  it('accepts a u32 IR value as the write source', () => {
    const latch: DeviceConfig = {
      id: 'latch1',
      type: 'test-parallel-latch',
      description: {
        pins: pinsOf(DATA_PINS, 'output'),
        states: { value: { type: 'u32', initial: 0x5a } },
        behaviors: {
          initialize: (api) => {
            for (const name of DATA_PINS) api.pin(name).configure(PIN_MODE.pushPull);
          },
          update: (api) => {
            api.pinGroup(DATA_PINS).writeDigital(api.state<'u32'>('value').load());
          },
        },
      },
    };
    const compiled = compileCircuit({ devices: [latch], connections: [] });
    const runtime = runtimeOf(compiled);
    initialize(compiled, runtime);
    tick(compiled, runtime);

    expect(packOutputs(compiled, runtime, 'latch1', DATA_PINS)).toBe(0x5a);
  });

  it('reads the solved levels into one u32, least significant pin first', () => {
    const bits = ['B0', 'B1', 'B2', 'B3'] as const;
    const inputs = ['P0', 'P1', 'P2', 'P3'] as const;
    const driver: DeviceConfig = {
      id: 'w1',
      type: 'test-bus-driver',
      description: {
        pins: pinsOf(bits, 'output'),
        behaviors: {
          initialize: (api) => {
            const port = api.pinGroup(bits);
            for (const name of bits) port.pin(name).configure(PIN_MODE.pushPull);
            // 0b1010: B0 = 0, B1 = 1, B2 = 0, B3 = 1.
            port.writeDigital(0b1010);
          },
        },
      },
    };
    const reader: DeviceConfig = {
      id: 'r1',
      type: 'test-bus-reader',
      description: {
        pins: pinsOf(inputs, 'input'),
        states: { value: { type: 'u32', initial: 0 } },
        behaviors: {
          update: (api) => {
            api.state<'u32'>('value').store(api.pinGroup(inputs).readDigital());
          },
        },
      },
    };
    const compiled = compileCircuit({
      devices: [driver, reader],
      connections: bits.map((name, bit) => ({ from: `w1.${name}`, to: `r1.${inputs[bit]!}` })),
    });
    const runtime = runtimeOf(compiled);
    initialize(compiled, runtime);
    expect(stateOf(compiled, runtime, 'r1', 'value')).toBe(0);

    tick(compiled, runtime);
    expect(stateOf(compiled, runtime, 'r1', 'value')).toBe(0b1010);
  });

  it('exposes group members through group.pin(name)', () => {
    let names: readonly string[] = [];
    let globalIds: readonly number[] = [];
    const lcd: DeviceConfig = {
      id: 'lcd1',
      type: 'test-parallel-lcd',
      description: {
        pins: pinsOf(['D0', 'D1'], 'output'),
        behaviors: {
          initialize: (api) => {
            const port = api.pinGroup(['D0', 'D1']);
            names = port.names;
            globalIds = port.globalIds;
            port.pin('D0').configure(PIN_MODE.pushPull);
            port.pin('D0').writeDigital(api.builder.const('bool', true));
          },
        },
      },
    };
    const compiled = compileCircuit({ devices: [lcd], connections: [] });
    const runtime = runtimeOf(compiled);
    initialize(compiled, runtime);

    expect(names).toEqual(['D0', 'D1']);
    expect(globalIds).toEqual([compiled.pinMap.get('lcd1.D0'), compiled.pinMap.get('lcd1.D1')]);
    expect(pinOutputOf(compiled, runtime, 'lcd1.D0')).toBe(true);
    expect(pinModeOf(compiled, runtime, 'lcd1.D0')).toBe(PIN_MODE.pushPull);
    expect(pinOutputOf(compiled, runtime, 'lcd1.D1')).toBe(false);
    expect(pinModeOf(compiled, runtime, 'lcd1.D1')).toBe(PIN_MODE.highZ);
  });

  it('provides pin groups inside a topic entry handler', () => {
    const sink: DeviceConfig = {
      id: 'sink1',
      type: 'test-topic-bus',
      description: {
        pins: pinsOf(DATA_PINS, 'output'),
        ports: { write: { direction: 'input', type: 'number' } },
        behaviors: {
          initialize: (api) => {
            api.topics.subscribe('write', (entry) => {
              const port = entry.pinGroup(DATA_PINS);
              for (const name of DATA_PINS) port.pin(name).configure(PIN_MODE.pushPull);
              const payload = entry.args[0] as Value<'f64'>;
              port.writeDigital(entry.builder.convert.floatToInt('u32', payload));
            });
          },
        },
      },
    };
    const compiled = compileCircuit({ devices: [sink], connections: [] });
    const runtime = runtimeOf(compiled);
    initialize(compiled, runtime);

    const entry = compiled.topics.byKey.get('sink1.write')?.entry;
    if (entry === undefined) throw new Error('Missing sink1.write entry');
    runtime.execute(entry, [0xa5], CONTEXT);

    expect(packOutputs(compiled, runtime, 'sink1', DATA_PINS)).toBe(0xa5);
  });

  it('rejects an empty group, duplicate names and a non-u32 write', () => {
    const broken = (initialize: (api: DeviceBehaviorApi) => void): DeviceConfig => ({
      id: 'broken1',
      type: 'broken',
      description: {
        pins: pinsOf(['D0', 'D1'], 'output'),
        behaviors: { initialize },
      },
    });

    expectCompilerError(
      () =>
        compileCircuit({
          devices: [broken((api) => void api.pinGroup([]))],
          connections: [],
        }),
      'invalid-input',
    );
    expectCompilerError(
      () =>
        compileCircuit({
          devices: [broken((api) => void api.pinGroup(['D0', 'D0']))],
          connections: [],
        }),
      'invalid-input',
    );
    expectCompilerError(
      () =>
        compileCircuit({
          devices: [
            broken((api) => {
              const bits = api.builder.const('u8', 1) as unknown as Value<'u32'>;
              api.pinGroup(['D0', 'D1']).writeDigital(bits);
            }),
          ],
          connections: [],
        }),
      'invalid-input',
    );
  });

  it('rejects a group wider than 32 pins', () => {
    // One device holds at most `DEVICE_PIN_STRIDE` pins, so the width guard is
    // checked before the names are resolved against the declarations.
    const names = Array.from({ length: 33 }, (_, bit) => `D${bit}`);
    const bus: DeviceConfig = {
      id: 'bus1',
      type: 'test-33-bit-bus',
      description: {
        pins: pinsOf(['D0'], 'output'),
        behaviors: { initialize: (api) => void api.pinGroup(names) },
      },
    };
    const failure = expectCompilerError(
      () => compileCircuit({ devices: [bus], connections: [] }),
      'invalid-input',
    );
    expect(failure.message).toContain('at most 32');
  });

  it('rejects undeclared pins and pins outside the group', () => {
    const unknown: DeviceConfig = {
      id: 'broken1',
      type: 'broken',
      description: {
        pins: pinsOf(['D0'], 'output'),
        behaviors: { initialize: (api) => void api.pinGroup(['D0', 'missing']) },
      },
    };
    const unknownFailure = expectCompilerError(
      () => compileCircuit({ devices: [unknown], connections: [] }),
      'pin-not-found',
    );
    expect(unknownFailure.message).toBe("Pin 'broken1.missing' not found. Available: [broken1.D0]");

    const outside: DeviceConfig = {
      id: 'broken1',
      type: 'broken',
      description: {
        pins: pinsOf(['D0', 'D1'], 'output'),
        behaviors: { initialize: (api) => void api.pinGroup(['D0']).pin('D1') },
      },
    };
    const outsideFailure = expectCompilerError(
      () => compileCircuit({ devices: [outside], connections: [] }),
      'pin-not-found',
    );
    expect(outsideFailure.message).toContain('Group: [D0]');
  });
});
