/**
 * MIR structural verifier (J5).
 *
 * Every JIT pass runs this after transforming a function (in tests always, at
 * run time behind `IRJITTuning.debug.verify`). Violations are internal errors:
 * `Error('MIR verification failed: ...')`, never user-facing diagnostics.
 *
 * Checked invariants:
 * - SSA: every value is defined exactly once and definition dominates use;
 * - types: operands and results match each opcode's rules;
 * - edges: edge argument counts/types match the target block parameters;
 * - steps: S-1 sufficient condition (block steps equal its source items);
 * - locations: non-synthetic instructions point at their source position.
 */
import { isFloatType, isIntegerType, isNumericType, isSignedIntegerType } from '../runtime';
import type { ScalarType } from '../types';
import { buildCFG, computeDominators, dominates } from './cfg';
import { Op, OP_VALUES } from './mir';
import type { MBlock, MFunction, MInst, MTerm, ValueId } from './mir';
import type { LowerContext } from './resolve';

const PREDICATES: ReadonlySet<string> = new Set(['eq', 'ne', 'lt', 'le', 'gt', 'ge']);
const INTEGER_WIDTH: Readonly<Record<string, number>> = {
  u8: 8,
  i8: 8,
  u16: 16,
  i16: 16,
  u32: 32,
  i32: 32,
};

interface Definition {
  readonly block: MBlock;
  readonly index: number;
}

class Verifier {
  readonly errors: string[] = [];
  readonly values = new Map<ValueId, ScalarType>();
  readonly definitions = new Map<ValueId, Definition>();
  readonly instBlock = new Map<MInst, Definition>();
  readonly blockById = new Map<number, MBlock>();

  constructor(
    readonly fn: MFunction,
    readonly context: LowerContext | undefined,
  ) {}

  fail(message: string): void {
    this.errors.push(message);
  }

  type(id: ValueId): ScalarType | undefined {
    return this.values.get(id);
  }

  /** Validate the value table and record every definition. */
  checkValues(): void {
    this.fn.values.forEach((value, id) => {
      if (value.id !== id) {
        this.fail(`values[${id}] has id ${value.id}`);
      }
      this.values.set(value.id, value.type);
    });
    this.fn.blocks.forEach((block) => {
      const existing = this.blockById.get(block.id);
      if (existing !== undefined && existing !== block) {
        this.fail(`block id ${block.id} is defined more than once`);
      }
      this.blockById.set(block.id, block);
      for (const param of block.params) {
        this.define(param, { block, index: -1 }, 'block parameter');
      }
      block.insts.forEach((inst, instIndex) => {
        this.instBlock.set(inst, { block, index: instIndex });
        for (const result of inst.results) {
          this.define(result, { block, index: instIndex }, 'instruction result');
        }
      });
    });
    for (const value of this.fn.values) {
      if (!this.definitions.has(value.id)) {
        this.fail(`v${value.id} is never defined`);
        continue;
      }
      const definition = this.definitions.get(value.id)!;
      const def = value.def;
      if ('insts' in def) {
        if (def !== definition.block || !def.params.includes(value.id)) {
          this.fail(`v${value.id} has an inconsistent definition`);
        }
      } else {
        const site = this.instBlock.get(def);
        if (
          site === undefined ||
          site.block !== definition.block ||
          site.index !== definition.index ||
          !def.results.includes(value.id)
        ) {
          this.fail(`v${value.id} has an inconsistent definition`);
        }
      }
    }
  }

  private define(id: ValueId, definition: Definition, kind: string): void {
    if (this.values.get(id) === undefined) {
      this.fail(`v${id} is used as a ${kind} but is outside the value table`);
      return;
    }
    const existing = this.definitions.get(id);
    if (existing !== undefined) {
      this.fail(
        `v${id} is defined more than once (blocks ${existing.block.id} and ${definition.block.id})`,
      );
      return;
    }
    this.definitions.set(id, definition);
  }

  checkStructure(): void {
    const body = this.fn.source.body;
    if (body === undefined) {
      this.fail('source function has no body');
      return;
    }
    if (this.fn.blocks.length === 0) {
      this.fail('function has no blocks');
      return;
    }
    if (this.fn.blocks[0]!.id !== 0) {
      this.fail('the first MIR block must be the entry block');
    }
    body.blocks.forEach((_source, index) => {
      if (this.blockById.get(index) === undefined) {
        this.fail(`source block ${index} has no MIR block`);
      }
    });
    const locations = this.fn.locs.locations;
    this.fn.blocks.forEach((block) => {
      const source = body.blocks[block.id];
      if (source === undefined) {
        // Blocks inserted by later passes carry no source steps (LICM preheaders).
        return;
      }
      if (block.term === undefined) {
        this.fail(`b${block.id} has no terminator`);
        return;
      }
      let steps = block.term.step;
      for (const inst of block.insts) steps += inst.step;
      if (steps !== source.instructions.length + 1) {
        this.fail(
          `b${block.id} accounts for ${steps} steps but its source has ${
            source.instructions.length + 1
          }`,
        );
      }
    });
    for (const location of locations) {
      const sourceBlock = body.blocks[location.blockIndex];
      if (
        sourceBlock === undefined ||
        sourceBlock.id !== location.blockId ||
        location.functionIndex !== this.fn.functionIndex
      ) {
        this.fail(`location for b${location.blockIndex} does not describe this function's source`);
      }
    }
  }

  checkBlocks(): void {
    for (const block of this.fn.blocks) {
      this.checkBlock(block);
    }
  }

  private checkBlock(block: MBlock): void {
    if (block.term === undefined) {
      this.fail(`b${block.id} has no terminator`);
      return;
    }
    if (block.term.loc < 0 || block.term.loc >= this.fn.locs.locations.length) {
      this.fail(`b${block.id} terminator loc ${block.term.loc} is out of range`);
    } else {
      const location = this.fn.locs.locations[block.term.loc]!;
      const source = this.fn.source.body?.blocks[block.id];
      if (
        location.terminator !== true ||
        (source !== undefined && location.blockIndex !== block.id)
      ) {
        this.fail(`b${block.id} terminator loc does not point at its source terminator`);
      }
    }
    for (const param of block.params) {
      if (this.type(param) === undefined)
        this.fail(`b${block.id} has an invalid parameter v${param}`);
    }
    for (const inst of block.insts) {
      this.checkInstruction(block, inst);
    }
    this.checkTerminator(block, block.term);
  }

  private checkValue(id: ValueId, label: string): void {
    if (this.type(id) === undefined) this.fail(`${label}: v${id} is not defined`);
  }

  private expectArgs(inst: MInst, count: number): boolean {
    if (inst.args.length !== count) {
      this.fail(`${inst.op} takes ${count} operand(s), found ${inst.args.length}`);
      return false;
    }
    return true;
  }

  private expectResults(inst: MInst, types: readonly ScalarType[]): boolean {
    if (inst.results.length !== types.length) {
      this.fail(`${inst.op} produces ${types.length} result(s), found ${inst.results.length}`);
      return false;
    }
    types.forEach((type, index) => {
      const actual = this.type(inst.results[index]!);
      if (actual !== type) {
        this.fail(`${inst.op} result ${index} must be ${type}, found ${String(actual)}`);
      }
    });
    return true;
  }

  private expectArgType(inst: MInst, index: number, type: ScalarType): void {
    const actual = this.type(inst.args[index]!);
    if (actual !== type) {
      this.fail(`${inst.op} operand ${index} must be ${type}, found ${String(actual)}`);
    }
  }

  private expectSameArgs(inst: MInst, count: number): ScalarType | undefined {
    if (!this.expectArgs(inst, count)) return undefined;
    const type = this.type(inst.args[0]!);
    if (type === undefined) return undefined;
    for (let index = 1; index < count; index += 1) {
      this.expectArgType(inst, index, type);
    }
    return type;
  }

  private literalString(inst: MInst, index: number): string | undefined {
    const value = inst.imm[index];
    return typeof value === 'string' ? value : undefined;
  }

  private literalType(inst: MInst, index: number): ScalarType | undefined {
    const value = this.literalString(inst, index);
    return value as ScalarType | undefined;
  }

  private checkInstruction(block: MBlock, inst: MInst): void {
    if (!OP_VALUES.has(inst.op)) {
      this.fail(`b${block.id} has an unknown opcode "${String(inst.op)}"`);
      return;
    }
    for (const arg of inst.args) this.checkValue(arg, `b${block.id} ${inst.op}`);
    for (const result of inst.results) this.checkValue(result, `b${block.id} ${inst.op}`);
    if (inst.step !== 0 && inst.step !== 1) {
      this.fail(`b${block.id} ${inst.op} has invalid step ${String(inst.step)}`);
    }
    this.checkListSplit(inst);
    if (inst.loc < 0 || inst.loc >= this.fn.locs.locations.length) {
      this.fail(`b${block.id} ${inst.op} loc ${inst.loc} is out of range`);
    } else if (inst.node !== undefined) {
      const location = this.fn.locs.locations[inst.loc]!;
      const sourceBlock = this.fn.source.body?.blocks[location.blockIndex];
      if (
        location.functionIndex !== this.fn.functionIndex ||
        location.instructionIndex === undefined ||
        sourceBlock === undefined ||
        sourceBlock.id !== location.blockId ||
        sourceBlock.instructions[location.instructionIndex] !== inst.node
      ) {
        this.fail(`b${block.id} ${inst.op} loc does not point at its source instruction`);
      }
    }
    if (inst.op !== Op.Check && inst.op !== Op.Spill) {
      if (inst.node === undefined) this.fail(`b${block.id} ${inst.op} has no source node`);
      if (inst.step !== 1) this.fail(`b${block.id} ${inst.op} must account for one step`);
    }
    if (inst.op === Op.Spill && inst.step !== 0) {
      this.fail('spill must not account for a source step');
    }
    this.checkOpTypes(inst);
  }

  private checkListSplit(inst: MInst): void {
    const split = inst.listSplit;
    if (split === undefined) return;
    let sum = 0;
    for (const length of split) {
      if (!Number.isSafeInteger(length) || length < 0) {
        this.fail(`${inst.op} has an invalid listSplit entry`);
        return;
      }
      sum += length;
    }
    if (sum !== inst.args.length) {
      this.fail(`${inst.op} listSplit covers ${sum} values but has ${inst.args.length} operands`);
    }
    if (inst.op === Op.Checkpoint && split.length !== 2) {
      this.fail('checkpoint requires exactly two ssa-list operands');
    }
  }

  private checkOpTypes(inst: MInst): void {
    switch (inst.op) {
      case Op.Const:
        if (
          !this.expectArgs(inst, 0) ||
          !this.expectResults(inst, [this.expectedConstType(inst)])
        ) {
          return;
        }
        if (inst.imm.length !== 1) this.fail('const requires exactly one literal');
        if (isFloatType(this.expectedConstType(inst))) {
          const rep = inst.constRep;
          if (rep !== 'D' && rep !== 'U') {
            this.fail('float const requires constRep D or U');
          } else if (rep === 'D' && typeof inst.imm[0] !== 'number') {
            this.fail('D const must hold a number');
          } else if (rep === 'U' && !Number.isSafeInteger(inst.imm[0])) {
            this.fail('U const must hold a constant-table index');
          }
        } else if (
          typeof inst.imm[0] !== (this.expectedConstType(inst) === 'bool' ? 'boolean' : 'number')
        ) {
          this.fail('const literal does not match its result type');
        }
        return;
      case Op.BoolNot:
        if (!this.expectArgs(inst, 1)) return;
        this.expectArgType(inst, 0, 'bool');
        this.expectResults(inst, ['bool']);
        return;
      case Op.BoolAnd:
      case Op.BoolOr:
      case Op.BoolXor:
        if (!this.expectArgs(inst, 2)) return;
        this.expectArgType(inst, 0, 'bool');
        this.expectArgType(inst, 1, 'bool');
        this.expectResults(inst, ['bool']);
        return;
      case Op.IntAdd:
      case Op.IntSub:
      case Op.IntMul:
      case Op.IntDiv:
      case Op.IntRem:
      case Op.IntAnd:
      case Op.IntOr:
      case Op.IntXor: {
        const type = this.expectSameArgs(inst, 2);
        if (type !== undefined) {
          if (!isIntegerType(type)) this.fail(`${inst.op} requires integer operands`);
          this.expectResults(inst, [type]);
        }
        return;
      }
      case Op.IntNot: {
        const type = this.expectSameArgs(inst, 1);
        if (type !== undefined) {
          if (!isIntegerType(type)) this.fail('int.not requires an integer operand');
          this.expectResults(inst, [type]);
        }
        return;
      }
      case Op.IntShl:
      case Op.IntLshr:
      case Op.IntAshr: {
        if (!this.expectArgs(inst, 2)) return;
        const type = this.type(inst.args[0]!);
        if (type !== undefined) {
          if (!isIntegerType(type)) this.fail(`${inst.op} requires an integer operand`);
          if (inst.op === Op.IntAshr && !isSignedIntegerType(type)) {
            this.fail('int.ashr requires a signed integer');
          }
          this.expectResults(inst, [type]);
        }
        this.expectArgType(inst, 1, 'u32');
        return;
      }
      case Op.IntCmp:
      case Op.FloatCmp: {
        if (!this.expectArgs(inst, 2)) return;
        const predicate = this.literalString(inst, 0);
        if (predicate === undefined || !PREDICATES.has(predicate)) {
          this.fail(`${inst.op} requires a comparison predicate`);
        }
        const type = this.type(inst.args[0]!);
        if (type !== undefined) {
          const valid = inst.op === Op.IntCmp ? isIntegerType(type) : isFloatType(type);
          if (!valid) this.fail(`${inst.op} has invalid operand type ${type}`);
          this.expectArgType(inst, 1, type);
        }
        this.expectResults(inst, ['bool']);
        return;
      }
      case Op.IntZext:
      case Op.IntSext:
      case Op.IntTrunc:
      case Op.IntReinterpret:
      case Op.ConvertIntToFloat:
      case Op.ConvertFloatToInt:
      case Op.ConvertFloat:
      case Op.Bitcast:
        this.checkConversion(inst);
        return;
      case Op.FloatAdd:
      case Op.FloatSub:
      case Op.FloatMul:
      case Op.FloatDiv: {
        const type = this.expectSameArgs(inst, 2);
        if (type !== undefined) {
          if (!isFloatType(type)) this.fail(`${inst.op} requires float operands`);
          this.expectResults(inst, [type]);
        }
        return;
      }
      case Op.FloatFma: {
        const type = this.expectSameArgs(inst, 3);
        if (type !== undefined) {
          if (!isFloatType(type)) this.fail('float.fma requires float operands');
          this.expectResults(inst, [type]);
        }
        return;
      }
      case Op.FloatIsNaN:
      case Op.FloatIsFinite: {
        if (!this.expectArgs(inst, 1)) return;
        const type = this.type(inst.args[0]!);
        if (type === undefined || !isFloatType(type)) {
          this.fail(`${inst.op} requires a float operand`);
        }
        this.expectResults(inst, ['bool']);
        return;
      }
      case Op.Select: {
        if (!this.expectArgs(inst, 3) || !this.expectResults(inst, [this.resultType(inst, 0)])) {
          return;
        }
        this.expectArgType(inst, 0, 'bool');
        const type = this.type(inst.args[1]!);
        if (type !== undefined) {
          this.expectArgType(inst, 2, type);
          if (this.type(inst.results[0]!) !== type) {
            this.fail(`select result must be ${type}`);
          }
        }
        return;
      }
      case Op.StateLoad:
        if (!this.expectArgs(inst, 0) || !this.expectResults(inst, [this.resultType(inst, 0)])) {
          return;
        }
        this.checkMemory(inst, 0, ['state'], this.type(inst.results[0]!));
        return;
      case Op.StateStore:
        if (!this.expectArgs(inst, 1) || !this.expectResults(inst, [])) return;
        this.checkMemory(inst, 0, ['state'], this.type(inst.args[0]!));
        return;
      case Op.ArrayLoad:
        if (!this.expectArgs(inst, 1) || !this.expectResults(inst, [this.resultType(inst, 0)])) {
          return;
        }
        this.expectArgType(inst, 0, 'u32');
        this.checkMemory(inst, 0, ['array'], this.type(inst.results[0]!));
        return;
      case Op.ArrayStore:
        if (!this.expectArgs(inst, 2) || !this.expectResults(inst, [])) return;
        this.expectArgType(inst, 0, 'u32');
        this.checkMemory(inst, 0, ['array'], this.type(inst.args[1]!));
        return;
      case Op.BytesLoad: {
        if (!this.expectArgs(inst, 1) || !this.expectResults(inst, [this.resultType(inst, 0)])) {
          return;
        }
        this.expectArgType(inst, 0, 'u32');
        this.checkByteOperands(inst, false);
        this.checkMemory(inst, 0, ['bytes', 'inbox']);
        return;
      }
      case Op.BytesStore:
        if (!this.expectArgs(inst, 2) || !this.expectResults(inst, [])) return;
        this.expectArgType(inst, 0, 'u32');
        this.checkByteOperands(inst, true);
        this.checkMemory(inst, 0, ['bytes'], this.type(inst.args[1]!));
        return;
      case Op.BytesCopy:
      case Op.ResourceUpdateBytes:
        if (!this.expectArgs(inst, 3) || !this.expectResults(inst, [])) return;
        this.expectArgType(inst, 0, 'u32');
        this.expectArgType(inst, 1, 'u32');
        this.expectArgType(inst, 2, 'u32');
        if (inst.refs.length !== 2) this.fail(`${inst.op} requires two resource indices`);
        this.checkMemory(inst, 0, ['bytes']);
        this.checkMemory(inst, 1, ['bytes', 'inbox']);
        return;
      case Op.ResourceFillBytes:
        if (!this.expectArgs(inst, 3) || !this.expectResults(inst, [])) return;
        this.expectArgType(inst, 0, 'u32');
        this.expectArgType(inst, 1, 'u32');
        this.expectArgType(inst, 2, 'u8');
        this.checkMemory(inst, 0, ['bytes']);
        return;
      case Op.BridgeSend: {
        if (!this.expectResults(inst, ['bool'])) return;
        if (inst.refs.length !== 1) this.fail('bridge.send requires one output index');
        this.checkOutput(inst, 0, 'scalar-output');
        const output = this.outputAt(inst.refs[0]);
        if (output !== undefined && output.kind === 'scalar-output') {
          if (inst.args.length !== output.params.length) {
            this.fail('bridge.send arguments do not match its output signature');
          }
          output.params.forEach((type, index) => {
            if (index < inst.args.length) this.expectArgType(inst, index, type);
          });
        }
        return;
      }
      case Op.BridgeSendBytes:
        if (!this.expectArgs(inst, 2) || !this.expectResults(inst, ['bool'])) return;
        this.expectArgType(inst, 0, 'u32');
        this.expectArgType(inst, 1, 'u32');
        if (inst.refs.length !== 2) this.fail('bridge.send_bytes requires two indices');
        this.checkOutput(inst, 0, 'bytes-output');
        this.checkMemory(inst, 1, ['bytes', 'inbox']);
        return;
      case Op.Call: {
        if (inst.refs.length !== 1) this.fail('call requires one function index');
        const callee =
          this.context === undefined ? undefined : this.context.model.functions[inst.refs[0]!];
        if (this.context !== undefined && callee === undefined) {
          this.fail(`call target ${inst.refs[0]} is not in the model`);
        }
        if (callee !== undefined) {
          if (inst.args.length !== callee.params.length) {
            this.fail('call arguments do not match the callee signature');
          }
          callee.params.forEach((type, index) => {
            if (index < inst.args.length) this.expectArgType(inst, index, type);
          });
          this.expectResults(inst, callee.results);
        }
        return;
      }
      case Op.EventNow:
        if (!this.expectArgs(inst, 0)) return;
        this.expectResults(inst, ['f64']);
        return;
      case Op.EventAt:
        if (inst.args.length < 1) {
          this.fail('event.at requires a deadline operand');
          return;
        }
        this.expectArgType(inst, 0, 'f64');
        this.expectResults(inst, ['u32']);
        if (inst.refs.length !== 1) this.fail('event.at requires one entry index');
        if (this.context !== undefined) {
          const target = this.context.model.functions[inst.refs[0]!];
          if (target === undefined || target.category !== 'entry') {
            this.fail('event.at target is not an entry function');
          } else if (inst.args.length - 1 !== target.params.length) {
            this.fail('event.at arguments do not match the entry signature');
          } else {
            target.params.forEach((type, index) => {
              this.expectArgType(inst, index + 1, type);
            });
          }
        }
        return;
      case Op.EventCancel:
        if (!this.expectArgs(inst, 1)) return;
        this.expectArgType(inst, 0, 'u32');
        this.expectResults(inst, []);
        return;
      case Op.Checkpoint:
        if (!this.expectResults(inst, [])) return;
        if (inst.refs.length !== 1) this.fail('checkpoint requires one provider index');
        return;
      case Op.Executor:
        if (inst.refs.length !== 1) this.fail('executor requires one executor index');
        return;
      case Op.Check:
      case Op.Spill:
        if (!this.expectResults(inst, [])) return;
        return;
    }
  }

  private resultType(inst: MInst, index: number): ScalarType {
    return this.type(inst.results[index]!) ?? 'bool';
  }

  /** The result type of a `const`, which has no operand to infer it from. */
  private expectedConstType(inst: MInst): ScalarType {
    return this.type(inst.results[0]!) ?? 'bool';
  }

  private checkConversion(inst: MInst): void {
    if (!this.expectArgs(inst, 1)) return;
    const target = this.literalType(inst, 0);
    if (target === undefined) {
      this.fail(`${inst.op} requires a target type literal`);
      return;
    }
    const source = this.type(inst.args[0]!);
    if (source === undefined) return;
    this.expectResults(inst, [target]);
    const width = (type: ScalarType): number => INTEGER_WIDTH[type] ?? 0;
    let valid = false;
    switch (inst.op) {
      case Op.IntZext:
        valid = isIntegerType(source) && isIntegerType(target) && width(target) > width(source);
        break;
      case Op.IntSext:
        valid =
          isIntegerType(source) &&
          isSignedIntegerType(source) &&
          isIntegerType(target) &&
          width(target) > width(source);
        break;
      case Op.IntTrunc:
        valid = isIntegerType(source) && isIntegerType(target) && width(target) < width(source);
        break;
      case Op.IntReinterpret:
        valid =
          isIntegerType(source) &&
          isIntegerType(target) &&
          width(target) === width(source) &&
          isSignedIntegerType(source) !== isSignedIntegerType(target);
        break;
      case Op.ConvertIntToFloat:
        valid = isIntegerType(source) && isFloatType(target);
        break;
      case Op.ConvertFloatToInt:
        valid = isFloatType(source) && isIntegerType(target);
        break;
      case Op.ConvertFloat:
        valid = isFloatType(source) && isFloatType(target);
        break;
      case Op.Bitcast:
        valid =
          (source === 'f32' && (target === 'u32' || target === 'i32')) ||
          ((source === 'u32' || source === 'i32') && target === 'f32');
        break;
      default:
        break;
    }
    if (!valid) this.fail(`${inst.op} cannot convert ${source} to ${target}`);
  }

  private checkByteOperands(inst: MInst, store: boolean): void {
    const type = this.literalType(inst, 0);
    if (type === undefined || !isNumericType(type)) {
      this.fail(`${inst.op} requires a numeric type literal`);
      return;
    }
    const endian = this.literalString(inst, 1);
    if (endian !== 'little' && endian !== 'big') {
      this.fail(`${inst.op} requires a little or big endian literal`);
    }
    if (store) {
      if (inst.args.length > 1) this.expectArgType(inst, 1, type);
    } else {
      const result = this.type(inst.results[0]!);
      if (result !== type) this.fail(`${inst.op} result must be ${type}`);
    }
  }

  private checkMemory(
    inst: MInst,
    refIndex: number,
    kinds: readonly string[],
    expected?: ScalarType,
  ): void {
    const index = inst.refs[refIndex];
    if (index === undefined) {
      this.fail(`${inst.op} is missing resource index ${refIndex}`);
      return;
    }
    const memory = this.context?.model.memories[index];
    if (memory === undefined) return;
    if (!kinds.includes(memory.kind)) {
      this.fail(`${inst.op} resource ${index} must be ${kinds.join(' or ')}`);
    }
    if (expected !== undefined && memory.layout.kind === 'scalar') {
      if (memory.layout.scalarType !== expected) {
        this.fail(`${inst.op} value type does not match resource ${index}`);
      }
    }
  }

  private outputAt(index: number | undefined) {
    if (index === undefined) return undefined;
    return this.context?.model.outputs[index];
  }

  private checkOutput(inst: MInst, refIndex: number, kind: string): void {
    const index = inst.refs[refIndex];
    if (index === undefined) {
      this.fail(`${inst.op} is missing output index ${refIndex}`);
      return;
    }
    const output = this.outputAt(index);
    if (output !== undefined && output.kind !== kind) {
      this.fail(`${inst.op} output ${index} must be ${kind}`);
    }
  }

  private checkTerminator(block: MBlock, term: MTerm): void {
    switch (term.kind) {
      case 'jump':
        this.checkEdge(block, term.target, term.args);
        return;
      case 'branch':
        this.checkValue(term.cond, `b${block.id} branch`);
        if (this.type(term.cond) !== 'bool') {
          this.fail(`b${block.id} branch condition must be bool`);
        }
        this.checkEdge(block, term.yes.target, term.yes.args);
        this.checkEdge(block, term.no.target, term.no.args);
        return;
      case 'return':
        if (term.values.length !== this.fn.results.length) {
          this.fail(
            `b${block.id} returns ${term.values.length} value(s), expected ${this.fn.results.length}`,
          );
        }
        term.values.forEach((value, index) => {
          this.checkValue(value, `b${block.id} return`);
          const expected = this.fn.results[index];
          if (expected !== undefined && this.type(value) !== expected) {
            this.fail(`b${block.id} return value ${index} must be ${expected}`);
          }
        });
        return;
      case 'dispatch': {
        if (
          this.context !== undefined &&
          this.context.model.providers[term.provider] === undefined
        ) {
          this.fail(`b${block.id} dispatch provider ${term.provider} is not in the model`);
        }
        term.key.forEach((value) => this.checkValue(value, `b${block.id} dispatch key`));
        term.args.forEach((value) => this.checkValue(value, `b${block.id} dispatch args`));
        if (this.context !== undefined) {
          const provider = this.context.model.providers[term.provider];
          if (provider !== undefined) {
            if (term.key.length !== provider.keyTypes.length) {
              this.fail(`b${block.id} dispatch key count does not match the provider`);
            }
            if (term.args.length !== provider.params.length) {
              this.fail(`b${block.id} dispatch argument count does not match the provider`);
            }
          }
        }
        return;
      }
      case 'trap':
        if (!Number.isSafeInteger(term.code) || term.code < 0) {
          this.fail(`b${block.id} trap code index is invalid`);
        } else if (
          this.context !== undefined &&
          (term.code >= this.context.constants.length ||
            typeof this.context.constants[term.code] !== 'string')
        ) {
          this.fail(`b${block.id} trap code ${term.code} is not in the constant table`);
        }
        return;
    }
  }

  private checkEdge(block: MBlock, target: number, args: readonly ValueId[]): void {
    const destination = this.blockById.get(target);
    if (destination === undefined) {
      this.fail(`b${block.id} branches to unknown block ${target}`);
      return;
    }
    if (args.length !== destination.params.length) {
      this.fail(
        `b${block.id} passes ${args.length} argument(s) to b${target}, which takes ${destination.params.length}`,
      );
    }
    args.forEach((value, index) => {
      this.checkValue(value, `b${block.id} edge`);
      const param = destination.params[index];
      if (param !== undefined && this.type(value) !== this.type(param)) {
        this.fail(`b${block.id} edge argument ${index} does not match b${target}'s parameter`);
      }
    });
  }

  /** SSA dominance: every definition dominates all of its uses. */
  checkDominance(): void {
    if (this.fn.blocks.some((block) => block.term === undefined)) return;
    const cfg = buildCFG(this.fn);
    const dominators = computeDominators(cfg);
    const checkUse = (useBlock: MBlock, useIndex: number, value: ValueId): void => {
      const definition = this.definitions.get(value);
      if (definition === undefined) return;
      if (!dominators.has(useBlock.id) || !dominators.has(definition.block.id)) return;
      if (definition.block.id === useBlock.id) {
        if (definition.index >= useIndex) {
          this.fail(`v${value} is used in b${useBlock.id} before its definition`);
        }
        return;
      }
      if (!dominates(dominators, definition.block.id, useBlock.id)) {
        this.fail(`v${value} is defined in b${definition.block.id} but used in b${useBlock.id}`);
      }
    };
    for (const block of this.fn.blocks) {
      block.insts.forEach((inst, index) => {
        for (const arg of inst.args) checkUse(block, index, arg);
        for (const result of inst.results) checkUse(block, index + 1, result);
      });
      if (block.term === undefined) continue;
      const end = block.insts.length;
      switch (block.term.kind) {
        case 'jump':
          for (const value of block.term.args) checkUse(block, end, value);
          break;
        case 'branch':
          checkUse(block, end, block.term.cond);
          for (const value of block.term.yes.args) checkUse(block, end, value);
          for (const value of block.term.no.args) checkUse(block, end, value);
          break;
        case 'return':
          for (const value of block.term.values) checkUse(block, end, value);
          break;
        case 'dispatch':
          for (const value of block.term.key) checkUse(block, end, value);
          for (const value of block.term.args) checkUse(block, end, value);
          break;
        case 'trap':
          break;
      }
    }
  }
}

/**
 * Verify one lowered function. Throws `Error('MIR verification failed: ...')`
 * listing every violation found. `context` enables model-dependent checks
 * (callee signatures, resource kinds, constant-table indices).
 */
export function verifyMIR(fn: MFunction, context?: LowerContext): void {
  const verifier = new Verifier(fn, context);
  verifier.checkValues();
  verifier.checkStructure();
  verifier.checkBlocks();
  verifier.checkDominance();
  if (verifier.errors.length > 0) {
    throw new Error(`MIR verification failed: ${verifier.errors.join('; ')}`);
  }
}

/** Throwing S-1 check used by debug builds and by every pass test. */
export function assertStepInvariant(fn: MFunction): void {
  const body = fn.source.body;
  if (body === undefined) throw new Error('MIR verification failed: source function has no body');
  for (const block of fn.blocks) {
    const source = body.blocks[block.id];
    if (source === undefined) continue;
    if (block.term === undefined) {
      throw new Error(`MIR verification failed: b${block.id} has no terminator`);
    }
    const steps = block.insts.reduce((sum, inst) => sum + inst.step, 0) + block.term.step;
    if (steps !== source.instructions.length + 1) {
      throw new Error(
        `MIR verification failed: b${block.id} accounts for ${steps} steps but its source has ${
          source.instructions.length + 1
        }`,
      );
    }
  }
}
