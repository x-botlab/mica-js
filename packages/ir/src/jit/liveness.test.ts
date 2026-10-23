import { describe, expect, it } from 'vitest';
import { createIRModule } from '../index';
import { computeLiveness, terminatorUses } from './liveness';
import { createLowerContext, lowerFunction } from './mir';

function sorted(values: Iterable<number>): number[] {
  return [...values].sort((a, b) => a - b);
}

describe('liveness', () => {
  it('handles a self-backedge parameter swap', () => {
    const module = createIRModule();
    const fn = module.func('swap', { params: ['u32'], results: ['u32'] });
    fn.body((b, [input]) => {
      const loop = b.block(['u32', 'u32']);
      const done = b.block(['u32']);
      b.jump(loop, [input, input]);
      b.at(loop, (b, [first, second]) => b.jump(loop, [second, first]));
      b.at(done, (b, [value]) => b.return([value]));
    });
    const mir = lowerFunction(createLowerContext(module), fn);
    const input = mir.blocks[0]!.params[0]!;
    const [first, second] = mir.blocks[1]!.params;
    const liveness = computeLiveness(mir);

    expect(sorted(liveness.liveIn.get(1)!)).toEqual([]);
    expect(sorted(liveness.liveOut.get(1)!)).toEqual([first!, second!].sort((a, b) => a - b));
    expect(liveness.blockUse.get(1)).toEqual([]);
    expect(sorted(liveness.blockDef.get(1)!)).toEqual([first!, second!].sort((a, b) => a - b));
    expect(sorted(liveness.liveIn.get(0)!)).toEqual([]);
    expect(sorted(liveness.liveOut.get(0)!)).toEqual([input]);
    expect(sorted(liveness.liveIn.get(2)!)).toEqual([]);
  });

  it('computes per-instruction use, def and live-before sets', () => {
    const module = createIRModule();
    const fn = module.func('chain', { params: ['u32'], results: ['u32'] });
    fn.body((b, [value]) => {
      const one = b.const('u32', 1);
      const added = b.int.add(value, one);
      b.return([b.int.add(added, one)]);
    });
    const mir = lowerFunction(createLowerContext(module), fn);
    const block = mir.blocks[0]!;
    const [constant, first, second] = block.insts;
    const param = block.params[0]!;
    const liveness = computeLiveness(mir);

    expect(liveness.instUse.get(constant!)).toEqual([]);
    expect(liveness.instDef.get(constant!)).toEqual([constant!.results[0]!]);
    expect(liveness.instKill.get(constant!)).toEqual([constant!.results[0]!]);
    expect(liveness.instUse.get(first!)).toEqual([param, constant!.results[0]!]);
    expect(liveness.instUse.get(second!)).toEqual([first!.results[0]!, constant!.results[0]!]);
    expect(sorted(liveness.liveBefore.get(second!)!)).toEqual(
      [first!.results[0]!, constant!.results[0]!].sort((a, b) => a - b),
    );
    expect(sorted(liveness.liveBefore.get(first!)!)).toEqual(
      [param, constant!.results[0]!].sort((a, b) => a - b),
    );
    expect(sorted(liveness.liveBefore.get(constant!)!)).toEqual([param]);
    expect(sorted(liveness.liveIn.get(0)!)).toEqual([]);
    expect(sorted(liveness.liveOut.get(0)!)).toEqual([]);
    expect(sorted(liveness.blockUse.get(0)!)).toEqual([]);
    expect(sorted(liveness.blockDef.get(0)!)).toEqual(
      [param, constant!.results[0]!, first!.results[0]!, second!.results[0]!].sort((a, b) => a - b),
    );
  });

  it('treats branch conditions and edge arguments as uses at the predecessor', () => {
    const module = createIRModule();
    const fn = module.func('branchy', { params: ['bool', 'u32'], results: ['u32'] });
    fn.body((b, [condition, value]) => {
      const yes = b.block(['u32']);
      const no = b.block(['u32']);
      b.branch(condition, { target: yes, args: [value] }, { target: no, args: [value] });
      b.at(yes, (b, [item]) => b.return([item]));
      b.at(no, (b, [item]) => b.return([item]));
    });
    const mir = lowerFunction(createLowerContext(module), fn);
    const [condition, value] = mir.blocks[0]!.params;
    const liveness = computeLiveness(mir);

    expect(sorted(liveness.liveIn.get(0)!)).toEqual([]);
    expect(sorted(liveness.liveOut.get(0)!)).toEqual([value!]);
    expect(sorted(liveness.liveIn.get(1)!)).toEqual([]);
    expect(sorted(liveness.liveOut.get(1)!)).toEqual([]);
    expect(terminatorUses(mir.blocks[0]!.term)).toEqual([condition!, value!]);
  });

  it('iterates a two-block loop to a fixed point', () => {
    const module = createIRModule();
    const fn = module.func('loop', { params: ['u32'], results: ['u32'] });
    fn.body((b, [limit]) => {
      const zero = b.const('u32', 0);
      const one = b.const('u32', 1);
      const head = b.block(['u32', 'u32']);
      const body = b.block(['u32', 'u32']);
      const done = b.block(['u32']);
      b.jump(head, [zero, limit]);
      b.at(head, (b, [index, total]) =>
        b.branch(
          b.int.cmp('lt', index, total),
          { target: body, args: [index, total] },
          { target: done, args: [total] },
        ),
      );
      b.at(body, (b, [index, total]) => {
        const next = b.int.add(index, one);
        b.jump(head, [next, total]);
      });
      b.at(done, (b, [total]) => b.return([total]));
    });
    const mir = lowerFunction(createLowerContext(module), fn);
    const liveness = computeLiveness(mir);
    const zero = mir.blocks[0]!.insts[0]!.results[0]!;
    const one = mir.blocks[0]!.insts[1]!.results[0]!;
    const limit = mir.blocks[0]!.params[0]!;
    const [index, total] = mir.blocks[1]!.params;
    const [, bodyTotal] = mir.blocks[2]!.params;

    expect(sorted(liveness.liveIn.get(0)!)).toEqual([]);
    expect(sorted(liveness.liveOut.get(0)!)).toEqual([zero, one, limit].sort((a, b) => a - b));
    expect(sorted(liveness.liveIn.get(1)!)).toEqual([one]);
    expect(sorted(liveness.liveOut.get(1)!)).toEqual([one, index!, total!].sort((a, b) => a - b));
    expect(sorted(liveness.liveIn.get(2)!)).toEqual([one]);
    expect(sorted(liveness.liveOut.get(2)!)).toEqual(
      [one, bodyTotal!, mir.blocks[2]!.insts[0]!.results[0]!].sort((a, b) => a - b),
    );
    expect(sorted(liveness.liveIn.get(3)!)).toEqual([]);
  });
});
