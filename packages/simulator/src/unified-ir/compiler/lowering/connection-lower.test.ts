import { describe, expect, it } from 'vitest';
import { validateIR } from '@mica-js/ir';
import {
  buttonCircuit,
  callTargets,
  compileCircuit,
  connectionStateOf,
  deliver,
  initialize,
  instrument,
  lampOf,
  normallyClosedContactCircuit,
  opsOf,
  operandsOf,
  pairCircuit,
  pinInputOf,
  reference,
  relayCircuit,
  resetRelayCircuit,
  tick,
} from './test-fixtures';

describe('connection lowering', () => {
  it('seeds connection_states from the declared initial level', () => {
    const compiled = compileCircuit(relayCircuit());
    expect(compiled.memory.connectionStates).toBeDefined();
    expect(compiled.connections.totalConnections).toBe(2);

    const runtime = instrument(compiled);
    initialize(compiled, runtime);
    expect(connectionStateOf(compiled, runtime, 'k1', 'normallyOpen')).toBe(false);
    expect(connectionStateOf(compiled, runtime, 'k1', 'normallyClosed')).toBe(true);
  });

  it('emits a valid module with a group solver for the two relay poles', () => {
    const compiled = compileCircuit(relayCircuit());
    expect(validateIR(compiled.module, compiled.validation).ok).toBe(true);
    expect(compiled.functions).toContain('solve_connections_0');
    expect(callTargets(compiled, 'unified_initialize')).toContain('solve_connections_0');
  });

  it('eliminates a constant patch statically: no state read, no select', () => {
    const compiled = compileCircuit(buttonCircuit());
    const ops = opsOf(compiled, 'sw1_initialize');
    expect(ops).toContain('array.store');
    expect(ops).not.toContain('select');

    const stateReads = operandsOf(compiled, 'sw1_initialize', 'array.load').filter((operands) =>
      operands.some((operand) => operand.ref === compiled.memory.connectionStates),
    );
    expect(stateReads).toEqual([]);
  });

  it('lowers a dynamic patch to a state store plus a select', () => {
    const compiled = compileCircuit(buttonCircuit());
    const ops = opsOf(compiled, 'sw1_pressed');
    expect(ops).toContain('select');

    const stateStores = operandsOf(compiled, 'sw1_pressed', 'array.store').filter((operands) =>
      operands.some((operand) => operand.ref === compiled.memory.connectionStates),
    );
    expect(stateStores).toHaveLength(1);
  });

  it('propagates a closed contact to the load across ticks (ideal-button)', () => {
    const compiled = compileCircuit(buttonCircuit());
    const runtime = instrument(compiled);
    initialize(compiled, runtime);
    tick(compiled, runtime);

    expect(lampOf(compiled, runtime, 'led1')).toBe(false);
    expect(pinInputOf(compiled, runtime, 'led1.anode')).toBe(false);

    deliver(compiled, runtime, 'sw1.pressed', [true]);
    // The patch takes effect immediately, before the next solve.
    expect(pinInputOf(compiled, runtime, 'led1.anode')).toBe(true);
    expect(connectionStateOf(compiled, runtime, 'sw1', 'contact')).toBe(true);

    tick(compiled, runtime);
    expect(pinInputOf(compiled, runtime, 'led1.anode')).toBe(true);
    expect(lampOf(compiled, runtime, 'led1')).toBe(true);

    deliver(compiled, runtime, 'sw1.pressed', [false]);
    tick(compiled, runtime);
    expect(pinInputOf(compiled, runtime, 'led1.anode')).toBe(false);
    expect(lampOf(compiled, runtime, 'led1')).toBe(false);
  });

  it('keeps a closed switch closed through the electrical solve', () => {
    const compiled = compileCircuit(buttonCircuit());
    const runtime = instrument(compiled);
    initialize(compiled, runtime);
    deliver(compiled, runtime, 'sw1.pressed', [true]);

    // Ten solves must not reset the merged net back to its open level.
    tick(compiled, runtime, 10);
    expect(pinInputOf(compiled, runtime, 'led1.anode')).toBe(true);
    expect(lampOf(compiled, runtime, 'led1')).toBe(true);
  });

  it('compiles a two-pole patch into one group solver call', () => {
    const compiled = compileCircuit(pairCircuit());
    expect(compiled.functions).toContain('solve_connections_0');

    const calls = callTargets(compiled, 'spdt1_select');
    expect(calls.filter((name) => name.startsWith('solve_connections_'))).toEqual([
      'solve_connections_0',
    ]);

    const stateStores = operandsOf(compiled, 'spdt1_select', 'array.store').filter((operands) =>
      operands.some((operand) => operand.ref === compiled.memory.connectionStates),
    );
    expect(stateStores).toHaveLength(2);
  });

  it('switches both poles atomically and re-solves them together', () => {
    const compiled = compileCircuit(pairCircuit());
    const runtime = instrument(compiled);
    initialize(compiled, runtime);
    tick(compiled, runtime);

    expect(lampOf(compiled, runtime, 'ledNo')).toBe(false);
    expect(lampOf(compiled, runtime, 'ledNc')).toBe(false);

    deliver(compiled, runtime, 'spdt1.select', [true]);
    tick(compiled, runtime, 2);
    expect(lampOf(compiled, runtime, 'ledNo')).toBe(true);
    expect(lampOf(compiled, runtime, 'ledNc')).toBe(false);

    deliver(compiled, runtime, 'spdt1.select', [false]);
    tick(compiled, runtime, 2);
    expect(lampOf(compiled, runtime, 'ledNo')).toBe(false);
    expect(lampOf(compiled, runtime, 'ledNc')).toBe(true);
  });

  it('clears an initially-closed switch with a constant patch', () => {
    const compiled = compileCircuit(resetRelayCircuit());
    const runtime = instrument(compiled);
    initialize(compiled, runtime);
    expect(connectionStateOf(compiled, runtime, 'k1', 'normallyClosed')).toBe(false);

    tick(compiled, runtime, 3);
    expect(connectionStateOf(compiled, runtime, 'k1', 'normallyClosed')).toBe(false);
    expect(pinInputOf(compiled, runtime, 'ledNc.anode')).toBe(false);
    expect(lampOf(compiled, runtime, 'ledNc')).toBe(false);
  });

  it('does not replay a declared closed state over a constant open patch', () => {
    const compiled = compileCircuit(normallyClosedContactCircuit());
    const runtime = instrument(compiled);
    initialize(compiled, runtime);
    expect(connectionStateOf(compiled, runtime, 'sw1', 'contact')).toBe(false);
    expect(pinInputOf(compiled, runtime, 'led1.anode')).toBe(false);

    tick(compiled, runtime, 3);
    expect(connectionStateOf(compiled, runtime, 'sw1', 'contact')).toBe(false);
    expect(lampOf(compiled, runtime, 'led1')).toBe(false);
  });

  it('matches the reference engine on the JIT path', () => {
    const compiled = compileCircuit(buttonCircuit());
    const jit = instrument(compiled);
    const interpreter = reference(compiled);
    for (const runtime of [jit, interpreter]) {
      initialize(compiled, runtime);
      deliver(compiled, runtime, 'sw1.pressed', [true]);
      tick(compiled, runtime);
      expect(lampOf(compiled, runtime, 'led1')).toBe(true);
      deliver(compiled, runtime, 'sw1.pressed', [false]);
      tick(compiled, runtime);
      expect(lampOf(compiled, runtime, 'led1')).toBe(false);
    }
  });
});
