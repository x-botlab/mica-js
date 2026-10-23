/* eslint-disable @typescript-eslint/no-explicit-any -- fixtures mix scalar brands. */
import { describe, expect, it } from 'vitest';
import { createIRModule } from '../../index';
import type { IRModule } from '../../types';
import { Op } from '../mir';
import { runBoundsElim } from './bounds-elim';
import { countOp, lowerMemory, opsOf, verifiedMemory } from './memory-helpers';

interface LooseBuilder {
  const(type: string, value: number): any;
  readonly int: {
    add(left: any, right: any): any;
    mul(left: any, right: any): any;
    cmp(predicate: string, left: any, right: any): any;
  };
  block(params: readonly string[]): any;
  at(block: any, callback: (b: LooseBuilder, values: readonly any[]) => void): void;
  jump(target: any, args: readonly any[]): void;
  branch(condition: any, yes: any, no: any): void;
  return(values: readonly any[]): void;
  readonly array: {
    load(ref: any, index: any): any;
    store(ref: any, index: any, value: any): void;
  };
  readonly bytes: {
    load(type: string, endian: string, ref: any, offset: any): any;
    store(type: string, endian: string, ref: any, offset: any, value: any): void;
  };
}

function loop(module: IRModule, body: (b: LooseBuilder, index: any) => void) {
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
      body(innerBuilder, index);
      innerBuilder.jump(head, [innerBuilder.int.add(index, one), total]);
    });
    loose.at(after, (afterBuilder, [total]) => afterBuilder.return([total]));
  });
  return run;
}

describe('J12 bounds elimination', () => {
  it('versions a loop with a dynamic induction bound', () => {
    const module = createIRModule();
    const table = module.array('table', 'u32', new Array<number>(8).fill(0));
    const run = loop(module, (b, index) => {
      const value = b.array.load(table, index);
      b.array.store(table, index, b.int.add(value, b.const('u32', 1)));
    });
    const lowered = lowerMemory(module, run);
    const blocksBefore = lowered.fn.blocks.length;
    const result = runBoundsElim(lowered.fn, lowered.context);
    verifiedMemory(lowered);

    expect(result.versioned).toBe(1);
    expect(result.eliminated).toBe(2);
    expect(lowered.fn.blocks.length).toBe(blocksBefore + 2); // header + body copies
    expect(countOp(lowered.fn, Op.BoundsGuard)).toBe(1);
    const loads = opsOf(lowered.fn, Op.ArrayLoad);
    const stores = opsOf(lowered.fn, Op.ArrayStore);
    expect(loads).toHaveLength(2);
    expect(stores).toHaveLength(2);
    expect(loads.filter((inst) => inst.uncheckedBounds === true)).toHaveLength(1);
    expect(stores.filter((inst) => inst.uncheckedBounds === true)).toHaveLength(1);
    // The preheader now selects the fast copy with the guard.
    const guard = opsOf(lowered.fn, Op.BoundsGuard)[0]!;
    const preheader = lowered.fn.blocks.find(
      (block) => block.term.kind === 'branch' && block.term.cond === guard.results[0],
    );
    expect(preheader).toBeDefined();
  });

  it('marks a statically proven constant index without versioning', () => {
    const module = createIRModule();
    const table = module.array('table', 'u32', new Array<number>(4).fill(0));
    const run = module.func('run', { params: ['u32'], results: ['u32'] });
    run.body((b, [value]) => {
      const loaded = b.array.load(table, b.const('u32', 2));
      b.array.store(table, b.const('u32', 3), value);
      b.return([loaded]);
    });
    const lowered = lowerMemory(module, run);
    const blocksBefore = lowered.fn.blocks.length;
    const result = runBoundsElim(lowered.fn, lowered.context);
    verifiedMemory(lowered);

    expect(result.versioned).toBe(0);
    expect(result.eliminated).toBe(2);
    expect(lowered.fn.blocks.length).toBe(blocksBefore);
    expect(countOp(lowered.fn, Op.BoundsGuard)).toBe(0);
    for (const inst of [...opsOf(lowered.fn, Op.ArrayLoad), ...opsOf(lowered.fn, Op.ArrayStore)]) {
      expect(inst.uncheckedBounds).toBe(true);
    }
  });

  it('versions a byte loop with a scaled induction address', () => {
    const module = createIRModule();
    const ram = module.bytes('ram', new Uint8Array(32), { readonly: false });
    const run = loop(module, (b, index) => {
      const address = b.int.mul(index, b.const('u32', 2));
      const value = b.bytes.load('u16', 'little', ram, address);
      b.bytes.store('u16', 'little', ram, address, value);
    });
    const lowered = lowerMemory(module, run);
    const result = runBoundsElim(lowered.fn, lowered.context);
    verifiedMemory(lowered);

    expect(result.versioned).toBe(1);
    expect(countOp(lowered.fn, Op.BoundsGuard)).toBe(1);
    const loads = opsOf(lowered.fn, Op.BytesLoad);
    expect(loads).toHaveLength(2);
    expect(loads.filter((inst) => inst.uncheckedBounds === true)).toHaveLength(1);
  });

  it('leaves loops with non-affine accesses untouched', () => {
    const module = createIRModule();
    const table = module.array('table', 'u32', new Array<number>(8).fill(0));
    const run = loop(module, (b, index) => {
      // `index * index` is not affine in the induction variable.
      const squared = b.int.mul(index, index);
      b.array.load(table, squared);
    });
    const lowered = lowerMemory(module, run);
    const before = lowered.fn.blocks.length;
    const result = runBoundsElim(lowered.fn, lowered.context);
    verifiedMemory(lowered);
    expect(result.versioned).toBe(0);
    expect(lowered.fn.blocks.length).toBe(before);
    for (const inst of opsOf(lowered.fn, Op.ArrayLoad)) {
      expect(inst.uncheckedBounds).not.toBe(true);
    }
  });
});
