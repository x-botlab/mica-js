/* eslint-disable @typescript-eslint/no-explicit-any -- fixtures mix scalar brands. */
import { describe, expect, it } from 'vitest';
import { createIRModule } from '../../index';
import type { IRModule } from '../../types';
import { Op } from '../mir';
import { runMemoryPasses } from './index';
import { countOp, lowerMemory, opsOf, verifiedMemory } from './memory-helpers';
import { runScalarPromotion } from './scalar-promotion';

/**
 * Structural view of the builder for fixtures. Permissive results keep these
 * tests focused on MIR shape instead of the builder's generic scalar brands.
 */
interface LooseBuilder {
  const(type: string, value: number): any;
  readonly int: {
    add(left: any, right: any): any;
    cmp(predicate: string, left: any, right: any): any;
  };
  block(params: readonly string[]): any;
  at(block: any, callback: (b: LooseBuilder, values: readonly any[]) => void): void;
  jump(target: any, args: readonly any[]): void;
  branch(condition: any, yes: any, no: any): void;
  return(values: readonly any[]): void;
  readonly state: { load(ref: any): any; store(ref: any, value: any): void };
  readonly array: {
    load(ref: any, index: any): any;
    store(ref: any, index: any, value: any): void;
  };
  call(target: any, args: readonly any[]): readonly any[];
}

function countedLoop(module: IRModule, body: (b: LooseBuilder, index: any, total: any) => void) {
  const run = module.func('run', { params: ['u32'], results: ['u32'] });
  run.body((b, [n]) => {
    const loose = b as unknown as LooseBuilder;
    const zero = loose.const('u32', 0);
    const one = loose.const('u32', 1);
    const head = loose.block(['u32', 'u32']);
    const inner = loose.block(['u32', 'u32']);
    const after = loose.block(['u32']);
    loose.jump(head, [zero, zero]);
    loose.at(head, (headBuilder, [index, total]) =>
      headBuilder.branch(
        headBuilder.int.cmp('lt', index, n),
        { target: inner, args: [index, total] },
        { target: after, args: [total] },
      ),
    );
    loose.at(inner, (innerBuilder, [index, total]) => {
      body(innerBuilder, index, total);
      innerBuilder.jump(head, [innerBuilder.int.add(index, one), total]);
    });
    loose.at(after, (afterBuilder, [total]) => afterBuilder.return([total]));
  });
  return run;
}

describe('J12 scalar promotion', () => {
  it('promotes a read-modify-write state loop and reloads once at entry', () => {
    const module = createIRModule();
    const counter = module.state('counter', 'u32', 0);
    const run = countedLoop(module, (b, index) => {
      const current = b.state.load(counter);
      b.state.store(counter, b.int.add(current, index));
    });
    const lowered = lowerMemory(module, run);
    expect(runScalarPromotion(lowered.fn, lowered.context)).toBe(1);
    verifiedMemory(lowered);

    expect(lowered.fn.promotions).toHaveLength(1);
    expect(lowered.fn.promotions[0]).toMatchObject({ memory: 0, index: undefined, type: 'u32' });
    expect(countOp(lowered.fn, Op.PromoteLoad)).toBe(1);
    expect(countOp(lowered.fn, Op.PromoteStore)).toBe(1);
    expect(countOp(lowered.fn, Op.StateLoad)).toBe(0);
    expect(countOp(lowered.fn, Op.StateStore)).toBe(0);
    // Locals start from the prologue; only the return writeback is explicit.
    expect(countOp(lowered.fn, Op.PromoteReload)).toBe(0);
    expect(countOp(lowered.fn, Op.Spill)).toBe(1);
  });

  it('promotes all 16 u32 registers of a DBT-style register file', () => {
    const module = createIRModule();
    const registers = module.array('registers', 'u32', new Array<number>(16).fill(0));
    const run = countedLoop(module, (b, index) => {
      for (let register = 0; register < 16; register += 1) {
        const slot = b.const('u32', register);
        const current = b.array.load(registers, slot);
        b.array.store(registers, slot, b.int.add(current, index));
      }
    });
    const lowered = lowerMemory(module, run);
    expect(runScalarPromotion(lowered.fn, lowered.context)).toBe(16);
    verifiedMemory(lowered);

    expect(lowered.fn.promotions).toHaveLength(16);
    expect(new Set(lowered.fn.promotions.map((promotion) => promotion.index)).size).toBe(16);
    expect(countOp(lowered.fn, Op.PromoteLoad)).toBe(16);
    expect(countOp(lowered.fn, Op.PromoteStore)).toBe(16);
    expect(countOp(lowered.fn, Op.ArrayLoad)).toBe(0);
    expect(countOp(lowered.fn, Op.ArrayStore)).toBe(0);
  });

  it('spills before a call barrier and reloads after it', () => {
    const module = createIRModule();
    const counter = module.state('counter', 'u32', 0);
    const helper = module.func('helper', { params: ['u32'], results: ['u32'] });
    helper.body((b, [value]) => b.return([b.int.add(value, b.const('u32', 1))]));
    const run = countedLoop(module, (b, index) => {
      const current = b.state.load(counter);
      const next = b.call(helper, [b.int.add(current, index)])[0]!;
      b.state.store(counter, next);
    });
    const lowered = lowerMemory(module, run);
    expect(runScalarPromotion(lowered.fn, lowered.context)).toBe(1);
    verifiedMemory(lowered);

    const insts = lowered.fn.blocks.flatMap((block) => block.insts);
    const callIndex = insts.findIndex((inst) => inst.op === Op.Call);
    expect(callIndex).toBeGreaterThan(0);
    expect(insts[callIndex - 1]!.op).toBe(Op.Spill);
    expect(insts[callIndex + 1]!.op).toBe(Op.PromoteReload);
    expect(countOp(lowered.fn, Op.Spill)).toBeGreaterThanOrEqual(2);
  });

  it('stays disabled in step-observer mode (storage is observable every step)', () => {
    const module = createIRModule();
    const counter = module.state('counter', 'u32', 0);
    const run = countedLoop(module, (b, index) => {
      const current = b.state.load(counter);
      b.state.store(counter, b.int.add(current, index));
    });
    const lowered = lowerMemory(module, run);
    runMemoryPasses(lowered.fn, lowered.context, { observer: true });
    verifiedMemory(lowered);
    expect(lowered.fn.promotions).toHaveLength(0);
    expect(countOp(lowered.fn, Op.StateLoad)).toBe(1);
    expect(countOp(lowered.fn, Op.StateStore)).toBe(1);
  });

  it('leaves straight-line functions alone (promotion needs a loop)', () => {
    const module = createIRModule();
    const counter = module.state('counter', 'u32', 0);
    const run = module.func('run', { params: ['u32'], results: ['u32'] });
    run.body((b, [value]) => {
      b.state.store(counter, value);
      const loaded = b.state.load(counter);
      b.state.store(counter, loaded);
      b.return([loaded]);
    });
    const lowered = lowerMemory(module, run);
    expect(runScalarPromotion(lowered.fn, lowered.context)).toBe(0);
    expect(opsOf(lowered.fn, Op.PromoteLoad)).toHaveLength(0);
  });
});
