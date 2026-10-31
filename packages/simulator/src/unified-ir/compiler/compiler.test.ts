import { physicalDescription, TEST_ELECTRICAL } from './test-helpers';
import { describe, expect, it } from 'vitest';
import { createIRModule, validateIR } from '@mica-js/ir';
import type { FunctionBodyDefinition, FunctionDefinition, IRModule } from '@mica-js/ir';
import {
  GlobalResourceAllocator,
  UnifiedIRCompilerError,
  compileCircuit as compilePhysicalCircuit,
  type CircuitCompilationInput,
  type CompiledCircuit,
  type DeviceConfig,
  type UnifiedIRCompilerErrorCode,
} from './index';
import { DEVICE_PIN_STRIDE, UNIFIED_PIN_CAPACITY } from '../pin-space';
import { lampSinkDescription, toggleDriverDescription } from './test-helpers';

function driver(id = 'drive1', pins?: readonly string[]): DeviceConfig {
  return {
    id,
    type: 'toggle-driver',
    description: physicalDescription(
      toggleDriverDescription(pins === undefined ? undefined : pins),
    ),
  };
}

function sink(id = 'sink1'): DeviceConfig {
  return { id, type: 'lamp-sink', description: physicalDescription(lampSinkDescription()) };
}

function driverSinkInput(): CircuitCompilationInput {
  return {
    devices: [driver(), sink()],
    connections: [
      { from: 'drive1.PA0', to: 'sink1.anode' },
      { from: 'sink1.cathode', to: 'GND' },
    ],
  };
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

type FunctionDefinitionWithBody = FunctionDefinition & { readonly body: FunctionBodyDefinition };

function definitionOf(compiled: CompiledCircuit, name: string): FunctionDefinitionWithBody {
  const definition = compiled.module.functions.find((fn) => fn.name === name);
  if (definition?.body === undefined) throw new Error(`Missing function body: ${name}`);
  return definition as FunctionDefinitionWithBody;
}

function terminatorsOf(compiled: CompiledCircuit, name: string): string[] {
  const definition = definitionOf(compiled, name);
  return definition.body.blocks.flatMap((block) =>
    block.terminator === undefined ? [] : [block.terminator.kind],
  );
}

/** Call targets of one generated function, resolved back to function names. */
function callTargets(compiled: CompiledCircuit, name: string): string[] {
  const definition = definitionOf(compiled, name);
  const calls: string[] = [];
  for (const block of definition.body.blocks) {
    for (const instruction of block.instructions) {
      if (instruction.op !== 'call') continue;
      const operand = instruction.operands[0];
      if (operand === undefined || operand.kind !== 'static') {
        throw new Error(`Call in ${name} has no static target`);
      }
      const target = compiled.module.functions.find((fn) => fn.ref === operand.ref);
      if (target === undefined) throw new Error(`Call in ${name} targets an unknown function`);
      calls.push(target.name);
    }
  }
  return calls;
}

function moduleFunctionNames(module: IRModule): string[] {
  return module.functions.map((fn) => fn.name);
}

describe('compileCircuit — single device', () => {
  it('exposes executable entry point refs next to their names', () => {
    const compiled = compileCircuit({ devices: [driver()], connections: [] });
    expect(compiled.entryPoints.refs.tick).toBe(
      compiled.module.functions.find((fn) => fn.name === compiled.entryPoints.tick)?.ref,
    );
    expect(compiled.entryPoints.refs.initialize).toBeDefined();
    expect(compiled.entryPoints.refs.batch).toBeDefined();
  });

  it('accepts custom entry point names', () => {
    const compiled = compileCircuit(
      { devices: [driver()], connections: [] },
      {
        entryPointNames: {
          tick: 'circuit_step',
          initialize: 'circuit_boot',
          batch: 'circuit_run',
        },
      },
    );
    expect(compiled.entryPoints).toMatchObject({
      tick: 'circuit_step',
      initialize: 'circuit_boot',
      batch: 'circuit_run',
    });
    expect(moduleFunctionNames(compiled.module)).toContain('circuit_run');
  });

  it('compiles a device whose description uses a Map of pins', () => {
    const description = {
      name: 'map-driver',
      pins: new Map([['PA0', { kind: 'signal' as const }]]),
      behaviors: { update: () => {} },
    };
    const compiled = compileCircuit({
      devices: [
        {
          id: 'map1',
          type: 'toggle-driver',
          description: physicalDescription(description, ['PA0']),
        },
      ],
      connections: [],
    });
    expect(compiled.pinMap.get('map1.PA0')).toBe(0);
  });
});

describe('GlobalResourceAllocator', () => {
  it('packs device pins into one contiguous address space', () => {
    const compiled = compileCircuit({
      devices: [driver('drive1', ['PA0', 'PA1']), sink('sink1')],
      connections: [],
    });

    expect(compiled.pinMap.get('drive1.PA0')).toBe(0);
    expect(compiled.pinMap.get('drive1.PA1')).toBe(1);
    expect(compiled.pinMap.get('sink1.anode')).toBe(2);
    expect(compiled.pinMap.get('sink1.cathode')).toBe(3);
    expect(compiled.pins.totalPins).toBe(4);
    expect(compiled.deviceMap.get('drive1')?.pinOffset).toBe(0);
    expect(compiled.deviceMap.get('sink1')?.pinOffset).toBe(2);
  });

  it('never overlaps two device pin ranges', () => {
    const compiled = compileCircuit({
      devices: [driver('drive1', ['PA0', 'PA1']), driver('drive2', ['PA0', 'PA1']), sink('sink1')],
      connections: [],
    });
    const ids = [...compiled.pinMap.values()];
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([0, 1, 2, 3, 4, 5]);
    expect(compiled.pins.totalPins).toBe(6);
    expect(compiled.pins.capacity).toBe(UNIFIED_PIN_CAPACITY);
  });

  it('allocates typed state slots across devices in declaration order', () => {
    const probe: DeviceConfig = {
      id: 'probe1',
      type: 'probe',
      description: physicalDescription({
        pins: { sense: { kind: 'signal' } },
        states: {
          counter: { type: 'u32', initial: 3 },
          flag: { type: 'bool', initial: true },
        },
        behaviors: { update: () => undefined },
      }),
    };
    const compiled = compileCircuit({ devices: [probe, sink()], connections: [] });

    const probeStates = compiled.deviceMap.get('probe1')?.states;
    expect(probeStates?.get('counter')).toMatchObject({ type: 'u32', index: 0, slot: 0 });
    expect(probeStates?.get('flag')).toMatchObject({ type: 'bool', index: 0, slot: 1 });
    expect(compiled.deviceMap.get('sink1')?.states.get('lamp')).toMatchObject({
      type: 'bool',
      index: 1,
      slot: 2,
    });
    expect(compiled.states.totalStates).toBe(3);
    expect(compiled.states.totals.get('bool')).toBe(2);
    expect(compiled.states.totals.get('u32')).toBe(1);
    expect(compiled.states.devices.get('probe1')?.size).toBe(2);
    expect(compiled.deviceMap.get('probe1')?.stateOffset).toBe(0);
    expect(compiled.deviceMap.get('sink1')?.stateOffset).toBe(2);
  });

  it('rejects a device with more pins than one device may own', () => {
    const pins = Array.from({ length: DEVICE_PIN_STRIDE + 1 }, (_, index) => `P${index}`);
    expectCompilerError(
      () => compileCircuit({ devices: [driver('drive1', pins)], connections: [] }),
      'capacity-exceeded',
    );
  });

  it('rejects a circuit that overflows the global pin space', () => {
    const pins = Array.from({ length: DEVICE_PIN_STRIDE }, (_, index) => `P${index}`);
    const devicesPerCapacity = Math.floor(UNIFIED_PIN_CAPACITY / DEVICE_PIN_STRIDE);
    const devices = Array.from({ length: devicesPerCapacity + 1 }, (_, index) =>
      driver(`driver${index}`, pins),
    );
    const failure = expectCompilerError(
      () => compileCircuit({ devices, connections: [] }),
      'capacity-exceeded',
    );
    expect(failure.message).toContain(String(UNIFIED_PIN_CAPACITY));
  });

  it('rejects duplicate device ids', () => {
    const failure = expectCompilerError(
      () =>
        compileCircuit({
          devices: [driver('dup'), driver('dup', ['PA1'])],
          connections: [],
        }),
      'duplicate-device',
    );
    expect(failure.message).toContain('dup');
  });

  it('rejects device ids that are not identifiers', () => {
    expectCompilerError(
      () =>
        compileCircuit({
          devices: [
            {
              id: 'driver-1',
              type: 'toggle-driver',
              description: physicalDescription(toggleDriverDescription()),
            },
          ],
          connections: [],
        }),
      'invalid-input',
    );
  });

  it('rejects a pin name containing a dot', () => {
    const description = { pins: { 'P.A0': { kind: 'signal' as const } }, factory: () => undefined };
    expectCompilerError(
      () =>
        compileCircuit({
          devices: [{ id: 'drive1', type: 'toggle-driver', description }],
          connections: [],
        }),
      'invalid-input',
    );
  });

  it('rejects malformed state declarations', () => {
    const description = {
      pins: { out: { kind: 'signal' as const } },
      factory: () => undefined,
      states: { counter: { type: 'u32' as const, initial: 1.5 } },
      behaviors: { tick: () => undefined },
    };
    expectCompilerError(
      () =>
        compileCircuit({
          devices: [{ id: 'odd1', type: 'odd', description }],
          connections: [],
        }),
      'invalid-input',
    );
  });

  it('can be used directly on a bare module', () => {
    const module = createIRModule();
    const allocator = new GlobalResourceAllocator(module);
    const allocation = allocator.allocate([driver('drive1', ['PA0', 'PA1']), sink()]);
    expect(allocation.pins.totalPins).toBe(4);
    expect(allocation.states.totalStates).toBe(1);
    expect(module.memories.map((memory) => memory.name)).toEqual(['device_state_bool']);
  });
});

describe('device IR generation', () => {
  it('compiles a custom device behavior', () => {
    const probe: DeviceConfig = {
      id: 'probe1',
      type: 'probe',
      description: physicalDescription({
        pins: { sense: { kind: 'signal' } },
        states: { last: { type: 'bool', initial: false } },
        behaviors: {
          update: (api) => {
            api.state<'bool'>('last').store(api.pin('sense').sampleDigital());
          },
        },
      }),
    };
    const compiled = compileCircuit({
      devices: [driver(), probe],
      connections: [{ from: 'drive1.PA0', to: 'probe1.sense' }],
    });
    expect(compiled.deviceMap.get('probe1')?.functions).toEqual(['probe1_update']);
    expect(compiled.deviceMap.get('probe1')?.states.get('last')?.name).toBe('last');
    expect(validateIR(compiled.module, compiled.validation).ok).toBe(true);
  });

  it('reports a missing pin reached from a behavior', () => {
    const broken: DeviceConfig = {
      id: 'broken1',
      type: 'broken',
      description: physicalDescription(
        {
          pins: { a: { kind: 'signal' } },
          behaviors: { tick: (api) => void api.pin('missing') },
        },
        ['a'],
      ),
    };
    const failure = expectCompilerError(
      () => compileCircuit({ devices: [broken], connections: [] }),
      'invalid-input',
    );
    expect(failure.message).toContain('Unknown pin "broken1.missing"');
  });

  it('reports a missing state reached from a behavior', () => {
    const broken: DeviceConfig = {
      id: 'broken1',
      type: 'broken',
      description: physicalDescription({
        pins: { a: { kind: 'signal' } },
        states: { known: { type: 'bool', initial: false } },
        behaviors: { update: (api) => void api.state('absent') },
      }),
    };
    const failure = expectCompilerError(
      () => compileCircuit({ devices: [broken], connections: [] }),
      'state-not-found',
    );
    expect(failure.message).toContain('absent');
    expect(failure.message).toContain('known');
  });
});

describe('main loop', () => {
  it('falls back to declaration order when devices feed each other', () => {
    const ping: DeviceConfig = {
      id: 'a1',
      type: 'peer',
      description: physicalDescription(
        {
          pins: { out: { kind: 'signal' }, input: { kind: 'signal' } },
          behaviors: { tick: () => undefined },
        },
        ['out'],
      ),
    };
    const pong: DeviceConfig = {
      id: 'b1',
      type: 'peer',
      description: physicalDescription(
        {
          pins: { out: { kind: 'signal' }, input: { kind: 'signal' } },
          behaviors: { tick: () => undefined },
        },
        ['out'],
      ),
    };
    const compiled = compileCircuit({
      devices: [ping, pong],
      connections: [
        { from: 'a1.out', to: 'b1.input' },
        { from: 'b1.out', to: 'a1.input' },
      ],
    });
    expect(compiled.executionOrder).toEqual(['a1', 'b1']);
  });

  it('keeps the batch loop inside the generated IR', () => {
    const compiled = compileCircuit(driverSinkInput());
    const batch = definitionOf(compiled, 'unified_tick_batch');
    expect(batch.params).toEqual(['u32']);
    expect(terminatorsOf(compiled, 'unified_tick_batch')).toContain('jump');
    expect(terminatorsOf(compiled, 'unified_tick_batch')).toContain('branch');
    const calls = callTargets(compiled, 'unified_tick_batch');
    expect(calls).toContain('drive1_tick');
    expect(calls).toContain('sink1_update');
    expect(calls.filter((name) => name === 'electrical_ensure')).toHaveLength(2);
    expect(calls.some((name) => name.startsWith('solve_net_'))).toBe(false);
  });
});

describe('compilation output', () => {
  it('is deterministic across runs', () => {
    const first = compileCircuit(driverSinkInput());
    const second = compileCircuit(driverSinkInput());
    expect(moduleFunctionNames(second.module)).toEqual(moduleFunctionNames(first.module));
    expect([...second.pinMap.entries()]).toEqual([...first.pinMap.entries()]);
    expect(second.executionOrder).toEqual(first.executionOrder);
  });

  it('reports every generated function in definition order', () => {
    const compiled = compileCircuit(driverSinkInput());
    expect(compiled.functions).toEqual(moduleFunctionNames(compiled.module));
  });

  it('rejects an empty device list', () => {
    expectCompilerError(() => compileCircuit({ devices: [], connections: [] }), 'invalid-input');
  });

  it('rejects a device whose function name collides with an entry point', () => {
    const failure = expectCompilerError(
      () =>
        compileCircuit(
          { devices: [driver('unified')], connections: [] },
          { entryPointNames: { tick: 'unified_tick' } },
        ),
      'invalid-input',
    );
    expect(failure.message).toContain('collides');
    expect(failure.message).toContain('unified_');
  });

  it('rejects duplicate entry point names', () => {
    expectCompilerError(
      () =>
        compileCircuit(
          { devices: [driver()], connections: [] },
          { entryPointNames: { tick: 'step', initialize: 'step' } },
        ),
      'invalid-input',
    );
  });

  it('rejects a description without a usable pins map', () => {
    expectCompilerError(
      () =>
        compileCircuit({
          devices: [
            { id: 'x1', type: 'x', description: physicalDescription({ pins: 42 as never }) },
          ],
          connections: [],
        }),
      'invalid-input',
    );
  });

  it('rejects unknown state types and wrong initial values', () => {
    expectCompilerError(
      () =>
        compileCircuit({
          devices: [
            {
              id: 'x1',
              type: 'x',
              description: physicalDescription({
                pins: { a: { kind: 'signal' } },
                states: { broken: { type: 'u64' as never, initial: 0 } },
                behaviors: { update: () => undefined },
              }),
            },
          ],
          connections: [],
        }),
      'invalid-input',
    );
    expectCompilerError(
      () =>
        compileCircuit({
          devices: [
            {
              id: 'x1',
              type: 'x',
              description: physicalDescription({
                pins: { a: { kind: 'signal' } },
                states: { broken: { type: 'bool', initial: 1 } },
                behaviors: { update: () => undefined },
              }),
            },
          ],
          connections: [],
        }),
      'invalid-input',
    );
  });

  it('rejects an out-of-range pin mode from a behavior', () => {
    expectCompilerError(
      () =>
        compileCircuit({
          devices: [
            {
              id: 'x1',
              type: 'x',
              description: physicalDescription(
                {
                  pins: { a: { kind: 'signal' } },
                  behaviors: { initialize: (api) => api.pin('a').configure(300) },
                },
                ['a'],
              ),
            },
          ],
          connections: [],
        }),
      'invalid-input',
    );
  });
});

function compileCircuit(
  input: CircuitCompilationInput,
  options: Parameters<typeof compilePhysicalCircuit>[1] = {},
) {
  return compilePhysicalCircuit(input, { ...TEST_ELECTRICAL, ...options });
}
