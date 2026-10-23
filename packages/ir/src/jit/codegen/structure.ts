/**
 * Control-flow structuring (Stackifier) for reducible MIR functions (J6).
 *
 * The translation follows the dominator-based approach of Ramsey, *Beyond
 * Relooper* (ICFP 2022), simplified to the subset J6 needs:
 *
 * - a function is emitted as nested sequences of blocks;
 * - a conditional branch becomes `if/else`; both arms are translated with the
 *   branch's immediate post-dominator as their join, and the join's code is
 *   emitted right after the `if`;
 * - a natural loop becomes `L<n>: for (;;) { ... }` and its back edges become
 *   `continue L<n>`;
 * - a loop has at most one exit *target*; exits use `break L<n>` and the exit
 *   block follows the loop;
 * - edges that leave the current region become `stop` transfers, which the
 *   emitter resolves against the active `if`/`loop` contexts.
 *
 * Everything the translation cannot express (irreducible graphs, loops with
 * several distinct exit targets, shared join blocks) raises
 * {@link StructurizationError}; `compileFunction` then falls back to the
 * `switch (pc)` form, which is correct for every CFG.
 */
import { blockEdges, buildCFG, computeDominators, findLoops } from '../cfg';
import type { CFG, Loop } from '../cfg';
import type { MBlock, MFunction, ValueId } from '../mir';

/** One CFG edge with its block arguments. */
export interface StructuredEdge {
  readonly target: number;
  readonly args: readonly ValueId[];
}

/** How control leaves the current region. */
export type TransferMode = 'fallthrough' | 'break' | 'continue' | 'stop';

export interface GotoShape {
  readonly kind: 'goto';
  readonly mode: TransferMode;
  readonly edge: StructuredEdge;
  /** Label for `break` / `continue`. */
  readonly label?: string;
}

/** One arm of a conditional branch. */
export type SideShape =
  | { readonly kind: 'transfer'; readonly edge: StructuredEdge; readonly transfer: GotoShape }
  | {
      readonly kind: 'inline';
      readonly edge: StructuredEdge;
      readonly body: readonly StructuredNode[];
    };

export type TermShape =
  | { readonly kind: 'native' }
  | GotoShape
  | {
      readonly kind: 'branch';
      readonly cond: ValueId;
      readonly join: number | undefined;
      readonly yes: SideShape;
      readonly no: SideShape;
    };

export type StructuredNode =
  | { readonly kind: 'block'; readonly id: number; readonly term: TermShape }
  | {
      readonly kind: 'loop';
      readonly label: string;
      readonly exit: number | undefined;
      readonly body: readonly StructuredNode[];
    };

export interface StructuredProgram {
  readonly nodes: readonly StructuredNode[];
  /** Blocks that carry generated code, in emission order. */
  readonly blocks: ReadonlySet<number>;
}

/** Raised when the CFG cannot be expressed with the J6 structuring rules. */
export class StructurizationError extends Error {
  override readonly name = 'StructurizationError';
}

function reversePostorder(entry: number, succ: ReadonlyMap<number, readonly number[]>): number[] {
  const visited = new Set<number>([entry]);
  const postorder: number[] = [];
  const stack: { readonly id: number; index: number }[] = [{ id: entry, index: 0 }];
  while (stack.length > 0) {
    const frame = stack[stack.length - 1]!;
    const next = succ.get(frame.id) ?? [];
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
  return postorder.reverse();
}

/**
 * Immediate post-dominators over the whole CFG.
 *
 * Back edges stay: the standard iterative algorithm handles cycles, and
 * keeping them is what makes a loop's exit the post-dominator of the loop
 * header (dropping them makes every loop look like an alternative exit).
 * Blocks inside a loop with no exit are unreachable from the virtual exit and
 * therefore have no post-dominator, which the builder treats as "no join".
 */
function computePostdominators(cfg: CFG, blocks: ReadonlyMap<number, MBlock>): Map<number, number> {
  const exit = -1;
  const succ = new Map<number, number[]>();
  for (const id of cfg.order) {
    const block = blocks.get(id)!;
    succ.set(
      id,
      blockEdges(block.term).map((edge) => edge.target),
    );
  }
  const reverse = new Map<number, number[]>();
  for (const id of cfg.order) reverse.set(id, []);
  for (const id of cfg.order) {
    for (const target of succ.get(id)!) reverse.get(target)!.push(id);
  }
  reverse.set(
    exit,
    cfg.order.filter((id) => succ.get(id)!.length === 0),
  );
  const preds = new Map<number, number[]>();
  for (const id of reverse.keys()) preds.set(id, []);
  for (const [id, successors] of reverse) {
    for (const successor of successors) preds.get(successor)!.push(id);
  }

  const order = reversePostorder(exit, reverse);
  const position = new Map<number, number>();
  order.forEach((id, index) => position.set(id, index));
  const idom = new Map<number, number>();
  if (order.length === 0) return idom;
  idom.set(order[0]!, order[0]!);
  const intersect = (left: number, right: number): number => {
    let a = left;
    let b = right;
    while (a !== b) {
      while (position.get(a)! > position.get(b)!) {
        const next = idom.get(a);
        if (next === undefined) throw new StructurizationError('incomplete post-dominators');
        a = next;
      }
      while (position.get(b)! > position.get(a)!) {
        const next = idom.get(b);
        if (next === undefined) throw new StructurizationError('incomplete post-dominators');
        b = next;
      }
    }
    return a;
  };
  let changed = true;
  while (changed) {
    changed = false;
    for (let index = 1; index < order.length; index += 1) {
      const block = order[index]!;
      let candidate: number | undefined;
      for (const pred of preds.get(block) ?? []) {
        if (!idom.has(pred)) continue;
        candidate = candidate === undefined ? pred : intersect(pred, candidate);
      }
      if (candidate !== undefined && idom.get(block) !== candidate) {
        idom.set(block, candidate);
        changed = true;
      }
    }
  }
  const result = new Map<number, number>();
  for (const [block, immediate] of idom) {
    if (block !== exit && immediate !== exit) result.set(block, immediate);
  }
  return result;
}

class Builder {
  readonly blocks: ReadonlyMap<number, MBlock>;
  readonly emitted = new Set<number>();
  readonly loopByHeader: Map<number, Loop>;
  readonly postdominators: Map<number, number>;

  constructor(
    readonly fn: MFunction,
    readonly cfg: CFG,
    readonly loops: readonly Loop[],
  ) {
    this.blocks = new Map(fn.blocks.map((block) => [block.id, block]));
    this.loopByHeader = new Map(loops.map((loop) => [loop.header, loop]));
    this.postdominators = computePostdominators(cfg, this.blocks);
  }

  block(id: number): MBlock {
    const block = this.blocks.get(id);
    if (block === undefined) throw new StructurizationError(`unknown block ${id}`);
    return block;
  }

  /** A back edge is an edge to a loop header from inside that loop. */
  isBackEdge(from: number, to: number): boolean {
    const loop = this.loopByHeader.get(to);
    return loop !== undefined && loop.blocks.has(from);
  }

  build(): StructuredProgram {
    const nodes = this.sequence(this.cfg.entry, new Set<number>(), true);
    return { nodes, blocks: this.emitted };
  }

  /**
   * Emit a linear sequence starting at `start` until a terminal, a back edge,
   * an out-of-region transfer, or (for the first block) a loop header.
   */
  private sequence(start: number, stops: ReadonlySet<number>, first: boolean): StructuredNode[] {
    const nodes: StructuredNode[] = [];
    let current = start;

    for (;;) {
      // Only the first block skips the loop-header check: `loop()` already
      // decided to open that loop here.
      if (!first && this.loopByHeader.has(current) && !this.emitted.has(current)) {
        const loopNode = this.loop(this.loopByHeader.get(current)!);
        nodes.push(loopNode);
        if (loopNode.exit === undefined) return nodes;
        if (stops.has(loopNode.exit)) return nodes;
        current = loopNode.exit;
        continue;
      }
      first = false;

      const block = this.block(current);
      if (this.emitted.has(current)) {
        throw new StructurizationError(`block ${current} would be emitted more than once`);
      }
      this.emitted.add(current);
      const term = block.term;

      if (term.kind === 'return' || term.kind === 'trap' || term.kind === 'dispatch') {
        nodes.push({ kind: 'block', id: current, term: { kind: 'native' } });
        return nodes;
      }

      if (term.kind === 'jump') {
        const edge: StructuredEdge = { target: term.target, args: term.args };
        if (this.isBackEdge(current, term.target)) {
          nodes.push({
            kind: 'block',
            id: current,
            term: { kind: 'goto', mode: 'continue', edge, label: `L${term.target}` },
          });
          return nodes;
        }
        if (stops.has(term.target)) {
          nodes.push({
            kind: 'block',
            id: current,
            term: { kind: 'goto', mode: 'stop', edge },
          });
          return nodes;
        }
        nodes.push({
          kind: 'block',
          id: current,
          term: { kind: 'goto', mode: 'fallthrough', edge },
        });
        if (this.emitted.has(term.target)) {
          throw new StructurizationError(`block ${term.target} would be emitted more than once`);
        }
        current = term.target;
        continue;
      }

      const join = this.postdominators.get(current);
      // A join outside this region (an enclosing loop exit/header or an
      // already-emitted block) is a stop, not a local fall-through target: its
      // code is not emitted right after this `if`, so the emitter must not
      // accept it as a stop destination.
      const reachableJoin =
        join !== undefined && !stops.has(join) && !this.emitted.has(join) ? join : undefined;
      const yes = this.side(term.yes, current, stops, reachableJoin);
      const no = this.side(term.no, current, stops, reachableJoin);
      nodes.push({
        kind: 'block',
        id: current,
        term: { kind: 'branch', cond: term.cond, join: reachableJoin, yes, no },
      });
      if (reachableJoin === undefined) return nodes;
      current = reachableJoin;
    }
  }

  private side(
    edge: { readonly target: number; readonly args: readonly ValueId[] },
    from: number,
    stops: ReadonlySet<number>,
    join: number | undefined,
  ): SideShape {
    const structured: StructuredEdge = { target: edge.target, args: edge.args };
    if (this.isBackEdge(from, edge.target)) {
      return {
        kind: 'transfer',
        edge: structured,
        transfer: {
          kind: 'goto',
          mode: 'continue',
          edge: structured,
          label: `L${edge.target}`,
        },
      };
    }
    // A stop (loop exit / enclosing join) wins over the join: when the loop
    // exit is also the branch's post-dominator, control must `break`, not fall
    // out of the loop body.
    if (stops.has(edge.target)) {
      return {
        kind: 'transfer',
        edge: structured,
        transfer: { kind: 'goto', mode: 'stop', edge: structured },
      };
    }
    if (edge.target === join) {
      return {
        kind: 'transfer',
        edge: structured,
        transfer: { kind: 'goto', mode: 'fallthrough', edge: structured },
      };
    }
    if (this.emitted.has(edge.target)) {
      throw new StructurizationError(`block ${edge.target} would be emitted more than once`);
    }
    const inner = new Set(stops);
    if (join !== undefined) inner.add(join);
    return {
      kind: 'inline',
      edge: structured,
      body: this.sequence(edge.target, inner, false),
    };
  }

  private loop(loop: Loop): Extract<StructuredNode, { kind: 'loop' }> {
    const exits = [...new Set(loop.exits.map((exit) => exit.to))];
    if (exits.length > 1) {
      throw new StructurizationError('loop has more than one exit target');
    }
    // A loop whose only exit is a back edge to an enclosing loop never falls
    // through: the edge itself becomes `continue L<enclosing>`.
    const exit =
      exits[0] !== undefined && this.isBackEdge(loop.header, exits[0]) ? undefined : exits[0];
    const label = `L${loop.header}`;
    const stops = new Set<number>();
    if (exit !== undefined) stops.add(exit);
    // `first = true`: the header is emitted here, not opened as a nested loop.
    const body = this.sequence(loop.header, stops, true);
    return { kind: 'loop', label, exit, body };
  }
}

/**
 * Structure a reducible function. Throws {@link StructurizationError} for
 * shapes the J6 rules cannot express; callers fall back to `switch (pc)`.
 */
export function structurize(fn: MFunction): StructuredProgram {
  if (!fn.reducible) {
    throw new StructurizationError('function is not reducible');
  }
  const cfg = buildCFG(fn);
  const dominators = computeDominators(cfg);
  const loops = findLoops(cfg, dominators);
  return new Builder(fn, cfg, loops).build();
}
