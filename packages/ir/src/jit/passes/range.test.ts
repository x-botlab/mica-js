import { describe, expect, it } from 'vitest';
import { createIRModule } from '../../index';
import { Op, printMIR } from '../mir';
import { analyzeRanges, optimizeFunction } from './range';
import { instructionsOf, lower, verified } from './helpers';

function guardedDivision(guarded: boolean) {
  const module = createIRModule();
  const fn = module.func('range', { params: ['u32', 'u32'], results: ['u32'] });
  fn.body((b, [value, divisor]) => {
    const zero = b.const('u32', 0);
    const yes = b.block(['u32']);
    const no = b.block([]);
    const join = b.block(['u32']);
    const condition = guarded
      ? b.int.cmp('ne', divisor, zero)
      : b.int.cmp('lt', divisor, b.const('u32', 10));
    b.branch(condition, { target: yes, args: [divisor] }, { target: no, args: [] });
    b.at(yes, (b, [inner]) => b.jump(join, [b.int.div(value, inner)]));
    b.at(no, (b) => b.jump(join, [zero]));
    b.at(join, (b, [result]) => b.return([result]));
  });
  return lower(module, fn);
}

describe('range analysis', () => {
  it('proves a guarded divisor non-zero and drops the division check', () => {
    const input = guardedDivision(true);
    const analysis = analyzeRanges(input);
    // The `yes` block parameter carries a proven `!= 0` fact.
    const yes = input.blocks[1]!;
    expect(analysis.nonzero.has(yes.params[0]!)).toBe(true);

    const output = verified(optimizeFunction(input));
    const division = instructionsOf(output, Op.IntDiv)[0]!;
    expect(division.imm).toContain('nozero');
    expect(printMIR(output)).toContain('nozero');
  });

  it('keeps the division check without a usable guard', () => {
    const output = verified(optimizeFunction(guardedDivision(false)));
    expect(instructionsOf(output, Op.IntDiv)[0]!.imm).not.toContain('nozero');
  });

  it('marks an in-range shift count and a non-wrapping add', () => {
    const module = createIRModule();
    const fn = module.func('hints', { params: ['u32'], results: ['u32', 'i16'] });
    fn.body((b, [value]) => {
      const shifted = b.int.shl(value, b.const('u32', 3));
      const added = b.int.add(b.const('i16', 1), b.const('i16', 2));
      return b.return([shifted, added]);
    });
    const output = verified(optimizeFunction(lower(module, fn)));
    expect(instructionsOf(output, Op.IntShl)[0]!.imm).toContain('inrange');
    expect(instructionsOf(output, Op.IntAdd)[0]!.imm).toContain('nowrap');
  });

  it('leaves the input MIR untouched', () => {
    const input = guardedDivision(true);
    const before = printMIR(input);
    optimizeFunction(input);
    expect(printMIR(input)).toBe(before);
  });
});
