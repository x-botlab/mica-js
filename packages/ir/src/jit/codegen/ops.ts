/**
 * JavaScript expression templates for every MIR opcode (J6).
 *
 * Correctness notes for the integer table:
 * - every operand is a JS number inside int32 or uint32 range, so `a + b`,
 *   `a - b` and `a & b` are exact before they are wrapped;
 * - `(a / b) | 0` truncates toward zero for 32-bit integers and also wraps
 *   `MIN / -1`;
 * - every `W(T, ...)` maps `-0` to `0`.
 *
 * The emitter never interpolates user strings: types, endianness, trap codes,
 * resource references and source nodes all go through the constant table.
 */
import { isFloatType } from '../../runtime';
import type { NumericType, ScalarType } from '../../types';
import { Op } from '../mir';
import type { MFunction, MInst, Rep, ValueId } from '../mir';

/** Constant pool shared by all generated functions of one module. */
export class ConstantPool {
  readonly values: unknown[];
  readonly #indices: Map<unknown, number>;

  constructor(seed: readonly unknown[] = []) {
    this.values = [...seed];
    this.#indices = new Map(seed.map((value, index) => [value, index]));
  }

  intern(value: unknown): number {
    const existing = this.#indices.get(value);
    if (existing !== undefined) return existing;
    const index = this.values.length;
    this.values.push(value);
    this.#indices.set(value, index);
    return index;
  }

  at(index: number): unknown {
    return this.values[index];
  }
}

/** Everything an opcode template needs from the surrounding function emitter. */
export interface OpsContext {
  readonly fn: MFunction;
  readonly le: boolean;
  readonly pool: ConstantPool;
  /** Append one generated line (the emitter owns indentation). */
  line(text: string): void;
  /** Intern a constant and return its `K<n>` reference. */
  constant(value: unknown): string;
  /** Reference an already-interned index (pre-lowered constants). */
  constantAt(index: number): string;
  /** Pre-fetched storage record name (`S<n>`). */
  resource(index: number): string;
  /** Resolved memory definition for a model memory index. */
  memory(index: number): unknown;
  /** Fresh temporary variable (`t0`, `t1`, ...). */
  temp(): string;
  /** Value local (`v<n>`). */
  value(id: ValueId): string;
  /** Numeric expression of a value (U floats are converted with `H.toNum`). */
  numeric(id: ValueId): string;
  /** SSA boundary expression of a value (floats become frozen `FloatBits`). */
  boundary(id: ValueId): string;
  readonly typeOf: (id: ValueId) => ScalarType;
  readonly repOf: (id: ValueId) => Rep;
  /** Constant reference for a scalar type literal. */
  typeConstant(type: ScalarType): string;
  /** True when the callee may transfer control to a provider artifact. */
  readonly hasTransfer: (callee: number) => boolean;
  /** Saved depth variable of the compiled function. */
  readonly depthName: string;
  /** Artifact dependency set, when compiling a provider artifact. */
  readonly artifactDependencies: readonly unknown[] | undefined;
}

const INTEGER_WIDTH: Readonly<Record<string, number>> = {
  u8: 8,
  i8: 8,
  u16: 16,
  i16: 16,
  u32: 32,
  i32: 32,
};

const NUMERIC_WIDTH: Readonly<Record<NumericType, number>> = {
  u8: 1,
  i8: 1,
  u16: 2,
  i16: 2,
  u32: 4,
  i32: 4,
  f32: 4,
  f64: 8,
};

const PREDICATE: Readonly<Record<string, string>> = {
  eq: '===',
  ne: '!==',
  lt: '<',
  le: '<=',
  gt: '>',
  ge: '>=',
};

/** Numeric literal: only safe integers, round-tripping floats, and specials. */
export function numberLiteral(value: number): string {
  if (Number.isNaN(value)) return 'NaN';
  if (value === Infinity) return 'Infinity';
  if (value === -Infinity) return '-Infinity';
  if (Object.is(value, -0)) return '-0';
  return String(value);
}

function widthOf(type: ScalarType): number {
  return INTEGER_WIDTH[type as string] ?? 0;
}

function mask(bits: number): string {
  return bits >= 32 ? '0xffffffff' : String(2 ** bits - 1);
}

/** `W(T, x)`: wrap an int32/uint32-range number to the width of `T`. */
export function wrap(type: ScalarType, expression: string): string {
  switch (type) {
    case 'i8':
      return `((${expression}) << 24 >> 24)`;
    case 'u8':
      return `((${expression}) & 255)`;
    case 'i16':
      return `((${expression}) << 16 >> 16)`;
    case 'u16':
      return `((${expression}) & 65535)`;
    case 'u32':
      return `((${expression}) >>> 0)`;
    case 'i32':
    default:
      return `((${expression}) | 0)`;
  }
}

function convertResult(context: OpsContext, type: ScalarType, expression: string): string {
  return isFloatType(type)
    ? `H.fromBoundary(${context.typeConstant(type)}, ${expression})`
    : expression;
}

function assignment(context: OpsContext, result: ValueId, expression: string): void {
  context.line(`${context.value(result)} = ${expression};`);
}

/** Load from a pre-fetched scalar record. */
function fastScalarLoad(
  context: OpsContext,
  record: string,
  index: string,
  type: ScalarType,
): string {
  if (context.le) {
    switch (type) {
      case 'bool':
        return `${record}.view[${index}] !== 0`;
      case 'f32':
        return `H.fromRaw32(${record}.raw[${index}])`;
      case 'f64':
        return `H.fromRaw64(${record}.raw[(${index}) * 2 + 1], ${record}.raw[(${index}) * 2])`;
      default:
        return `${record}.view[${index}]`;
    }
  }
  // Big-endian hosts have no typed views; scalar bytes are still stored
  // little-endian, so read them with an explicit little-endian DataView.
  const offset = `${index} * ${NUMERIC_WIDTH[type as NumericType] ?? 1}`;
  switch (type) {
    case 'bool':
      return `${record}.data.getUint8(${offset}) !== 0`;
    case 'f32':
      return `H.fromRaw32(${record}.data.getUint32(${offset}, true))`;
    case 'f64':
      return `H.fromRaw64(${record}.data.getUint32((${offset}) + 4, true), ${record}.data.getUint32(${offset}, true))`;
    default:
      return `${record}.data.${dataViewGetter(type)}(${offset}, true)`;
  }
}

function dataViewGetter(type: ScalarType): string {
  switch (type) {
    case 'bool':
    case 'u8':
      return 'getUint8';
    case 'i8':
      return 'getInt8';
    case 'u16':
      return 'getUint16';
    case 'i16':
      return 'getInt16';
    case 'u32':
      return 'getUint32';
    case 'i32':
      return 'getInt32';
    case 'f32':
      return 'getUint32';
    case 'f64':
      return 'getUint32';
    default:
      return 'getUint32';
  }
}

function dataViewSetter(type: ScalarType): string {
  switch (type) {
    case 'bool':
    case 'u8':
      return 'setUint8';
    case 'i8':
      return 'setInt8';
    case 'u16':
      return 'setUint16';
    case 'i16':
      return 'setInt16';
    case 'u32':
      return 'setUint32';
    case 'i32':
      return 'setInt32';
    case 'f32':
      return 'setUint32';
    case 'f64':
      return 'setUint32';
    default:
      return 'setUint32';
  }
}

/** Emit one instruction; multi-result instructions assign every result. */
export function emitInstruction(inst: MInst, context: OpsContext): void {
  const results = inst.results;
  const arg = (index: number): string => context.value(inst.args[index]!);
  const num = (index: number): string => context.numeric(inst.args[index]!);
  const type = results.length > 0 ? context.typeOf(results[0]!) : context.typeOf(inst.args[0]!);

  switch (inst.op) {
    case Op.Const: {
      const result = results[0]!;
      const value = inst.imm[0]!;
      let expression: string;
      if (typeof value === 'boolean') {
        expression = value ? 'true' : 'false';
      } else if (inst.constRep === 'U') {
        expression = context.constantAt(value as number);
      } else {
        expression = numberLiteral(value as number);
      }
      assignment(context, result, expression);
      return;
    }
    case Op.BoolNot:
      assignment(context, results[0]!, `!${arg(0)}`);
      return;
    case Op.BoolAnd:
      assignment(context, results[0]!, `${arg(0)} && ${arg(1)}`);
      return;
    case Op.BoolOr:
      assignment(context, results[0]!, `${arg(0)} || ${arg(1)}`);
      return;
    case Op.BoolXor:
      assignment(context, results[0]!, `${arg(0)} !== ${arg(1)}`);
      return;
    case Op.IntAdd:
      assignment(context, results[0]!, wrap(type, `${arg(0)} + ${arg(1)}`));
      return;
    case Op.IntSub:
      assignment(context, results[0]!, wrap(type, `${arg(0)} - ${arg(1)}`));
      return;
    case Op.IntMul:
      assignment(context, results[0]!, wrap(type, `Math.imul(${arg(0)}, ${arg(1)})`));
      return;
    case Op.IntDiv: {
      const node = context.constant(inst.node!);
      const fail = `H.scalar(${node}, [${arg(0)}, ${arg(1)}])`;
      const quotient =
        type === 'u32'
          ? `((${arg(0)} / ${arg(1)}) >>> 0)`
          : wrap(type, `(${arg(0)} / ${arg(1)}) | 0`);
      assignment(context, results[0]!, `${arg(1)} === 0 ? ${fail} : ${quotient}`);
      return;
    }
    case Op.IntRem: {
      const node = context.constant(inst.node!);
      const fail = `H.scalar(${node}, [${arg(0)}, ${arg(1)}])`;
      assignment(
        context,
        results[0]!,
        `${arg(1)} === 0 ? ${fail} : ${wrap(type, `${arg(0)} % ${arg(1)}`)}`,
      );
      return;
    }
    case Op.IntAnd:
      assignment(context, results[0]!, wrap(type, `${arg(0)} & ${arg(1)}`));
      return;
    case Op.IntOr:
      assignment(context, results[0]!, wrap(type, `${arg(0)} | ${arg(1)}`));
      return;
    case Op.IntXor:
      assignment(context, results[0]!, wrap(type, `${arg(0)} ^ ${arg(1)}`));
      return;
    case Op.IntNot:
      assignment(context, results[0]!, wrap(type, `~${arg(0)}`));
      return;
    case Op.IntShl: {
      const width = widthOf(type);
      assignment(
        context,
        results[0]!,
        `${arg(1)} >= ${width} ? 0 : ${wrap(type, `${arg(0)} << ${arg(1)}`)}`,
      );
      return;
    }
    case Op.IntLshr: {
      const width = widthOf(type);
      const shift =
        type === 'u32'
          ? `${arg(0)} >>> ${arg(1)}`
          : wrap(type, `(${arg(0)} & ${mask(width)}) >>> ${arg(1)}`);
      assignment(context, results[0]!, `${arg(1)} >= ${width} ? 0 : ${shift}`);
      return;
    }
    case Op.IntAshr: {
      const width = widthOf(type);
      assignment(
        context,
        results[0]!,
        `${arg(1)} >= ${width} ? (${arg(0)} < 0 ? -1 : 0) : (${arg(0)} >> ${arg(1)})`,
      );
      return;
    }
    case Op.IntCmp: {
      const predicate = PREDICATE[String(inst.imm[0])];
      if (predicate === undefined)
        throw new Error(`unsupported int.cmp predicate: ${String(inst.imm[0])}`);
      assignment(context, results[0]!, `${arg(0)} ${predicate} ${arg(1)}`);
      return;
    }
    case Op.IntZext: {
      const source = context.typeOf(inst.args[0]!);
      const bits = widthOf(source);
      assignment(context, results[0]!, bits >= 32 ? arg(0) : `(${arg(0)} & ${mask(bits)})`);
      return;
    }
    case Op.IntSext:
    case Op.IntTrunc:
    case Op.IntReinterpret:
      assignment(context, results[0]!, wrap(type, arg(0)));
      return;
    case Op.FloatAdd:
      assignment(
        context,
        results[0]!,
        type === 'f32' ? `Math.fround(${num(0)} + ${num(1)})` : `(${num(0)} + ${num(1)})`,
      );
      return;
    case Op.FloatSub:
      assignment(
        context,
        results[0]!,
        type === 'f32' ? `Math.fround(${num(0)} - ${num(1)})` : `(${num(0)} - ${num(1)})`,
      );
      return;
    case Op.FloatMul:
      assignment(
        context,
        results[0]!,
        type === 'f32' ? `Math.fround(${num(0)} * ${num(1)})` : `(${num(0)} * ${num(1)})`,
      );
      return;
    case Op.FloatDiv:
      assignment(
        context,
        results[0]!,
        type === 'f32' ? `Math.fround(${num(0)} / ${num(1)})` : `(${num(0)} / ${num(1)})`,
      );
      return;
    case Op.FloatFma: {
      const helper = type === 'f32' ? 'H.fma32' : 'H.fma64';
      assignment(context, results[0]!, `${helper}(${num(0)}, ${num(1)}, ${num(2)})`);
      return;
    }
    case Op.FloatCmp: {
      const predicate = PREDICATE[String(inst.imm[0])];
      if (predicate === undefined) {
        throw new Error(`unsupported float.cmp predicate: ${String(inst.imm[0])}`);
      }
      assignment(context, results[0]!, `${num(0)} ${predicate} ${num(1)}`);
      return;
    }
    case Op.FloatIsNaN:
      assignment(context, results[0]!, `${num(0)} !== ${num(0)}`);
      return;
    case Op.FloatIsFinite:
      assignment(context, results[0]!, `Number.isFinite(${num(0)})`);
      return;
    case Op.ConvertIntToFloat:
      assignment(context, results[0]!, type === 'f32' ? `Math.fround(${arg(0)})` : arg(0));
      return;
    case Op.ConvertFloatToInt: {
      const node = context.constant(inst.node!);
      assignment(context, results[0]!, `H.floatToInt(${node}, ${num(0)})`);
      return;
    }
    case Op.ConvertFloat:
      assignment(context, results[0]!, type === 'f32' ? `Math.fround(${num(0)})` : num(0));
      return;
    case Op.Bitcast: {
      const source = context.typeOf(inst.args[0]!);
      if (source === 'f32') {
        assignment(context, results[0]!, wrap(type, `H.raw32(${arg(0)})`));
      } else {
        assignment(context, results[0]!, `H.fromRaw32(${arg(0)})`);
      }
      return;
    }
    case Op.Select: {
      const result = results[0]!;
      assignment(context, result, `${arg(0)} ? ${arg(1)} : ${arg(2)}`);
      return;
    }
    case Op.StateLoad: {
      const memory = inst.refs[0]!;
      const record = context.resource(memory);
      assignment(context, results[0]!, fastScalarLoad(context, record, '0', type));
      return;
    }
    case Op.ArrayLoad: {
      const memory = inst.refs[0]!;
      const record = context.resource(memory);
      const ref = context.constant(context.memory(memory));
      const fast = fastScalarLoad(context, record, `(${arg(0)})`, type);
      const slow = `H.storage.loadArray(${ref}, ${arg(0)})`;
      assignment(context, results[0]!, `${arg(0)} < ${record}.length ? ${fast} : ${slow}`);
      return;
    }
    case Op.StateStore: {
      const memory = inst.refs[0]!;
      const record = context.resource(memory);
      const value = context.value(inst.args[0]!);
      const boundary = context.boundary(inst.args[0]!);
      const valueType = context.typeOf(inst.args[0]!);
      const reference = context.constant(context.memory(memory));
      context.line(`if (H.ctl.suspended !== 0) {`);
      context.line(`  H.storage.storeState(${reference}, ${boundary});`);
      context.line('} else {');
      if (context.le) {
        if (valueType === 'f32') {
          context.line(`  ${record}.raw[0] = H.raw32(${value});`);
        } else if (valueType === 'f64') {
          context.line(`  H.raw64(${value}, H.scratch);`);
          context.line(`  ${record}.raw[0] = H.scratch[0];`);
          context.line(`  ${record}.raw[1] = H.scratch[1];`);
        } else if (valueType === 'bool') {
          context.line(`  ${record}.view[0] = ${value} ? 1 : 0;`);
        } else {
          context.line(`  ${record}.view[0] = ${value};`);
        }
      } else {
        writeDataView(context, record, '0', valueType, value);
      }
      context.line(`  if (${record}.tracked()) H.advance(${record});`);
      context.line('}');
      return;
    }
    case Op.ArrayStore: {
      const memory = inst.refs[0]!;
      const record = context.resource(memory);
      const index = context.value(inst.args[0]!);
      const value = context.value(inst.args[1]!);
      const boundary = context.boundary(inst.args[1]!);
      const valueType = context.typeOf(inst.args[1]!);
      const reference = context.constant(context.memory(memory));
      context.line(`if (H.ctl.suspended !== 0 || !(${index} < ${record}.length)) {`);
      context.line(`  H.storage.storeArray(${reference}, ${index}, ${boundary});`);
      context.line('} else {');
      if (context.le) {
        if (valueType === 'f32') {
          context.line(`  ${record}.raw[${index}] = H.raw32(${value});`);
        } else if (valueType === 'f64') {
          context.line(`  H.raw64(${value}, H.scratch);`);
          context.line(`  ${record}.raw[(${index}) * 2] = H.scratch[0];`);
          context.line(`  ${record}.raw[(${index}) * 2 + 1] = H.scratch[1];`);
        } else if (valueType === 'bool') {
          context.line(`  ${record}.view[${index}] = ${value} ? 1 : 0;`);
        } else {
          context.line(`  ${record}.view[${index}] = ${value};`);
        }
      } else {
        writeDataView(context, record, index, valueType, value);
      }
      context.line(`  if (${record}.tracked()) H.advance(${record});`);
      context.line('}');
      return;
    }
    case Op.BytesLoad: {
      const memory = inst.refs[0]!;
      const record = context.resource(memory);
      const numeric = inst.imm[0] as NumericType;
      const endian = inst.imm[1] as string;
      const width = NUMERIC_WIDTH[numeric];
      const little = endian === 'little';
      const offset = context.value(inst.args[0]!);
      const reference = context.constant(context.memory(memory));
      const fast = readDataView(context, record, offset, numeric, little);
      const slow = `H.storage.loadBytes(${context.constant(inst.imm[0])}, ${context.constant(
        inst.imm[1],
      )}, ${reference}, ${offset})`;
      assignment(
        context,
        results[0]!,
        `${offset} <= ${record}.length - ${width} ? ${fast} : ${slow}`,
      );
      return;
    }
    case Op.BytesStore: {
      const memory = inst.refs[0]!;
      const record = context.resource(memory);
      const numeric = inst.imm[0] as NumericType;
      const endian = inst.imm[1] as string;
      const width = NUMERIC_WIDTH[numeric];
      const little = endian === 'little';
      const offset = context.value(inst.args[0]!);
      const value = context.value(inst.args[1]!);
      const reference = context.constant(context.memory(memory));
      context.line(`if (H.ctl.suspended !== 0 || !(${offset} <= ${record}.length - ${width})) {`);
      context.line(
        `  H.storage.storeBytes(${context.constant(inst.imm[0])}, ${context.constant(
          inst.imm[1],
        )}, ${reference}, ${offset}, ${context.boundary(inst.args[1]!)});`,
      );
      context.line('} else {');
      writeDataViewBytes(context, record, offset, numeric, little, value, '  ');
      context.line('}');
      return;
    }
    case Op.BytesCopy: {
      const destination = inst.refs[0]!;
      const source = inst.refs[1]!;
      context.line(
        `H.storage.copy(${context.constant(context.memory(destination))}, ${context.value(
          inst.args[0]!,
        )}, ${context.constant(context.memory(source))}, ${context.value(
          inst.args[1]!,
        )}, ${context.value(inst.args[2]!)});`,
      );
      return;
    }
    case Op.ResourceUpdateBytes: {
      const destination = inst.refs[0]!;
      const source = inst.refs[1]!;
      context.line(
        `H.storage.updateBytes(${context.constant(
          context.memory(destination),
        )}, ${context.value(inst.args[0]!)}, ${context.constant(
          context.memory(source),
        )}, ${context.value(inst.args[1]!)}, ${context.value(inst.args[2]!)});`,
      );
      return;
    }
    case Op.ResourceFillBytes: {
      const memory = inst.refs[0]!;
      context.line(
        `H.storage.fillBytes(${context.constant(context.memory(memory))}, ${context.value(
          inst.args[0]!,
        )}, ${context.value(inst.args[1]!)}, ${context.value(inst.args[2]!)});`,
      );
      return;
    }
    case Op.EventNow: {
      const node = context.constant(inst.node!);
      const temp = context.temp();
      context.line('rt.beforeHost();');
      context.line(`${temp} = H.event(${node}, []);`);
      context.line('rt.afterHost();');
      assignment(context, results[0]!, convertResult(context, 'f64', `${temp}[0]`));
      return;
    }
    case Op.EventAt: {
      const node = context.constant(inst.node!);
      const temp = context.temp();
      context.line('rt.beforeHost();');
      context.line(
        `${temp} = H.event(${node}, [${inst.args.map((id) => context.boundary(id)).join(', ')}]);`,
      );
      context.line('rt.afterHost();');
      assignment(context, results[0]!, convertResult(context, 'u32', `${temp}[0]`));
      return;
    }
    case Op.EventCancel: {
      const node = context.constant(inst.node!);
      context.line('rt.beforeHost();');
      context.line(
        `H.event(${node}, [${inst.args.map((id) => context.boundary(id)).join(', ')}]);`,
      );
      context.line('rt.afterHost();');
      return;
    }
    case Op.BridgeSend:
    case Op.BridgeSendBytes: {
      const node = context.constant(inst.node!);
      const temp = context.temp();
      context.line('rt.beforeHost();');
      context.line(
        `${temp} = H.output(${node}, [${inst.args
          .map((id) => context.boundary(id))
          .join(', ')}], rt.ctx);`,
      );
      context.line('rt.afterHost();');
      assignment(context, results[0]!, `${temp}[0]`);
      return;
    }
    case Op.Executor: {
      const node = context.constant(inst.node!);
      const temp = context.temp();
      context.line('rt.beforeHost();');
      context.line(
        `${temp} = H.executor(${inst.refs[0]!}, ${node}, [${inst.args
          .map((id) => context.boundary(id))
          .join(', ')}], rt.ctx);`,
      );
      context.line('rt.afterHost();');
      inst.results.forEach((result, index) => {
        assignment(
          context,
          result,
          convertResult(context, context.typeOf(result), `${temp}[${index}]`),
        );
      });
      return;
    }
    case Op.Call: {
      const callee = inst.refs[0]!;
      const target = `H.fns[${callee}]`;
      const args = inst.args.map((id) => context.value(id)).join(', ');
      const transfer = context.hasTransfer(callee);
      if (results.length === 0) {
        if (transfer) {
          const temp = context.temp();
          context.line(`${temp} = ${target}(${args});`);
          context.line(`while (${temp} === rt.TAIL) ${temp} = rt.runTail();`);
        } else {
          context.line(`${target}(${args});`);
        }
        return;
      }
      const temp = context.temp();
      context.line(`${temp} = ${target}(${args});`);
      if (transfer) context.line(`while (${temp} === rt.TAIL) ${temp} = rt.runTail();`);
      if (results.length === 1) {
        assignment(context, results[0]!, temp);
      } else {
        results.forEach((result, index) => {
          assignment(context, result, `rt.ret[${index}]`);
        });
      }
      return;
    }
    case Op.Checkpoint: {
      if (context.artifactDependencies === undefined) {
        context.line('throw H.checkpointOutside();');
        return;
      }
      const dependencies = context.constant(context.artifactDependencies);
      const temp = context.temp();
      context.line(`if (!H.validate(${dependencies})) {`);
      context.line('  rt.beforeHost();');
      context.line(
        `  ${temp} = H.recover(${inst.refs[0]!}, [${inst.args
          .slice(0, keyCount(inst))
          .map((id) => context.value(id))
          .join(', ')}], [${inst.args
          .slice(keyCount(inst))
          .map((id) => context.boundary(id))
          .join(', ')}], ${context.constant(context.fn.name)});`,
      );
      context.line('  rt.afterHost();');
      context.line(`  rt.tailFn = ${temp}.fn; rt.tailArgs = ${temp}.args;`);
      context.line(`  rt.depth = ${context.depthName};`);
      context.line('  return rt.TAIL;');
      context.line('}');
      return;
    }
    case Op.Check:
    case Op.Spill:
      // Synthetic ops arrive with J11/J12; J5 never produces them.
      context.line(`/* ${inst.op} */`);
      return;
    default:
      throw new Error(`JIT codegen has no template for opcode "${String(inst.op)}"`);
  }
}

/**
 * Checkpoint operands are two `ssa-list`s (key and args); `listSplit` keeps
 * their lengths. A missing split means the first list is empty.
 */
function keyCount(inst: MInst): number {
  return inst.listSplit?.[0] ?? 0;
}

function writeDataView(
  context: OpsContext,
  record: string,
  index: string,
  type: ScalarType,
  value: string,
): void {
  const width = NUMERIC_WIDTH[type as NumericType] ?? 1;
  const offset = `${index} * ${width}`;
  if (type === 'f32') {
    context.line(`  ${record}.data.setUint32(${offset}, H.raw32(${value}), true);`);
  } else if (type === 'f64') {
    context.line(`  H.raw64(${value}, H.scratch);`);
    context.line(`  ${record}.data.setUint32(${offset}, H.scratch[0], true);`);
    context.line(`  ${record}.data.setUint32(${offset} + 4, H.scratch[1], true);`);
  } else if (type === 'bool') {
    context.line(`  ${record}.data.setUint8(${offset}, ${value} ? 1 : 0);`);
  } else {
    context.line(`  ${record}.data.${dataViewSetter(type)}(${offset}, ${value}, true);`);
  }
}

function readDataView(
  context: OpsContext,
  record: string,
  offset: string,
  type: NumericType,
  little: boolean,
): string {
  const flag = little ? 'true' : 'false';
  switch (type) {
    case 'f32':
      return `H.fromRaw32(${record}.data.getUint32(${offset}, ${flag}))`;
    case 'f64':
      return `H.fromRaw64(${record}.data.getUint32(${offset}, ${flag}), ${record}.data.getUint32((${offset}) + 4, ${flag}))`;
    default:
      return `${record}.data.${dataViewGetter(type)}(${offset}, ${flag})`;
  }
}

function writeDataViewBytes(
  context: OpsContext,
  record: string,
  offset: string,
  type: NumericType,
  little: boolean,
  value: string,
  indent: string,
): void {
  const flag = little ? 'true' : 'false';
  switch (type) {
    case 'f32':
      context.line(`  ${indent}${record}.data.setUint32(${offset}, H.raw32(${value}), ${flag});`);
      return;
    case 'f64':
      context.line(`  ${indent}H.raw64(${value}, H.scratch);`);
      // `raw64` yields [low, high]; big-endian destinations need them swapped.
      context.line(
        `  ${indent}${record}.data.setUint32(${offset}, H.scratch[${little ? 0 : 1}], ${flag});`,
      );
      context.line(
        `  ${indent}${record}.data.setUint32((${offset}) + 4, H.scratch[${little ? 1 : 0}], ${flag});`,
      );
      return;
    case 'u8':
    case 'i8':
      context.line(`  ${indent}${record}.data.setUint8(${offset}, ${value});`);
      return;
    default:
      context.line(
        `  ${indent}${record}.data.${dataViewSetter(type)}(${offset}, ${value}, ${flag});`,
      );
  }
}

/** Exact width of a numeric type in bytes; used by the emitter for bounds checks. */
export function numericBytes(type: NumericType): number {
  return NUMERIC_WIDTH[type];
}
