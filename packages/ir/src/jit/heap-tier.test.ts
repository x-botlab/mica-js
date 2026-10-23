import { describe, expect, it } from 'vitest';
import { CORE_INSTRUCTION_NAMES } from '../builder';
import {
  createIRInterpreter,
  createIRJIT,
  createIRModule,
  type IRExecutionError,
  type IRModule,
  type IRValidationOptions,
} from '../index';

/* -------------------------------------------------------------------------
 * Harness
 * ---------------------------------------------------------------------- */

const context = { instanceId: 'heap-tier', virtualTime: 7 };

function policy(module: IRModule): IRValidationOptions {
  return {
    supportedInstructions: CORE_INSTRUCTION_NAMES,
    authorizedInstructions: CORE_INSTRUCTION_NAMES,
    resources: module.memories.map(({ ref }) => ({ ref, access: 'read-write' })),
  };
}

/**
 * A non-tail chain: `levelN(n) = levelN-1(n) + 1`. Every level is live while its
 * callee runs, so a deep enough chain forces the compiled prologue into the heap
 * tier and its results must come back through every frame.
 */
function chain(depth: number, trapAtBase = false) {
  const module = createIRModule();
  const counter = module.state('counter', 'u32', 0);
  const base = module.func('base', { params: ['u32'], results: ['u32'] });
  base.body((b, [n]) => {
    if (trapAtBase) {
      b.trap('heap tier trap');
    } else {
      b.state.store(counter, b.int.add(b.state.load(counter), b.const('u32', 1)));
      b.return([n]);
    }
  });
  let target = base;
  for (let index = 1; index <= depth; index += 1) {
    const previous = target;
    const level = module.func(`level${index}`, { params: ['u32'], results: ['u32'] });
    level.body((b, [n]) => {
      const [value] = b.call(previous, [n]);
      b.return([b.int.add(value, b.const('u32', 1))]);
    });
    target = level;
  }
  return { module, target, counter };
}

function capture(run: () => unknown): IRExecutionError {
  let caught: unknown;
  try {
    run();
  } catch (cause) {
    caught = cause;
  }
  expect(caught).toBeInstanceOf(Error);
  return caught as IRExecutionError;
}

/* -------------------------------------------------------------------------
 * Tests
 * ---------------------------------------------------------------------- */

describe('heap tier deep fallback', () => {
  it('matches the reference results, steps and storage when maxCompiledDepth is reached', () => {
    const { module, target, counter } = chain(8);
    const validation = policy(module);
    const expected = createIRInterpreter(module, { validation }).execute(target, [5], context);

    // Depth 1 sends every callee through the heap tier, not just the tail of a
    // long chain.
    const jit = createIRJIT(module, { validation, jit: { maxCompiledDepth: 1 } });
    expect(jit.execute(target, [5], context)).toEqual(expected);
    expect(expected.values).toEqual([13]);
    expect(expected.steps).toBeGreaterThan(0);
    expect(jit.storage.loadState(counter)).toBe(1);
  });

  it('reports heap-tier failures with the reference location and call stack', () => {
    const { module, target } = chain(4, true);
    const validation = policy(module);
    const expected = capture(() =>
      createIRInterpreter(module, { validation }).execute(target, [1], context),
    );
    const actual = capture(() =>
      createIRJIT(module, { validation, jit: { maxCompiledDepth: 1 } }).execute(
        target,
        [1],
        context,
      ),
    );

    expect(actual.code).toBe(expected.code);
    expect(actual.message).toBe(expected.message);
    expect(actual.steps).toBe(expected.steps);
    expect(actual.location).toEqual(expected.location);
    expect(actual.callStack).toEqual(expected.callStack);
  });

  it('keeps the default depth budget working for shallow recursion', () => {
    const { module, target, counter } = chain(3);
    const validation = policy(module);
    const expected = createIRInterpreter(module, { validation }).execute(target, [1], context);
    const jit = createIRJIT(module, { validation });
    expect(jit.execute(target, [1], context)).toEqual(expected);
    expect(jit.storage.loadState(counter)).toBe(1);
  });
});
