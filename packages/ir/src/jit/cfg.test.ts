import { describe, expect, it } from 'vitest';
import { createIRModule } from '../index';
import {
  analyzeCFG,
  buildCFG,
  computeDominators,
  dominates,
  dominanceFrontiers,
  findLoops,
  isReducible,
} from './cfg';
import { createLowerContext, lowerFunction } from './mir';

function diamond() {
  const module = createIRModule();
  const fn = module.func('diamond', { params: ['bool'], results: [] });
  fn.body((b, [condition]) => {
    const yes = b.block([]);
    const no = b.block([]);
    const join = b.block([]);
    b.branch(condition, { target: yes, args: [] }, { target: no, args: [] });
    b.at(yes, (b) => b.jump(join, []));
    b.at(no, (b) => b.jump(join, []));
    b.at(join, (b) => b.return([]));
  });
  return lowerFunction(createLowerContext(module), fn);
}

function nestedLoops() {
  const module = createIRModule();
  const fn = module.func('nested', { params: ['u32'], results: ['u32'] });
  fn.body((b, [start]) => {
    const zero = b.const('u32', 0);
    const one = b.const('u32', 1);
    const limit = b.const('u32', 10);
    const outer = b.block(['u32']);
    const inner = b.block(['u32']);
    const innerBody = b.block(['u32']);
    const outerLatch = b.block(['u32']);
    const done = b.block(['u32']);
    b.jump(outer, [start]);
    b.at(outer, () => b.jump(inner, [zero]));
    b.at(inner, (b, [index]) =>
      b.branch(
        b.int.cmp('lt', index, limit),
        { target: innerBody, args: [index] },
        { target: outerLatch, args: [index] },
      ),
    );
    b.at(innerBody, (b, [index]) => b.jump(inner, [b.int.add(index, one)]));
    b.at(outerLatch, (b, [index]) =>
      b.branch(
        b.int.cmp('lt', index, limit),
        { target: outer, args: [b.int.add(index, one)] },
        { target: done, args: [index] },
      ),
    );
    b.at(done, (b, [index]) => b.return([index]));
  });
  return lowerFunction(createLowerContext(module), fn);
}

function irreducible() {
  const module = createIRModule();
  const fn = module.func('irreducible', { params: ['bool'], results: [] });
  fn.body((b, [condition]) => {
    const a = b.block([]);
    const other = b.block([]);
    const c = b.block([]);
    b.branch(condition, { target: a, args: [] }, { target: other, args: [] });
    b.at(a, (b) => b.jump(c, []));
    b.at(other, (b) => b.jump(c, []));
    b.at(c, (b) => b.jump(a, []));
  });
  return lowerFunction(createLowerContext(module), fn);
}

describe('CFG', () => {
  it('builds predecessors, successors and RPO for a diamond', () => {
    const fn = diamond();
    const cfg = buildCFG(fn);
    expect(cfg.entry).toBe(0);
    expect([...cfg.order].sort()).toEqual([0, 1, 2, 3]);
    expect(cfg.order[0]).toBe(0);
    expect(cfg.unreachable).toEqual([]);
    expect(cfg.succs.get(0)).toEqual([1, 2]);
    expect(cfg.preds.get(3)).toEqual([1, 2]);
    expect(fn.blocks[3]!.preds).toEqual([1, 2]);
    expect(fn.blocks[0]!.succs).toEqual([1, 2]);
  });

  it('computes immediate dominators and dominance frontiers', () => {
    const fn = diamond();
    const cfg = buildCFG(fn);
    const dominators = computeDominators(cfg);
    expect(dominators.get(0)).toBe(0);
    expect(dominators.get(1)).toBe(0);
    expect(dominators.get(2)).toBe(0);
    expect(dominators.get(3)).toBe(0);
    expect(dominates(dominators, 0, 3)).toBe(true);
    expect(dominates(dominators, 1, 3)).toBe(false);
    expect(dominates(dominators, 3, 3)).toBe(true);
    const frontiers = dominanceFrontiers(cfg, dominators);
    expect([...frontiers.get(1)!]).toEqual([3]);
    expect([...frontiers.get(2)!]).toEqual([3]);
    expect([...frontiers.get(0)!]).toEqual([]);
  });

  it('finds nested natural loops with exits and depths', () => {
    const fn = nestedLoops();
    const cfg = buildCFG(fn);
    const dominators = computeDominators(cfg);
    const loops = findLoops(cfg, dominators);
    expect(loops).toHaveLength(2);
    const outer = loops.find((loop) => loop.header === 1)!;
    const inner = loops.find((loop) => loop.header === 2)!;

    expect([...outer.blocks].sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
    expect(outer.latches).toEqual([4]);
    expect(outer.exits).toEqual([{ from: 4, to: 5 }]);
    expect(outer.parent).toBe(-1);
    expect(outer.depth).toBe(0);

    expect([...inner.blocks].sort((a, b) => a - b)).toEqual([2, 3]);
    expect(inner.latches).toEqual([3]);
    expect(inner.exits).toEqual([{ from: 2, to: 4 }]);
    expect(inner.parent).toBe(loops.indexOf(outer));
    expect(inner.depth).toBe(1);
    expect(outer.children).toEqual([loops.indexOf(inner)]);
    expect(isReducible(cfg, dominators)).toBe(true);
    expect(analyzeCFG(fn).reducible).toBe(true);
    expect(fn.reducible).toBe(true);
  });

  it('detects irreducible control flow', () => {
    const fn = irreducible();
    const cfg = buildCFG(fn);
    const dominators = computeDominators(cfg);
    expect(dominates(dominators, 1, 3)).toBe(false);
    expect(isReducible(cfg, dominators)).toBe(false);
    const analysis = analyzeCFG(fn);
    expect(analysis.reducible).toBe(false);
    expect(fn.reducible).toBe(false);
    expect(analysis.loops).toEqual([]);
  });

  it('keeps unreachable blocks but excludes them from the dominator tree', () => {
    const module = createIRModule();
    const fn = module.func('dead', { params: [], results: [] });
    fn.body((b) => {
      const dead = b.block([]);
      b.return([]);
      b.at(dead, (b) => b.return([]));
    });
    const mir = lowerFunction(createLowerContext(module), fn);
    const cfg = buildCFG(mir);
    expect(cfg.unreachable).toEqual([1]);
    expect(cfg.order).toEqual([0]);
    const dominators = computeDominators(cfg);
    expect(dominators.has(1)).toBe(false);
    expect(analyzeCFG(mir).loops).toEqual([]);
  });
});
