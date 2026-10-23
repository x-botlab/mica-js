import { describe, expect, it } from 'vitest';
import { createIRModule } from '../../index';
import { Op } from '../mir';
import { runLoadElim } from './load-elim';
import { countOp, lowerMemory, verifiedMemory } from './memory-helpers';

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
});
