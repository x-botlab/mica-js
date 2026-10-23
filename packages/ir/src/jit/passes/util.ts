/**
 * Shared helpers for the scalar optimization passes (J11).
 *
 * Every pass is a pure function `MFunction → MFunction`: it never mutates its
 * input. Blocks, instructions and terminators that a pass keeps are cloned
 * before their operands are rewritten, and {@link rebuildFunction} then
 * renumbers the value table so that it stays dense and index-aligned with
 * `MValue.id`.
 */
import { Effect, EFFECT_INFO } from '../effects';
import type { EffectInfo } from '../effects';
import { Op } from '../mir';
import type { MBlock, MEdge, MFunction, MInst, MValue, MTerm, Rep, ValueId } from '../mir';
import type { FloatBits } from '../../types';

/** Options shared by every scalar pass. */
export interface OptimizeOptions {
  /**
   * Module-wide constant table (`LowerContext.constants`). Folding a float
   * result whose exact bits cannot be represented by a JS number requires
   * interning a `FloatBits` object here. Without a table such folds are
   * skipped, which is always conservative.
   */
  readonly constants?: unknown[];
}

/** A boolean, integer or exact float constant. */
export type ScalarConstant = boolean | number | FloatBits;

/** True when a value is a `FloatBits` object rather than a canonical number. */
export function isFloatBits(value: unknown): value is FloatBits {
  return typeof value === 'object' && value !== null;
}

/** Structural equality for scalar constants (float objects compare by bits). */
export function sameConstant(left: ScalarConstant, right: ScalarConstant): boolean {
  if (typeof left !== typeof right) return false;
  if (isFloatBits(left) || isFloatBits(right)) {
    return (
      isFloatBits(left) &&
      isFloatBits(right) &&
      left.type === right.type &&
      left.bits === right.bits
    );
  }
  return Object.is(left, right);
}

/** A stable key for CSE / value numbering. */
export function constantKey(value: ScalarConstant): string {
  if (isFloatBits(value)) return `b:${value.type}:${value.bits}`;
  if (typeof value === 'boolean') return `z:${value ? 1 : 0}`;
  return `n:${Object.is(value, -0) ? '-0' : String(value)}`;
}

/** Clone one instruction, optionally replacing selected fields. */
export function copyInst(inst: MInst, changes: Partial<MInst> = {}): MInst {
  const op = changes.op ?? inst.op;
  const instCopy: MInst = {
    op,
    args: changes.args !== undefined ? [...changes.args] : [...inst.args],
    results: changes.results !== undefined ? [...changes.results] : [...inst.results],
    imm: changes.imm !== undefined ? [...changes.imm] : [...inst.imm],
    refs: changes.refs !== undefined ? [...changes.refs] : [...inst.refs],
    node: 'node' in changes ? changes.node : inst.node,
    loc: changes.loc ?? inst.loc,
    step: changes.step ?? inst.step,
  };
  if (changes.listSplit !== undefined) {
    instCopy.listSplit = [...changes.listSplit];
  } else if (inst.listSplit !== undefined && op === inst.op) {
    instCopy.listSplit = [...inst.listSplit];
  }
  const constRep = 'constRep' in changes ? changes.constRep : inst.constRep;
  if (op === Op.Const && constRep !== undefined) instCopy.constRep = constRep;
  // J12 bounds-elimination hint; dropping it is safe (only loses an
  // optimization), but preserving it keeps the memory pipeline intact when a
  // scalar pass rebuilds the function.
  if (inst.uncheckedBounds === true) instCopy.uncheckedBounds = true;
  return instCopy;
}

/** Clone one edge. */
export function copyEdge(edge: MEdge): MEdge {
  return { target: edge.target, args: [...edge.args] };
}

/** Clone a terminator including its edges and argument arrays. */
export function copyTerm(term: MTerm): MTerm {
  switch (term.kind) {
    case 'jump':
      return {
        kind: 'jump',
        target: term.target,
        args: [...term.args],
        loc: term.loc,
        step: term.step,
      };
    case 'branch':
      return {
        kind: 'branch',
        cond: term.cond,
        yes: copyEdge(term.yes),
        no: copyEdge(term.no),
        loc: term.loc,
        step: term.step,
      };
    case 'return':
      return { kind: 'return', values: [...term.values], loc: term.loc, step: term.step };
    case 'dispatch':
      return {
        kind: 'dispatch',
        provider: term.provider,
        key: [...term.key],
        args: [...term.args],
        loc: term.loc,
        step: term.step,
      };
    case 'trap':
      return { kind: 'trap', code: term.code, loc: term.loc, step: term.step };
  }
}

/** Every edge leaving a terminator, in source order. */
export function terminatorEdges(term: MTerm): MEdge[] {
  switch (term.kind) {
    case 'jump':
      return [{ target: term.target, args: term.args }];
    case 'branch':
      return [term.yes, term.no];
    default:
      return [];
  }
}

/** Replace every operand of a terminator through `map`. */
export function mapTermValues(term: MTerm, map: (id: ValueId) => ValueId): MTerm {
  switch (term.kind) {
    case 'jump':
      return {
        kind: 'jump',
        target: term.target,
        args: term.args.map(map),
        loc: term.loc,
        step: term.step,
      };
    case 'branch':
      return {
        kind: 'branch',
        cond: map(term.cond),
        yes: { target: term.yes.target, args: term.yes.args.map(map) },
        no: { target: term.no.target, args: term.no.args.map(map) },
        loc: term.loc,
        step: term.step,
      };
    case 'return':
      return { kind: 'return', values: term.values.map(map), loc: term.loc, step: term.step };
    case 'dispatch':
      return {
        kind: 'dispatch',
        provider: term.provider,
        key: term.key.map(map),
        args: term.args.map(map),
        loc: term.loc,
        step: term.step,
      };
    case 'trap':
      return { kind: 'trap', code: term.code, loc: term.loc, step: term.step };
  }
}

/** True when an instruction's effect description makes it observable. */
export function hasObservableEffect(info: EffectInfo): boolean {
  return (
    info.host ||
    info.transfer ||
    info.writes.length > 0 ||
    info.effects.includes(Effect.MemoryRead) ||
    info.effects.includes(Effect.ScalarRead) ||
    info.effects.includes(Effect.VersionedRead) ||
    info.effects.includes(Effect.Event) ||
    info.effects.includes(Effect.Output)
  );
}

/** True for instructions the effect table classifies as side-effect free. */
export function isPure(info: EffectInfo): boolean {
  return !hasObservableEffect(info);
}

/** True for pure instructions that can still throw (div/rem/f2i). */
export function isPureThrowing(info: EffectInfo): boolean {
  return isPure(info) && info.throws;
}

/** Effect description of one instruction. */
export function instEffects(inst: MInst): EffectInfo {
  const info = EFFECT_INFO[inst.op];
  if (info === undefined) throw new Error(`MIR passes failed: unknown opcode "${String(inst.op)}"`);
  return info;
}

/** Kinds understood by the generated `check` template. */
export type CheckKind = 'none' | 'divzero' | 'f2i' | 'bounds';

/** Build a synthetic `Check` that accounts for one source step. */
export function makeCheck(inst: MInst, kind: CheckKind, extra: Partial<MInst> = {}): MInst {
  return {
    op: Op.Check,
    args: extra.args !== undefined ? [...extra.args] : [],
    results: [],
    imm: [kind, ...(extra.imm ?? [])],
    refs: extra.refs !== undefined ? [...extra.refs] : [],
    node: extra.node !== undefined ? extra.node : inst.node,
    loc: extra.loc ?? inst.loc,
    step: extra.step ?? 1,
  };
}

/** Outcome of {@link rebuildFunction}: the function plus the id translation. */
export interface RebuiltFunction {
  readonly fn: MFunction;
  /** old value id → new value id (only defined values survive). */
  readonly map: ReadonlyMap<ValueId, ValueId>;
}

/**
 * Rebuild an `MFunction` from fresh blocks whose operands still use the input
 * value ids, dropping every value that is no longer defined and renumbering
 * the surviving values densely.
 *
 * The input is never modified: every instruction and terminator is copied
 * before the new value ids are written into it.
 */
export function rebuildFunction(fn: MFunction, blocks: readonly MBlock[]): RebuiltFunction {
  const oldDefs = new Map<ValueId, MInst | MBlock>();
  for (const block of blocks) {
    for (const param of block.params) {
      if (oldDefs.has(param)) {
        throw new Error(`MIR passes failed: v${param} is defined more than once`);
      }
      oldDefs.set(param, block);
    }
    for (const inst of block.insts) {
      for (const result of inst.results) {
        if (oldDefs.has(result)) {
          throw new Error(`MIR passes failed: v${result} is defined more than once`);
        }
        oldDefs.set(result, inst);
      }
    }
  }

  const map = new Map<ValueId, ValueId>();
  let next = 0;
  for (let id = 0; id < fn.values.length; id += 1) {
    if (!oldDefs.has(id)) continue;
    map.set(id, next);
    next += 1;
  }
  const translate = (id: ValueId): ValueId => {
    const translated = map.get(id);
    if (translated === undefined) {
      throw new Error(`MIR passes failed: v${id} is used but no longer defined`);
    }
    return translated;
  };
  const translateAll = (ids: readonly ValueId[]): ValueId[] => ids.map(translate);

  const copiedBlocks: MBlock[] = [];
  const newDefs = new Map<ValueId, MInst | MBlock>();
  for (const block of blocks) {
    const params = translateAll(block.params);
    const insts = block.insts.map((inst) => {
      const copied = copyInst(inst, {
        args: translateAll(inst.args),
        results: translateAll(inst.results),
      });
      for (const result of inst.results) newDefs.set(result, copied);
      return copied;
    });
    const term = mapTermValues(block.term, translate);
    const copiedBlock: MBlock = {
      id: block.id,
      params,
      insts,
      term,
      preds: [],
      succs: [],
    };
    for (const param of block.params) newDefs.set(param, copiedBlock);
    copiedBlocks.push(copiedBlock);
  }

  const values: MValue[] = [];
  for (let oldId = 0; oldId < fn.values.length; oldId += 1) {
    const newId = map.get(oldId);
    if (newId === undefined) continue;
    const original = fn.values[oldId]!;
    const def = newDefs.get(oldId);
    if (def === undefined) {
      throw new Error(`MIR passes failed: v${oldId} has no definition after rebuilding`);
    }
    values.push({ id: newId, type: original.type, rep: original.rep, def });
  }

  return {
    fn: { ...fn, blocks: copiedBlocks, values },
    map,
  };
}

/** Block id → block map for one function. */
export function blockMap(fn: MFunction): Map<number, MBlock> {
  return new Map(fn.blocks.map((block) => [block.id, block]));
}

/** Value id → defining block id, for values defined inside the function. */
export function definitionBlocks(fn: MFunction): Map<ValueId, number> {
  const result = new Map<ValueId, number>();
  for (const block of fn.blocks) {
    for (const param of block.params) result.set(param, block.id);
    for (const inst of block.insts) {
      for (const value of inst.results) result.set(value, block.id);
    }
  }
  return result;
}

/** A fresh block id that no existing block uses and that has no source block. */
export function freshBlockId(fn: MFunction): number {
  let id = 0;
  for (const block of fn.blocks) id = Math.max(id, block.id + 1);
  return Math.max(id, fn.source.body?.blocks.length ?? 0);
}

/** Representation of an existing value. */
export function repOf(fn: MFunction, id: ValueId): Rep {
  return fn.values[id]!.rep;
}
