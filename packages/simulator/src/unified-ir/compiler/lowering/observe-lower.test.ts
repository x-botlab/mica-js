import { describe, expect, it } from 'vitest';
import { validateIR } from '@mica-js/ir';
import {
  DomainInstructionLowering,
  findDomainInstructions,
  LOWERED_DOMAIN_INSTRUCTIONS,
} from './index';
import {
  callTargets,
  compileCircuit,
  deliver,
  initialize,
  instrument,
  lampOf,
  opsOf,
  operandsOf,
  pinInputOf,
  reference,
  relayCircuit,
  terminatorsOf,
  tick,
} from './test-fixtures';

describe('observe lowering', () => {
  it('declares the lowered domain instructions', () => {
    expect(LOWERED_DOMAIN_INSTRUCTIONS).toEqual(['connection.apply', 'observe.configure']);
  });

  it('seeds the observer baseline in initialize and detects in the tick', () => {
    const compiled = compileCircuit(relayCircuit());
    expect(compiled.memory.observeBaselines).toBeDefined();
    expect(compiled.observers.totalObservers).toBe(1);
    expect(compiled.functions).toContain('k1_observe_control');

    // initialize: `observe_baselines[i] = PIN_INPUT[trigger]`
    const baselineStores = operandsOf(compiled, 'k1_initialize', 'array.store').filter((operands) =>
      operands.some((operand) => operand.ref === compiled.memory.observeBaselines),
    );
    expect(baselineStores).toHaveLength(1);

    // tick: XOR (edges: 'both') + branch + conditional handler call
    const tickOps = opsOf(compiled, 'unified_tick');
    expect(tickOps).toContain('bool.xor');
    expect(terminatorsOf(compiled, 'unified_tick')).toContain('branch');
    expect(callTargets(compiled, 'unified_tick')).toContain('k1_observe_control');

    const target = compiled.module.functions.find((fn) => fn.name === 'k1_observe_control');
    expect(target?.params).toEqual(['bool']);
  });

  it('switches the relay on both edges (ideal-relay)', () => {
    const compiled = compileCircuit(relayCircuit());
    const runtime = instrument(compiled);
    initialize(compiled, runtime);

    // The normally-closed pole conducts from t=0.
    expect(pinInputOf(compiled, runtime, 'ledNc.anode')).toBe(true);
    expect(pinInputOf(compiled, runtime, 'ledNo.anode')).toBe(false);

    tick(compiled, runtime);
    expect(lampOf(compiled, runtime, 'ledNc')).toBe(true);
    expect(lampOf(compiled, runtime, 'ledNo')).toBe(false);

    deliver(compiled, runtime, 'src1.level', [true]);
    tick(compiled, runtime, 2);
    expect(pinInputOf(compiled, runtime, 'ledNo.anode')).toBe(true);
    expect(pinInputOf(compiled, runtime, 'ledNc.anode')).toBe(false);
    expect(lampOf(compiled, runtime, 'ledNo')).toBe(true);
    expect(lampOf(compiled, runtime, 'ledNc')).toBe(false);

    deliver(compiled, runtime, 'src1.level', [false]);
    tick(compiled, runtime, 2);
    expect(lampOf(compiled, runtime, 'ledNo')).toBe(false);
    expect(lampOf(compiled, runtime, 'ledNc')).toBe(true);
  });

  it('only reacts to rising edges when the observer asks for them', () => {
    const compiled = compileCircuit(relayCircuit('rising'));
    const runtime = instrument(compiled);
    initialize(compiled, runtime);
    tick(compiled, runtime);

    deliver(compiled, runtime, 'src1.level', [true]);
    tick(compiled, runtime, 2);
    expect(lampOf(compiled, runtime, 'ledNo')).toBe(true);
    expect(lampOf(compiled, runtime, 'ledNc')).toBe(false);

    // Falling edge: no handler call, the contacts keep their state.
    deliver(compiled, runtime, 'src1.level', [false]);
    tick(compiled, runtime, 2);
    expect(lampOf(compiled, runtime, 'ledNo')).toBe(true);
    expect(lampOf(compiled, runtime, 'ledNc')).toBe(false);
  });

  it('lowers a disabled observation to nothing', () => {
    const compiled = compileCircuit(relayCircuit('both', false));
    expect(compiled.functions).not.toContain('k1_observe_control');
    const tickOps = opsOf(compiled, 'unified_tick');
    expect(tickOps).not.toContain('bool.xor');
    expect(terminatorsOf(compiled, 'unified_tick')).not.toContain('branch');
    expect(callTargets(compiled, 'unified_tick')).not.toContain('k1_observe_control');

    const runtime = instrument(compiled);
    initialize(compiled, runtime);
    tick(compiled, runtime);
    deliver(compiled, runtime, 'src1.level', [true]);
    tick(compiled, runtime, 2);

    // The relay never switches: the normally-closed pole stays on.
    expect(lampOf(compiled, runtime, 'ledNc')).toBe(true);
    expect(lampOf(compiled, runtime, 'ledNo')).toBe(false);
  });

  it('leaves no domain instruction in the module', () => {
    const compiled = compileCircuit(relayCircuit());
    expect(findDomainInstructions(compiled.module)).toEqual([]);
    expect(validateIR(compiled.module, compiled.validation).ok).toBe(true);
  });

  it('matches the reference engine on the JIT path', () => {
    const compiled = compileCircuit(relayCircuit());
    for (const runtime of [instrument(compiled), reference(compiled)]) {
      initialize(compiled, runtime);
      tick(compiled, runtime);
      deliver(compiled, runtime, 'src1.level', [true]);
      tick(compiled, runtime, 2);
      expect(lampOf(compiled, runtime, 'ledNo')).toBe(true);
      expect(lampOf(compiled, runtime, 'ledNc')).toBe(false);
    }
  });
});

describe('DomainInstructionLowering', () => {
  it('is exported with the pass contract', () => {
    expect(typeof DomainInstructionLowering).toBe('function');
    expect(typeof findDomainInstructions).toBe('function');
  });
});
