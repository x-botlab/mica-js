import { describe, expect, it } from 'vitest';
import { createIRModule } from '../../index';
import { Op, printMIR } from '../mir';
import { optimizeFunction } from './dce';
import { countOf, instructionsOf, lower, verified } from './helpers';

describe('DCE', () => {
  it('replaces unused pure instructions with a step-preserving Check', () => {
    const module = createIRModule();
    const fn = module.func('pure', { params: ['u32'], results: ['u32'] });
    fn.body((b, [value]) => {
      b.int.add(value, b.const('u32', 1));
      return b.return([value]);
    });
    const output = verified(optimizeFunction(lower(module, fn)));
    expect(countOf(output, Op.IntAdd)).toBe(0);
    expect(countOf(output, Op.Check)).toBeGreaterThanOrEqual(1);
    expect(printMIR(output)).toContain('check');
  });

  it('keeps the division-by-zero check of an unused division', () => {
    const module = createIRModule();
    const fn = module.func('divide', { params: ['u32'], results: ['u32'] });
    fn.body((b, [value]) => {
      b.int.div(value, b.const('u32', 0));
      return b.return([value]);
    });
    const output = verified(optimizeFunction(lower(module, fn)));
    expect(countOf(output, Op.IntDiv)).toBe(0);
    const checks = instructionsOf(output, Op.Check);
    expect(checks.some((inst) => inst.imm[0] === 'divzero')).toBe(true);
    const check = checks.find((inst) => inst.imm[0] === 'divzero')!;
    expect(check.args).toHaveLength(2);
    expect(check.node?.op).toBe('int.div');
  });

  it('keeps bounds checks of unused array loads', () => {
    const module = createIRModule();
    const table = module.array('table', 'u32', [0, 0, 0]);
    const fn = module.func('load', { params: ['u32'], results: ['u32'] });
    fn.body((b, [index]) => {
      b.array.load(table, index);
      return b.return([index]);
    });
    const output = verified(optimizeFunction(lower(module, fn)));
    expect(countOf(output, Op.ArrayLoad)).toBe(0);
    const check = instructionsOf(output, Op.Check).find((inst) => inst.imm[0] === 'bounds');
    expect(check).toBeDefined();
    expect(check!.node?.op).toBe('array.load');
    expect(check!.args).toHaveLength(1);
  });

  it('removes unreachable blocks', () => {
    const module = createIRModule();
    const fn = module.func('dead', { params: [], results: [] });
    fn.body((b) => {
      const dead = b.block([]);
      const reachable = b.block([]);
      b.jump(reachable, []);
      b.at(dead, (b) => b.return([]));
      b.at(reachable, (b) => b.return([]));
    });
    const output = verified(optimizeFunction(lower(module, fn)));
    expect(output.blocks.map((block) => block.id)).toEqual([0, 2]);
  });

  it('removes unused block parameters and their edge arguments', () => {
    const module = createIRModule();
    const fn = module.func('params', { params: ['u32', 'bool'], results: [] });
    fn.body((b, [value, flag]) => {
      const yes = b.block([]);
      const no = b.block([]);
      const join = b.block(['u32']);
      b.branch(flag, { target: yes, args: [] }, { target: no, args: [] });
      b.at(yes, (b) => b.jump(join, [value]));
      b.at(no, (b) => b.jump(join, [value]));
      b.at(join, (b, [inner]) => {
        b.int.add(inner, b.const('u32', 1));
        b.return([]);
      });
    });
    const output = verified(optimizeFunction(lower(module, fn)));
    const join = output.blocks.find((block) => block.id === 3)!;
    expect(join.params).toHaveLength(0);
    for (const block of output.blocks) {
      if (block.term.kind === 'jump' && block.term.target === 3) {
        expect(block.term.args).toHaveLength(0);
      }
    }
  });

  it('leaves the input MIR untouched', () => {
    const module = createIRModule();
    const fn = module.func('immutable', { params: ['u32'], results: ['u32'] });
    fn.body((b, [value]) => {
      b.int.add(value, b.const('u32', 1));
      return b.return([value]);
    });
    const input = lower(module, fn);
    const before = printMIR(input);
    optimizeFunction(input);
    expect(printMIR(input)).toBe(before);
  });
});
