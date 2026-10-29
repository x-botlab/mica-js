import { describe, expect, it } from 'vitest';
import { createIRInterpreter, createIRJIT } from '@mica-js/ir';
import type { IRExecutionContext, IRInterpreter, ScalarType, StorageValue } from '@mica-js/ir';
import {
  compileCircuit,
  type CircuitCompilationInput,
  type CompiledCircuit,
  type DeviceConfig,
} from './index';
import { lampSinkDescription, toggleDriverDescription } from './test-helpers';

const CONTEXT: IRExecutionContext = Object.freeze({
  instanceId: 'unified-ir-compiler-test',
  virtualTime: 0,
});

function createRuntime(
  compiled: CompiledCircuit,
  engine: 'jit' | 'reference' = 'jit',
): IRInterpreter {
  const options = { validation: compiled.validation, maxSteps: Number.MAX_SAFE_INTEGER };
  return engine === 'jit'
    ? createIRJIT(compiled.module, { ...options, jit: { tierUpThreshold: 0 } })
    : createIRInterpreter(compiled.module, options);
}

function initialize(compiled: CompiledCircuit, runtime: IRInterpreter): void {
  runtime.execute(compiled.entryPoints.refs.initialize, [], CONTEXT);
}

function tick(compiled: CompiledCircuit, runtime: IRInterpreter): void {
  runtime.execute(compiled.entryPoints.refs.tick, [], CONTEXT);
}

function lampOf(compiled: CompiledCircuit, runtime: IRInterpreter, deviceId: string): boolean {
  const slot = compiled.deviceMap.get(deviceId)?.states.get('lamp');
  if (slot === undefined) throw new Error(`Device "${deviceId}" has no lamp state`);
  return runtime.storage.loadArray(slot.array, slot.index) === true;
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

function pinInputOf(compiled: CompiledCircuit, runtime: IRInterpreter, endpoint: string): boolean {
  const pin = compiled.pinMap.get(endpoint);
  if (pin === undefined) throw new Error(`Unknown pin ${endpoint}`);
  return runtime.storage.loadArray(compiled.memory.input, pin) === true;
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

function driver(id = 'drive1'): DeviceConfig {
  return { id, type: 'toggle-driver', description: toggleDriverDescription() };
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

describe('CompiledCircuit integration', () => {
  it('propagates a driver pin toggle to the sink lamp', () => {
    const compiled = compileCircuit(driverSinkInput());
    const jit = createRuntime(compiled);
    initialize(compiled, jit);

    expect(lampOf(compiled, jit, 'sink1')).toBe(false);

    tick(compiled, jit);
    expect(pinOutputOf(compiled, jit, 'drive1.PA0')).toBe(true);
    expect(pinInputOf(compiled, jit, 'sink1.anode')).toBe(true);
    expect(pinInputOf(compiled, jit, 'sink1.cathode')).toBe(false);
    expect(lampOf(compiled, jit, 'sink1')).toBe(true);

    tick(compiled, jit);
    expect(pinOutputOf(compiled, jit, 'drive1.PA0')).toBe(false);
    expect(pinInputOf(compiled, jit, 'sink1.anode')).toBe(false);
    expect(lampOf(compiled, jit, 'sink1')).toBe(false);

    tick(compiled, jit);
    expect(lampOf(compiled, jit, 'sink1')).toBe(true);
  });

  it('configures the driving pin as push-pull during initialize', () => {
    const compiled = compileCircuit(driverSinkInput());
    const jit = createRuntime(compiled);
    initialize(compiled, jit);

    expect(pinModeOf(compiled, jit, 'drive1.PA0')).toBe(1);
    expect(pinOutputOf(compiled, jit, 'drive1.PA0')).toBe(false);
    expect(lampOf(compiled, jit, 'sink1')).toBe(false);
  });

  it('keeps the sink dark when the cathode sits on VCC', () => {
    const compiled = compileCircuit({
      devices: [driver(), sink()],
      connections: [
        { from: 'drive1.PA0', to: 'sink1.anode' },
        { from: 'sink1.cathode', to: 'VCC' },
      ],
    });
    const jit = createRuntime(compiled);
    initialize(compiled, jit);
    for (let step = 0; step < 4; step += 1) {
      tick(compiled, jit);
      expect(pinInputOf(compiled, jit, 'sink1.cathode')).toBe(true);
      expect(lampOf(compiled, jit, 'sink1')).toBe(false);
    }
  });

  it('lights a sink wired between VCC and GND without any driver', () => {
    const compiled = compileCircuit({
      devices: [sink()],
      connections: [
        { from: 'sink1.anode', to: 'VCC' },
        { from: 'sink1.cathode', to: 'GND' },
      ],
    });
    const jit = createRuntime(compiled);
    initialize(compiled, jit);
    tick(compiled, jit);
    expect(lampOf(compiled, jit, 'sink1')).toBe(true);
  });

  it('runs a custom probe device off the solved net', () => {
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
    const jit = createRuntime(compiled);
    initialize(compiled, jit);

    tick(compiled, jit);
    expect(stateOf(compiled, jit, 'probe1', 'last')).toBe(true);
    tick(compiled, jit);
    expect(stateOf(compiled, jit, 'probe1', 'last')).toBe(false);
  });

  it('keeps two independent driver + sink pairs apart', () => {
    const compiled = compileCircuit({
      devices: [driver('drive1'), driver('drive2'), sink('sink1'), sink('sink2')],
      connections: [
        { from: 'drive1.PA0', to: 'sink1.anode' },
        { from: 'sink1.cathode', to: 'GND' },
        { from: 'drive2.PA0', to: 'sink2.anode' },
        { from: 'sink2.cathode', to: 'GND' },
      ],
    });
    const jit = createRuntime(compiled);
    initialize(compiled, jit);

    tick(compiled, jit);
    expect(lampOf(compiled, jit, 'sink1')).toBe(true);
    expect(lampOf(compiled, jit, 'sink2')).toBe(true);
    expect(pinInputOf(compiled, jit, 'sink1.anode')).toBe(pinInputOf(compiled, jit, 'sink2.anode'));

    tick(compiled, jit);
    expect(lampOf(compiled, jit, 'sink1')).toBe(false);
    expect(lampOf(compiled, jit, 'sink2')).toBe(false);
  });

  it('produces the same trace on the JIT and the reference interpreter', () => {
    const compiled = compileCircuit(driverSinkInput());
    const jit = createRuntime(compiled, 'jit');
    const reference = createRuntime(compiled, 'reference');
    initialize(compiled, jit);
    initialize(compiled, reference);

    for (let step = 0; step < 6; step += 1) {
      tick(compiled, jit);
      tick(compiled, reference);
      expect(lampOf(compiled, reference, 'sink1')).toBe(lampOf(compiled, jit, 'sink1'));
      expect(pinInputOf(compiled, reference, 'sink1.anode')).toBe(
        pinInputOf(compiled, jit, 'sink1.anode'),
      );
    }
  });

  it('batches ticks inside the generated loop', () => {
    const compiled = compileCircuit(driverSinkInput());
    const single = createRuntime(compiled);
    const batched = createRuntime(compiled);
    initialize(compiled, single);
    initialize(compiled, batched);

    for (let step = 0; step < 5; step += 1) tick(compiled, single);
    batched.execute(compiled.entryPoints.refs.batch, [5], CONTEXT);

    expect(lampOf(compiled, batched, 'sink1')).toBe(lampOf(compiled, single, 'sink1'));
    expect(pinInputOf(compiled, batched, 'sink1.anode')).toBe(
      pinInputOf(compiled, single, 'sink1.anode'),
    );
    expect(pinOutputOf(compiled, batched, 'drive1.PA0')).toBe(
      pinOutputOf(compiled, single, 'drive1.PA0'),
    );

    // One more tick must resume exactly where the batch stopped.
    tick(compiled, single);
    tick(compiled, batched);
    expect(lampOf(compiled, batched, 'sink1')).toBe(lampOf(compiled, single, 'sink1'));
  });

  it('accumulates a typed u32 device state on every tick', () => {
    const counter: DeviceConfig = {
      id: 'c1',
      type: 'counter',
      description: {
        pins: { clk: { direction: 'input' } },
        states: {
          count: { type: 'u32', initial: 0 },
          last: { type: 'bool', initial: false },
        },
        behaviors: {
          update: (api) => {
            const count = api.state<'u32'>('count');
            count.store(api.builder.int.add(count.load(), api.builder.const('u32', 1)));
            api.state<'bool'>('last').store(api.pin('clk').sampleDigital());
          },
        },
      },
    };
    const compiled = compileCircuit({
      devices: [driver(), counter],
      connections: [{ from: 'drive1.PA0', to: 'c1.clk' }],
    });
    expect(compiled.states.arrays.get('u32')).toBeDefined();

    const jit = createRuntime(compiled);
    initialize(compiled, jit);
    tick(compiled, jit);
    expect(stateOf(compiled, jit, 'c1', 'count')).toBe(1);
    expect(stateOf(compiled, jit, 'c1', 'last')).toBe(true);
    tick(compiled, jit);
    expect(stateOf(compiled, jit, 'c1', 'count')).toBe(2);
    expect(stateOf(compiled, jit, 'c1', 'last')).toBe(false);
    tick(compiled, jit);
    expect(stateOf(compiled, jit, 'c1', 'count')).toBe(3);
    expect(stateOf(compiled, jit, 'c1', 'last')).toBe(true);
  });

  it('lets a bidirectional pin sense its own solved net', () => {
    const bridge: DeviceConfig = {
      id: 'b1',
      type: 'bridge',
      description: {
        pins: { line: { direction: 'bidirectional' } },
        behaviors: {
          initialize: (api) => api.pin('line').configure(1),
          tick: (api) => {
            const line = api.pin('line');
            line.writeDigital(api.builder.bool.not(line.sampleDigital()));
          },
        },
      },
    };
    const compiled = compileCircuit({
      devices: [bridge, sink()],
      connections: [
        { from: 'b1.line', to: 'sink1.anode' },
        { from: 'sink1.cathode', to: 'GND' },
      ],
    });
    expect(compiled.netlist.nets[0]?.sinks.map((pin) => pin.endpoint)).toEqual([
      'b1.line',
      'sink1.anode',
    ]);

    const jit = createRuntime(compiled);
    initialize(compiled, jit);
    tick(compiled, jit);
    expect(pinInputOf(compiled, jit, 'b1.line')).toBe(true);
    expect(lampOf(compiled, jit, 'sink1')).toBe(true);
    tick(compiled, jit);
    expect(pinInputOf(compiled, jit, 'b1.line')).toBe(false);
    expect(lampOf(compiled, jit, 'sink1')).toBe(false);
  });

  it('compiles quickly and ticks at prototype speed', () => {
    const compileStart = performance.now();
    const compiled = compileCircuit(driverSinkInput());
    const compileMs = performance.now() - compileStart;
    expect(compileMs).toBeLessThan(200);

    const jit = createRuntime(compiled);
    initialize(compiled, jit);
    tick(compiled, jit);
    // Warm the compiled loop so the measurement excludes code generation.
    jit.execute(compiled.entryPoints.refs.batch, [100], CONTEXT);

    const ticks = 1000;
    const start = performance.now();
    jit.execute(compiled.entryPoints.refs.batch, [ticks], CONTEXT);
    const elapsedMs = performance.now() - start;
    // The prototype target is ~400 ns/tick; 10 ms for 1000 ticks (~10 us/tick)
    // still leaves >20x headroom on a busy CI machine.
    expect(elapsedMs).toBeLessThan(10);
  });
});
