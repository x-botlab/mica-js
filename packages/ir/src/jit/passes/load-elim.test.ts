import { describe, expect, it } from 'vitest';
import { CORE_INSTRUCTION_NAMES } from '../../builder';
import { prepareEngine } from '../../engine-setup';
import { createIRModule } from '../../index';
import type { IRModule, IRValidationOptions, ProviderRef } from '../../index';
import { lowerFunction, Op } from '../mir';
import { createLowerContext } from '../resolve';
import { runMemoryPasses } from './index';
import { runLoadElim } from './load-elim';
import { countOp, lowerMemory, verifiedMemory } from './memory-helpers';
import type { LoweredMemoryFunction } from './memory-helpers';

function validationPolicy(module: IRModule): IRValidationOptions {
  const instructions = [...CORE_INSTRUCTION_NAMES];
  return {
    supportedInstructions: instructions,
    authorizedInstructions: instructions,
    resources: module.memories.map((memory) => ({
      ref: memory.ref,
      access: memory.writable ? ('read-write' as const) : ('read' as const),
    })),
  };
}

/**
 * Lower one generated provider artifact. `checkpoint` only exists on the
 * generated builder, so provider artifacts are the only place a checkpoint can
 * appear in MIR.
 */
function lowerArtifact(
  module: IRModule,
  provider: ProviderRef<readonly ['u32'], readonly [], readonly []>,
  key: number,
): LoweredMemoryFunction {
  const setup = prepareEngine(module, { validation: validationPolicy(module) });
  const artifact = setup.providers.materialize(provider, [key]);
  const lower = createLowerContext(setup.model);
  return {
    fn: lowerFunction(lower, artifact.fn, artifact.index, artifact.name),
    lower,
    context: { memories: setup.model.memories },
  };
}

describe('J12 load elimination', () => {
  it('forwards a state store into a later load', () => {
    const module = createIRModule();
    const counter = module.state('counter', 'u32', 0);
    const run = module.func('run', { params: ['u32'], results: ['u32'] });
    run.body((b, [value]) => {
      b.state.store(counter, value);
      b.return([b.state.load(counter)]);
    });
    const lowered = lowerMemory(module, run);
    expect(runLoadElim(lowered.fn, lowered.context)).toBe(1);
    verifiedMemory(lowered);
    expect(countOp(lowered.fn, Op.StateLoad)).toBe(0);
    expect(countOp(lowered.fn, Op.Forward)).toBe(1);
  });

  it('forwards a constant float store (D) but not a parameter float (U)', () => {
    const module = createIRModule();
    const constant = module.state('constant', 'f64', 0);
    const captured = module.state('captured', 'f64', 0);
    const run = module.func('run', { params: ['f64'], results: ['f64'] });
    run.body((b, [value]) => {
      b.state.store(constant, b.const('f64', 1.5));
      const fromConstant = b.state.load(constant);
      b.state.store(captured, value);
      const fromParameter = b.state.load(captured);
      b.return([b.float.add(fromConstant, fromParameter)]);
    });
    const lowered = lowerMemory(module, run);
    expect(runLoadElim(lowered.fn, lowered.context)).toBe(1);
    verifiedMemory(lowered);
    expect(countOp(lowered.fn, Op.StateLoad)).toBe(1);
  });

  it('invalidates availability at a call barrier', () => {
    const module = createIRModule();
    const counter = module.state('counter', 'u32', 0);
    const helper = module.func('helper', { params: [], results: [] });
    helper.body((b) => b.return([]));
    const run = module.func('run', { params: ['u32'], results: ['u32'] });
    run.body((b, [value]) => {
      b.state.store(counter, value);
      b.call(helper, []);
      b.return([b.state.load(counter)]);
    });
    const lowered = lowerMemory(module, run);
    expect(runLoadElim(lowered.fn, lowered.context)).toBe(0);
    verifiedMemory(lowered);
    expect(countOp(lowered.fn, Op.StateLoad)).toBe(1);
  });

  it('keeps disjoint constant array elements and invalidates on an unknown index', () => {
    const module = createIRModule();
    const table = module.array('table', 'u32', [0, 0, 0, 0]);
    const run = module.func('run', { params: ['u32', 'u32'], results: ['u32', 'u32', 'u32'] });
    run.body((b, [index, value]) => {
      b.array.store(table, b.const('u32', 2), value);
      const same = b.array.load(table, b.const('u32', 2));
      const other = b.array.load(table, b.const('u32', 1));
      b.array.store(table, index, value);
      const unknown = b.array.load(table, b.const('u32', 2));
      b.return([same, other, unknown]);
    });
    const lowered = lowerMemory(module, run);
    expect(runLoadElim(lowered.fn, lowered.context)).toBe(1);
    verifiedMemory(lowered);
    expect(countOp(lowered.fn, Op.ArrayLoad)).toBe(2);
  });

  it('forwards identical byte accesses only and invalidates overlapping intervals', () => {
    const module = createIRModule();
    const ram = module.bytes('ram', new Uint8Array(8), { readonly: false });
    const run = module.func('run', {
      params: ['u32'],
      results: ['u32', 'u16', 'u32', 'u8'],
    });
    run.body((b, [value]) => {
      b.bytes.store('u32', 'little', ram, b.const('u32', 0), value);
      const same = b.bytes.load('u32', 'little', ram, b.const('u32', 0));
      const narrow = b.bytes.load('u16', 'little', ram, b.const('u32', 0));
      const bigEndian = b.bytes.load('u32', 'big', ram, b.const('u32', 0));
      b.return([same, narrow, bigEndian, b.bytes.load('u8', 'big', ram, b.const('u32', 0))]);
    });
    const lowered = lowerMemory(module, run);
    // Only the exact u32/little load forwards; different width and endianness
    // use different keys and stay in place.
    expect(runLoadElim(lowered.fn, lowered.context)).toBe(1);
    verifiedMemory(lowered);
    expect(countOp(lowered.fn, Op.BytesLoad)).toBe(3);
  });

  it('reuses a dominating load in every block it dominates', () => {
    const module = createIRModule();
    const counter = module.state('counter', 'u32', 7);
    const run = module.func('run', { params: ['bool'], results: ['u32', 'u32', 'u32'] });
    run.body((b, [flag]) => {
      const yes = b.block([]);
      const no = b.block([]);
      const join = b.block(['u32']);
      // Defined before the branch: available on every path to the two arms and
      // to the join block they both reach.
      const first = b.state.load(counter);
      b.branch(flag, { target: yes, args: [] }, { target: no, args: [] });
      b.at(yes, (inner) => inner.jump(join, [inner.state.load(counter)]));
      b.at(no, (inner) => inner.jump(join, [inner.state.load(counter)]));
      b.at(join, (inner, [value]) => inner.return([first, value, inner.state.load(counter)]));
    });
    const lowered = lowerMemory(module, run);
    expect(runLoadElim(lowered.fn, lowered.context)).toBe(3);
    verifiedMemory(lowered);
    // Only the dominating load itself stays; the two arm loads and the join
    // load are replaced by it.
    expect(countOp(lowered.fn, Op.StateLoad)).toBe(1);
    expect(countOp(lowered.fn, Op.Forward)).toBe(3);
  });

  it('keeps only the loads available on every predecessor at a merge', () => {
    const module = createIRModule();
    const counter = module.state('counter', 'u32', 0);
    const run = module.func('run', {
      params: ['bool', 'u32', 'u32'],
      results: ['u32', 'u32'],
    });
    run.body((b, [flag, left, right]) => {
      const yes = b.block(['u32']);
      const no = b.block(['u32']);
      const join = b.block(['u32']);
      const first = b.state.load(counter);
      b.branch(flag, { target: yes, args: [first] }, { target: no, args: [first] });
      b.at(yes, (inner, [seen]) => {
        inner.state.store(counter, left);
        inner.jump(join, [seen]);
      });
      b.at(no, (inner, [seen]) => {
        inner.state.store(counter, right);
        inner.jump(join, [seen]);
      });
      // Each predecessor stored a different value, so the dominating load is
      // no longer available at the join and the load must stay.
      b.at(join, (inner, [seen]) => inner.return([seen, inner.state.load(counter)]));
    });
    const lowered = lowerMemory(module, run);
    expect(runLoadElim(lowered.fn, lowered.context)).toBe(0);
    verifiedMemory(lowered);
    expect(countOp(lowered.fn, Op.StateLoad)).toBe(2);
  });

  it('forwards across blocks and drops the entry when a later store may alias it', () => {
    const module = createIRModule();
    const table = module.array('table', 'u32', [0, 1, 2, 3]);
    const run = module.func('run', { params: ['u32', 'u32'], results: ['u32', 'u32'] });
    run.body((b, [index, value]) => {
      const next = b.block([]);
      b.array.store(table, b.const('u32', 2), value);
      b.jump(next, []);
      b.at(next, (inner) => {
        const forwarded = inner.array.load(table, inner.const('u32', 2));
        // A store through an unknown index may hit element 2.
        inner.array.store(table, index, value);
        const reloaded = inner.array.load(table, inner.const('u32', 2));
        inner.return([forwarded, reloaded]);
      });
    });
    const lowered = lowerMemory(module, run);
    expect(runLoadElim(lowered.fn, lowered.context)).toBe(1);
    verifiedMemory(lowered);
    expect(countOp(lowered.fn, Op.ArrayLoad)).toBe(1);
  });

  it('drops a dominating load at a call in a later block', () => {
    const module = createIRModule();
    const counter = module.state('counter', 'u32', 0);
    const helper = module.func('helper', { params: [], results: [] });
    helper.body((b) => b.return([]));
    const run = module.func('run', { params: [], results: ['u32', 'u32'] });
    run.body((b) => {
      const next = b.block([]);
      const first = b.state.load(counter);
      b.jump(next, []);
      b.at(next, (inner) => {
        inner.call(helper, []);
        inner.return([first, inner.state.load(counter)]);
      });
    });
    const lowered = lowerMemory(module, run);
    expect(runLoadElim(lowered.fn, lowered.context)).toBe(0);
    verifiedMemory(lowered);
    expect(countOp(lowered.fn, Op.StateLoad)).toBe(2);
  });

  it('drops a dominating load at a checkpoint in a later block', () => {
    const module = createIRModule();
    const counter = module.state('counter', 'u32', 0);
    const recovery = module.provider(
      'recovery',
      { keyTypes: ['u32'], params: [], results: [], reads: [], imports: [] },
      (gen) => gen.function((b) => b.return([])),
    );
    const code = module.provider(
      'code',
      { keyTypes: ['u32'], params: [], results: [], reads: [], imports: [counter, recovery] },
      (gen) =>
        gen.function((b) => {
          const next = b.block([]);
          const first = b.state.load(counter);
          b.jump(next, []);
          b.at(next, (inner) => {
            // `checkpoint` runs provider code that may change storage.
            inner.checkpoint(recovery, [inner.const('u32', 0)], []);
            inner.state.store(
              counter,
              inner.int.add(inner.state.load(counter), inner.const('u32', 1)),
            );
            inner.return([]);
          });
          void first;
        }),
    );
    const lowered = lowerArtifact(module, code, 0);
    expect(runLoadElim(lowered.fn, lowered.context)).toBe(0);
    verifiedMemory(lowered);
    expect(countOp(lowered.fn, Op.StateLoad)).toBe(2);
  });

  it('reuses a loop-header load in the blocks it dominates', () => {
    const module = createIRModule();
    const counter = module.state('counter', 'u32', 0);
    const sink = module.state('sink', 'u32', 0);
    const run = module.func('run', { params: ['u32'], results: ['u32'] });
    run.body((b, [n]) => {
      const zero = b.const('u32', 0);
      const one = b.const('u32', 1);
      const head = b.block(['u32']);
      const body = b.block(['u32']);
      const after = b.block([]);
      b.jump(head, [zero]);
      b.at(head, (inner, [index]) => {
        // Reloaded on every iteration: a back edge can reach the header, so the
        // entry availability must not be reused here.
        inner.state.store(sink, inner.state.load(counter));
        inner.branch(
          inner.int.cmp('lt', index, n),
          { target: body, args: [index] },
          { target: after, args: [] },
        );
      });
      b.at(body, (inner, [index]) => {
        // Dominated by the header of this iteration: reuse its loads.
        inner.state.store(sink, inner.state.load(counter));
        inner.jump(head, [inner.int.add(index, one)]);
      });
      b.at(after, (inner) => inner.return([inner.state.load(sink)]));
    });
    const lowered = lowerMemory(module, run);
    // The body load and the exit load both forward to the header's loads; the
    // header itself keeps its single load.
    expect(runLoadElim(lowered.fn, lowered.context)).toBe(2);
    verifiedMemory(lowered);
    expect(countOp(lowered.fn, Op.StateLoad)).toBe(1);
  });

  it('runs after scalar promotion and eliminates what promotion leaves behind', () => {
    const module = createIRModule();
    const counter = module.state('counter', 'u32', 0);
    const other = module.state('other', 'u32', 5);
    const run = module.func('run', { params: ['u32'], results: ['u32'] });
    run.body((b, [n]) => {
      const one = b.const('u32', 1);
      const zero = b.const('u32', 0);
      const mid = b.block([]);
      const head = b.block(['u32']);
      const body = b.block(['u32']);
      const after = b.block([]);
      const first = b.state.load(other);
      b.jump(mid, []);
      // Straight-line block dominated by the entry load.
      b.at(mid, (inner) => {
        inner.state.store(other, inner.state.load(other));
        inner.jump(head, [zero]);
      });
      b.at(head, (inner, [index]) =>
        inner.branch(
          inner.int.cmp('lt', index, n),
          { target: body, args: [index] },
          { target: after, args: [] },
        ),
      );
      // Two accesses in a loop: `counter` is promoted to a local.
      b.at(body, (inner, [index]) => {
        inner.state.store(counter, inner.int.add(inner.state.load(counter), one));
        inner.jump(head, [inner.int.add(index, one)]);
      });
      b.at(after, (inner) => inner.return([inner.int.add(first, inner.state.load(counter))]));
    });
    const lowered = lowerMemory(module, run);
    const report = runMemoryPasses(lowered.fn, lowered.context);
    expect(report.scalarPromotion).toBe(1);
    // `counter` is a local now, so only the two straggling `other` loads are
    // left for load elimination, which forwards the second one.
    expect(report.loadElim).toBe(1);
    verifiedMemory(lowered);
    expect(countOp(lowered.fn, Op.StateLoad)).toBe(1);
    expect(countOp(lowered.fn, Op.PromoteLoad)).toBe(2);
  });
});
