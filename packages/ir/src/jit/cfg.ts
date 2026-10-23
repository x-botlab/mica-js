/**
 * CFG construction, dominators, dominance frontiers and natural loops (J5).
 *
 * MIR blocks are numbered by their source index and may be unreachable. The
 * analysis keeps unreachable blocks (code generation skips them) but only
 * builds the dominator tree for blocks reachable from the entry.
 */
import type { MFunction, MTerm, ValueId } from './mir';

/** One control-flow edge with its block arguments. */
export interface BlockEdge {
  readonly target: number;
  readonly args: readonly ValueId[];
}

/** Edges leaving one terminator; `dispatch` and `trap` have none inside this function. */
export function blockEdges(term: MTerm): BlockEdge[] {
  switch (term.kind) {
    case 'jump':
      return [{ target: term.target, args: term.args }];
    case 'branch':
      return [term.yes, term.no];
    case 'return':
    case 'dispatch':
    case 'trap':
      return [];
  }
}

/** Control-flow graph of one MIR function. */
export interface CFG {
  readonly function: MFunction;
  readonly entry: number;
  /** Reachable block ids in reverse postorder. */
  readonly order: readonly number[];
  readonly preds: ReadonlyMap<number, readonly number[]>;
  readonly succs: ReadonlyMap<number, readonly number[]>;
  /** Blocks not reachable from the entry, in id order. */
  readonly unreachable: readonly number[];
}

function unique(values: readonly number[]): number[] {
  return [...new Set(values)];
}

/**
 * Build the CFG and fill `MBlock.preds` / `MBlock.succs` for later passes.
 */
export function buildCFG(fn: MFunction): CFG {
  const succs = new Map<number, number[]>();
  const preds = new Map<number, number[]>();
  for (const block of fn.blocks) {
    succs.set(block.id, []);
    preds.set(block.id, []);
  }
  for (const block of fn.blocks) {
    for (const edge of blockEdges(block.term)) {
      if (!succs.has(edge.target)) {
        throw new Error(`MIR CFG failed: block ${block.id} targets unknown block ${edge.target}`);
      }
      succs.get(block.id)!.push(edge.target);
      preds.get(edge.target)!.push(block.id);
    }
  }
  for (const block of fn.blocks) {
    block.succs = unique(succs.get(block.id)!);
    block.preds = unique(preds.get(block.id)!);
    succs.set(block.id, block.succs);
    preds.set(block.id, block.preds);
  }

  const entry = fn.blocks[0]!.id;
  if (!succs.has(entry)) {
    throw new Error('MIR CFG failed: function has no entry block');
  }
  const visited = new Set<number>([entry]);
  const postorder: number[] = [];
  const stack: { readonly id: number; index: number }[] = [{ id: entry, index: 0 }];
  while (stack.length > 0) {
    const frame = stack[stack.length - 1]!;
    const next = succs.get(frame.id)!;
    if (frame.index < next.length) {
      const successor = next[frame.index]!;
      frame.index += 1;
      if (!visited.has(successor)) {
        visited.add(successor);
        stack.push({ id: successor, index: 0 });
      }
      continue;
    }
    postorder.push(frame.id);
    stack.pop();
  }
  const order = postorder.reverse();
  const unreachable = fn.blocks
    .map((block) => block.id)
    .filter((id) => !visited.has(id))
    .sort((a, b) => a - b);
  return { function: fn, entry, order, preds, succs, unreachable };
}

/** Immediate-dominator map; the entry dominates itself. Reachable blocks only. */
export type Dominators = ReadonlyMap<number, number>;

/**
 * Cooper–Harvey–Kennedy iterative dominator computation over RPO.
 */
export function computeDominators(cfg: CFG): Map<number, number> {
  const dominators = new Map<number, number>();
  const rpo = cfg.order;
  if (rpo.length === 0 || rpo[0] !== cfg.entry) {
    return dominators;
  }
  const position = new Map<number, number>();
  rpo.forEach((id, index) => position.set(id, index));
  dominators.set(cfg.entry, cfg.entry);

  const intersect = (left: number, right: number): number => {
    let a = left;
    let b = right;
    while (a !== b) {
      while (position.get(a)! > position.get(b)!) {
        const next = dominators.get(a);
        if (next === undefined) throw new Error('MIR dominators failed: incomplete tree');
        a = next;
      }
      while (position.get(b)! > position.get(a)!) {
        const next = dominators.get(b);
        if (next === undefined) throw new Error('MIR dominators failed: incomplete tree');
        b = next;
      }
    }
    return a;
  };

  let changed = true;
  while (changed) {
    changed = false;
    for (let index = 1; index < rpo.length; index += 1) {
      const block = rpo[index]!;
      let candidate: number | undefined;
      for (const pred of cfg.preds.get(block) ?? []) {
        if (!dominators.has(pred)) continue;
        candidate = candidate === undefined ? pred : intersect(pred, candidate);
      }
      if (candidate !== undefined && dominators.get(block) !== candidate) {
        dominators.set(block, candidate);
        changed = true;
      }
    }
  }
  return dominators;
}

/** True when `a` dominates `b` (reflexively). */
export function dominates(dominators: Dominators, a: number, b: number): boolean {
  if (!dominators.has(b)) return false;
  let current = b;
  for (;;) {
    if (current === a) return true;
    const parent = dominators.get(current);
    if (parent === undefined || parent === current) return false;
    current = parent;
  }
}

/** Dominance frontier for every reachable block. */
export function dominanceFrontiers(cfg: CFG, dominators: Dominators): Map<number, Set<number>> {
  const frontiers = new Map<number, Set<number>>();
  for (const block of cfg.order) frontiers.set(block, new Set<number>());
  for (const block of cfg.order) {
    const preds = cfg.preds.get(block) ?? [];
    if (preds.length < 2) continue;
    const immediate = dominators.get(block);
    if (immediate === undefined) continue;
    for (const pred of preds) {
      let runner: number | undefined = pred;
      while (runner !== undefined && runner !== immediate) {
        frontiers.get(runner)!.add(block);
        const next = dominators.get(runner);
        runner = next === runner ? undefined : next;
      }
    }
  }
  return frontiers;
}

/** One directed edge leaving a natural loop. */
export interface LoopExit {
  readonly from: number;
  readonly to: number;
}

/** One natural loop; loops with the same header are merged. */
export interface Loop {
  readonly header: number;
  readonly latches: readonly number[];
  readonly blocks: ReadonlySet<number>;
  readonly exits: readonly LoopExit[];
  /** Index of the innermost enclosing loop, or -1. */
  readonly parent: number;
  readonly depth: number;
  /** Indices of directly nested loops. */
  readonly children: readonly number[];
}

interface PendingLoop {
  readonly header: number;
  readonly latches: number[];
  readonly blocks: Set<number>;
}

function blockOf(cfg: CFG, id: number): MTerm {
  const block = cfg.function.blocks.find((candidate) => candidate.id === id);
  if (block === undefined) throw new Error(`MIR CFG failed: unknown block ${id}`);
  return block.term;
}

/**
 * Find natural loops from back edges `latch → header` where the header
 * dominates the latch. Returns loops ordered by the header's RPO position.
 */
export function findLoops(cfg: CFG, dominators: Dominators): Loop[] {
  const pending = new Map<number, PendingLoop>();
  for (const block of cfg.order) {
    for (const edge of blockEdges(blockOf(cfg, block))) {
      if (!dominates(dominators, edge.target, block)) continue;
      let loop = pending.get(edge.target);
      if (loop === undefined) {
        loop = { header: edge.target, latches: [], blocks: new Set<number>([edge.target]) };
        pending.set(edge.target, loop);
      }
      if (!loop.latches.includes(block)) loop.latches.push(block);
      // Natural loop: the header plus every node that reaches a latch without
      // passing through the header again.
      const stack = [block];
      while (stack.length > 0) {
        const node = stack.pop()!;
        if (loop.blocks.has(node)) continue;
        loop.blocks.add(node);
        for (const pred of cfg.preds.get(node) ?? []) {
          if (dominators.has(pred)) stack.push(pred);
        }
      }
    }
  }

  const ordered = [...pending.values()].sort(
    (a, b) => cfg.order.indexOf(a.header) - cfg.order.indexOf(b.header),
  );
  // Exits: every edge leaving the loop body.
  const bodies = ordered.map((loop) => {
    const exits: LoopExit[] = [];
    for (const block of [...loop.blocks].sort((a, b) => a - b)) {
      for (const successor of cfg.succs.get(block) ?? []) {
        if (!loop.blocks.has(successor)) exits.push({ from: block, to: successor });
      }
    }
    exits.sort((a, b) => a.from - b.from || a.to - b.to);
    return {
      header: loop.header,
      latches: [...loop.latches].sort((a, b) => a - b),
      blocks: loop.blocks,
      exits,
    };
  });

  // Nesting: a loop is nested in the innermost loop that contains its header.
  const parents = bodies.map((loop, index) => {
    let parent = -1;
    let smallest = Infinity;
    bodies.forEach((candidate, candidateIndex) => {
      if (candidateIndex === index) return;
      if (!candidate.blocks.has(loop.header)) return;
      if (candidate.blocks.size <= loop.blocks.size) return;
      if (candidate.blocks.size < smallest) {
        smallest = candidate.blocks.size;
        parent = candidateIndex;
      }
    });
    return parent;
  });
  const children: number[][] = bodies.map(() => []);
  parents.forEach((parent, index) => {
    if (parent >= 0) children[parent]!.push(index);
  });
  const depthOf = (index: number): number => {
    let depth = 0;
    let current = parents[index]!;
    while (current >= 0) {
      depth += 1;
      current = parents[current]!;
    }
    return depth;
  };
  return bodies.map((loop, index) => ({
    header: loop.header,
    latches: loop.latches,
    blocks: loop.blocks,
    exits: loop.exits,
    parent: parents[index]!,
    depth: depthOf(index),
    children: children[index]!,
  }));
}

/**
 * Reducibility check from the spec: every DFS back edge `u → v` must have `v`
 * dominate `u`. Unreachable blocks do not participate.
 */
export function isReducible(cfg: CFG, dominators: Dominators): boolean {
  if (cfg.order.length === 0) return true;
  const preorder = new Map<number, number>();
  const postorder = new Map<number, number>();
  let time = 0;
  preorder.set(cfg.entry, time++);
  const stack: { readonly id: number; index: number }[] = [{ id: cfg.entry, index: 0 }];
  while (stack.length > 0) {
    const frame = stack[stack.length - 1]!;
    const successors = cfg.succs.get(frame.id)!;
    if (frame.index < successors.length) {
      const successor = successors[frame.index]!;
      frame.index += 1;
      if (!preorder.has(successor)) {
        preorder.set(successor, time++);
        stack.push({ id: successor, index: 0 });
      }
      continue;
    }
    postorder.set(frame.id, time++);
    stack.pop();
  }
  const isAncestor = (ancestor: number, node: number): boolean =>
    preorder.get(ancestor)! <= preorder.get(node)! &&
    postorder.get(node)! <= postorder.get(ancestor)!;
  for (const block of cfg.order) {
    for (const edge of blockEdges(blockOf(cfg, block))) {
      if (!isAncestor(edge.target, block)) continue;
      if (!dominates(dominators, edge.target, block)) return false;
    }
  }
  return true;
}

export interface CFGAnalysis {
  readonly cfg: CFG;
  readonly dominators: Map<number, number>;
  readonly frontiers: Map<number, Set<number>>;
  readonly loops: readonly Loop[];
  readonly reducible: boolean;
}

/** Build every CFG-level analysis and update `MFunction.reducible`. */
export function analyzeCFG(fn: MFunction): CFGAnalysis {
  const cfg = buildCFG(fn);
  const dominators = computeDominators(cfg);
  const reducible = isReducible(cfg, dominators);
  fn.reducible = reducible;
  return {
    cfg,
    dominators,
    frontiers: dominanceFrontiers(cfg, dominators),
    loops: findLoops(cfg, dominators),
    reducible,
  };
}
