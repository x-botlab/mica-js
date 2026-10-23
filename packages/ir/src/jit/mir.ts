/**
 * JIT middle-level IR (MIR) and IR → MIR lowering (J5).
 *
 * The reference IR is an object graph: `Value`s are compared by identity and
 * operands mix `ssa`, `ssa-list`, `literal` and `static` forms. MIR is a flat,
 * numbered form: every value is a `ValueId`, every operand form is expanded
 * into a separate field and every static reference is already resolved to an
 * integer index (see `./resolve`).
 *
 * Lowering is deliberately semantics preserving and performs no optimization:
 * every source instruction becomes exactly one `MInst` with `step = 1` and
 * every source terminator becomes exactly one `MTerm` with `step = 1`, so a
 * path's MIR steps already equal the reference interpreter's step count (the
 * S-1 invariant verified by `./verify`).
 */
import { makeLocation } from '../engine-host';
import { fromNumber, toNumber } from '../float-ieee';
import { isFloatType, isIntegerType, normalizeScalarLiteral } from '../runtime';
import type { IRExecutionLocation } from '../interpreter';
import { fromBoundary } from './float-runtime';
import type {
  EntryRef,
  FloatBits,
  FloatType,
  FunctionDefinition,
  FunctionRef,
  HexBits,
  InstructionNode,
  LifecycleRef,
  ScalarType,
  Terminator,
  Value,
} from '../types';
import type { LowerContext } from './resolve';
import {
  internConstant,
  resolveCall,
  resolveCheckpoint,
  resolveDispatchTerminator,
  resolveEntry,
  resolveExecutor,
  resolveMemory,
  resolveOutput,
  resolveTrapCode,
} from './resolve';

export type { LowerContext, LowerModel } from './resolve';
export { createLowerContext, internConstant } from './resolve';

/** Function-local SSA number; assigned contiguously from 0. */
export type ValueId = number;
/** Index into {@link MFunction.locs}. */
export type LocId = number;

/**
 * MIR opcodes.
 *
 * Core operations use their source instruction name verbatim, so `printMIR`
 * and debugging never need a second table. `const` and `const.bits` share
 * {@link Op.Const}; `jump`/`branch`/`return`/`dispatch`/`trap` are terminators
 * and therefore have no opcode. Synthetic operations below are introduced by
 * later passes.
 */
export enum Op {
  Const = 'const',
  BoolNot = 'bool.not',
  BoolAnd = 'bool.and',
  BoolOr = 'bool.or',
  BoolXor = 'bool.xor',
  IntAdd = 'int.add',
  IntSub = 'int.sub',
  IntMul = 'int.mul',
  IntDiv = 'int.div',
  IntRem = 'int.rem',
  IntAnd = 'int.and',
  IntOr = 'int.or',
  IntXor = 'int.xor',
  IntNot = 'int.not',
  IntShl = 'int.shl',
  IntLshr = 'int.lshr',
  IntAshr = 'int.ashr',
  IntCmp = 'int.cmp',
  IntZext = 'int.zext',
  IntSext = 'int.sext',
  IntTrunc = 'int.trunc',
  IntReinterpret = 'int.reinterpret',
  FloatAdd = 'float.add',
  FloatSub = 'float.sub',
  FloatMul = 'float.mul',
  FloatDiv = 'float.div',
  FloatFma = 'float.fma',
  FloatCmp = 'float.cmp',
  FloatIsNaN = 'float.isNaN',
  FloatIsFinite = 'float.isFinite',
  ConvertIntToFloat = 'convert.intToFloat',
  ConvertFloatToInt = 'convert.floatToInt',
  ConvertFloat = 'convert.float',
  Bitcast = 'bitcast',
  Select = 'select',
  StateLoad = 'state.load',
  StateStore = 'state.store',
  ArrayLoad = 'array.load',
  ArrayStore = 'array.store',
  BytesLoad = 'bytes.load',
  BytesStore = 'bytes.store',
  BytesCopy = 'bytes.copy',
  ResourceUpdateBytes = 'resource.update_bytes',
  ResourceFillBytes = 'resource.fill_bytes',
  BridgeSend = 'bridge.send',
  BridgeSendBytes = 'bridge.send_bytes',
  Call = 'call',
  EventNow = 'event.now',
  EventAt = 'event.at',
  EventCancel = 'event.cancel',
  Checkpoint = 'checkpoint',
  /** Domain instruction executed by the captured executor table. */
  Executor = 'executor',
  /** Synthetic (step = 0) placeholder carrying a check's throwing semantics (J11). */
  Check = 'check',
  /** Synthetic (step = 0) register spill writeback (J12). */
  Spill = 'spill',
  /** Synthetic (step = 1) load replacement that forwards an already available value (J12). */
  Forward = 'forward',
  /** Promoted location read: the result is the promoted local (J12). */
  PromoteLoad = 'promote.load',
  /** Promoted location write: updates the local, keeping the suspended check (J12). */
  PromoteStore = 'promote.store',
  /** Synthetic (step = 0) reload of promoted locals after a barrier (J12). */
  PromoteReload = 'promote.reload',
  /** Synthetic (step = 0) loop-versioning range guard for bounds elimination (J12). */
  BoundsGuard = 'bounds.guard',
}

/** Every valid opcode; used by the verifier. */
export const OP_VALUES: ReadonlySet<Op> = new Set(Object.values(Op));

/**
 * Value representation used by generated code.
 *
 * `bool` and `int` are the JS values of those scalar types; `D` is a JS
 * `number` holding canonical floating bits and `U` is `number | FloatBits`
 * (see J4). `i32u` arrives with J11; J5 never produces it.
 */
export type Rep = 'bool' | 'int' | 'i32u' | 'D' | 'U';

/** One SSA value of a lowered function. */
export interface MValue {
  readonly id: ValueId;
  readonly type: ScalarType;
  rep: Rep;
  def: MInst | MBlock;
}

/**
 * One lowered instruction.
 *
 * `args` is the flattened list of `ssa` and `ssa-list` operands in source
 * order; `imm` holds `literal` operands and `refs` holds resolved `static`
 * operands, each in source order of their own kind. `listSplit` preserves the
 * segment lengths of `ssa-list` operands when there is more than one, so a
 * consumer can recover the grouping of `checkpoint` key/args for example.
 */
export interface MInst {
  op: Op;
  args: ValueId[];
  results: ValueId[];
  imm: readonly (number | boolean | string)[];
  refs: readonly number[];
  listSplit?: readonly number[];
  /** Source node identity; `undefined` for synthetic instructions. */
  readonly node: InstructionNode | undefined;
  readonly loc: LocId;
  /** Source steps accounted for by this instruction; later passes must preserve it. */
  readonly step: 0 | 1;
  /**
   * Only for `Op.Const` with a floating result: `'D'` means `imm[0]` is a JS
   * number, `'U'` means `imm[0]` indexes {@link LowerContext.constants} and
   * holds a frozen `FloatBits` object.
   */
  constRep?: 'D' | 'U';
  /**
   * Set by the bounds-elimination pass on an array/bytes access that the
   * loop-versioning guard proved in range. Code generation then skips the
   * bounds slow path; the original loop copy keeps it.
   */
  uncheckedBounds?: boolean;
}

/** One CFG edge with its block arguments. */
export interface MEdge {
  readonly target: number;
  readonly args: readonly ValueId[];
}

/**
 * Terminators account for one source step, except the synthetic jump that
 * enters an inlined call body (J13); that jump has `step = 0` so the inlined
 * call keeps the reference step count (call 1 + body + return 1).
 */
export type MTerm =
  | { kind: 'jump'; target: number; args: ValueId[]; loc: LocId; step: 0 | 1 }
  | { kind: 'branch'; cond: ValueId; yes: MEdge; no: MEdge; loc: LocId; step: 0 | 1 }
  | { kind: 'return'; values: ValueId[]; loc: LocId; step: 0 | 1 }
  | {
      kind: 'dispatch';
      provider: number;
      key: ValueId[];
      args: ValueId[];
      loc: LocId;
      step: 0 | 1;
    }
  | { kind: 'trap'; code: number; loc: LocId; step: 0 | 1 };

/** One basic block; `id` equals the source block index. */
export interface MBlock {
  readonly id: number;
  params: ValueId[];
  insts: MInst[];
  term: MTerm;
  /** Filled by the CFG analysis. */
  preds: number[];
  /** Filled by the CFG analysis. */
  succs: number[];
}

/**
 * One virtual frame recorded for a location that was copied into a caller by
 * the inlining pass (J13). It names the position in the callee's source and is
 * parallel to {@link LocTable.locations}; `undefined` marks a location that
 * belongs to the compiled function itself.
 */
export interface MInlineFrame {
  readonly functionIndex: number;
  readonly blockIndex: number;
  readonly instructionIndex?: number;
  readonly terminator?: true;
}

/** Per-item source locations; `stepsAfter` and `parent` are filled by later issues. */
export interface LocTable {
  /** One frozen location per source instruction and per terminator, in source order. */
  readonly locations: readonly IRExecutionLocation[];
  /** Steps remaining in the current segment after this item; filled by J6. */
  readonly stepsAfter: Int32Array;
  /**
   * Inlining frame chain; -1 means no parent frame. An inlined instruction's
   * loc points at its own source position and `parent[loc]` points at the call
   * site in the enclosing function, so errors can be expanded layer by layer.
   */
  readonly parent: Int32Array;
  /** Virtual frame for each location id, or `undefined` for the function's own code. */
  readonly inlineFrames: readonly (MInlineFrame | undefined)[];
}

/**
 * Block weights used by tier-2 (J13) to bias generated code layout. Higher
 * values are executed more often according to the tier-1 profile.
 */
export interface LayoutProfile {
  readonly blockWeights: ReadonlyMap<number, number>;
}

/**
 * One storage location promoted to a local variable (J12).
 *
 * `memory` is a resolved model memory index and `index` is the constant array
 * element, or `undefined` for a scalar `state` resource. The generated local
 * names are derived from `id` (`p<id>` for the value, `p<id>d` for its dirty
 * flag), so code generation never interpolates user text.
 */
export interface MPromotion {
  readonly id: number;
  readonly memory: number;
  readonly index: number | undefined;
  readonly type: ScalarType;
}

/** One lowered function or provider artifact. */
export interface MFunction {
  readonly source: FunctionDefinition;
  /** Model function index, or `artifact.index` for generated provider functions. */
  readonly functionIndex: number;
  /** Diagnostic name only; code generation never interpolates it into source. */
  readonly name: string;
  readonly params: ScalarType[];
  readonly results: ScalarType[];
  /** `blocks[0]` is the entry block. */
  blocks: MBlock[];
  values: MValue[];
  readonly locs: LocTable;
  /** Set by {@link import('./cfg').analyzeCFG}; optimistic until then. */
  reducible: boolean;
  /** Storage locations promoted to locals; empty for an unoptimized function. */
  promotions: MPromotion[];
  /**
   * True after the inlining pass copied at least one callee body into this
   * function (J13). Source-block step checks no longer apply: a source block
   * may have been split across the call site and its continuation.
   */
  inlined?: boolean;
}

const OP_BY_NAME: ReadonlyMap<string, Op> = (() => {
  const map = new Map<string, Op>();
  for (const op of Object.values(Op)) map.set(op, op);
  map.set('const.bits', Op.Const);
  return map;
})();

const TERMINATOR_NAMES: ReadonlySet<string> = new Set([
  'jump',
  'branch',
  'return',
  'dispatch',
  'trap',
]);

/**
 * J4 boundary normalization: use `D` only for bit strings that are lowercase
 * and either finite/infinite or the canonical NaN. Everything else must stay
 * a frozen object so the exact bit string survives.
 */
function boundaryFloat(type: FloatType, bits: string): number | FloatBits {
  return fromBoundary(type, { type, bits: bits as HexBits });
}

function initialRep(type: ScalarType): Rep {
  if (type === 'bool') return 'bool';
  return isIntegerType(type) ? 'int' : 'U';
}

/** Normalize integer literals so the reference `-0` quirk never enters MIR. */
function normalizeInteger(value: number): number {
  return value === 0 ? 0 : value;
}

function literalOperand(node: InstructionNode, index: number): boolean | number | string {
  const operand = node.operands[index];
  if (operand?.kind !== 'literal') {
    throw new Error(`MIR lowering failed: ${node.op} operand ${index} must be a literal`);
  }
  return operand.value;
}

interface FlatOperands {
  readonly args: ValueId[];
  readonly imm: (number | boolean | string)[];
  readonly listSplit: number[] | undefined;
}

function flattenOperands(node: InstructionNode, ids: Map<object, ValueId>): FlatOperands {
  const args: ValueId[] = [];
  const imm: (number | boolean | string)[] = [];
  let listSplit: number[] | undefined;
  for (const operand of node.operands) {
    switch (operand.kind) {
      case 'ssa':
        args.push(ids.get(operand.value)!);
        break;
      case 'ssa-list': {
        (listSplit ??= []).push(operand.values.length);
        for (const value of operand.values) args.push(ids.get(value)!);
        break;
      }
      case 'literal':
        imm.push(operand.value);
        break;
      case 'static':
        break;
    }
  }
  return { args, imm, listSplit };
}

/** Resolved static operands, in operand order; `Executor` keeps only its table index. */
function resolveInstructionRefs(node: InstructionNode, op: Op, ctx: LowerContext): number[] {
  switch (op) {
    case Op.Call:
      return [resolveCall(ctx, node)];
    case Op.Checkpoint:
      return [resolveCheckpoint(ctx, node)];
    case Op.EventAt:
      return [resolveEntry(ctx, node)];
    case Op.BridgeSend:
      return [resolveOutput(ctx, node, 0)];
    case Op.BridgeSendBytes:
      return [resolveOutput(ctx, node, 0), resolveMemory(ctx, node, 1)];
    case Op.StateLoad:
    case Op.StateStore:
    case Op.ArrayLoad:
    case Op.ArrayStore:
    case Op.ResourceFillBytes:
      return [resolveMemory(ctx, node, 0)];
    case Op.BytesLoad:
    case Op.BytesStore:
      return [resolveMemory(ctx, node, 2)];
    case Op.BytesCopy:
    case Op.ResourceUpdateBytes:
      return [resolveMemory(ctx, node, 0), resolveMemory(ctx, node, 2)];
    default:
      return [];
  }
}

interface LoweredInstruction {
  readonly inst: MInst;
  readonly constRep: 'D' | 'U' | undefined;
}

function lowerInstruction(
  node: InstructionNode,
  loc: LocId,
  ids: Map<object, ValueId>,
  ctx: LowerContext,
): LoweredInstruction {
  const flat = flattenOperands(node, ids);
  const results = node.results.map((value) => ids.get(value)!);
  if (node.op === 'const' || node.op === 'const.bits') {
    const type = node.results[0]!.type;
    const raw = literalOperand(node, 0);
    let imm: readonly (number | boolean | string)[];
    let constRep: 'D' | 'U' | undefined;
    if (node.op === 'const.bits') {
      if (type !== 'f32' && type !== 'f64') {
        throw new Error('MIR lowering failed: const.bits requires a float result');
      }
      const normalized = boundaryFloat(type, raw as string);
      if (typeof normalized === 'number') {
        imm = [normalized];
        constRep = 'D';
      } else {
        imm = [internConstant(ctx, normalized)];
        constRep = 'U';
      }
    } else if (isFloatType(type)) {
      // Canonicalize through the reference conversion so NaN and f32 rounding match.
      imm = [toNumber(fromNumber(type as FloatType, raw as number))];
      constRep = 'D';
    } else {
      const value = normalizeScalarLiteral(type, raw);
      imm = [typeof value === 'number' ? normalizeInteger(value) : value];
    }
    return {
      inst: {
        op: Op.Const,
        args: [],
        results,
        imm,
        refs: [],
        node,
        loc,
        step: 1,
        ...(constRep === undefined ? {} : { constRep }),
      },
      constRep,
    };
  }
  if (TERMINATOR_NAMES.has(node.op)) {
    throw new Error(`MIR lowering failed: ${node.op} must be encoded as a block terminator`);
  }
  const op = OP_BY_NAME.get(node.op);
  if (op === undefined) {
    return {
      inst: {
        op: Op.Executor,
        args: flat.args,
        results,
        imm: flat.imm,
        refs: [resolveExecutor(ctx, node.op)],
        ...(flat.listSplit === undefined ? {} : { listSplit: flat.listSplit }),
        node,
        loc,
        step: 1,
      },
      constRep: undefined,
    };
  }
  return {
    inst: {
      op,
      args: flat.args,
      results,
      imm: flat.imm,
      refs: resolveInstructionRefs(node, op, ctx),
      ...(flat.listSplit === undefined ? {} : { listSplit: flat.listSplit }),
      node,
      loc,
      step: 1,
    },
    constRep: undefined,
  };
}

function lowerTerminator(
  term: Terminator,
  loc: LocId,
  ids: Map<object, ValueId>,
  blockIndexByIdentity: Map<object, number>,
  ctx: LowerContext,
): MTerm {
  const target = (block: object): number => {
    const index = blockIndexByIdentity.get(block);
    if (index === undefined) {
      throw new Error('MIR lowering failed: terminator target belongs to another function');
    }
    return index;
  };
  const values = (list: readonly Value[]): ValueId[] => {
    const result: ValueId[] = [];
    for (const value of list) {
      const id = ids.get(value);
      if (id === undefined) {
        throw new Error('MIR lowering failed: terminator references an unknown value');
      }
      result.push(id);
    }
    return result;
  };
  switch (term.kind) {
    case 'jump':
      return { kind: 'jump', target: target(term.target), args: values(term.args), loc, step: 1 };
    case 'branch':
      return {
        kind: 'branch',
        cond: values([term.condition])[0]!,
        yes: { target: target(term.yes.target), args: values(term.yes.args) },
        no: { target: target(term.no.target), args: values(term.no.args) },
        loc,
        step: 1,
      };
    case 'return':
      return { kind: 'return', values: values(term.values), loc, step: 1 };
    case 'dispatch':
      return {
        kind: 'dispatch',
        provider: resolveDispatchTerminator(ctx, term),
        key: values(term.key),
        args: values(term.args),
        loc,
        step: 1,
      };
    case 'trap':
      return { kind: 'trap', code: resolveTrapCode(ctx, term.code), loc, step: 1 };
  }
}

/** Any author-facing function handle accepted by {@link lowerFunction}. */
export type LowerableFunction = FunctionDefinition | FunctionRef | EntryRef | LifecycleRef;

function resolveDefinition(ctx: LowerContext, target: LowerableFunction): FunctionDefinition {
  if (typeof (target as FunctionRef).body !== 'function') {
    return target as FunctionDefinition;
  }
  const definition = ctx.model.functions.find(
    (candidate) => candidate.ref === (target as FunctionRef),
  );
  if (definition === undefined) {
    throw new Error('MIR lowering failed: function handle is not part of the model');
  }
  return definition;
}

/**
 * Lower one validated function (or provider artifact) to MIR.
 *
 * `functionIndex` and `name` default to the model index and declared name;
 * provider artifacts pass `artifact.index` and `${provider}#${keyId}`.
 */
export function lowerFunction(
  ctx: LowerContext,
  target: LowerableFunction,
  functionIndex?: number,
  name?: string,
): MFunction {
  const fn = resolveDefinition(ctx, target);
  const body = fn.body;
  if (body === undefined) {
    throw new Error(`MIR lowering failed: function "${fn.name}" has no body`);
  }
  const index = functionIndex ?? ctx.functionIndices.get(fn.ref);
  if (index === undefined) {
    throw new Error(
      `MIR lowering failed: function "${fn.name}" is not part of the lowering context`,
    );
  }

  const ids = new Map<object, ValueId>();
  const types: ScalarType[] = [];
  const initialReps: Rep[] = [];
  const register = (value: { readonly type: ScalarType }): void => {
    ids.set(value, types.length);
    types.push(value.type);
    initialReps.push(initialRep(value.type));
  };
  for (const block of body.blocks) {
    for (const param of block.params) register(param);
    for (const instruction of block.instructions) {
      for (const result of instruction.results) register(result);
    }
  }

  const blockIndexByIdentity = new Map<object, number>();
  body.blocks.forEach((block, blockIndex) => blockIndexByIdentity.set(block, blockIndex));

  const locations: IRExecutionLocation[] = [];
  const pushLocation = (blockIndex: number, instructionIndex: number | undefined): LocId => {
    const loc = locations.length;
    locations.push(makeLocation(index, fn, blockIndex, body.blocks[blockIndex]!, instructionIndex));
    return loc;
  };

  const defs: (MInst | MBlock)[] = new Array<MInst | MBlock>(types.length);
  const terminatorOf = (block: (typeof body.blocks)[number]): Terminator => {
    if (block.terminator === undefined) {
      throw new Error(`MIR lowering failed: block ${block.id} has no terminator`);
    }
    return block.terminator;
  };
  const blocks: MBlock[] = body.blocks.map((block, blockIndex) => {
    const params = block.params.map((param) => ids.get(param)!);
    const insts: MInst[] = block.instructions.map((instruction, instructionIndex) => {
      const loc = pushLocation(blockIndex, instructionIndex);
      const lowered = lowerInstruction(instruction, loc, ids, ctx);
      for (const result of lowered.inst.results) defs[result] = lowered.inst;
      if (lowered.constRep !== undefined && lowered.inst.results.length > 0) {
        initialReps[lowered.inst.results[0]!] = lowered.constRep;
      }
      return lowered.inst;
    });
    const termLoc = pushLocation(blockIndex, undefined);
    const term = lowerTerminator(terminatorOf(block), termLoc, ids, blockIndexByIdentity, ctx);
    const mblock: MBlock = { id: blockIndex, params, insts, term, preds: [], succs: [] };
    for (const param of params) defs[param] = mblock;
    return mblock;
  });

  const values: MValue[] = types.map((type, id) => {
    const def = defs[id];
    if (def === undefined) {
      throw new Error(`MIR lowering failed: value ${id} has no definition`);
    }
    return { id, type, rep: initialReps[id]!, def };
  });

  return {
    source: fn,
    functionIndex: index,
    name: name ?? fn.name,
    params: [...fn.params],
    results: [...fn.results],
    blocks,
    values,
    locs: {
      locations: Object.freeze(locations),
      stepsAfter: new Int32Array(locations.length).fill(-1),
      parent: new Int32Array(locations.length).fill(-1),
      inlineFrames: Object.freeze(
        new Array<MInlineFrame | undefined>(locations.length).fill(undefined),
      ),
    },
    reducible: true,
    promotions: [],
  };
}

function formatValue(id: ValueId): string {
  return `v${id}`;
}

function formatLiteral(value: number | boolean | string): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return 'NaN';
    if (value === Infinity) return 'Infinity';
    if (value === -Infinity) return '-Infinity';
    return Object.is(value, -0) ? '-0' : String(value);
  }
  return String(value);
}

function instructionName(inst: MInst): string {
  return inst.op === Op.Executor ? (inst.node?.op ?? inst.op) : inst.op;
}

function formatInstruction(inst: MInst): string {
  const result = inst.results.length === 0 ? '' : `${inst.results.map(formatValue).join(', ')} = `;
  if (inst.op === Op.Const) {
    const fromTable = inst.constRep === 'U';
    return `${result}const ${
      fromTable ? `bits#${String(inst.imm[0])}` : formatLiteral(inst.imm[0]!)
    }`;
  }
  const imm = inst.imm.length === 0 ? '' : `(${inst.imm.map(formatLiteral).join(', ')})`;
  const refs = inst.refs.length === 0 ? '' : ` [#${inst.refs.join(', #')}]`;
  const args = inst.args.length === 0 ? '' : ` ${inst.args.map(formatValue).join(', ')}`;
  return `${result}${instructionName(inst)}${imm}${refs}${args}`;
}

function formatTerm(term: MTerm): string {
  switch (term.kind) {
    case 'jump':
      return `jump b${term.target}(${term.args.map(formatValue).join(', ')})`;
    case 'branch':
      return `branch ${formatValue(term.cond)} ? b${term.yes.target}(${term.yes.args
        .map(formatValue)
        .join(', ')}) : b${term.no.target}(${term.no.args.map(formatValue).join(', ')})`;
    case 'return':
      return `return (${term.values.map(formatValue).join(', ')})`;
    case 'dispatch':
      return `dispatch #${term.provider} key(${term.key
        .map(formatValue)
        .join(', ')}) args(${term.args.map(formatValue).join(', ')})`;
    case 'trap':
      return `trap code#${term.code}`;
  }
}

/**
 * Stable textual MIR dump for tests and debugging.
 *
 * The output is part of the J5 test surface: keep it deterministic and
 * independent of object identity.
 */
export function printMIR(fn: MFunction): string {
  const lines: string[] = [];
  lines.push(
    `function ${fn.name}#${fn.functionIndex}(${fn.params.join(', ')}) -> (${fn.results.join(
      ', ',
    )})`,
  );
  for (const block of fn.blocks) {
    const params = block.params
      .map((param) => `${formatValue(param)}: ${fn.values[param]!.type}`)
      .join(', ');
    lines.push(`  b${block.id}(${params}):`);
    for (const inst of block.insts) lines.push(`    ${formatInstruction(inst)}`);
    lines.push(`    ${formatTerm(block.term)}`);
  }
  return lines.join('\n');
}
