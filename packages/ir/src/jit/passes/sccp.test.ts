import { describe, expect, it } from 'vitest';
import { createIRModule } from '../../index';
import { createLowerContext, lowerFunction, Op, printMIR } from '../mir';
import { isFloatBits } from './util';
import { optimizeFunction } from './sccp';
import { countOf, instructionsOf, lower, verified } from './helpers';

describe('SCCP', () => {
  it('folds constants, folds a constant branch and removes unreachable blocks', () => {
    const module = createIRModule();
    const fn = module.func('fold', { params: ['u32'], results: ['u32'] });
    fn.body((b, [value]) => {
      const yes = b.block(['u32']);
      const no = b.block(['u32']);
      const join = b.block(['u32']);
      const three = b.int.add(b.const('u32', 1), b.const('u32', 2));
      const condition = b.int.cmp('lt', three, b.const('u32', 5));
      b.branch(condition, { target: yes, args: [three] }, { target: no, args: [value] });
      b.at(yes, (b, [inner]) => b.jump(join, [b.int.mul(inner, b.const('u32', 2))]));
      b.at(no, (b, [inner]) => b.jump(join, [b.int.add(inner, b.const('u32', 100))]));
      b.at(join, (b, [inner]) => b.return([inner]));
    });

    const input = lower(module, fn);
    const output = verified(optimizeFunction(input));

    // b2 (`no`) is unreachable once the branch is folded.
    expect(output.blocks.map((block) => block.id)).toEqual([0, 1, 3]);
    expect(output.blocks[0]!.term.kind).toBe('jump');
    // `1 + 2` and `3 * 2` are constants now.
    expect(countOf(output, Op.Const)).toBeGreaterThanOrEqual(4);
    expect(countOf(output, Op.IntMul)).toBe(0);
    expect(printMIR(output)).not.toContain('branch');
    expect(printMIR(output)).toContain('const 6');
  });

  it('keeps a NaN payload const.bits as an exact U constant', () => {
    const module = createIRModule();
    const fn = module.func('nan', { params: [], results: ['f32', 'bool'] });
    fn.body((b) => {
      const raw = b.bits('f32', '0x7fc12345');
      return b.return([raw, b.float.isNaN(raw)]);
    });
    const context = createLowerContext(module);
    const input = lowerFunction(context, fn);
    const output = verified(optimizeFunction(input, { constants: context.constants }));

    const constants = instructionsOf(output, Op.Const);
    const exact = constants.find((inst) => inst.constRep === 'U');
    expect(exact).toBeDefined();
    const value = context.constants[exact!.imm[0] as number];
    expect(isFloatBits(value)).toBe(true);
    if (isFloatBits(value)) expect(value.bits).toBe('0x7fc12345');
    // `float.isNaN` on the payload folded to `true`.
    expect(constants.some((inst) => inst.imm[0] === true)).toBe(true);
  });

  it('does not fold an evaluation that would throw', () => {
    const module = createIRModule();
    const fn = module.func('div', { params: [], results: ['u32'] });
    fn.body((b) => b.return([b.int.div(b.const('u32', 1), b.const('u32', 0))]));
    const output = verified(optimizeFunction(lower(module, fn)));
    expect(countOf(output, Op.IntDiv)).toBe(1);
    expect(printMIR(output)).toContain('int.div');
  });

  it('leaves the input MIR untouched', () => {
    const module = createIRModule();
    const fn = module.func('immutable', { params: ['u32'], results: ['u32'] });
    fn.body((b, [value]) => b.return([b.int.add(value, b.const('u32', 1))]));
    const input = lower(module, fn);
    const before = printMIR(input);
    optimizeFunction(input);
    expect(printMIR(input)).toBe(before);
  });
});
