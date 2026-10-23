/**
 * Global value numbering / common subexpression elimination (GVN).
 *
 * Value numbers are assigned by a dominator-tree walk. The available table is
 * a scope chain: an entry defined in a block is visible in its whole dominated
 * subtree and disappears when the walk leaves that subtree. Only pure
 * instructions participate — including *pure but throwing* ones (`int.div`,
 * `int.rem`, `convert.floatToInt`): if the dominating copy throws, the
 * duplicate is unreachable; if it returns, the duplicate computes the same
 * value. The duplicate is replaced by a reference to the dominating result and
 * its original position keeps an empty `Check` so the step count is unchanged.
 *
 * Commutative operators (`add`, `mul`, `and`, `or`, `xor`, `cmp eq/ne`,
 * `bool.and/or/xor`) sort their operands before numbering.
 */
import { EFFECT_INFO } from '../effects';
import { analyzeCFG } from '../cfg';
import { Op } from '../mir';
import type { MBlock, MFunction, MInst, ValueId } from '../mir';
import { copyInst, isPure, makeCheck, rebuildFunction, type CheckKind } from './util';

const COMMUTATIVE: ReadonlySet<Op> = new Set([
  Op.IntAdd,
  Op.IntMul,
  Op.IntAnd,
  Op.IntOr,
  Op.IntXor,
  Op.BoolAnd,
  Op.BoolOr,
  Op.BoolXor,
]);

const COMMUTATIVE_CMP: ReadonlySet<Op> = new Set([Op.IntCmp, Op.FloatCmp]);

function canonical(inst: MInst): { readonly op: Op; readonly commutative: boolean } | undefined {
  if (inst.op === Op.Check || inst.op === Op.Spill) return undefined;
  const info = EFFECT_INFO[inst.op];
  if (info === undefined || !isPure(info)) return undefined;
  if (inst.results.length !== 1) return undefined;
  if (inst.op === Op.Const) return { op: inst.op, commutative: false };
  if (COMMUTATIVE.has(inst.op)) return { op: inst.op, commutative: true };
  if (COMMUTATIVE_CMP.has(inst.op) && (inst.imm[0] === 'eq' || inst.imm[0] === 'ne')) {
    return { op: inst.op, commutative: true };
  }
  return { op: inst.op, commutative: false };
}

/** Stable literal key: JSON would collapse `-0` to `0` and `NaN` to `null`. */
function literalKey(value: number | boolean | string): string {
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return 'NaN';
    return Object.is(value, -0) ? '-0' : String(value);
  }
  return JSON.stringify(value);
}

function keyOf(
  fn: MFunction,
  inst: MInst,
  commutative: boolean,
  rep: (id: ValueId) => ValueId,
): string {
  const args = inst.args.map(rep);
  if (commutative) args.sort((left, right) => left - right);
  const resultType = fn.values[inst.results[0]!]?.type;
  // `constRep` separates a float `D` literal (`imm = [number]`) from a `U`
  // constant-table index (`imm = [index]`); without it a `const 5` could be
  // merged with `const bits#5`.
  const representation = inst.op === Op.Const ? (inst.constRep ?? null) : null;
  return JSON.stringify([
    inst.op,
    resultType,
    representation,
    inst.imm.map(literalKey),
    inst.refs,
    args,
  ]);
}

/** Empty `Check` standing in for a folded duplicate (never a throw site). */
function replacementCheck(inst: MInst): MInst {
  const check: CheckKind = 'none';
  // Preserve the duplicate's accounting: normally one source step, but a
  // hoisted instruction may already be step 0 if passes run in another order.
  return makeCheck(inst, check, { step: inst.step });
}

export function optimizeFunction(fn: MFunction): MFunction {
  const { cfg, dominators } = analyzeCFG(fn);
  const children = new Map<number, number[]>();
  for (const id of cfg.order) children.set(id, []);
  for (const id of cfg.order) {
    const parent = dominators.get(id);
    if (parent !== undefined && parent !== id) children.get(parent)?.push(id);
  }

  const subst = new Map<ValueId, ValueId>();
  const rep = (id: ValueId): ValueId => {
    let current = id;
    for (;;) {
      const next = subst.get(current);
      if (next === undefined || next === current) break;
      current = next;
    }
    // Path compression keeps repeated lookups cheap on long duplicate chains.
    let walk = id;
    while (walk !== current) {
      const next = subst.get(walk)!;
      subst.set(walk, current);
      walk = next;
    }
    return current;
  };

  const work = new Map<number, MBlock>();
  for (const block of fn.blocks) {
    work.set(block.id, {
      id: block.id,
      params: [...block.params],
      insts: block.insts.map((inst) => copyInst(inst)),
      term: block.term,
      preds: [],
      succs: [],
    });
  }

  let changed = false;
  const scopes: Map<string, ValueId>[] = [];

  const lookup = (key: string): ValueId | undefined => {
    for (let index = scopes.length - 1; index >= 0; index -= 1) {
      const found = scopes[index]!.get(key);
      if (found !== undefined) return found;
    }
    return undefined;
  };

  const visit = (id: number): void => {
    const block = work.get(id);
    if (block === undefined) return;
    const scope = new Map<string, ValueId>();
    scopes.push(scope);
    block.insts.forEach((inst, index) => {
      const shape = canonical(inst);
      if (shape === undefined) return;
      const key = keyOf(fn, inst, shape.commutative, rep);
      const existing = lookup(key);
      if (existing !== undefined) {
        subst.set(inst.results[0]!, existing);
        block.insts[index] = replacementCheck(inst);
        changed = true;
        return;
      }
      scope.set(key, inst.results[0]!);
    });
    for (const child of children.get(id) ?? []) visit(child);
    scopes.pop();
  };

  const entry = cfg.order[0];
  if (entry !== undefined) visit(entry);

  if (!changed) return fn;

  // Rewrite every operand (kept instructions, block edges, terminators) and
  // drop the duplicate result values during the rebuild.
  for (const block of work.values()) {
    for (const inst of block.insts) {
      inst.args = inst.args.map(rep);
      inst.results = inst.results.map(rep);
    }
    if (block.term.kind === 'jump') {
      block.term = { ...block.term, args: block.term.args.map(rep) };
    } else if (block.term.kind === 'branch') {
      block.term = {
        ...block.term,
        cond: rep(block.term.cond),
        yes: { target: block.term.yes.target, args: block.term.yes.args.map(rep) },
        no: { target: block.term.no.target, args: block.term.no.args.map(rep) },
      };
    } else if (block.term.kind === 'return') {
      block.term = { ...block.term, values: block.term.values.map(rep) };
    } else if (block.term.kind === 'dispatch') {
      block.term = {
        ...block.term,
        key: block.term.key.map(rep),
        args: block.term.args.map(rep),
      };
    }
  }

  const remaining: MBlock[] = fn.blocks.map((block) => work.get(block.id)!);
  return rebuildFunction(fn, remaining).fn;
}
