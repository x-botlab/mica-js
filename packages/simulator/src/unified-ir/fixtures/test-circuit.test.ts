import { describe, expect, it } from 'vitest';
import { validateIR } from '@mica-js/ir';
import { createUnifiedCircuit } from './test-circuit';
import { generateUnifiedIR, planUnifiedCircuit } from '../codegen';
import {
  devicePinId,
  LED_PIN,
  MAX_UNIFIED_DEVICES,
  MCU_PIN,
  createMcuLedCircuit,
  PIN_MODE,
  UNIFIED_PIN_CAPACITY,
  UnifiedCircuitError,
  type UnifiedCircuit,
  type UnifiedCircuitConfig,
  type UnifiedCircuitErrorCode,
} from '../types';

const CONTEXT = Object.freeze({ instanceId: 'unified-ir-test', virtualTime: 0 });

function expectCircuitError(run: () => unknown, code: UnifiedCircuitErrorCode): void {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(UnifiedCircuitError);
  expect((caught as UnifiedCircuitError).code).toBe(code);
}

function functionNames(config: UnifiedCircuitConfig): string[] {
  return generateUnifiedIR(config).module.functions.map((fn) => fn.name);
}

/** Call targets of one generated function, across its entry and all blocks. */
function callTargets(circuit: UnifiedCircuit, name: string): string[] {
  const definition = circuit.program.module.functions.find((fn) => fn.name === name);
  if (definition?.body === undefined) throw new Error(`Missing ${name} body`);
  const calls: string[] = [];
  // `body.blocks` already contains the entry block.
  for (const block of definition.body.blocks) {
    for (const instruction of block.instructions) {
      if (instruction.op !== 'call') continue;
      const operand = instruction.operands[0];
      if (operand === undefined || operand.kind !== 'static') {
        throw new Error('Expected a callee');
      }
      const target = circuit.program.module.functions.find((fn) => fn.ref === operand.ref);
      if (target === undefined) throw new Error('Call target is not a module function');
      calls.push(target.name);
    }
  }
  return calls;
}

/** Whole observable state of a circuit, for engine-equivalence checks. */
function snapshot(circuit: UnifiedCircuit, pins: readonly number[]): string {
  const levels = pins.map((pin) => `${pin}:${circuit.readPinInput(pin) ? 1 : 0}`);
  const outputs = pins.map((pin) => `${pin}:${circuit.readPinOutput(pin) ? 1 : 0}`);
  const modes = pins.map((pin) => `${pin}:${circuit.readPinMode(pin)}`);
  return `${circuit.ledOn('led')}|${levels.join(',')}|${outputs.join(',')}|${modes.join(',')}`;
}

describe('generateUnifiedIR', () => {
  it('plans the MCU + LED circuit onto the global pin space', () => {
    const layout = createMcuLedCircuit();
    expect(layout.mcuPa0).toBe(0);
    expect(layout.ledAnode).toBe(32);
    expect(layout.ledCathode).toBe(33);

    const plan = planUnifiedCircuit(layout.config);
    expect(plan.devices.map((device) => device.deviceId)).toEqual(['mcu', 'led']);
    expect(plan.nets.map((net) => net.netId)).toEqual([0, 1]);
    expect(plan.nets[0]?.drivers.map((pin) => pin.globalPinId)).toEqual([0]);
    expect(plan.nets[0]?.loads.map((pin) => pin.globalPinId)).toEqual([32]);
  });

  it('emits one module with a tick per device, a solver per net, and one main loop', () => {
    expect(functionNames(createMcuLedCircuit().config)).toEqual([
      'mcu_tick',
      'led_update',
      'solve_net_0',
      'solve_net_1',
      'unified_step',
      'unified_tick',
    ]);
  });

  it('allocates the shared pin, output, input, and lamp memories', () => {
    const program = generateUnifiedIR(createMcuLedCircuit().config);
    expect(program.module.memories.map((memory) => memory.name)).toEqual([
      'pin_mode',
      'pin_output',
      'pin_input',
      'led_state',
    ]);
    expect(program.module.memories.map((memory) => memory.layout)).toEqual([
      { kind: 'scalar', scalarType: 'u8', length: UNIFIED_PIN_CAPACITY },
      { kind: 'scalar', scalarType: 'bool', length: UNIFIED_PIN_CAPACITY },
      { kind: 'scalar', scalarType: 'bool', length: UNIFIED_PIN_CAPACITY },
      { kind: 'scalar', scalarType: 'bool', length: MAX_UNIFIED_DEVICES },
    ]);
  });

  it('produces IR that passes validateIR', () => {
    const program = generateUnifiedIR(createMcuLedCircuit().config);
    const result = validateIR(program.module, program.validation);
    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('calls the drives, then the nets, then the loads from the main entries', () => {
    const circuit = createUnifiedCircuit(createMcuLedCircuit().config);
    expect(callTargets(circuit, 'unified_step')).toEqual([
      'mcu_tick',
      'solve_net_0',
      'solve_net_1',
      'led_update',
    ]);
    // The batched entry repeats the same body inside a generated loop.
    expect(callTargets(circuit, 'unified_tick')).toEqual([
      'mcu_tick',
      'solve_net_0',
      'solve_net_1',
      'led_update',
    ]);
    const tick = circuit.program.module.functions.find((fn) => fn.name === 'unified_tick');
    expect(tick?.params).toEqual(['u32']);
    expect(tick?.body?.blocks).toHaveLength(4);
  });
});

describe('unified circuit behaviour', () => {
  it('toggles the MCU output and propagates it through the net into the LED', () => {
    const layout = createMcuLedCircuit();
    const circuit = createUnifiedCircuit(layout.config);

    expect(circuit.readPinMode(layout.mcuPa0)).toBe(PIN_MODE.highZ);
    expect(circuit.readPinOutput(layout.mcuPa0)).toBe(false);
    expect(circuit.readPinInput(layout.ledAnode)).toBe(false);
    expect(circuit.ledOn(layout.ledId)).toBe(false);

    circuit.tick();
    expect(circuit.ticks).toBe(1);
    expect(circuit.readPinOutput(layout.mcuPa0)).toBe(true);
    expect(circuit.readPinMode(layout.mcuPa0)).toBe(PIN_MODE.pushPull);
    expect(circuit.readPinInput(layout.ledAnode)).toBe(true);
    expect(circuit.ledOn(layout.ledId)).toBe(true);

    circuit.tick();
    expect(circuit.ticks).toBe(2);
    expect(circuit.readPinOutput(layout.mcuPa0)).toBe(false);
    expect(circuit.readPinInput(layout.ledAnode)).toBe(false);
    expect(circuit.ledOn(layout.ledId)).toBe(false);
  });

  it('keeps the grounded cathode low so the lamp follows the anode alone', () => {
    const layout = createMcuLedCircuit();
    const circuit = createUnifiedCircuit(layout.config);
    for (let step = 0; step < 5; step += 1) {
      circuit.tick();
      expect(circuit.readPinInput(layout.ledCathode)).toBe(false);
      expect(circuit.ledOn(layout.ledId)).toBe(circuit.readPinInput(layout.ledAnode));
    }
  });

  it('drives the net only while the driver is push-pull', () => {
    const layout = createMcuLedCircuit();
    const circuit = createUnifiedCircuit(layout.config);

    // One tick leaves PA0 high and push-pull, so the anode is driven high.
    circuit.tick();
    expect(circuit.readPinInput(layout.ledAnode)).toBe(true);

    // Force high-z behind the device's back and re-solve the net alone.
    circuit.writePinMode(layout.mcuPa0, PIN_MODE.highZ);
    circuit.runtime.execute(circuit.program.nets[0]!.solve, [], CONTEXT);
    expect(circuit.readPinInput(layout.ledAnode)).toBe(false);

    // ... and the next full tick toggles PA0 low again, so the drive follows.
    circuit.tick();
    expect(circuit.readPinOutput(layout.mcuPa0)).toBe(false);
    expect(circuit.readPinInput(layout.ledAnode)).toBe(false);
  });

  it('honours a hand-solved net without running any device', () => {
    const layout = createMcuLedCircuit();
    const circuit = createUnifiedCircuit(layout.config);
    circuit.writePinMode(layout.mcuPa0, PIN_MODE.pushPull);
    circuit.runtime.execute(circuit.program.nets[0]!.solve, [], CONTEXT);
    expect(circuit.readPinInput(layout.ledAnode)).toBe(false);
    expect(circuit.ledOn(layout.ledId)).toBe(false);
  });

  it('runs batches through run()', () => {
    const circuit = createUnifiedCircuit(createMcuLedCircuit().config);
    circuit.run(3);
    expect(circuit.ticks).toBe(3);
    expect(circuit.ledOn('led')).toBe(true);
    circuit.run(1);
    expect(circuit.ticks).toBe(4);
    expect(circuit.ledOn('led')).toBe(false);
  });

  it('matches the reference interpreter tick for tick', () => {
    const layout = createMcuLedCircuit();
    const jit = createUnifiedCircuit(layout.config);
    const reference = createUnifiedCircuit(layout.config, { engine: 'reference' });
    const pins = [layout.mcuPa0, layout.ledAnode, layout.ledCathode];
    for (let step = 0; step < 10; step += 1) {
      jit.tick();
      reference.tick();
      expect(snapshot(jit, pins)).toBe(snapshot(reference, pins));
    }
  });

  it('hosts several device pairs in one module', () => {
    const first = createMcuLedCircuit();
    const second = createMcuLedCircuit({
      mcuId: 'mcu-2',
      ledId: 'led-2',
      mcuPinOffset: 64,
      ledPinOffset: 96,
    });
    const config: UnifiedCircuitConfig = {
      devices: [...first.config.devices, ...second.config.devices],
      netlist: {
        nets: [
          ...first.config.netlist.nets,
          ...second.config.netlist.nets.map((net) => ({ ...net, netId: net.netId + 2 })),
        ],
      },
    };
    const program = generateUnifiedIR(config);
    expect(validateIR(program.module, program.validation).ok).toBe(true);
    expect(program.mcus).toHaveLength(2);
    expect(program.leds).toHaveLength(2);

    const circuit = createUnifiedCircuit(config);
    circuit.tick();
    expect(circuit.ledOn('led')).toBe(true);
    expect(circuit.ledOn('led-2')).toBe(true);
    circuit.tick();
    expect(circuit.ledOn('led')).toBe(false);
    expect(circuit.ledOn('led-2')).toBe(false);
  });

  it('resolves pin addresses through pinOf()', () => {
    const circuit = createUnifiedCircuit(createMcuLedCircuit().config);
    expect(circuit.pinOf('mcu', 'PA0')).toBe(0);
    expect(circuit.pinOf('led', 'anode')).toBe(32);
    expect(circuit.pinOf('led', 'cathode')).toBe(33);
    expect(devicePinId({ deviceId: 'x', type: 'mcu', pinOffset: 64 }, 'PA0')).toBe(64);
    expect(MCU_PIN.PA0).toBe(0);
    expect(LED_PIN.anode).toBe(0);
  });
});

describe('unified circuit validation', () => {
  const layout = createMcuLedCircuit();

  it('rejects a missing or empty device list', () => {
    expectCircuitError(
      () => generateUnifiedIR({ devices: [], netlist: { nets: [] } }),
      'unified-invalid-config',
    );
    expectCircuitError(
      () => generateUnifiedIR({ netlist: { nets: [] } } as unknown as UnifiedCircuitConfig),
      'unified-invalid-config',
    );
  });

  it('rejects more devices than the pin space holds', () => {
    const devices = Array.from({ length: MAX_UNIFIED_DEVICES + 1 }, (_, index) => ({
      deviceId: `mcu-${index}`,
      type: 'mcu' as const,
      pinOffset: index * 32,
    }));
    expectCircuitError(
      () => generateUnifiedIR({ devices, netlist: { nets: [] } }),
      'unified-invalid-config',
    );
  });

  it('rejects duplicate device ids', () => {
    expectCircuitError(
      () =>
        generateUnifiedIR({
          devices: [
            { deviceId: 'mcu', type: 'mcu', pinOffset: 0 },
            { deviceId: 'mcu', type: 'led', pinOffset: 32 },
          ],
          netlist: { nets: [] },
        }),
      'unified-duplicate-device',
    );
  });

  it('rejects pin offsets that are unaligned, overlapping, or outside the pin space', () => {
    expectCircuitError(
      () =>
        generateUnifiedIR({
          devices: [{ deviceId: 'mcu', type: 'mcu', pinOffset: 16 }],
          netlist: { nets: [] },
        }),
      'unified-invalid-pin',
    );
    expectCircuitError(
      () =>
        generateUnifiedIR({
          devices: [
            { deviceId: 'a', type: 'mcu', pinOffset: 0 },
            { deviceId: 'b', type: 'mcu', pinOffset: 0 },
          ],
          netlist: { nets: [] },
        }),
      'unified-invalid-pin',
    );
    expectCircuitError(
      () =>
        generateUnifiedIR({
          devices: [{ deviceId: 'mcu', type: 'mcu', pinOffset: UNIFIED_PIN_CAPACITY }],
          netlist: { nets: [] },
        }),
      'unified-invalid-pin',
    );
  });

  it('rejects an unsupported device type', () => {
    expectCircuitError(
      () =>
        generateUnifiedIR({
          devices: [{ deviceId: 'x', type: 'resistor', pinOffset: 0 } as never],
          netlist: { nets: [] },
        }),
      'unified-invalid-config',
    );
  });

  it('rejects a net that names an unknown device or pin', () => {
    expectCircuitError(
      () =>
        generateUnifiedIR({
          ...layout.config,
          netlist: {
            nets: [
              {
                netId: 7,
                connections: [
                  { deviceId: 'ghost', pinName: 'PA0', globalPinId: 0, role: 'driver' },
                ],
              },
            ],
          },
        }),
      'unified-unknown-device',
    );
    expectCircuitError(
      () =>
        generateUnifiedIR({
          ...layout.config,
          netlist: {
            nets: [
              {
                netId: 7,
                connections: [{ deviceId: 'mcu', pinName: 'PA1', globalPinId: 0, role: 'driver' }],
              },
            ],
          },
        }),
      'unified-invalid-connection',
    );
  });

  it('rejects a netlist that disagrees with the device pin layout', () => {
    expectCircuitError(
      () =>
        generateUnifiedIR({
          ...layout.config,
          netlist: {
            nets: [
              {
                netId: 7,
                connections: [{ deviceId: 'mcu', pinName: 'PA0', globalPinId: 5, role: 'driver' }],
              },
            ],
          },
        }),
      'unified-invalid-connection',
    );
  });

  it('rejects a pin wired into two nets', () => {
    expectCircuitError(
      () =>
        generateUnifiedIR({
          ...layout.config,
          netlist: {
            nets: [
              ...layout.config.netlist.nets,
              {
                netId: 9,
                connections: [{ deviceId: 'led', pinName: 'anode', globalPinId: 32, role: 'load' }],
              },
            ],
          },
        }),
      'unified-invalid-connection',
    );
  });

  it('rejects duplicate net ids and empty nets', () => {
    expectCircuitError(
      () =>
        generateUnifiedIR({
          ...layout.config,
          netlist: { nets: [layout.config.netlist.nets[0]!, layout.config.netlist.nets[0]!] },
        }),
      'unified-duplicate-net',
    );
    expectCircuitError(
      () =>
        generateUnifiedIR({ ...layout.config, netlist: { nets: [{ netId: 3, connections: [] }] } }),
      'unified-invalid-config',
    );
  });

  it('rejects device ids that collide with a generated function name', () => {
    expectCircuitError(
      () =>
        generateUnifiedIR({
          devices: [
            { deviceId: 'unified', type: 'mcu', pinOffset: 0 },
            { deviceId: 'led', type: 'led', pinOffset: 32 },
          ],
          netlist: {
            nets: [
              {
                netId: 0,
                connections: [{ deviceId: 'led', pinName: 'anode', globalPinId: 32, role: 'load' }],
              },
            ],
          },
        }),
      'unified-invalid-config',
    );
  });
});

describe('unified circuit host API', () => {
  it('reports invalid pins, unknown devices, unknown pins, and bad options', () => {
    const circuit = createUnifiedCircuit(createMcuLedCircuit().config);
    expectCircuitError(() => circuit.readPinMode(UNIFIED_PIN_CAPACITY), 'unified-invalid-pin');
    expectCircuitError(() => circuit.readPinInput(-1), 'unified-invalid-pin');
    expectCircuitError(() => circuit.ledOn('nope'), 'unified-unknown-device');
    expectCircuitError(() => circuit.pinOf('nope', 'PA0'), 'unified-unknown-device');
    expectCircuitError(() => circuit.pinOf('led', 'grid'), 'unified-invalid-connection');
    expectCircuitError(() => circuit.run(-1), 'unified-invalid-config');
    expectCircuitError(
      () => createUnifiedCircuit(createMcuLedCircuit().config, { engine: 'vm' as never }),
      'unified-invalid-config',
    );
    expectCircuitError(
      () => createUnifiedCircuit(createMcuLedCircuit().config, { tierUpThreshold: -1 }),
      'unified-invalid-config',
    );
  });

  it('accepts a caller-supplied validation factory', () => {
    const circuit = createUnifiedCircuit(createMcuLedCircuit().config, {
      validation: (program) => program.validation,
    });
    circuit.tick();
    expect(circuit.ledOn('led')).toBe(true);
  });
});

describe('unified circuit performance', () => {
  const now = (): number => {
    const perf = (globalThis as { performance?: { now(): number } }).performance;
    return perf === undefined ? Date.now() : perf.now();
  };

  it('meets the per-tick latency and throughput targets', () => {
    const circuit = createUnifiedCircuit(createMcuLedCircuit().config);
    circuit.run(100_000);

    const ticks = 1_000_000;
    const started = now();
    circuit.run(ticks);
    const elapsedMs = now() - started;
    const nsPerTick = (elapsedMs * 1_000_000) / ticks;
    const ticksPerSecond = ticks / (elapsedMs / 1_000);

    expect(nsPerTick).toBeLessThan(200);
    expect(ticksPerSecond).toBeGreaterThan(5_000_000);
    expect(circuit.ticks).toBe(100_000 + ticks);
  });

  it('keeps the host-driven single tick far below the scheduler architecture', () => {
    const circuit = createUnifiedCircuit(createMcuLedCircuit().config);
    circuit.run(1_000);

    const ticks = 20_000;
    const started = now();
    for (let index = 0; index < ticks; index += 1) circuit.tick();
    const nsPerTick = ((now() - started) * 1_000_000) / ticks;

    // One host entry per tick still pays the engine's per-call fee; the
    // scheduler architecture pays that fee once per device per tick and adds
    // the event queue on top, which measures ~8.5 us per tick (see the bench).
    expect(nsPerTick).toBeLessThan(2_000);
  });
});
