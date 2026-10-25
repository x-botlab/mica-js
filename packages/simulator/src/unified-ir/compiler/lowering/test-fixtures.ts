import { createIRJIT, createIRInterpreter } from '@mica-js/ir';
import type {
  FunctionBodyDefinition,
  FunctionDefinition,
  IRExecutionContext,
  IRInterpreter,
  Value,
} from '@mica-js/ir';
import { PIN_MODE } from '../../pin-space';
import {
  compileCircuit,
  createLedDescription,
  type CircuitCompilationInput,
  type CompiledCircuit,
  type DeviceConfig,
  type DeviceDescription,
} from '../index';

/** Context every test engine call shares. */
export const CONTEXT: IRExecutionContext = Object.freeze({
  instanceId: 'unified-ir-lowering-test',
  virtualTime: 0,
});

export function instrument(compiled: CompiledCircuit): IRInterpreter {
  return createIRJIT(compiled.module, {
    validation: compiled.validation,
    maxSteps: Number.MAX_SAFE_INTEGER,
    jit: { tierUpThreshold: 0 },
  });
}

export function reference(compiled: CompiledCircuit): IRInterpreter {
  return createIRInterpreter(compiled.module, {
    validation: compiled.validation,
    maxSteps: Number.MAX_SAFE_INTEGER,
  });
}

export function initialize(compiled: CompiledCircuit, runtime: IRInterpreter): void {
  runtime.execute(compiled.entryPoints.refs.initialize, [], CONTEXT);
}

export function tick(compiled: CompiledCircuit, runtime: IRInterpreter, count = 1): void {
  for (let index = 0; index < count; index += 1) {
    runtime.execute(compiled.entryPoints.refs.tick, [], CONTEXT);
  }
}

/** Calls one topic entry directly, as the runtime would on delivery. */
export function deliver(
  compiled: CompiledCircuit,
  runtime: IRInterpreter,
  key: string,
  values: readonly (boolean | number)[],
): void {
  const entry = compiled.topics.byKey.get(key)?.entry;
  if (entry === undefined) throw new Error(`Topic "${key}" is not an input port`);
  runtime.execute(entry, values, CONTEXT);
}

export function pinInputOf(
  compiled: CompiledCircuit,
  runtime: IRInterpreter,
  endpoint: string,
): boolean {
  return runtime.storage.loadArray(compiled.memory.input, globalPin(compiled, endpoint)) === true;
}

export function pinOutputOf(
  compiled: CompiledCircuit,
  runtime: IRInterpreter,
  endpoint: string,
): boolean {
  return runtime.storage.loadArray(compiled.memory.output, globalPin(compiled, endpoint)) === true;
}

function globalPin(compiled: CompiledCircuit, endpoint: string): number {
  const pin = compiled.pinMap.get(endpoint);
  if (pin === undefined) throw new Error(`Unknown pin ${endpoint}`);
  return pin;
}

export function lampOf(
  compiled: CompiledCircuit,
  runtime: IRInterpreter,
  deviceId: string,
): boolean {
  const slot = compiled.deviceMap.get(deviceId)?.states.get('lamp');
  if (slot === undefined) throw new Error(`Device "${deviceId}" has no lamp state`);
  return runtime.storage.loadArray(slot.array, slot.index) === true;
}

export function connectionStateOf(
  compiled: CompiledCircuit,
  runtime: IRInterpreter,
  deviceId: string,
  name: string,
): boolean {
  const slot = compiled.connections.devices.get(deviceId)?.get(name);
  const array = compiled.memory.connectionStates;
  if (slot === undefined || array === undefined) {
    throw new Error(`Device "${deviceId}" has no connection "${name}"`);
  }
  return runtime.storage.loadArray(array, slot.index) === true;
}

type FunctionDefinitionWithBody = FunctionDefinition & { readonly body: FunctionBodyDefinition };

export function definitionOf(compiled: CompiledCircuit, name: string): FunctionDefinitionWithBody {
  const definition = compiled.module.functions.find((fn) => fn.name === name);
  if (definition?.body === undefined) throw new Error(`Missing function body: ${name}`);
  return definition as FunctionDefinitionWithBody;
}

export function opsOf(compiled: CompiledCircuit, name: string): string[] {
  const ops: string[] = [];
  for (const block of definitionOf(compiled, name).body.blocks) {
    for (const instruction of block.instructions) ops.push(instruction.op);
  }
  return ops;
}

/** Terminator kinds of one generated function, blocks in definition order. */
export function terminatorsOf(compiled: CompiledCircuit, name: string): string[] {
  return definitionOf(compiled, name).body.blocks.flatMap((block) =>
    block.terminator === undefined ? [] : [block.terminator.kind],
  );
}

/** Every static operand ref of one op in one function, in definition order. */
export function operandsOf(
  compiled: CompiledCircuit,
  name: string,
  op: string,
): { readonly index: number; readonly ref: unknown }[][] {
  const found: { readonly index: number; readonly ref: unknown }[][] = [];
  for (const block of definitionOf(compiled, name).body.blocks) {
    for (const instruction of block.instructions) {
      if (instruction.op !== op) continue;
      found.push(
        instruction.operands.flatMap((operand, index) =>
          operand.kind === 'static' ? [{ index, ref: operand.ref }] : [],
        ),
      );
    }
  }
  return found;
}

export function callTargets(compiled: CompiledCircuit, name: string): string[] {
  const calls: string[] = [];
  for (const block of definitionOf(compiled, name).body.blocks) {
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

/**
 * Push button mirroring `packages/device/examples/ideal-button`: a passive
 * contact between `A` and `B`, driven only by the `pressed` topic.
 */
export function buttonDescription(): DeviceDescription {
  return {
    name: 'ideal-button',
    pins: {
      A: { direction: 'passive' },
      B: { direction: 'passive' },
    },
    connections: {
      contact: { pins: ['A', 'B'], initial: 'open' },
    },
    ports: {
      pressed: { direction: 'input', type: 'boolean' },
    },
    behaviors: {
      initialize: (api) => {
        api.connection.apply([{ connection: 'contact', closed: false }]);
        api.topics.subscribe('pressed', (handler) => {
          handler.connection.apply([
            { connection: 'contact', closed: handler.args[0] as Value<'bool'> },
          ]);
        });
      },
    },
  };
}

/**
 * SPDT relay mirroring `packages/device/examples/ideal-relay`: the `IN` edge is
 * captured by an observation and both contacts switch in one patch.
 */
export function relayDescription(
  edges: 'rising' | 'falling' | 'both' = 'both',
  enabled = true,
): DeviceDescription {
  return {
    name: 'ideal-relay',
    pins: {
      IN: { direction: 'input' },
      COM: { direction: 'passive' },
      NO: { direction: 'passive' },
      NC: { direction: 'passive' },
    },
    connections: {
      normallyOpen: { pins: ['COM', 'NO'], initial: 'open' },
      normallyClosed: { pins: ['COM', 'NC'], initial: 'closed' },
    },
    observers: {
      control: { trigger: 'IN', captures: ['IN'], edges },
    },
    behaviors: {
      initialize: (api) => {
        api.pin('IN').configure(PIN_MODE.highZ);
        api.observe.configure('control', {
          enabled,
          handler: (handler, captured) => {
            const level = captured[0];
            if (level === undefined) return;
            handler.connection.set('normallyOpen', level);
            handler.connection.set('normallyClosed', handler.builder.bool.not(level));
          },
        });
      },
    },
  };
}

/**
 * Relay whose `initialize` opens the initially-closed pole with a constant.
 * Regression: the constant must also reset `connection_states`, or the next
 * tick's switch-aware solve would close it again.
 */
export function resetRelayDescription(): DeviceDescription {
  return {
    name: 'reset-relay',
    pins: {
      COM: { direction: 'passive' },
      NO: { direction: 'passive' },
      NC: { direction: 'passive' },
    },
    connections: {
      normallyOpen: { pins: ['COM', 'NO'], initial: 'open' },
      normallyClosed: { pins: ['COM', 'NC'], initial: 'closed' },
    },
    behaviors: {
      initialize: (api) => {
        api.connection.set('normallyClosed', false);
      },
    },
  };
}

/**
 * Single usually-closed contact whose `initialize` opens it with a constant.
 * Regression: the initialize tail must not replay the declared `closed`.
 */
export function normallyClosedContactDescription(): DeviceDescription {
  return {
    name: 'nc-contact',
    pins: {
      A: { direction: 'passive' },
      B: { direction: 'passive' },
    },
    connections: {
      contact: { pins: ['A', 'B'], initial: 'closed' },
    },
    behaviors: {
      initialize: (api) => {
        api.connection.set('contact', false);
      },
    },
  };
}

/** `sw1.A -> VCC`, `sw1.B -> led1.anode`, `led1.cathode -> GND`. */
export function normallyClosedContactCircuit(): CircuitCompilationInput {
  return {
    devices: [device('sw1', normallyClosedContactDescription()), led()],
    connections: [
      { from: 'sw1.A', to: 'VCC' },
      { from: 'sw1.B', to: 'led1.anode' },
      { from: 'led1.cathode', to: 'GND' },
    ],
  };
}

/** `COM -> VCC`, `NO -> ledNo.anode`, `NC -> ledNc.anode`. */
export function resetRelayCircuit(): CircuitCompilationInput {
  return {
    devices: [device('k1', resetRelayDescription()), led('ledNo'), led('ledNc')],
    connections: [
      { from: 'k1.COM', to: 'VCC' },
      { from: 'k1.NO', to: 'ledNo.anode' },
      { from: 'ledNo.cathode', to: 'GND' },
      { from: 'k1.NC', to: 'ledNc.anode' },
      { from: 'ledNc.cathode', to: 'GND' },
    ],
  };
}

/** SPDT pair with no observation: one topic applies both poles at once. */
export function pairDescription(): DeviceDescription {
  return {
    name: 'spdt-pair',
    pins: {
      COM: { direction: 'passive' },
      NO: { direction: 'passive' },
      NC: { direction: 'passive' },
    },
    connections: {
      normallyOpen: { pins: ['COM', 'NO'], initial: 'open' },
      normallyClosed: { pins: ['COM', 'NC'], initial: 'open' },
    },
    ports: {
      select: { direction: 'input', type: 'boolean' },
    },
    behaviors: {
      initialize: (api) => {
        api.topics.subscribe('select', (handler) => {
          const level = handler.args[0] as Value<'bool'>;
          handler.connection.apply([
            { connection: 'normallyOpen', closed: level },
            { connection: 'normallyClosed', closed: handler.builder.bool.not(level) },
          ]);
        });
      },
    },
  };
}

/** Host-controlled digital source: the `level` topic drives `OUT`. */
export function sourceDescription(): DeviceDescription {
  return {
    name: 'logic-source',
    pins: { OUT: { direction: 'output' } },
    ports: { level: { direction: 'input', type: 'boolean' } },
    behaviors: {
      initialize: (api) => {
        api.pin('OUT').configure(PIN_MODE.pushPull);
        api.topics.subscribe('level', (handler) => {
          handler.pin('OUT').writeDigital(handler.args[0] as Value<'bool'>);
        });
      },
    },
  };
}

export function led(id = 'led1'): DeviceConfig {
  return { id, type: 'ideal-led', description: createLedDescription() };
}

export function device(id: string, description: DeviceDescription): DeviceConfig {
  return { id, type: description.name ?? id, description };
}

/** `sw1.A -> VCC`, `sw1.B -> led1.anode`, `led1.cathode -> GND`. */
export function buttonCircuit(): CircuitCompilationInput {
  return {
    devices: [device('sw1', buttonDescription()), led()],
    connections: [
      { from: 'sw1.A', to: 'VCC' },
      { from: 'sw1.B', to: 'led1.anode' },
      { from: 'led1.cathode', to: 'GND' },
    ],
  };
}

/**
 * Relay with `COM -> VCC` and one LED on each pole:
 *
 * ```text
 * src1.OUT -> k1.IN
 * k1.COM   -> VCC          k1.NO -> ledNo.anode   ledNo.cathode -> GND
 *                          k1.NC -> ledNc.anode   ledNc.cathode -> GND
 * ```
 */
export function relayCircuit(
  edges: 'rising' | 'falling' | 'both' = 'both',
  enabled = true,
): CircuitCompilationInput {
  return {
    devices: [
      device('k1', relayDescription(edges, enabled)),
      device('src1', sourceDescription()),
      led('ledNo'),
      led('ledNc'),
    ],
    connections: [
      { from: 'src1.OUT', to: 'k1.IN' },
      { from: 'k1.COM', to: 'VCC' },
      { from: 'k1.NO', to: 'ledNo.anode' },
      { from: 'ledNo.cathode', to: 'GND' },
      { from: 'k1.NC', to: 'ledNc.anode' },
      { from: 'ledNc.cathode', to: 'GND' },
    ],
  };
}

/** Both poles wired to their own LED, applied from the `select` topic. */
export function pairCircuit(): CircuitCompilationInput {
  return {
    devices: [device('spdt1', pairDescription()), led('ledNo'), led('ledNc')],
    connections: [
      { from: 'spdt1.COM', to: 'VCC' },
      { from: 'spdt1.NO', to: 'ledNo.anode' },
      { from: 'ledNo.cathode', to: 'GND' },
      { from: 'spdt1.NC', to: 'ledNc.anode' },
      { from: 'ledNc.cathode', to: 'GND' },
    ],
  };
}

export { compileCircuit };
