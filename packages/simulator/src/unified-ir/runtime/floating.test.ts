import { createIRJIT } from '@mica-js/ir';
import { describe, expect, it } from 'vitest';
import type { CircuitCompilationInput, DeviceDescription } from '../compiler';
import { compileCircuit } from '../compiler';
import { Circuit } from './circuit';
import { FLOATING_ALGORITHM, hashFloatingState, hashTopology, sampleFloating } from './floating';

/**
 * RFC 0002 §4.5 — `mica-floating-v2` floating-node sampling.
 *
 * A net with no strong driver, no weak bias and no rail has no source, so the
 * boolean model samples a deterministic pseudo-random level instead of reading
 * a constant. The tests pin the three guarantees the RFC asks for:
 *
 * - the same circuit at the same time always reads the same level (`reset()`
 *   reproduces a run exactly);
 * - the level walks a pseudo-random sequence as time advances;
 * - the seed — and therefore the sequence — is a property of the topology.
 */

/** Picoseconds per circuit tick; mirrors `TICK_PS` in the runtime. */
const TICK_PS = 1_000_000;

/** A pin that only senses: a net of two of these has no source at all. */
function passivePin(): DeviceDescription {
  return {
    pins: { io: { direction: 'passive' } },
    behaviors: { initialize: () => {} },
  };
}

/** A pin that senses and applies a weak bias (`pin.pull`). */
function biasedPin(pull: 'none' | 'up' | 'down'): DeviceDescription {
  return {
    pins: { io: { direction: 'passive' } },
    behaviors: {
      initialize: (api) => {
        api.pin('io').pull(pull);
      },
    },
  };
}

/** Two passive pins on one net; nothing can hold it. */
function floatingCircuit(): CircuitCompilationInput {
  return {
    devices: [
      { id: 'a1', type: 'test-passive', description: passivePin() },
      { id: 'a2', type: 'test-passive', description: passivePin() },
    ],
    connections: [{ from: 'a1.io', to: 'a2.io' }],
  };
}

/** Two passive pins on one net, one of them biased with `pull`. */
function biasedCircuit(pull: 'none' | 'up' | 'down'): CircuitCompilationInput {
  return {
    devices: [
      { id: 'a1', type: 'test-passive', description: biasedPin(pull) },
      { id: 'a2', type: 'test-passive', description: passivePin() },
    ],
    connections: [{ from: 'a1.io', to: 'a2.io' }],
  };
}

/** Reads the level of the floating net once per tick. */
function trace(circuit: Circuit, ticks: number): boolean[] {
  const levels: boolean[] = [];
  for (let tick = 0; tick < ticks; tick += 1) {
    circuit.step();
    levels.push(circuit.getPin('a1.io'));
  }
  return levels;
}

describe('mica-floating-v2 sampling function', () => {
  it('names the algorithm it implements', () => {
    expect(FLOATING_ALGORITHM).toBe('mica-floating-v2');
  });

  it('is a pure function of (netId, time, seed)', () => {
    const sample = hashFloatingState(3, 1_000_000, 12345);
    expect(hashFloatingState(3, 1_000_000, 12345)).toBe(sample);
    expect(sampleFloating(3, 1_000_000, 12345)).toBe(sampleFloating(3, 1_000_000, 12345));
  });

  it('keeps every net independent', () => {
    const first = [0, 1, 2, 3].map((time) => sampleFloating(0, time * TICK_PS, 12345));
    const second = [0, 1, 2, 3].map((time) => sampleFloating(1, time * TICK_PS, 12345));
    expect(first).not.toEqual(second);
  });

  it('reports the settled low level at the reset point', () => {
    expect(sampleFloating(0, 0, 12345)).toBe(false);
    expect(sampleFloating(7, 0, 0xffffffff)).toBe(false);
  });

  it('walks a pseudo-random sequence as time advances', () => {
    const levels = Array.from({ length: 256 }, (_, time) =>
      sampleFloating(0, time * TICK_PS, 12345),
    );
    expect(new Set(levels).size).toBe(2);
    // A constant sequence would make this test meaningless.
    expect(levels.filter((level) => level).length).toBeGreaterThan(64);
    expect(levels.filter((level) => !level).length).toBeGreaterThan(64);
  });

  it('uses both halves of the 64-bit time', () => {
    const time = 0x1234_5678;
    expect(sampleFloating(0, time + 0x1_0000_0000, 99)).not.toBe(sampleFloating(0, time, 99));
  });

  it('changes the sequence when the topology seed changes', () => {
    const levels = (seed: number): boolean[] =>
      Array.from({ length: 32 }, (_, time) => sampleFloating(0, time * TICK_PS, seed));
    expect(levels(1)).not.toEqual(levels(2));
  });

  it('hashes topology descriptions deterministically', () => {
    expect(hashTopology(['net0[a,b]', 'net1[c]'])).toBe(hashTopology(['net0[a,b]', 'net1[c]']));
    expect(hashTopology(['net0[a,b]'])).not.toBe(hashTopology(['net0[a,c]']));
  });

  it('rejects arguments outside the u32 / time range', () => {
    expect(() => sampleFloating(-1, 0, 0)).toThrow(RangeError);
    expect(() => sampleFloating(0, -1, 0)).toThrow(RangeError);
    expect(() => sampleFloating(0, 1.5, 0)).toThrow(RangeError);
    expect(() => sampleFloating(0, 0, 0x1_0000_0000)).toThrow(RangeError);
  });
});

describe('floating nets in a compiled circuit', () => {
  it('samples the same sequence the emitted IR runs', () => {
    const compiled = createCircuit({ ...floatingCircuit() });
    const jit = createIRJIT(compiled.module, { validation: compiled.validation });
    const pinId = compiled.pinMap.get('a1.io');
    expect(pinId).toBeDefined();
    expect(compiled.floating.nets).toHaveLength(1);
    const netId = compiled.floating.nets[0] as number;

    jit.execute(compiled.entryPoints.refs.initialize, [], { instanceId: 'test', virtualTime: 0 });
    jit.execute(compiled.entryPoints.refs.tick, [], { instanceId: 'test', virtualTime: 0 });
    // The first tick samples the reset point, before the clock moved.
    expect(jit.storage.loadArray(compiled.memory.input, pinId as number)).toBe(
      sampleFloating(netId, 0, compiled.floating.seed),
    );
    for (let tick = 1; tick <= 64; tick += 1) {
      jit.execute(compiled.entryPoints.refs.tick, [], { instanceId: 'test', virtualTime: tick });
      expect(jit.storage.loadArray(compiled.memory.input, pinId as number)).toBe(
        sampleFloating(netId, tick * TICK_PS, compiled.floating.seed),
      );
    }
  });

  it('samples deterministically and repeats after reset', async () => {
    const circuit = await Circuit.create({ ...floatingCircuit() });
    try {
      const first = trace(circuit, 40);
      circuit.reset();
      expect(trace(circuit, 40)).toEqual(first);
    } finally {
      circuit.dispose();
    }
  });

  it('changes level over time', async () => {
    const circuit = await Circuit.create({ ...floatingCircuit() });
    try {
      const levels = trace(circuit, 100);
      expect(new Set(levels).size).toBeGreaterThan(1);
    } finally {
      circuit.dispose();
    }
  });

  it('advances the same sequence inside the batch loop', async () => {
    const stepped = await Circuit.create({ ...floatingCircuit() });
    const batched = await Circuit.create({ ...floatingCircuit() });
    try {
      const direct = trace(stepped, 24);
      const looped: boolean[] = [];
      for (let tick = 0; tick < 24; tick += 1) {
        batched.runBatch(1);
        looped.push(batched.getPin('a1.io'));
      }
      expect(looped).toEqual(direct);
    } finally {
      stepped.dispose();
      batched.dispose();
    }
  });

  it('samples identically on the reference engine and the JIT', async () => {
    const reference = await Circuit.create({ ...floatingCircuit() }, { engine: 'reference' });
    const jit = await Circuit.create({ ...floatingCircuit() }, { engine: 'jit' });
    try {
      expect(trace(reference, 48)).toEqual(trace(jit, 48));
    } finally {
      reference.dispose();
      jit.dispose();
    }
  });

  it('holds the settled low level until the first tick completes', async () => {
    const circuit = await Circuit.create({ ...floatingCircuit() });
    try {
      expect(circuit.getPin('a1.io')).toBe(false);
      circuit.step();
      expect(circuit.getPin('a1.io')).toBe(false);
    } finally {
      circuit.dispose();
    }
  });

  it('derives a seed from the topology', () => {
    const first = createCircuit({ ...floatingCircuit() });
    const same = createCircuit({ ...floatingCircuit() });
    const other = createCircuit({
      devices: [
        { id: 'b1', type: 'test-passive', description: passivePin() },
        { id: 'b2', type: 'test-passive', description: passivePin() },
      ],
      connections: [{ from: 'b1.io', to: 'b2.io' }],
    });
    expect(same.floating.seed).toBe(first.floating.seed);
    expect(other.floating.seed).not.toBe(first.floating.seed);
  });

  it('samples differently in a different topology', async () => {
    const first = await Circuit.create({ ...floatingCircuit() });
    const other = await Circuit.create({
      devices: [
        { id: 'b1', type: 'test-passive', description: passivePin() },
        { id: 'b2', type: 'test-passive', description: passivePin() },
      ],
      connections: [{ from: 'b1.io', to: 'b2.io' }],
    });
    try {
      const left: boolean[] = [];
      const right: boolean[] = [];
      for (let tick = 0; tick < 32; tick += 1) {
        first.step();
        other.step();
        left.push(first.getPin('a1.io'));
        right.push(other.getPin('b1.io'));
      }
      expect(left).not.toEqual(right);
      expect(first.floatingSeed).not.toBe(other.floatingSeed);
    } finally {
      first.dispose();
      other.dispose();
    }
  });

  it('never samples a node a weak bias holds', async () => {
    for (const pull of ['up', 'down'] as const) {
      const circuit = await Circuit.create(biasedCircuit(pull));
      try {
        const levels = trace(circuit, 40);
        expect(levels.every((level) => level === (pull === 'up'))).toBe(true);
      } finally {
        circuit.dispose();
      }
    }
  });

  it('never samples a node a strong driver holds', async () => {
    const driver: DeviceDescription = {
      pins: { io: { direction: 'output' } },
      behaviors: {
        initialize: (api) => {
          api.pin('io').configure({ mode: 'push-pull' });
          api.pin('io').writeDigital(api.builder.const('bool', false));
        },
      },
    };
    const circuit = await Circuit.create({
      devices: [
        { id: 'd1', type: 'test-driver', description: driver },
        { id: 'a1', type: 'test-passive', description: passivePin() },
      ],
      connections: [{ from: 'd1.io', to: 'a1.io' }],
    });
    try {
      const levels = trace(circuit, 40);
      expect(levels.every((level) => level === false)).toBe(true);
    } finally {
      circuit.dispose();
    }
  });
});

/** Compiles a circuit without running it, so the test can drive the engine. */
function createCircuit(input: CircuitCompilationInput) {
  return compileCircuit(input);
}
