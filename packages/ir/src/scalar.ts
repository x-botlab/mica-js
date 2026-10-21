import { isIntegerType, normalizeScalarLiteral } from './runtime';
import type { InstructionNode, InstructionOperand, IntegerType, ScalarType } from './types';

export type IRScalarEvaluationErrorCode =
  | 'unsupported-instruction'
  | 'invalid-instruction'
  | 'invalid-operand'
  | 'division-by-zero'
  | 'conversion-out-of-range';

export class IRScalarEvaluationError extends Error {
  override readonly name = 'IRScalarEvaluationError';

  constructor(
    readonly code: IRScalarEvaluationErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const WIDTH: Readonly<Record<IntegerType, number>> = {
  u8: 8,
  i8: 8,
  u16: 16,
  i16: 16,
  u32: 32,
  i32: 32,
};
const BINARY = new Set([
  'int.add',
  'int.sub',
  'int.mul',
  'int.div',
  'int.rem',
  'int.and',
  'int.or',
  'int.xor',
]);
const BOOLEAN = new Set(['bool.not', 'bool.and', 'bool.or', 'bool.xor']);
const SHIFT = new Set(['int.shl', 'int.lshr', 'int.ashr']);
const CONVERSION = new Set(['int.zext', 'int.sext', 'int.trunc', 'int.reinterpret']);
const PREDICATES = new Set(['eq', 'ne', 'lt', 'le', 'gt', 'ge']);

/** Evaluate one scalar node; operands contain only its already-evaluated SSA inputs. */
export function evaluateScalarInstruction(
  instruction: InstructionNode,
  operands: readonly (boolean | number)[],
): boolean | number {
  checkNode(instruction);
  checkSignature(instruction);
  const inputs = instruction.operands.filter((operand) => operand.kind === 'ssa');
  if (!Array.isArray(operands) || operands.length !== inputs.length) {
    error('invalid-operand', `${instruction.op} requires ${inputs.length} evaluated SSA operands`);
  }
  const values = inputs.map((input, index) => scalar(input.value.type, operands[index]));
  const type = instruction.results[0]!.type;
  const [a, b] = values;

  if (instruction.op === 'const') {
    return scalar(type, literal(instruction, 0));
  }
  if (instruction.op === 'select') {
    // Both alternatives have already been evaluated and checked; this is not a branch.
    return values[0] ? values[1]! : values[2]!;
  }
  if (BOOLEAN.has(instruction.op)) {
    switch (instruction.op) {
      case 'bool.not':
        return !a;
      case 'bool.and':
        return a === true && b === true;
      case 'bool.or':
        return a === true || b === true;
      default:
        return a !== b;
    }
  }

  const source = ssaType(
    instruction,
    instruction.op === 'int.cmp' || CONVERSION.has(instruction.op) ? 1 : 0,
  ) as IntegerType;
  const left = BigInt(a as number);
  const right = b === undefined ? 0n : BigInt(b as number);
  if (instruction.op === 'int.cmp') {
    switch (literal(instruction, 0)) {
      case 'eq':
        return left === right;
      case 'ne':
        return left !== right;
      case 'lt':
        return left < right;
      case 'le':
        return left <= right;
      case 'gt':
        return left > right;
      default:
        return left >= right;
    }
  }
  if (CONVERSION.has(instruction.op)) {
    return wrap(
      type as IntegerType,
      instruction.op === 'int.zext' ? BigInt.asUintN(WIDTH[source], left) : left,
    );
  }
  if (SHIFT.has(instruction.op)) {
    const width = WIDTH[source];
    if (right >= BigInt(width)) {
      return instruction.op === 'int.ashr' && left < 0n ? -1 : 0;
    }
    switch (instruction.op) {
      case 'int.shl':
        return wrap(source, left << right);
      case 'int.lshr':
        return wrap(source, BigInt.asUintN(width, left) >> right);
      default:
        return wrap(source, left >> right);
    }
  }
  switch (instruction.op) {
    case 'int.add':
      return wrap(source, left + right);
    case 'int.sub':
      return wrap(source, left - right);
    case 'int.mul':
      return wrap(source, left * right);
    case 'int.div':
    case 'int.rem':
      if (right === 0n) error('division-by-zero', `${instruction.op} divisor must not be zero`);
      // BigInt division truncates toward zero; fixed-width wrapping also handles MIN / -1.
      return wrap(source, instruction.op === 'int.div' ? left / right : left % right);
    case 'int.and':
      return wrap(source, left & right);
    case 'int.or':
      return wrap(source, left | right);
    case 'int.xor':
      return wrap(source, left ^ right);
    case 'int.not':
      return wrap(source, ~left);
    default:
      return error('unsupported-instruction', `${instruction.op} has no scalar implementation`);
  }
}

function error(code: IRScalarEvaluationErrorCode, message: string): never {
  throw new IRScalarEvaluationError(code, message);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function checkNode(node: InstructionNode): void {
  if (!record(node) || typeof node.op !== 'string') {
    error('invalid-instruction', 'Expected an InstructionNode');
  }
  if (
    !BOOLEAN.has(node.op) &&
    !BINARY.has(node.op) &&
    !SHIFT.has(node.op) &&
    !CONVERSION.has(node.op) &&
    !['const', 'select', 'int.not', 'int.cmp'].includes(node.op)
  ) {
    error('unsupported-instruction', `${node.op} has no scalar implementation`);
  }
  if (!Array.isArray(node.operands) || !Array.isArray(node.results) || node.results.length !== 1) {
    error('invalid-instruction', `${node.op} requires an operand list and one result`);
  }
  if (!record(node.results[0]) || typeof node.results[0].type !== 'string') {
    error('invalid-instruction', `${node.op} requires a typed result`);
  }
  for (const operand of node.operands) {
    if (!record(operand) || (operand.kind !== 'literal' && operand.kind !== 'ssa')) {
      error('invalid-instruction', `${node.op} accepts only SSA or literal operands`);
    }
    if (
      operand.kind === 'ssa' &&
      (!record(operand.value) || typeof operand.value.type !== 'string')
    ) {
      error('invalid-instruction', `${node.op} requires typed SSA operands`);
    }
  }
}

function layout(node: InstructionNode, kinds: readonly InstructionOperand['kind'][]): void {
  if (
    node.operands.length !== kinds.length ||
    kinds.some((kind, i) => node.operands[i]?.kind !== kind)
  ) {
    error('invalid-instruction', `${node.op} requires operand kinds: ${kinds.join(', ')}`);
  }
}

function literal(node: InstructionNode, index: number): boolean | number | string {
  return (node.operands[index] as Extract<InstructionOperand, { kind: 'literal' }>).value;
}

function ssaType(node: InstructionNode, index: number): ScalarType {
  return (node.operands[index] as Extract<InstructionOperand, { kind: 'ssa' }>).value.type;
}

function requireType(valid: boolean, node: InstructionNode): void {
  if (!valid) error('invalid-instruction', `${node.op} has incompatible operand or result types`);
}

function supportedType(type: unknown): type is 'bool' | IntegerType {
  return type === 'bool' || isIntegerType(type);
}

function checkSignature(node: InstructionNode): void {
  const result = node.results[0]!.type;
  if (node.op === 'const') {
    layout(node, ['literal']);
    if (result === 'f32' || result === 'f64')
      error(
        'unsupported-instruction',
        'Floating constants belong to the floating scalar implementation',
      );
    requireType(supportedType(result), node);
    return;
  }
  if (node.op === 'select') {
    layout(node, ['ssa', 'ssa', 'ssa']);
    requireType(
      ssaType(node, 0) === 'bool' && ssaType(node, 1) === result && ssaType(node, 2) === result,
      node,
    );
    if (result === 'f32' || result === 'f64')
      error(
        'unsupported-instruction',
        'Floating select belongs to the floating scalar implementation',
      );
    requireType(supportedType(result), node);
    return;
  }
  if (CONVERSION.has(node.op)) {
    layout(node, ['literal', 'ssa']);
    const source = ssaType(node, 1);
    const target = literal(node, 0);
    requireType(isIntegerType(source) && isIntegerType(target) && target === result, node);
    const sourceWidth = WIDTH[source as IntegerType];
    const targetWidth = WIDTH[target as IntegerType];
    switch (node.op) {
      case 'int.zext':
        requireType(targetWidth > sourceWidth, node);
        break;
      case 'int.sext':
        requireType(source.startsWith('i') && targetWidth > sourceWidth, node);
        break;
      case 'int.trunc':
        requireType(targetWidth < sourceWidth, node);
        break;
      default:
        requireType(targetWidth === sourceWidth && source !== target, node);
    }
    return;
  }
  if (node.op === 'int.cmp') {
    layout(node, ['literal', 'ssa', 'ssa']);
    const predicate = literal(node, 0);
    requireType(
      typeof predicate === 'string' &&
        PREDICATES.has(predicate) &&
        result === 'bool' &&
        isIntegerType(ssaType(node, 1)) &&
        ssaType(node, 1) === ssaType(node, 2),
      node,
    );
    return;
  }
  if (SHIFT.has(node.op)) {
    layout(node, ['ssa', 'ssa']);
    requireType(
      isIntegerType(result) &&
        ssaType(node, 0) === result &&
        ssaType(node, 1) === 'u32' &&
        (node.op !== 'int.ashr' || result.startsWith('i')),
      node,
    );
    return;
  }
  const unary = node.op === 'int.not' || node.op === 'bool.not';
  layout(node, unary ? ['ssa'] : ['ssa', 'ssa']);
  requireType(
    (BOOLEAN.has(node.op) ? result === 'bool' : isIntegerType(result)) &&
      ssaType(node, 0) === result &&
      (unary || ssaType(node, 1) === result),
    node,
  );
}

function scalar(type: ScalarType, value: unknown): boolean | number {
  try {
    const normalized = normalizeScalarLiteral(type, value, 'Scalar operand');
    return typeof normalized === 'number' && normalized === 0 ? 0 : normalized;
  } catch {
    return error('invalid-operand', `Scalar operand must be a valid ${type} value`);
  }
}

function wrap(type: IntegerType, value: bigint): number {
  const bits = WIDTH[type];
  return Number(type.startsWith('i') ? BigInt.asIntN(bits, value) : BigInt.asUintN(bits, value));
}
