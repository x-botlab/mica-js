import { describe, expect, it } from 'vitest';
import { createIRModule } from '../../index';
import { Op, printMIR } from '../mir';
import { optimizeFunction } from './licm';
import { countOf, instructionsOf, lower, verified } from './helpers';

function loopFixture() {
  const module = createIRModule();
  const fn = module.func('loop', { params: ['u32', 'u32'], results: ['u32'] });
  fn.body((b, [start, factor]) => {
    const limit = b.const('u32', 10);
    const two = b.const('u32', 2);
    const head = b.block(['u32']);
    const body = b.block(['u32']);
    const done = b.block(['u32']);
    b.jump(head, [start]);
    b.at(head, (b, [index]) =>
      b.branch(
        b.int.cmp('lt', index, limit),
        { target: body, args: [index] },
        { target: done, args: [index] },
      ),
    );
    b.at(body, (b, [index]) => {
      const invariant = b.int.mul(factor, two);
      const quotient = b.int.div(factor, two);
      b.jump(head, [b.int.add(b.int.add(index, invariant), quotient)]);
    });
    b.at(done, (b, [index]) => b.return([index]));
  });
  return lower(module, fn);
}

describe('LICM', () => {
  it('hoists a loop-invariant pure instruction into the preheader', () => {
    const input = loopFixture();
    const output = verified(optimizeFunction(input));

    const multiplications = instructionsOf(output, Op.IntMul);
    expect(multiplications).toHaveLength(1);
    expect(multiplications[0]!.step).toBe(0);
    const entry = output.blocks.find((block) => block.id === 0)!;
    expect(entry.insts).toContain(multiplications[0]);

    // The original position keeps a step-accounting Check.
    expect(countOf(output, Op.Check)).toBeGreaterThanOrEqual(1);
    expect(printMIR(output)).toContain('check');
  });

  it('never hoists a throwing instruction', () => {
    const output = verified(optimizeFunction(loopFixture()));
    const divisions = instructionsOf(output, Op.IntDiv);
    expect(divisions).toHaveLength(1);
    expect(divisions[0]!.step).toBe(1);
    // The division stays inside the loop body (block 2), not in the preheader.
    const body = output.blocks.find((block) => block.id === 2)!;
    expect(body.insts).toContain(divisions[0]);
    expect(output.blocks[0]!.insts).not.toContain(divisions[0]);
  });

  it('inserts a preheader when the header has several outside predecessors', () => {
    const module = createIRModule();
    const fn = module.func('multi', { params: ['bool', 'u32'], results: ['u32'] });
    fn.body((b, [flag, factor]) => {
      const limit = b.const('u32', 10);
      const two = b.const('u32', 2);
      const left = b.block([]);
      const right = b.block([]);
      const head = b.block(['u32']);
      const body = b.block(['u32']);
      const done = b.block(['u32']);
      b.branch(flag, { target: left, args: [] }, { target: right, args: [] });
      b.at(left, (b) => b.jump(head, [b.const('u32', 0)]));
      b.at(right, (b) => b.jump(head, [b.const('u32', 1)]));
      b.at(head, (b, [index]) =>
        b.branch(
          b.int.cmp('lt', index, limit),
          { target: body, args: [index] },
          { target: done, args: [index] },
        ),
      );
      b.at(body, (b, [index]) => b.jump(head, [b.int.add(index, b.int.mul(factor, two))]));
      b.at(done, (b, [index]) => b.return([index]));
    });

    const input = lower(module, fn);
    const output = verified(optimizeFunction(input));
    expect(output.blocks.length).toBe(input.blocks.length + 1);
    const preheader = output.blocks[output.blocks.length - 1]!;
    expect(preheader.id).toBeGreaterThanOrEqual(input.source.body!.blocks.length);
    expect(preheader.insts).toHaveLength(1);
    expect(preheader.insts[0]!.op).toBe(Op.IntMul);
    expect(preheader.insts[0]!.step).toBe(0);
    expect(preheader.term.kind).toBe('jump');
    expect(preheader.term.step).toBe(0);
    // Both outside predecessors now enter the preheader.
    for (const id of [1, 2]) {
      const block = output.blocks.find((candidate) => candidate.id === id)!;
      expect(block.term.kind).toBe('jump');
      if (block.term.kind === 'jump') expect(block.term.target).toBe(preheader.id);
    }
  });

  it('leaves the input MIR untouched', () => {
    const input = loopFixture();
    const before = printMIR(input);
    optimizeFunction(input);
    expect(printMIR(input)).toBe(before);
  });
});
