import { describe, expect, it } from 'vitest';
import { createIRModule, validateIR } from '@mica-js/ir';
import type { FunctionBodyDefinition, FunctionDefinition, IRModule } from '@mica-js/ir';
import {
  GlobalResourceAllocator,
  NetworkTopologyAnalyzer,
  UnifiedIRCompilerError,
  compileCircuit,
  type CircuitCompilationInput,
  type CompiledCircuit,
  type DeviceConfig,
  type UnifiedIRCompilerErrorCode,
} from './index';
import { lampSinkDescription, toggleDriverDescription } from './test-helpers';

function driver(id = 'drive1', pins?: readonly string[]): DeviceConfig {
  return {
    id,
    type: 'toggle-driver',
    description: toggleDriverDescription(pins === undefined ? undefined : pins),
  };
}

function sink(id = 'sink1'): DeviceConfig {
  return { id, type: 'lamp-sink', description: lampSinkDescription() };
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

/** All instruction ops of one generated function, blocks in definition order. */
function opsOf(compiled: CompiledCircuit, name: string): string[] {
  const definition = definitionOf(compiled, name);
  const ops: string[] = [];
  for (const block of definition.body.blocks) {
    for (const instruction of block.instructions) ops.push(instruction.op);
  }
  return ops;
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
  it('compiles one device into a valid IR module', () => {
    const compiled = compileCircuit({ devices: [driver()], connections: [] });

    expect(compiled.module).toBeDefined();
    expect(compiled.entryPoints.tick).toBe('unified_tick');
    expect(compiled.entryPoints.initialize).toBe('unified_initialize');
    expect(compiled.entryPoints.batch).toBe('unified_tick_batch');
    expect(moduleFunctionNames(compiled.module)).toEqual([
      'drive1_initialize',
      'drive1_tick',
      'unified_initialize',
      'unified_tick',
      'unified_tick_batch',
    ]);
    expect(validateIR(compiled.module, compiled.validation).ok).toBe(true);
  });

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
      pins: new Map([['PA0', { direction: 'output' as const }]]),
      behaviors: { update: () => {} },
    };
    const compiled = compileCircuit({
      devices: [{ id: 'map1', type: 'toggle-driver', description }],
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
    expect(compiled.pins.capacity).toBe(256);
  });

  it('allocates typed state slots across devices in declaration order', () => {
    const probe: DeviceConfig = {
      id: 'probe1',
      type: 'probe',
      description: {
        pins: { sense: { direction: 'input' } },
        states: {
          counter: { type: 'u32', initial: 3 },
          flag: { type: 'bool', initial: true },
        },
        behaviors: { update: () => undefined },
      },
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

  it('rejects a device with more pins than one port holds', () => {
    const pins = Array.from({ length: 33 }, (_, index) => `P${index}`);
    expectCompilerError(
      () => compileCircuit({ devices: [driver('drive1', pins)], connections: [] }),
      'capacity-exceeded',
    );
  });

  it('rejects a circuit that overflows the global pin space', () => {
    const pins = Array.from({ length: 32 }, (_, index) => `P${index}`);
    const devices = Array.from({ length: 9 }, (_, index) => driver(`driver${index}`, pins));
    const failure = expectCompilerError(
      () => compileCircuit({ devices, connections: [] }),
      'capacity-exceeded',
    );
    expect(failure.message).toContain('256');
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
            { id: 'driver-1', type: 'toggle-driver', description: toggleDriverDescription() },
          ],
          connections: [],
        }),
      'invalid-input',
    );
  });

  it('rejects a pin name containing a dot', () => {
    const description = { pins: { 'P.A0': { direction: 'output' as const } } };
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
      pins: { out: { direction: 'output' as const } },
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
    expect(module.memories.map((memory) => memory.name)).toEqual([
      'pin_mode',
      'pin_output',
      'pin_input',
      'device_state_bool',
    ]);
  });
});

describe('NetworkTopologyAnalyzer', () => {
  it('recognises one net per connected component and splits drivers from loads', () => {
    const compiled = compileCircuit(driverSinkInput());
    expect(compiled.netlist.nets).toHaveLength(2);

    const [driven, ground] = compiled.netlist.nets;
    expect(driven?.source).toBe('driver');
    expect(driven?.drivers.map((pin) => pin.endpoint)).toEqual(['drive1.PA0']);
    expect(driven?.loads.map((pin) => pin.endpoint)).toEqual(['sink1.anode']);
    expect(driven?.pins.map((pin) => pin.globalPinId)).toEqual([0, 1]);

    expect(ground?.source).toBe('rail');
    expect(ground?.level).toBe(false);
    expect(ground?.rails.map((rail) => rail.name)).toEqual(['GND']);
    expect(ground?.loads.map((pin) => pin.endpoint)).toEqual(['sink1.cathode']);
    expect(compiled.netlist.diagnostics).toEqual([]);
  });

  it('merges a chain of connections into a single net', () => {
    const compiled = compileCircuit({
      devices: [driver(), sink('sink1'), sink('sink2')],
      connections: [
        { from: 'drive1.PA0', to: 'sink1.anode' },
        { from: 'sink1.anode', to: 'sink2.anode' },
      ],
    });
    expect(compiled.netlist.nets).toHaveLength(1);
    expect(compiled.netlist.nets[0]?.pins).toHaveLength(3);
    expect(compiled.netlist.nets[0]?.loads).toHaveLength(2);
    expect(
      moduleFunctionNames(compiled.module).filter((name) => name.startsWith('solve_net_')),
    ).toEqual(['solve_net_0']);
  });

  it('numbers nets by first appearance', () => {
    const compiled = compileCircuit({
      devices: [driver(), sink()],
      connections: [
        { from: 'sink1.cathode', to: 'GND' },
        { from: 'drive1.PA0', to: 'sink1.anode' },
      ],
    });
    expect(compiled.netlist.nets[0]?.source).toBe('rail');
    expect(compiled.netlist.nets[1]?.source).toBe('driver');
    expect(compiled.netlist.nets[1]?.netId).toBe(1);
  });

  it('warns about a floating net but still compiles it', () => {
    const compiled = compileCircuit({
      devices: [sink()],
      connections: [{ from: 'sink1.anode', to: 'sink1.cathode' }],
    });
    const floating = compiled.netlist.diagnostics.find((entry) => entry.code === 'floating-net');
    expect(floating?.severity).toBe('warning');
    expect(compiled.netlist.nets[0]?.source).toBe('floating');
  });

  it('rejects two drivers on one net', () => {
    const failure = expectCompilerError(
      () =>
        compileCircuit({
          devices: [driver('drive1'), driver('drive2'), sink()],
          connections: [
            { from: 'drive1.PA0', to: 'sink1.anode' },
            { from: 'drive2.PA0', to: 'sink1.anode' },
          ],
        }),
      'driver-conflict',
    );
    expect(failure.message).toContain('drive1.PA0');
    expect(failure.message).toContain('drive2.PA0');
    expect(failure.diagnostics.some((entry) => entry.code === 'driver-conflict')).toBe(true);
  });

  it('solves several drivers as a wired-OR when allowed', () => {
    const compiled = compileCircuit(
      {
        devices: [driver('drive1'), driver('drive2'), sink()],
        connections: [
          { from: 'drive1.PA0', to: 'sink1.anode' },
          { from: 'drive2.PA0', to: 'sink1.anode' },
        ],
      },
      { allowMultiDriver: true },
    );
    const conflict = compiled.netlist.diagnostics.find((entry) => entry.code === 'driver-conflict');
    expect(conflict?.severity).toBe('warning');
    expect(opsOf(compiled, 'solve_net_0')).toContain('bool.or');
  });

  it('rejects a driver shorted against a rail', () => {
    const failure = expectCompilerError(
      () =>
        compileCircuit({
          devices: [driver()],
          connections: [{ from: 'drive1.PA0', to: 'GND' }],
        }),
      'power-short',
    );
    expect(failure.message).toContain('GND');
  });

  it('rejects opposite rails wired together', () => {
    expectCompilerError(
      () => compileCircuit({ devices: [driver()], connections: [{ from: 'GND', to: 'VCC' }] }),
      'rail-conflict',
    );
  });

  it('rejects an unknown device in a connection', () => {
    const failure = expectCompilerError(
      () =>
        compileCircuit({
          devices: [driver()],
          connections: [{ from: 'ghost.PA0', to: 'drive1.PA0' }],
        }),
      'unknown-device',
    );
    expect(failure.message).toContain('ghost');
    expect(failure.message).toContain('Available: [drive1]');
  });

  it('reports a missing pin with the pins the device declares', () => {
    const failure = expectCompilerError(
      () =>
        compileCircuit({
          devices: [driver()],
          connections: [{ from: 'drive1.PA9', to: 'drive1.PA0' }],
        }),
      'pin-not-found',
    );
    expect(failure.message).toBe("Pin 'drive1.PA9' not found. Available: [drive1.PA0]");
  });

  it('rejects malformed connection endpoints', () => {
    expectCompilerError(
      () =>
        compileCircuit({
          devices: [driver()],
          connections: [{ from: 'drive1', to: 'drive1.PA0' }],
        }),
      'invalid-connection',
    );
    expectCompilerError(
      () =>
        compileCircuit({
          devices: [driver()],
          connections: [{ from: '', to: 'drive1.PA0' }],
        }),
      'invalid-connection',
    );
  });

  it('accepts a caller-defined rail', () => {
    const compiled = compileCircuit(
      {
        devices: [sink()],
        connections: [{ from: 'sink1.anode', to: 'VRAIL' }],
      },
      { rails: { VRAIL: true } },
    );
    expect(compiled.netlist.nets[0]?.source).toBe('rail');
    expect(compiled.netlist.nets[0]?.level).toBe(true);
  });

  it('can be used directly on an allocation', () => {
    const module = createIRModule();
    const allocation = new GlobalResourceAllocator(module).allocate([driver(), sink()]);
    const analyzer = new NetworkTopologyAnalyzer();
    const netlist = analyzer.analyze([{ from: 'drive1.PA0', to: 'sink1.anode' }], allocation.pins);
    expect(netlist.nets).toHaveLength(1);
    expect(netlist.nets[0]?.drivers[0]?.globalPinId).toBe(0);
    expect(netlist.nets[0]?.loads[0]?.globalPinId).toBe(1);
  });
});

describe('device IR generation', () => {
  it('emits one solver per net plus device functions', () => {
    const compiled = compileCircuit(driverSinkInput());
    expect(moduleFunctionNames(compiled.module)).toEqual([
      'drive1_initialize',
      'drive1_tick',
      'sink1_update',
      'solve_net_0',
      'solve_net_1',
      'unified_initialize',
      'unified_tick',
      'unified_tick_batch',
    ]);
    expect(compiled.deviceMap.get('drive1')?.functions).toEqual([
      'drive1_initialize',
      'drive1_tick',
    ]);
    expect(compiled.deviceMap.get('sink1')?.functions).toEqual(['sink1_update']);
  });

  it('generates a branch-free solver for a single-driver net', () => {
    const compiled = compileCircuit(driverSinkInput());
    expect(terminatorsOf(compiled, 'solve_net_0')).toEqual(['return']);
    expect(opsOf(compiled, 'solve_net_0')).toEqual([
      'const',
      'array.load',
      'array.load',
      'const',
      'int.cmp',
      'bool.and',
      'const',
      'array.store',
    ]);
  });

  it('inlines pin domain instructions into the shared pin memories', () => {
    const compiled = compileCircuit(driverSinkInput());
    const tickOps = opsOf(compiled, 'drive1_tick');
    expect(tickOps).toEqual([
      'const',
      'array.load',
      'bool.not',
      'const',
      'array.store',
      'const',
      'const',
      'array.store',
    ]);
    expect(tickOps.some((op) => op.startsWith('pin.') || op.startsWith('observe.'))).toBe(false);
  });

  it('writes push-pull mode when an output pin is configured', () => {
    const compiled = compileCircuit(driverSinkInput());
    const definition = definitionOf(compiled, 'drive1_initialize');
    const store = definition.body.blocks
      .flatMap((block) => block.instructions)
      .find((instruction) => instruction.op === 'array.store');
    const target = store?.operands[0];
    expect(target?.kind).toBe('static');
    expect(target?.kind === 'static' ? target.ref : undefined).toBe(compiled.memory.mode);
  });

  it('compiles a custom device behavior', () => {
    const probe: DeviceConfig = {
      id: 'probe1',
      type: 'probe',
      description: {
        pins: { sense: { direction: 'input' } },
        states: { last: { type: 'bool', initial: false } },
        behaviors: {
          update: (api) => {
            api.state<'bool'>('last').store(api.pin('sense').sampleDigital());
          },
        },
      },
    };
    const compiled = compileCircuit({
      devices: [driver(), probe],
      connections: [{ from: 'drive1.PA0', to: 'probe1.sense' }],
    });
    expect(compiled.deviceMap.get('probe1')?.functions).toEqual(['probe1_update']);
    expect(compiled.deviceMap.get('probe1')?.states.get('last')?.name).toBe('last');
    expect(validateIR(compiled.module, compiled.validation).ok).toBe(true);
  });

  it('rejects a device type without a kernel or behaviors', () => {
    const failure = expectCompilerError(
      () =>
        compileCircuit({
          devices: [{ id: 'x1', type: 'mystery', description: { pins: {} } }],
          connections: [],
        }),
      'unsupported-device',
    );
    expect(failure.message).toContain('declares no behaviors');
    expect(failure.message).toContain('description.behaviors');
  });

  it('reports a missing pin reached from a behavior', () => {
    const broken: DeviceConfig = {
      id: 'broken1',
      type: 'broken',
      description: {
        pins: { a: { direction: 'output' } },
        behaviors: { tick: (api) => void api.pin('missing') },
      },
    };
    const failure = expectCompilerError(
      () => compileCircuit({ devices: [broken], connections: [] }),
      'pin-not-found',
    );
    expect(failure.message).toBe("Pin 'broken1.missing' not found. Available: [broken1.a]");
  });

  it('reports a missing state reached from a behavior', () => {
    const broken: DeviceConfig = {
      id: 'broken1',
      type: 'broken',
      description: {
        pins: { a: { direction: 'input' } },
        states: { known: { type: 'bool', initial: false } },
        behaviors: { update: (api) => void api.state('absent') },
      },
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
  it('calls drivers, then every net, then the loads', () => {
    const compiled = compileCircuit(driverSinkInput());
    expect(callTargets(compiled, 'unified_tick')).toEqual([
      'drive1_tick',
      'solve_net_0',
      'solve_net_1',
      'sink1_update',
    ]);
    expect(callTargets(compiled, 'unified_initialize')).toEqual(['drive1_initialize']);
  });

  it('orders devices so that a driver runs before the devices it feeds', () => {
    const compiled = compileCircuit({
      devices: [sink(), driver()],
      connections: [
        { from: 'drive1.PA0', to: 'sink1.anode' },
        { from: 'sink1.cathode', to: 'GND' },
      ],
    });
    expect(compiled.executionOrder).toEqual(['drive1', 'sink1']);
    expect(callTargets(compiled, 'unified_tick')[0]).toBe('drive1_tick');
  });

  it('falls back to declaration order when devices feed each other', () => {
    const ping: DeviceConfig = {
      id: 'a1',
      type: 'peer',
      description: {
        pins: { out: { direction: 'output' }, input: { direction: 'input' } },
        behaviors: { tick: () => undefined },
      },
    };
    const pong: DeviceConfig = {
      id: 'b1',
      type: 'peer',
      description: {
        pins: { out: { direction: 'output' }, input: { direction: 'input' } },
        behaviors: { tick: () => undefined },
      },
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
    expect(batch.body.blocks).toHaveLength(4);
    expect(terminatorsOf(compiled, 'unified_tick_batch').sort()).toEqual([
      'branch',
      'jump',
      'jump',
      'return',
    ]);
    expect(callTargets(compiled, 'unified_tick_batch')).toEqual([
      'drive1_tick',
      'solve_net_0',
      'solve_net_1',
      'sink1_update',
    ]);
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

  it('rejects malformed compiler options', () => {
    const input = { devices: [driver()], connections: [] };
    expectCompilerError(
      () => compileCircuit(input, { validate: 'yes' as unknown as boolean }),
      'invalid-input',
    );
    expectCompilerError(() => compileCircuit(input, { rails: { '': true } }), 'invalid-input');
    expectCompilerError(
      () => compileCircuit(input, { rails: { VRAIL: 1 as unknown as boolean } }),
      'invalid-input',
    );
    expectCompilerError(
      () => compileCircuit(input, { rails: null as unknown as Record<string, boolean> }),
      'invalid-input',
    );
  });

  it('rejects a description without a usable pins map', () => {
    expectCompilerError(
      () =>
        compileCircuit({
          devices: [{ id: 'x1', type: 'x', description: { pins: 42 as never } }],
          connections: [],
        }),
      'invalid-input',
    );
  });

  it('rejects an unknown pin direction', () => {
    expectCompilerError(
      () =>
        compileCircuit({
          devices: [
            {
              id: 'x1',
              type: 'x',
              description: {
                pins: { a: { direction: 'sideways' as never } },
                behaviors: { tick: () => undefined },
              },
            },
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
              description: {
                pins: { a: { direction: 'input' } },
                states: { broken: { type: 'u64' as never, initial: 0 } },
                behaviors: { update: () => undefined },
              },
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
              description: {
                pins: { a: { direction: 'input' } },
                states: { broken: { type: 'bool', initial: 1 } },
                behaviors: { update: () => undefined },
              },
            },
          ],
          connections: [],
        }),
      'invalid-input',
    );
  });

  it('derives pin roles from the direction and honours explicit overrides', () => {
    const compiled = compileCircuit({
      devices: [
        {
          id: 'd1',
          type: 'multi',
          description: {
            pins: {
              out: { direction: 'output' },
              input: { direction: 'input' },
              both: { direction: 'bidirectional' },
              passive: {},
              forcedDriver: { direction: 'input', role: 'driver' },
              forcedLoad: { direction: 'output', role: 'load' },
            },
            behaviors: { tick: () => undefined },
          },
        },
      ],
      connections: [],
    });
    const resolved = compiled.pins.devices.get('d1')?.resolved;
    expect(resolved?.get('out')).toMatchObject({ role: 'driver', senses: false });
    expect(resolved?.get('input')).toMatchObject({ role: 'load', senses: true });
    expect(resolved?.get('both')).toMatchObject({ role: 'driver', senses: true });
    expect(resolved?.get('passive')).toMatchObject({ role: 'load', senses: true });
    expect(resolved?.get('forcedDriver')).toMatchObject({ role: 'driver', senses: false });
    expect(resolved?.get('forcedLoad')).toMatchObject({ role: 'load', senses: true });
  });

  it('rejects an out-of-range pin mode from a behavior', () => {
    expectCompilerError(
      () =>
        compileCircuit({
          devices: [
            {
              id: 'x1',
              type: 'x',
              description: {
                pins: { a: { direction: 'output' } },
                behaviors: { initialize: (api) => api.pin('a').configure(300) },
              },
            },
          ],
          connections: [],
        }),
      'invalid-input',
    );
  });
});
