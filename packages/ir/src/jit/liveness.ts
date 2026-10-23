/**
 * Block-level and instruction-level liveness for MIR (J5).
 *
 * Standard backward dataflow. Block parameters are defined at block entry;
 * edge arguments are used at the end of the predecessor block. `blockUse`
 * therefore holds only upward-exposed uses (uses that happen before any local
 * definition), while `liveOut` additionally contains the arguments of every
 * outgoing edge.
 */
import { blockEdges } from './cfg';
import type { MFunction, MInst, MTerm, ValueId } from './mir';

export interface LivenessInfo {
  /** Values live at block entry (before the block parameters are defined). */
  readonly liveIn: ReadonlyMap<number, ReadonlySet<ValueId>>;
  /** Values live at block exit. */
  readonly liveOut: ReadonlyMap<number, ReadonlySet<ValueId>>;
  readonly blockUse: ReadonlyMap<number, readonly ValueId[]>;
  readonly blockDef: ReadonlyMap<number, readonly ValueId[]>;
  readonly instUse: ReadonlyMap<MInst, readonly ValueId[]>;
  readonly instDef: ReadonlyMap<MInst, readonly ValueId[]>;
  /** Values an instruction potentially overwrites (its results). */
  readonly instKill: ReadonlyMap<MInst, readonly ValueId[]>;
  /** Values live immediately before each instruction executes. */
  readonly liveBefore: ReadonlyMap<MInst, ReadonlySet<ValueId>>;
}

function unique(values: readonly ValueId[]): ValueId[] {
  return [...new Set(values)];
}

/** Every value read by a terminator, including both branch edge arguments. */
export function terminatorUses(term: MTerm): ValueId[] {
  switch (term.kind) {
    case 'jump':
      return [...term.args];
    case 'branch':
      return unique([term.cond, ...term.yes.args, ...term.no.args]);
    case 'return':
      return [...term.values];
    case 'dispatch':
      return unique([...term.key, ...term.args]);
    case 'trap':
      return [];
  }
}

function sameSet(left: ReadonlySet<ValueId>, right: ReadonlySet<ValueId>): boolean {
  if (left.size !== right.size) return false;
  for (const value of left) if (!right.has(value)) return false;
  return true;
}

/** Compute liveness for one function. */
export function computeLiveness(fn: MFunction): LivenessInfo {
  const blockUse = new Map<number, ValueId[]>();
  const blockDef = new Map<number, ValueId[]>();
  const defSets = new Map<number, ReadonlySet<ValueId>>();
  const instUse = new Map<MInst, readonly ValueId[]>();
  const instDef = new Map<MInst, readonly ValueId[]>();
  const instKill = new Map<MInst, readonly ValueId[]>();

  for (const block of fn.blocks) {
    const defined = new Set<ValueId>(block.params);
    const uses: ValueId[] = [];
    for (const inst of block.insts) {
      const args = unique(inst.args);
      const results = unique(inst.results);
      instUse.set(inst, args);
      instDef.set(inst, results);
      instKill.set(inst, results);
      for (const arg of args) if (!defined.has(arg)) uses.push(arg);
      for (const result of results) defined.add(result);
    }
    for (const use of terminatorUses(block.term)) {
      if (!defined.has(use)) uses.push(use);
    }
    const defs = unique([...block.params, ...block.insts.flatMap((inst) => inst.results)]);
    blockUse.set(block.id, unique(uses));
    blockDef.set(block.id, defs);
    defSets.set(block.id, new Set(defs));
  }

  const liveIn = new Map<number, Set<ValueId>>();
  const liveOut = new Map<number, Set<ValueId>>();
  for (const block of fn.blocks) {
    liveIn.set(block.id, new Set<ValueId>());
    liveOut.set(block.id, new Set<ValueId>());
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const block of fn.blocks) {
      const out = new Set<ValueId>();
      for (const edge of blockEdges(block.term)) {
        for (const value of liveIn.get(edge.target) ?? []) out.add(value);
        // Edge arguments are read at the end of this block.
        for (const value of edge.args) out.add(value);
      }
      const input = new Set<ValueId>(blockUse.get(block.id)!);
      const defined = defSets.get(block.id)!;
      for (const value of out) if (!defined.has(value)) input.add(value);

      if (!sameSet(out, liveOut.get(block.id)!)) {
        liveOut.set(block.id, out);
        changed = true;
      }
      if (!sameSet(input, liveIn.get(block.id)!)) {
        liveIn.set(block.id, input);
        changed = true;
      }
    }
  }

  const liveBefore = new Map<MInst, ReadonlySet<ValueId>>();
  for (const block of fn.blocks) {
    const live = new Set<ValueId>(liveOut.get(block.id)!);
    for (const value of terminatorUses(block.term)) live.add(value);
    for (let index = block.insts.length - 1; index >= 0; index -= 1) {
      const inst = block.insts[index]!;
      for (const result of inst.results) live.delete(result);
      for (const arg of inst.args) live.add(arg);
      liveBefore.set(inst, new Set(live));
    }
  }

  return { liveIn, liveOut, blockUse, blockDef, instUse, instDef, instKill, liveBefore };
}
