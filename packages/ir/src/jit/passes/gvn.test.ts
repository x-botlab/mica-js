import { describe, expect, it } from 'vitest';
import { createIRModule } from '../../index';
import { Op, printMIR } from '../mir';
import { optimizeFunction } from './gvn';
import { countOf, instructionsOf, lower, verified } from './helpers';

describe('GVN', () => {
  it('merges identical instructions and leaves a step-preserving Check', () => {
    const module = createIRModule();
    const fn = module.func('duplicate', { params: ['u32', 'u32'], results: ['u32'] });
    fn.body((b, [x, y]) => {
      const first = b.int.add(x, y);
      const second = b.int.add(x, y);
      return b.return([b.int.add(first, second)]);
    });
    const output = verified(optimizeFunction(lower(module, fn)));
    expect(countOf(output, Op.IntAdd)).toBe(2);
    expect(countOf(output, Op.Check)).toBe(1);
    expect(printMIR(output)).toContain('check');
  });

  it('canonicalizes commutative operands', () => {
    const module = createIRModule();
    const fn = module.func('commutative', { params: ['u32', 'u32'], results: ['u32'] });
    fn.body((b, [x, y]) => {
      const first = b.int.add(x, y);
      const second = b.int.add(y, x);
      return b.return([b.int.add(first, second)]);
    });
    const output = verified(optimizeFunction(lower(module, fn)));
    // `y + x` is the same value as `x + y`; only the outer add remains.
    expect(countOf(output, Op.IntAdd)).toBe(2);
    expect(countOf(output, Op.Check)).toBe(1);
  });

  it('merges pure-but-throwing instructions (the first one throws)', () => {
    const module = createIRModule();
    const fn = module.func('division', { params: ['u32', 'u32'], results: ['u32'] });
    fn.body((b, [x, y]) => {
      const first = b.int.div(x, y);
      const second = b.int.div(x, y);
      return b.return([b.int.add(first, second)]);
    });
    const output = verified(optimizeFunction(lower(module, fn)));
    expect(countOf(output, Op.IntDiv)).toBe(1);
    expect(countOf(output, Op.Check)).toBe(1);
    // The surviving division still owns the original source location.
    const division = instructionsOf(output, Op.IntDiv)[0]!;
    expect(division.node?.op).toBe('int.div');
  });

  it('reuses an entry value in both dominated branches', () => {
    const module = createIRModule();
    const fn = module.func('dominated', { params: ['bool', 'u32', 'u32'], results: ['u32'] });
    fn.body((b, [flag, x, y]) => {
      const common = b.int.add(x, y);
      const yes = b.block([]);
      const no = b.block([]);
      const join = b.block(['u32']);
      b.branch(flag, { target: yes, args: [] }, { target: no, args: [] });
      b.at(yes, (b) => b.jump(join, [b.int.add(x, y)]));
      b.at(no, (b) => b.jump(join, [b.int.add(x, y)]));
      b.at(join, (b, [value]) => b.return([b.int.add(value, common)]));
    });
    const output = verified(optimizeFunction(lower(module, fn)));
    expect(countOf(output, Op.IntAdd)).toBe(2);
    expect(countOf(output, Op.Check)).toBe(2);
  });

  it('does not merge sibling-branch expressions', () => {
    const module = createIRModule();
    const fn = module.func('siblings', { params: ['bool', 'u32'], results: ['u32'] });
    fn.body((b, [flag, x]) => {
      const yes = b.block([]);
      const no = b.block([]);
      const join = b.block(['u32']);
      b.branch(flag, { target: yes, args: [] }, { target: no, args: [] });
      b.at(yes, (b) => b.jump(join, [b.int.add(x, b.const('u32', 1))]));
      b.at(no, (b) => b.jump(join, [b.int.add(x, b.const('u32', 2))]));
      b.at(join, (b, [value]) => b.return([value]));
    });
    const output = verified(optimizeFunction(lower(module, fn)));
    expect(countOf(output, Op.IntAdd)).toBe(2);
    expect(countOf(output, Op.Check)).toBe(0);
  });

  it('does not merge +0 and -0 float constants', () => {
    const module = createIRModule();
    const fn = module.func('zeros', { params: [], results: ['f64', 'f64'] });
    fn.body((b) => {
      const one = b.const('f64', 1);
      const positive = b.float.div(one, b.const('f64', 0));
      const negative = b.float.div(one, b.const('f64', -0));
      return b.return([positive, negative]);
    });
    const output = verified(optimizeFunction(lower(module, fn)));
    // one, +0 and -0 are three distinct constants.
    expect(countOf(output, Op.Const)).toBe(3);
    expect(countOf(output, Op.Check)).toBe(0);
  });

  it('does not merge a D literal with a U constant table index', () => {
    const module = createIRModule();
    const fn = module.func('representations', { params: [], results: ['f64', 'f64'] });
    fn.body((b) => b.return([b.bits('f64', '0x7ff0000000000002'), b.const('f64', 0)]));
    const output = verified(optimizeFunction(lower(module, fn)));
    const constants = instructionsOf(output, Op.Const);
    expect(constants).toHaveLength(2);
    expect(new Set(constants.map((inst) => inst.constRep))).toEqual(new Set(['U', 'D']));
  });

  it('does not merge constants of different types', () => {
    const module = createIRModule();
    const fn = module.func('typed', { params: [], results: ['u32', 'i16'] });
    fn.body((b) => b.return([b.const('u32', 1), b.const('i16', 1)]));
    const output = verified(optimizeFunction(lower(module, fn)));
    expect(countOf(output, Op.Const)).toBe(2);
    expect(countOf(output, Op.Check)).toBe(0);
  });
});
