import { arithmetic, decode, fromNumber, pack, round, special, toNumber } from './float-ieee';
import type { FloatBits, RuntimeScalar } from './float-ieee';
import type { FloatType, InstructionNode, IntegerType, Predicate, ScalarType } from './types';

export type { FloatBits, RuntimeScalar } from './float-ieee';

export class IRFloatEvaluationError extends Error {
  override readonly name = 'IRFloatEvaluationError';

  constructor(
    readonly code:
      'invalid-instruction' | 'invalid-operand' | 'integer-overflow' | 'unsupported-operation',
    message: string,
  ) {
    super(message);
  }
}

const INTEGER_RANGES: Record<IntegerType, readonly [number, number]> = {
  u8: [0, 255],
  i8: [-128, 127],
  u16: [0, 65535],
  i16: [-32768, 32767],
  u32: [0, 4294967295],
  i32: [-2147483648, 2147483647],
};
const OPERATIONS = new Set([
  'const',
  'const.bits',
  'select',
  'float.add',
  'float.sub',
  'float.mul',
  'float.div',
  'float.fma',
  'float.cmp',
  'float.isNaN',
  'float.isFinite',
  'convert.intToFloat',
  'convert.floatToInt',
  'convert.float',
  'bitcast',
]);
const PREDICATES: Record<Predicate, (left: number, right: number) => boolean> = {
  eq: (a, b) => a === b,
  ne: (a, b) => a !== b,
  lt: (a, b) => a < b,
  le: (a, b) => a <= b,
  gt: (a, b) => a > b,
  ge: (a, b) => a >= b,
};

function fail(code: IRFloatEvaluationError['code'], message: string): never {
  throw new IRFloatEvaluationError(code, message);
}

function requireInstruction(condition: unknown, message: string): asserts condition {
  if (!condition) fail('invalid-instruction', message);
}

function isFloat(type: unknown): type is FloatType {
  return type === 'f32' || type === 'f64';
}

function isInteger(type: unknown): type is IntegerType {
  return typeof type === 'string' && Object.hasOwn(INTEGER_RANGES, type);
}

function integer(type: IntegerType, value: RuntimeScalar): number {
  const [minimum, maximum] = INTEGER_RANGES[type];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) {
    fail('invalid-operand', `Expected an in-range ${type} integer`);
  }
  return value === 0 ? 0 : value;
}

function floating(type: FloatType, value: RuntimeScalar): FloatBits {
  if (typeof value === 'number') return fromNumber(type, value);
  if (
    typeof value !== 'object' ||
    value === null ||
    value.type !== type ||
    typeof value.bits !== 'string' ||
    value.bits.length !== (type === 'f32' ? 10 : 18) ||
    !(type === 'f32' ? /^0x[\da-fA-F]{8}$/ : /^0x[\da-fA-F]{16}$/).test(value.bits)
  ) {
    fail('invalid-operand', `Expected a number or exact ${type} FloatBits`);
  }
  return value;
}

/** Evaluate only one floating instruction; operands are SSA values in node order, excluding literals. */
export function evaluateFloatInstruction(
  instruction: InstructionNode,
  operands: readonly RuntimeScalar[],
): RuntimeScalar {
  requireInstruction(
    instruction !== null &&
      typeof instruction === 'object' &&
      typeof instruction.op === 'string' &&
      Array.isArray(instruction.operands) &&
      Array.isArray(instruction.results),
    'Expected an InstructionNode',
  );
  const { op } = instruction;
  if (!OPERATIONS.has(op)) fail('unsupported-operation', `Unsupported floating operation: ${op}`);
  requireInstruction(instruction.results.length === 1, 'Expected exactly one result');
  const target = instruction.results[0]?.type;
  const types: ScalarType[] = [];
  const literals: unknown[] = [];
  const kinds: string[] = [];
  for (const operand of instruction.operands) {
    requireInstruction(
      operand !== null && typeof operand === 'object',
      'Invalid instruction operand',
    );
    kinds.push(operand.kind);
    if (operand.kind === 'ssa') {
      requireInstruction(
        operand.value !== null && typeof operand.value === 'object',
        'Expected an SSA value',
      );
      types.push(operand.value.type);
    } else if (operand.kind === 'literal') {
      literals.push(operand.value);
    } else {
      fail('invalid-instruction', 'Floating operations do not accept static references');
    }
  }
  if (!Array.isArray(operands) || operands.length !== types.length) {
    fail('invalid-operand', 'Runtime operands must match the SSA operand count');
  }
  for (let index = 0; index < operands.length; index += 1) {
    if (!Object.hasOwn(operands, index))
      fail('invalid-operand', 'Runtime operands cannot be sparse');
  }
  const signature = (expected: readonly string[]) =>
    requireInstruction(
      kinds.length === expected.length && kinds.every((kind, index) => kind === expected[index]),
      `Invalid ${op} operand layout`,
    );
  if (op === 'const' || op === 'const.bits') {
    signature(['literal']);
    requireInstruction(isFloat(target), 'Floating constants require f32/f64 results');
    if (op === 'const') {
      requireInstruction(
        typeof literals[0] === 'number',
        'Floating const requires a numeric literal',
      );
      return fromNumber(target, literals[0]);
    }
    try {
      return floating(target, { type: target, bits: literals[0] } as FloatBits);
    } catch {
      fail('invalid-instruction', 'const.bits requires an exact-width hexadecimal literal');
    }
  }
  if (op === 'select') {
    signature(['ssa', 'ssa', 'ssa']);
    requireInstruction(
      isFloat(target) && types[0] === 'bool' && types[1] === target && types[2] === target,
      'Floating select requires bool, F, F -> F',
    );
    if (typeof operands[0] !== 'boolean') fail('invalid-operand', 'select condition must be bool');
    const yes = floating(target, operands[1]!);
    const no = floating(target, operands[2]!);
    return operands[0] ? yes : no;
  }
  if (op === 'bitcast' || op.startsWith('convert.')) {
    signature(['literal', 'ssa']);
    requireInstruction(literals[0] === target, 'Conversion target must match the result');
    const source = types[0];
    if (op === 'convert.intToFloat') {
      requireInstruction(isInteger(source) && isFloat(target), 'Expected I -> F conversion');
      return fromNumber(target, integer(source, operands[0]!));
    }
    if (op === 'convert.floatToInt') {
      requireInstruction(isFloat(source) && isInteger(target), 'Expected F -> I conversion');
      const value = Math.trunc(toNumber(floating(source, operands[0]!)));
      const [minimum, maximum] = INTEGER_RANGES[target];
      if (!Number.isFinite(value) || value < minimum || value > maximum) {
        fail('integer-overflow', `Float cannot be converted to ${target}`);
      }
      return value === 0 ? 0 : value;
    }
    if (op === 'convert.float') {
      requireInstruction(isFloat(source) && isFloat(target), 'Expected F -> F conversion');
      const value = decode(floating(source, operands[0]!));
      if (value.kind !== 'finite') return special(target, value.kind, value.negative);
      return round(target, value.negative, value.coefficient, 1n, value.exponent);
    }
    requireInstruction(
      (source === 'f32' && (target === 'u32' || target === 'i32')) ||
        ((source === 'u32' || source === 'i32') && target === 'f32'),
      'bitcast permits only f32 <-> u32/i32',
    );
    if (source === 'f32') {
      const raw = BigInt(floating(source, operands[0]!).bits);
      return Number(target === 'i32' ? BigInt.asIntN(32, raw) : raw);
    }
    return pack('f32', BigInt.asUintN(32, BigInt(integer(source as IntegerType, operands[0]!))));
  }
  const comparison = op === 'float.cmp';
  const classification = op === 'float.isNaN' || op === 'float.isFinite';
  const count = classification ? 1 : op === 'float.fma' ? 3 : 2;
  signature([...(comparison ? ['literal'] : []), ...Array<string>(count).fill('ssa')]);
  const type = types[0];
  requireInstruction(
    isFloat(type) &&
      types.every((other) => other === type) &&
      target === (comparison || classification ? 'bool' : type),
    'Invalid floating signature',
  );
  const values = operands.map((operand) => floating(type, operand));
  if (comparison) {
    const predicate = literals[0];
    requireInstruction(
      typeof predicate === 'string' && Object.hasOwn(PREDICATES, predicate),
      'Unknown float comparison predicate',
    );
    return PREDICATES[predicate as Predicate](toNumber(values[0]!), toNumber(values[1]!));
  }
  if (classification) {
    const kind = decode(values[0]!).kind;
    return op === 'float.isNaN' ? kind === 'nan' : kind === 'finite';
  }
  return arithmetic(type, op, values);
}
