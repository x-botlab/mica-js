import { describe, expect, it } from 'vitest';
import { createIRModule } from '../../index';
import { Op } from '../mir';
import { OPTIMIZATION_PASS_NAMES, runOptimizationPipeline } from './pipeline';
import { countOf, lower, verified } from './helpers';

function program() {
  const module = createIRModule();
  const fn = module.func('pipeline', { params: ['u32', 'bool'], results: ['u32'] });
  fn.body((b, [value, flag]) => {
    const yes = b.block(['u32']);
    const no = b.block(['u32']);
    const join = b.block(['u32']);
    const three = b.int.add(b.const('u32', 1), b.const('u32', 2));
    b.branch(flag, { target: yes, args: [three] }, { target: no, args: [value] });
    b.at(yes, (b, [inner]) => b.jump(join, [b.int.mul(inner, b.const('u32', 2))]));
    b.at(no, (b, [inner]) => b.jump(join, [b.int.add(inner, b.const('u32', 100))]));
    b.at(join, (b, [inner]) => {
      b.int.add(inner, b.const('u32', 7));
      return b.return([inner]);
    });
  });
  return lower(module, fn);
}

describe('optimization pipeline', () => {
  it('returns the input untouched when every pass is disabled', () => {
    const input = program();
    const switches = Object.fromEntries(OPTIMIZATION_PASS_NAMES.map((pass) => [pass, false]));
    expect(runOptimizationPipeline(input, { passes: switches })).toBe(input);
  });

  it.each(OPTIMIZATION_PASS_NAMES)('stays correct when %s is disabled', (disabled) => {
    const switches = Object.fromEntries(
      OPTIMIZATION_PASS_NAMES.map((pass) => [pass, pass !== disabled]),
    );
    const output = verified(runOptimizationPipeline(program(), { passes: switches, verify: true }));
    // With SCCP disabled the multiplication is not constant, but every
    // configuration must still produce verifier-clean MIR.
    expect(output.blocks.length).toBeGreaterThan(0);
  });

  it('runs every pass by default with the verifier enabled', () => {
    const output = verified(runOptimizationPipeline(program(), { verify: true }));
    expect(countOf(output, Op.IntMul)).toBe(0);
  });
});
